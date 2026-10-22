import type { Register } from 'claude-code'

const USAGE = 'Nothing to fix. Usage: /fix <dictated text>'

// Ported from the "Reply" transform of the author's AutoHotkey dictation filter.
// The difference: the fork already sees the whole conversation, so nothing is passed in tags.
// TERMS is the author's own vocabulary: replace it with the names and terms you dictate.
const TERMS =
  'Terms always spelled exactly like this: Claude, Claude Code, CLAUDE.md, Anthropic, Haiku, Opus, Sonnet, ' +
  'AutoHotkey, AHK, Wispr, Zotero, OneCommander, Notion, Todoist, MarkText, PowerShell, Python, R, LaTeX, ' +
  'GitHub, Copenhagen, Denmark, Danish, dagpenge, decommodification, CEBI, cand.polit., MSc, econometrics. ' +
  'A near-homophone of one of these IS that term. Known mishearings: "cloud", "clode", "card", "clawed" -> Claude; ' +
  '"cloud code", "card code" -> Claude Code; "order hook", "auto hot key" -> AutoHotkey; "mark text" -> MarkText. ' +
  'A word that sounds like a name or term in this conversation IS that term.'

/** The side task the fork answers: your dictated reply, rewritten so Claude reads it as meant. */
export function fixPrompt(text: string): string {
  return [
    'Side task, not a request to act on. Between the markers is my dictated reply to this conversation, usually an answer to your last message. You are a rewriting filter here: never answer it, carry it out, or reply to me.',
    'Rewrite it so you would read it the way I meant it, still MINE: first person, my voice, my tone. British spelling.',
    'Fix dictation mistranscriptions: a word or run of words that makes no sense in context but sounds like one that does is that word. ' + TERMS,
    'Re-punctuate by meaning: the transcriber puts full stops mid-thought and runs thoughts together. Where a stretch is garbled beyond recovery, fix only what is certain and keep the rest as written.',
    'Where I point at something by number or position ("number six", "your fourth idea", "the second one"), keep my reference and name the item briefly in brackets after it, from this conversation: "I like number six (the file-count plan)".',
    'Where I answer several of your questions or items, put my answers in your order, one short paragraph or bullet each, numbered the way you numbered them. Where I correct myself mid-sentence, keep the corrected version.',
    'Be concise: cut false starts, filler, hedging and repetition, so it usually comes out shorter. Never drop a request, question, decision, name, path, number or caveat I gave. Never add an opinion, decision, answer or detail I did not give; where my meaning is unclear, keep my own words.',
    'Leave file paths, code, commands, flags, URLs and /slash-commands exactly as written.',
    'Reply with the rewritten text only: no preamble, no quotes, no code fences, no explanation.',
    '<<<DICTATED',
    text,
    'DICTATED>>>',
  ].join('\n\n')
}

/** The one line shown after a rewrite. */
export function rewriteLine(before: string, after: string): string {
  const a = before.split(/\s+/).filter(Boolean).length
  const b = after.split(/\s+/).filter(Boolean).length
  return before.trim() === after.trim() ? 'already clear; text unchanged' : `rewritten as your reply: ${a} → ${b} words; read it before sending`
}

/** Strips what a model may wrap the text in: fences, the markers, surrounding quotes. */
export function cleanReply(reply: string): string {
  let t = reply.trim()
  const fence = t.match(/^```[\w-]*\n([\s\S]*?)\n?```$/)
  if (fence) t = fence[1]!.trim()
  t = t.replace(/^<<<DICTATED\s*/, '').replace(/\s*DICTATED>>>$/, '').trim()
  const q = t.match(/^(["'“‘])([\s\S]*)(["'”’])$/)
  // Only a quote pair around the whole reply, not `"a" and "b"`.
  if (q && pairs(q[1]!, q[3]!) && !q[2]!.includes(q[1]!) && !q[2]!.includes(q[3]!)) t = q[2]!.trim()
  return t
}

const pairs = (open: string, close: string) =>
  (open === '"' && close === '"') || (open === "'" && close === "'") || (open === '“' && close === '”') || (open === '‘' && close === '’')

const words = (s: string) => s.split(/\s+/).filter(Boolean)

/**
 * True when the reply looks like a rewrite of the text, not an answer to it: it may come out
 * shorter (filler cut) or a little longer (bracketed names, numbering), not a different length class.
 */
export function plausible(before: string, after: string): boolean {
  const a = words(before).length
  const b = words(after).length
  if (b === 0) return false
  return b >= Math.floor(a * 0.35) && b <= Math.ceil(a * 1.4) + 8
}

/** Word-level changes from `before` to `after`, each as "old → new". */
export function changes(before: string, after: string): string[] {
  const a = words(before)
  const b = words(after)
  const n = a.length
  const m = b.length
  // LCS table over words; prompts are short, so O(n·m) is fine.
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i]![j] = a[i] === b[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!)
    }
  }
  const out: string[] = []
  let del: string[] = []
  let ins: string[] = []
  const flush = () => {
    if (del.length || ins.length) {
      out.push(`${del.length ? del.join(' ') : '(nothing)'} → ${ins.length ? ins.join(' ') : '(removed)'}`)
    }
    del = []
    ins = []
  }
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      flush()
      i++
      j++
    } else if (j < m && (i === n || L[i]![j + 1]! >= L[i + 1]![j]!)) {
      ins.push(b[j++]!)
    } else {
      del.push(a[i++]!)
    }
  }
  flush()
  return out
}

/** The one line shown after a fix. */
export function summary(list: string[]): string {
  return list.length ? `fixed: ${list.join('; ')}` : 'no misheard words found; text unchanged'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'fix',
      description: 'Rewrite a dictated reply so Claude reads it as meant: misheard words fixed, answers in Claude\'s order, more concise. Fills the prompt box to review.',
      argumentHint: '<dictated text>',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'fix' }, async ($, e) => {
    let text = (e.args ?? '').trim()
    if (!text) {
      const draft = (await $.prompt.read()).text.trim()
      if (draft && !draft.startsWith('/')) text = draft
    }
    if (!text) return { text: USAGE }

    const r = await $.model.fork({ prompt: fixPrompt(text) })
    let fixed = text
    let line: string
    if (!r.isAnswered) {
      line = r.reason === 'nothing-to-fork'
        ? 'no conversation yet to read; text left as dictated'
        : `fix failed (${r.reason}); text left as dictated`
    } else {
      const reply = cleanReply(r.text)
      if (plausible(text, reply)) {
        fixed = reply
        line = rewriteLine(text, fixed)
      } else {
        line = 'the reply did not look like a rewrite; text left as dictated'
      }
    }

    const filled = await $.prompt.fill({ text: fixed })
    $.ui.toast(line, { timeoutMs: 8000 })
    return { text: filled.isFilled ? line : `${line}\n${fixed}` }
  })
}
