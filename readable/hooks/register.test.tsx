import { test, expect } from 'claude-code/testing'
import { subjectOf, wrapLines, boldLead, inlineOutput, linkify, pathOfFileHref, dividerLabel, duration, segments } from './register'

test('relative links become file links; web links stay', () => {
  const cwd = 'C:\\code\\project'
  expect(linkify('see [README](mods/README.md:56)', cwd)).toBe('see [README](file:///C:/code/project/mods/README.md)')
  expect(linkify('[x](https://github.com)', cwd)).toBe('[x](https://github.com)')
  expect(linkify('[d](C:\\Users\\me\\.claude)', cwd)).toBe('[d](file:///C:/Users/me/.claude)')
  expect(pathOfFileHref('file:///C:/Users/me/a%20b/x.md')).toBe('C:\\Users\\me\\a b\\x.md')
})

test('inline output for reads and searches', () => {
  expect(inlineOutput('Grep', { mode: 'content', content: 'a:1\nb:2', numLines: 2 })).toEqual(['a:1', 'b:2'])
  expect(inlineOutput('Grep', { mode: 'files_with_matches', filenames: ['x.md', 'y.md'] })).toEqual(['x.md', 'y.md'])
  expect(inlineOutput('Read', { type: 'text', file: { content: 'line1\nline2' } })).toEqual(['line1', 'line2'])
  expect(inlineOutput('Glob', null)).toEqual([])
})

test('opening a grep shows its lines under the tool line', async $ => {
  const ui = await $.ui.mount({
    plugin: 'readable', surface: 'terminal', component: 'ToolUse',
    props: { tool_use_id: 'g1', tool: 'Grep', input: { pattern: 'td' }, isRunning: false, isErrored: false, isInterrupted: false, output: { content: 'MEMORY.md:3: td cli' } } as never,
  })
  expect(await ui.find({ type: 'Text', text: /td cli/ })).toBeUndefined()
  await ui.press({ key: 'out-g1' })
  expect(await ui.find({ type: 'Text', text: /td cli/ })).toBeDefined()
  await ui.unmount()
})

test('bold lead only on plain prose', () => {
  expect(boldLead('All three calls worked. Bash printed it.')).toBe('**All three calls worked.** Bash printed it.')
  expect(boldLead('Done.')).toBe('**Done.**')
  expect(boldLead('# Heading\ntext.')).toBe('# Heading\ntext.')
  expect(boldLead('`code` first.')).toBe('`code` first.')
  expect(boldLead('- a list.')).toBe('- a list.')
})

test('press output opens the hidden result', async ($, on) => {
  on('ui.render', async ($$, e) => {
    const { Text } = $$.ui.resolve(e)
    return <Text>engine row</Text>
  })
  const use = await $.ui.mount({
    plugin: 'readable', surface: 'terminal', component: 'ToolUse',
    props: { tool_use_id: 't9', tool: 'Bash', input: { command: 'echo hi' }, isRunning: false, isErrored: false, isInterrupted: false, output: { stdout: 'hi' } } as never,
  })
  const result = await $.ui.mount({
    plugin: 'readable', surface: 'terminal', component: 'ToolResult',
    props: { tool_use_id: 't9', tool: 'Bash', output: { stdout: 'hi' }, isErrored: false } as never,
  })
  expect(await result.find({ type: 'Text', text: 'engine row' })).toBeUndefined()
  await use.press({ key: 'out-t9' })
  expect(await result.find({ type: 'Text', text: 'engine row' })).toBeDefined()
  await use.unmount()
  await result.unmount()
})

test('wrap keeps words whole and paragraphs apart', () => {
  expect(wrapLines('testing my new mods! Can you make a tool call', 20)).toEqual(['testing my new mods!', 'Can you make a tool', 'call'])
  expect(wrapLines('a\n\nb', 10)).toEqual(['a', '', 'b'])
  expect(wrapLines('abcdefghijkl', 5)).toEqual(['abcde', 'fghij', 'kl'])
})

test('subject picks the telling field and clips it', () => {
  expect(subjectOf({ command: 'td   project\nlist' })).toBe('td project list')
  expect(subjectOf({ file_path: 'C:/x/night_pass.py', limit: 5 })).toBe('C:/x/night_pass.py')
  expect(subjectOf({ command: 'x'.repeat(100) }, 10)).toBe('xxxxxxxxx…')
  expect(subjectOf(null)).toBe('')
})

test('prompt row draws the you bar on the terminal', async $ => {
  const ui = await $.ui.mount({
    plugin: 'readable', surface: 'terminal', component: 'UserMessage',
    props: { text: 'make the night pass skip Shopping List', origin: { kind: 'composer' }, isExpanded: false } as never,
  })
  expect(await ui.find({ type: 'Text', text: 'you' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /night pass/ })).toBeDefined()
  await ui.unmount()
})

test('tool row is one line, with an error note when it failed', async $ => {
  const ui = await $.ui.mount({
    plugin: 'readable', surface: 'terminal', component: 'ToolUse',
    props: { tool_use_id: 't1', tool: 'Bash', input: { command: 'python -V' }, isRunning: false, isErrored: true, isInterrupted: false } as never,
  })
  expect(await ui.find({ type: 'Text', text: /^Bash/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /python -V/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /error/ })).toBeDefined()
  await ui.unmount()
})

test('desktop is left alone', async ($, on) => {
  on('ui.render', async ($$, e) => {
    const { Text } = $$.ui.resolve(e)
    return <Text>engine row</Text>
  })
  const ui = await $.ui.mount({
    plugin: 'readable', surface: 'desktop', component: 'ToolUse',
    props: { tool_use_id: 't2', tool: 'Read', input: { file_path: 'a.md' }, isRunning: false, isErrored: false, isInterrupted: false, output: {} } as never,
  })
  expect(await ui.find({ type: 'Text', text: 'engine row' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Read$/ })).toBeUndefined()
  await ui.unmount()
})

test('turn divider label: time, length, tools, agents', () => {
  const at = new Date(2026, 9, 15, 14, 32).getTime()
  expect(dividerLabel(undefined)).toBe('')
  expect(dividerLabel({ text: 'x', at, tools: 0, agents: 0 })).toBe('14:32 · running')
  expect(dividerLabel({ text: 'x', at, ms: 72_000, tools: 6, agents: 1 })).toBe('14:32 · 1m 12s · 6 tools · 1 agent')
  expect(duration(48_000)).toBe('48s')
  expect(duration(3_725_000)).toBe('1h 02m')
})

test('reply splits into prose and closed code blocks', () => {
  const fence = '`'.repeat(3)
  const text = ['Run this:', fence + 'powershell', 'td today', fence, 'Then check.', fence + 'py', 'open'].join('\n')
  const segs = segments(text)
  expect(segs.map(s => s.kind)).toEqual(['prose', 'code', 'prose'])
  expect(segs[1]).toEqual({ kind: 'code', text: 'td today', lang: 'powershell' })
  expect(segs[2]!.text).toContain(fence + 'py')
})

test('a reply with a code block draws its language and a copy button', async ($, on) => {
  on('session.cwd', async () => ({ value: 'C:/repo' }))
  on('process.run', async () => ({ value: { stdout: 'C:/Users/me', stderr: '', code: 0 } }) as never)
  on('fs.exists', async () => ({ value: false }) as never)
  const fence = '`'.repeat(3)
  const ui = await $.ui.mount({
    plugin: 'readable', surface: 'terminal', component: 'AssistantMessage',
    props: { text: ['Done. Run it:', fence + 'powershell', 'td today', fence].join('\n') } as never,
  })
  expect(await ui.find({ type: 'Text', text: /^── claude ─/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /powershell/ })).toBeDefined()
  expect(await ui.find({ key: 'copy-1' })).toBeDefined()
  await ui.unmount()
})
