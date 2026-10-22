import { test, expect } from 'claude-code/testing'
import { digest } from './register'

const msgs = [
  { role: 'user', text: 'Find what mods can do on desktop', toolUses: [] },
  { role: 'assistant', text: '', toolUses: [{ tool: 'Bash', input: {} }] },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'x', text: 'huge output', isError: false }] },
  { role: 'assistant', text: 'Drawing on messages works; jumping does not.', toolUses: [] },
  { role: 'user', text: '<system-reminder>noise</system-reminder>', toolUses: [] },
  { role: 'user', text: 'Build /outside', toolUses: [] },
] as never

test('digest keeps prompts and reply text, drops tools and noise', () => {
  const d = digest(msgs)
  expect(d.text).toContain('USER: Find what mods can do on desktop')
  expect(d.text).toContain('ASSISTANT: Drawing on messages works')
  expect(d.text).not.toContain('huge output')
  expect(d.text).not.toContain('system-reminder')
  expect(d.turns).toBe(2)
})

test('digest keeps the newest turns within budget', () => {
  const d = digest(msgs, 60)
  expect(d.text).toContain('Build /outside')
  expect(d.text).not.toContain('Find what mods')
  expect(d.dropped).toBeGreaterThan(0)
})
