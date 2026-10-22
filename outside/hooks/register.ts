// /outside [question]: an outside view of this session. Builds a digest from the transcript
// (your prompts and Claude's reply text; tool calls and their results dropped), keeps the most
// recent turns that fit the budget, and asks a model with no conversation history to review it.
// Cost scales with the digest, not the session. Unlike /btw, it is not a fork of this conversation.
import type { Register, SessionMessage } from 'claude-code'

const MODEL = 'sonnet'
const BUDGET = 60_000 // characters of digest sent, newest turns first
const PER_MESSAGE = 2_000 // a long reply is cut to its head
const DEFAULT_QUESTION = 'What is this session trying to do, is it getting there, and what looks off: drift, going in circles, questions left unanswered, decisions made without saying why? What would you do next?'

const SYSTEM = [
  'You are an outside reviewer of a working session between a user and an AI coding assistant.',
  'You see only what was said: the user\'s prompts and the assistant\'s replies. You do not see files, tool calls or their output, so do not guess at them.',
  'You have no stake in what was decided. Be direct and specific; quote short phrases from the digest when you point at something.',
  'Answer in at most 150 words, plain sentences, no preamble.',
].join(' ')

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)} […]` : s)

export function digest(msgs: readonly SessionMessage[], budget = BUDGET): { text: string; turns: number; dropped: number } {
  const lines: string[] = []
  for (const m of msgs) {
    const t = m.text.trim()
    if (!t) continue
    if (m.role === 'user') {
      if (t.startsWith('<') || m.toolResults?.length) continue
      lines.push(`USER: ${cut(t, PER_MESSAGE)}`)
    } else {
      lines.push(`ASSISTANT: ${cut(t, PER_MESSAGE)}`)
    }
  }
  const kept: string[] = []
  let size = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    if (size + lines[i].length > budget) break
    kept.unshift(lines[i])
    size += lines[i].length + 2
  }
  return { text: kept.join('\n\n'), turns: kept.filter(l => l.startsWith('USER:')).length, dropped: lines.length - kept.length }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({ name: 'outside', description: 'An outside reviewer reads a digest of this session and answers', argumentHint: '[question]', immediate: true })
    return r
  })

  on('command.run', { command: 'outside' }, async ($, e) => {
    const d = digest(await $.session.messages())
    if (!d.text) return { text: 'Nothing to review yet.' }
    const question = e.args.trim() || DEFAULT_QUESTION
    const r = await $.model.complete({
      model: MODEL,
      system: SYSTEM,
      prompt: `Session digest (oldest first${d.dropped ? `; ${d.dropped} earlier messages left out` : ''}):\n\n${d.text}\n\n---\nQuestion: ${question}`,
      maxTokens: 600,
      timeoutMs: 90_000,
    })
    const head = `outside view · ${d.turns} of your prompts · ${Math.round(d.text.length / 1000)}k chars · ${MODEL}`
    return { text: r.isAnswered ? `${head}\n\n${r.text.trim()}` : `${head}\n\nNo answer: ${r.reason}` }
  })
}
