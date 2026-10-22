import { test, expect } from 'claude-code/testing'
import type { On } from 'claude-code'
import { changes, cleanReply, plausible, summary } from './register'

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const RUN = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } }

test('changes lists word swaps', () => {
  expect(changes('make the night parse skip it', 'make the night parse skip it')).toEqual([])
  expect(changes('ask card about the night parse', 'ask Claude about the night pass')).toEqual(['card → Claude', 'parse → pass'])
  expect(changes('fix the order hook script', 'fix the AutoHotkey script')).toEqual(['order hook → AutoHotkey'])
  expect(summary([])).toMatch(/unchanged/)
  expect(summary(['card → Claude'])).toBe('fixed: card → Claude')
})

test('cleanReply and plausible', () => {
  expect(cleanReply('```\nask Claude\n```')).toBe('ask Claude')
  expect(cleanReply('"ask Claude"')).toBe('ask Claude')
  expect(cleanReply('"a" and "b"')).toBe('"a" and "b"')
  expect(plausible('ask card about it', 'ask Claude about it')).toBe(true)
  expect(plausible('ask card', 'Sure! Here is a long answer about what Claude can do for you today')).toBe(false)
})

function engine(on: On, draft: string, reply: string | null) {
  const seen = { forkPrompt: '', filled: [] as string[], toasts: [] as string[] }
  on('model.fork', async (_$, e) => {
    seen.forkPrompt = e.prompt
    return { value: reply === null ? { isAnswered: false, reason: 'nothing-to-fork' } : { isAnswered: true, text: reply, usage: USAGE } }
  })
  on('prompt.read', async () => ({ value: { text: draft, cursor: draft.length } }))
  on('prompt.fill', async (_$, e) => {
    seen.filled.push(e.text)
    return { isFilled: true }
  })
  on('ui.toast', async (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  return seen
}

test('/fix <text> fills the corrected text and lists the change', async ($, on) => {
  const seen = engine(on, '', 'make the night pass skip Shopping List')
  const r = await $.command.run({ command: 'fix', args: 'make the night parse skip Shopping List', ...RUN })
  expect(seen.forkPrompt).toContain('make the night parse skip Shopping List')
  expect(seen.filled).toEqual(['make the night pass skip Shopping List'])
  expect(seen.toasts).toEqual([expect.stringMatching(/^rewritten as your reply/)])
  expect(r.text).toMatch(/^rewritten as your reply/)
})

test('/fix with no argument fixes the draft in the box', async ($, on) => {
  const seen = engine(on, 'ask card to check it', 'ask Claude to check it')
  const r = await $.command.run({ command: 'fix', args: '', ...RUN })
  expect(seen.filled).toEqual(['ask Claude to check it'])
  expect(r.text).toMatch(/^rewritten as your reply/)
})

test('/fix with nothing anywhere says how to use it', async ($, on) => {
  const seen = engine(on, '', 'x')
  const r = await $.command.run({ command: 'fix', args: '', ...RUN })
  expect(r.text).toMatch(/Usage/)
  expect(seen.filled).toEqual([])
})

test('no conversation yet: text left as dictated, still filled', async ($, on) => {
  const seen = engine(on, '', null)
  const r = await $.command.run({ command: 'fix', args: 'ask card', ...RUN })
  expect(seen.filled).toEqual(['ask card'])
  expect(r.text).toMatch(/no conversation yet/)
})

test('an answer instead of a correction is not filled in', async ($, on) => {
  const seen = engine(on, '', 'Sure! Here is a long explanation of everything Claude can do for you today and more')
  const r = await $.command.run({ command: 'fix', args: 'ask card about it', ...RUN })
  expect(seen.filled).toEqual(['ask card about it'])
  expect(r.text).toMatch(/did not look like a rewrite/)
})
