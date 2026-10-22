import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'
import { linkPaths, openCommand } from './paths'

// Whether a path exists, cached for the session: replies redraw often.
const seen = new Map<string, boolean>()
async function existsCached($: { fs: { exists(p: string): Promise<boolean> } }, p: string): Promise<boolean> {
  const hit = seen.get(p)
  if (hit !== undefined) return hit
  const ok = await $.fs.exists(p).catch(() => false)
  seen.set(p, ok)
  return ok
}

// The user's home folder, for ~/ paths; asked of Windows once.
let home: string | undefined
async function homeDir($: { process: { run(cmd: string[]): Promise<{ stdout: string }> } }): Promise<string> {
  if (home === undefined) {
    const r = await $.process.run(['cmd.exe', '/d', '/c', 'echo %USERPROFILE%']).catch(() => ({ stdout: '' }))
    home = r.stdout.trim() || 'C:' + String.fromCharCode(92) + 'Users'
  }
  return home
}

// Colours are ANSI names, so they come from the Windows Terminal scheme (GitHub Light by day,
// GitHub Dark after f.lux flips) rather than from a palette of our own. No background tint on
// the prompt: Claude's theme can be dark under a light terminal, which drew a black bar.
const YOU = 'blue'
const CLAUDE = 'magenta'
const FAILED = 'red'
const DONE = 'green'
const RUNNING = 'yellow'

// Tool calls whose output you opened, by tool_use_id.
const open = atom({ plugin: 'readable', key: 'open' } as const, [] as string[])

// One entry per main-loop turn, keyed by the prompt that started it, for the turn divider.
type Turn = { text: string; at: number; ms?: number; tools: number; agents: number }
const turns = atom({ plugin: 'readable', key: 'turns' } as const, [] as Turn[])
const MAX_TURNS = 200
const AGENT_TOOLS = new Set(['Agent', 'Task'])

/** "14:32", local time. */
export function clock(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** "48s", "3m 05s", "1h 02m". */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** The label on the rule above a prompt: when the turn began, how long it ran, what it used. */
export function dividerLabel(turn: Turn | undefined): string {
  if (!turn) return ''
  const parts = [clock(turn.at), turn.ms === undefined ? 'running' : duration(turn.ms)]
  if (turn.tools) parts.push(`${turn.tools} tool${turn.tools === 1 ? '' : 's'}`)
  if (turn.agents) parts.push(`${turn.agents} agent${turn.agents === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

const same = (a: string, b: string) => a.trim() === b.trim()
const isSubagent = (e: unknown) => Boolean((e as { agentId?: string }).agentId)

// Input fields that name what a call acts on, most telling first.
const SUBJECT_KEYS = ['command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'skill', 'description', 'path', 'prompt']
const MAX_SUBJECT = 60
const FALLBACK_COLUMNS = 120

/** The one argument worth showing for a tool call, on one line and clipped. */
export function subjectOf(input: unknown, max = MAX_SUBJECT): string {
  if (typeof input !== 'object' || input === null) return ''
  const fields = input as Record<string, unknown>
  const key = SUBJECT_KEYS.find(k => typeof fields[k] === 'string' && fields[k] !== '')
  const raw = key !== undefined ? String(fields[key]) : ''
  const one = raw.replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max - 1) + '…' : one
}

/** Word-wraps text to a width, so every row can carry the bar. */
export function wrapLines(text: string, width: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    let row = ''
    for (const word of para.split(/\s+/).filter(w => w !== '')) {
      if (row === '') row = word
      else if (row.length + 1 + word.length <= width) row += ' ' + word
      else { out.push(row); row = word }
      while (row.length > width) { out.push(row.slice(0, width)); row = row.slice(width) }
    }
    out.push(row)
  }
  return out
}

export type Segment = { kind: 'prose' | 'code'; text: string; lang: string }

/** Splits a reply into prose and closed fenced code blocks; an unclosed fence stays prose. */
export function segments(text: string): Segment[] {
  const out: Segment[] = []
  let at = 0
  for (const m of text.matchAll(/^```([\w+#.-]*)[^\n]*\n([\s\S]*?)^```[ \t]*$/gm)) {
    if (m.index! > at) out.push({ kind: 'prose', text: text.slice(at, m.index), lang: '' })
    out.push({ kind: 'code', text: m[2]!.replace(/\n$/, ''), lang: m[1]!.toLowerCase() })
    at = m.index! + m[0].length
  }
  if (at < text.length) out.push({ kind: 'prose', text: text.slice(at), lang: '' })
  return out.filter(s => s.kind === 'code' || s.text.trim() !== '')
}

/** The first line number a Read call asked for, so its lines are numbered right. */
export function readOffset(input: unknown): number {
  const o = (input ?? {}) as { offset?: unknown }
  return typeof o.offset === 'number' && o.offset > 0 ? o.offset : 1
}

/** Bolds a reply's opening sentence, when the reply opens with plain prose. */
export function boldLead(text: string): string {
  const m = /^([A-Z][^\n*`#>|[\]]{0,240}?[.!?])(\s|$)/.exec(text)
  const lead = m?.[1]
  return lead ? `**${lead}**${text.slice(lead.length)}` : text
}

/**
 * Turns markdown links to local paths into file: links, which the terminal can press;
 * a link to a bare relative path is otherwise drawn as plain text. A :line suffix is dropped.
 */
export function linkify(text: string, cwd: string): string {
  const base = cwd.split(String.fromCharCode(92)).join('/').replace(/\/$/, '')
  return text.replace(/\]\(([^)\s]+)\)/g, (whole, href: string) => {
    if (/^(https?:|file:|mailto:|#)/i.test(href)) return whole
    const path = href.replace(/:\d+(-\d+)?$/, '').split(String.fromCharCode(92)).join('/')
    const abs = /^[A-Za-z]:\//.test(path) ? path : `${base}/${path.replace(/^\.\//, '')}`
    return `](file:///${encodeURI(abs)})`
  })
}

/** The Windows path a file: link points at, for explorer.exe. */
export function pathOfFileHref(href: string): string {
  return decodeURI(href.replace(/^file:\/\/\/?/i, '')).split('/').join(String.fromCharCode(92))
}

// Reads and searches are drawn as a group, which has no result row of its own, so their
// output is drawn under the tool line when opened. Other tools open the engine's result row.
const INLINE_OUTPUT = new Set(['Read', 'Grep', 'Glob'])
const INLINE_LINES = 12

/** The text a Read, Grep or Glob call returned, as far as its stored output says. */
export function inlineOutput(tool: string, output: unknown): string[] {
  if (typeof output === 'string') return output.split('\n')
  if (typeof output !== 'object' || output === null) return []
  const o = output as Record<string, unknown>
  const file = o.file as Record<string, unknown> | undefined
  if (tool === 'Read' && typeof file?.content === 'string') return file.content.split('\n')
  if (typeof o.content === 'string' && o.content !== '') return o.content.split('\n')
  if (Array.isArray(o.filenames)) return o.filenames.map(String)
  return []
}

// The full ctrl+o view is left to the engine. Only prompt rows say whether it is open,
// so their flag is mirrored here for the tool rows.
let expanded = false

export const register: Register = on => {
  // Turn stats for the divider, main loop only: a subagent's events carry agentId.
  on('turn.start', async ($, e, next) => {
    if (!isSubagent(e)) {
      await update($, turns, list => [...(list ?? []), { text: e.text, at: Date.now(), tools: 0, agents: 0 }].slice(-MAX_TURNS))
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (!isSubagent(e)) {
      const tool = String((e as { tool?: unknown }).tool ?? '')
      await update($, turns, list => {
        const all = list ?? []
        const last = all[all.length - 1]
        if (!last || last.ms !== undefined) return all
        return [...all.slice(0, -1), { ...last, tools: last.tools + 1, agents: last.agents + (AGENT_TOOLS.has(tool) ? 1 : 0) }]
      })
    }
    return next(e)
  // A tool call must never fail because the count did.
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (!isSubagent(e)) {
      await update($, turns, list => {
        const all = list ?? []
        const last = all[all.length - 1]
        return last && last.ms === undefined ? [...all.slice(0, -1), { ...last, ms: e.durationMs }] : all
      })
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  on('ui.render', { component: 'UserMessage', props: { origin: { kind: 'composer' } } }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    if (e.props.isExpanded !== expanded) {
      expanded = e.props.isExpanded
      $.ui.invalidate('ui.render')
    }
    if (expanded) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const width = Math.max(20, (e.viewport?.columns ?? FALLBACK_COLUMNS) - 4)
    // 7 columns go to the bar and the "you" label.
    const lines = wrapLines(e.props.text.replace(/^\s*\n/, '').trimEnd(), width - 7)
    const all = await read($, turns)
    const label = dividerLabel([...all].reverse().find(t => same(t.text, e.props.text)))
    const rule = label ? `── ${label} ${'─'.repeat(Math.max(3, width - label.length - 4))}` : '─'.repeat(width)
    return (
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        <Text dimColor>{rule}</Text>
        {lines.map((line, i) => (
          <Box key={`l${i}`} flexDirection="row">
            <Text color={YOU}>▌ </Text>
            <Text color={YOU} bold>{i === 0 ? 'you  ' : '     '}</Text>
            <Text>{(line === '' ? ' ' : line).padEnd(width - 7)}</Text>
          </Box>
        ))}
      </Box>
    )
  })

  // Each block of Claude's text gets a "claude" label line above it, so it reads apart from the
  // ∴ thinking summary (which no hook draws). The text itself starts at the left edge.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || expanded) return next(e)
    const { Box, Text, Markdown } = $.ui.resolve(e)
    const cwd = await $.session.cwd()
    // A click on a link: code and text open in VS Code (at the line, when given), documents in
    // their app, folders in Explorer, programs are only revealed, web links go to the browser.
    const { Code, Button } = $.ui.resolve(e)
    const userHome = await homeDir($)
    const onLinkPress = (link: { href: string }) => {
      const cmd = /^file:/i.test(link.href) ? openCommand(link.href) : ['explorer.exe', link.href]
      void $.process.run(cmd).catch(() => undefined)
    }
    // Prose goes to Markdown with its paths linked; each fenced block gets a header with its
    // language and a copy button over highlighted code (prismantis' code idea, MIT).
    const parts = await Promise.all(segments(boldLead(e.props.text)).map(async (seg, i) => seg.kind === 'code' ? (
      <Box key={`c${i}`} flexDirection="column" marginTop={1}>
        <Box flexDirection="row">
          <Text dimColor>{`${seg.lang || 'code'}  `}</Text>
          <Button key={`copy-${i}`} plain dimColor label="⧉ copy" onPress={press => void $.ui.copy({ text: seg.text, surface: press.surface })} />
        </Box>
        <Code source={seg.text} language={seg.lang || undefined} />
      </Box>
    ) : (
      <Markdown key={`m${i}`} text={await linkPaths(linkify(seg.text, cwd), cwd, userHome, p => existsCached($, p))} onLinkPress={onLinkPress} />
    )))
    return (
      <Box flexDirection="column" marginTop={1}>
        {/* A coloured full-width rule opens each reply, so it reads apart from the dim ∴ thinking
            line above it, which no mod can restyle (probed 2026-10-19). */}
        <Text color={CLAUDE} bold>{`── claude ${'─'.repeat(Math.max(3, Math.max(20, (e.viewport?.columns ?? FALLBACK_COLUMNS) - 4) - 10))}`}</Text>
        {parts}
      </Box>
    )
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || expanded) return next(e)
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const p = e.props
    const failed = p.isErrored || p.isInterrupted
    const dot = failed ? FAILED : p.isRunning || p.output === undefined ? RUNNING : DONE
    const note = p.isInterrupted ? 'interrupted' : p.isErrored ? 'error' : ''
    const id = p.tool_use_id
    const isOpen = (await read($, open)).includes(id)
    const hasOutput = p.output !== undefined && !failed
    const inline = isOpen && INLINE_OUTPUT.has(p.tool) ? inlineOutput(p.tool, p.output) : []
    const shown = inline.slice(0, INLINE_LINES)
    return (
      <Box flexDirection="column">
      <Box flexDirection="row" marginLeft={2}>
        <Text color={dot}>● </Text>
        {hasOutput ? (
          // The whole line is the toggle: click it to show or hide the output.
          <Button key={`out-${id}`} plain dimColor label={`${p.tool} ${subjectOf(p.input)}  ${isOpen ? '▾' : '▸'}`}
            onPress={() => update($, open, ids => (ids ?? []).includes(id) ? (ids ?? []).filter(x => x !== id) : [...(ids ?? []), id])} />
        ) : (
          <Text wrap="wrap">
            <Text bold dimColor>{p.tool}</Text>
            <Text dimColor>{` ${subjectOf(p.input)}`}</Text>
            {note ? <Text color={FAILED}>{`  ${note}`}</Text> : null}
          </Text>
        )}
      </Box>
      {shown.length > 0 && p.tool === 'Read' ? (
        // A file read is drawn highlighted by its type, numbered from where the read began.
        <Box marginLeft={6}><Code source={shown.join('\n')} path={subjectOf(p.input, 400)} startLine={readOffset(p.input)} /></Box>
      ) : shown.map((line, i) => (
        <Text key={`o${i}`} dimColor>{`      ${line}`}</Text>
      ))}
      {inline.length > INLINE_LINES ? <Text dimColor>{`      … +${inline.length - INLINE_LINES} lines (ctrl+o)`}</Text> : null}
      </Box>
    )
  })

  // Results stay hidden unless the call failed or you opened it.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || expanded || e.props.isErrored) return next(e)
    if ((await read($, open)).includes(e.props.tool_use_id)) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  // A grouped run of reads and searches unfolds, so each call gets its own one-line row.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || expanded) return next(e)
    return next({ ...e, props: { ...e.props, isExpanded: true } })
  })
}
