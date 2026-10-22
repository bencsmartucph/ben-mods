// File paths in Claude's replies become links, the open-paths idea (kiankhooban/open-paths, MIT),
// rebuilt for readable: only paths that exist are linked, code and text open in VS Code at the
// line, documents in their default app, and nothing is ever run.

const BS = String.fromCharCode(92)

/** Types that open in the editor (at the line when one is given), never in their default app. */
const EDITOR = new Set([
  'py', 'r', 'rmd', 'qmd', 'ipynb', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'jsonc', 'md', 'txt', 'csv', 'tsv',
  'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'xml', 'html', 'css', 'scss', 'sql', 'tex', 'bib', 'log', 'ahk', 'lua',
  'go', 'rs', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'rb', 'sh', 'ps1', 'psm1', 'bat', 'cmd', 'do', 'env', 'gitignore',
])
/** Types that are only shown in Explorer, never launched. */
const REVEAL = new Set(['exe', 'msi', 'lnk', 'dll', 'com', 'scr', 'vbs', 'reg'])

export type Target = { path: string; line?: number; col?: number }

const extOf = (p: string) => (/\.([A-Za-z0-9]+)$/.exec(p)?.[1] ?? '').toLowerCase()

/** Splits `path:12:3` into the path and its position. */
export function splitPosition(raw: string): Target {
  const m = /^(.*?):(\d+)(?::(\d+))?$/.exec(raw)
  if (!m || /^[A-Za-z]$/.test(m[1]!)) return { path: raw }
  return { path: m[1]!, line: Number(m[2]), col: m[3] ? Number(m[3]) : undefined }
}

/** True when a string reads as a file path rather than prose or code. */
export function looksLikePath(s: string): boolean {
  if (s.length < 3 || s.length > 260 || /\s{2}|[<>|*?"]/.test(s) || /^[a-z]+:\/\//i.test(s)) return false
  const { path } = splitPosition(s)
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('~/') || path.startsWith('~' + BS)) return true
  // Relative: needs a separator, or a file name with an extension.
  return /[\\/]/.test(path) ? !/\s/.test(path) : /^[\w.-]+\.[A-Za-z0-9]{1,6}$/.test(path) && !/^\d/.test(path)
}

/** The absolute Windows path a written path points at. */
export function absolute(path: string, cwd: string, home: string): string {
  let p = path.split('/').join(BS)
  if (p.startsWith('~' + BS)) p = home.replace(/[\\/]$/, '') + p.slice(1)
  else if (!/^[A-Za-z]:\\/.test(p)) p = cwd.replace(/[\\/]$/, '') + BS + p.replace(/^\.\\/, '')
  return p
}

export function hrefOf(abs: string, t: Target): string {
  const pos = t.line ? `#L${t.line}${t.col ? 'C' + t.col : ''}` : ''
  return `file:///${encodeURI(abs.split(BS).join('/'))}${pos}`
}

/** What a press on a file link runs: VS Code at the line, the default app, or an Explorer reveal. */
export function openCommand(href: string): string[] {
  const m = /^file:\/\/\/?([^#]*)(?:#L(\d+)(?:C(\d+))?)?$/i.exec(href)
  if (!m) return ['explorer.exe', href]
  const fwd = decodeURI(m[1]!)
  const win = fwd.split('/').join(BS)
  const ext = extOf(fwd)
  if (EDITOR.has(ext) || (m[2] && !REVEAL.has(ext))) {
    const pos = m[2] ? `:${m[2]}${m[3] ? ':' + m[3] : ''}` : ''
    return ['explorer.exe', `vscode://file/${fwd}${pos}`]
  }
  if (REVEAL.has(ext)) return ['explorer.exe', `/select,${win}`]
  return ['explorer.exe', win]
}

// Bare paths in prose: absolute (C:\ or C:/), home (~/) or relative with a separator, then an
// optional :line:col. Trailing punctuation is trimmed afterwards.
const BARE = /(?<![\w`/\\[(])((?:[A-Za-z]:[\\/]|~[\\/])[^\s`'"<>|*?()[\]]+|(?:\.{1,2}[\\/])?[\w.-]+(?:[\\/][\w.-]+)+(?::\d+(?::\d+)?)?)/g

type Found = { start: number; end: number; raw: string; code: boolean }

/** Path candidates in a reply, outside fenced blocks and existing links. */
export function candidates(text: string): Found[] {
  const out: Found[] = []
  // Mask what must not be touched: fenced blocks, markdown links, autolinks.
  const masked = text.replace(/```[\s\S]*?```|\[[^\]]*\]\([^)]*\)|<https?:[^>]*>|https?:\/\/\S+/g, m => ' '.repeat(m.length))
  for (const m of masked.matchAll(/`([^`\n]+)`/g)) {
    if (looksLikePath(m[1]!.trim())) out.push({ start: m.index!, end: m.index! + m[0].length, raw: m[1]!.trim(), code: true })
  }
  const noCode = masked.replace(/`[^`\n]+`/g, m => ' '.repeat(m.length))
  for (const m of noCode.matchAll(BARE)) {
    const raw = m[1]!.replace(/[.,;:!?)\]]+$/, '')
    if (looksLikePath(raw) && /[\\/]/.test(raw)) out.push({ start: m.index!, end: m.index! + raw.length, raw, code: false })
  }
  return out.sort((a, b) => a.start - b.start)
}

/** Rewrites the reply so each path that exists is a link; `exists` gets absolute paths. */
export async function linkPaths(text: string, cwd: string, home: string, exists: (abs: string) => Promise<boolean>): Promise<string> {
  const found = candidates(text)
  if (!found.length) return text
  const checks = await Promise.all(found.map(async f => {
    const t = splitPosition(f.raw)
    const abs = absolute(t.path, cwd, home)
    return (await exists(abs).catch(() => false)) ? hrefOf(abs, t) : null
  }))
  let out = ''
  let at = 0
  found.forEach((f, i) => {
    const href = checks[i]
    if (!href || f.start < at) return
    const shown = f.code ? '`' + f.raw + '`' : f.raw
    out += text.slice(at, f.start) + `[${shown}](${href})`
    at = f.end
  })
  return out + text.slice(at)
}
