import { test, expect, mock } from 'claude-code/testing'
import { group, asText, keyOf, prefill, toIssue, excerpt, age, whyNoRepo } from './register'

const NOW = Date.parse('2026-10-09T12:00:00Z')
const DAY = 86_400_000
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

const GH = [
  { number: 15, title: 'Pane for the night pass', labels: [{ name: 'mods' }, { name: 'ui' }], body: 'Show the pass.', createdAt: iso(3 * DAY), comments: [{}, {}] },
  { number: 12, title: 'Backlog command', labels: [{ name: 'mods' }], body: 'line1\r\nline2\nline3\nline4\nline5\nline6\nline7', createdAt: iso(5 * 3_600_000), comments: [] },
  { number: 7, title: 'Thesis figures', labels: [{ name: 'thesis' }], body: '', createdAt: iso(40 * DAY), comments: [{}] },
  { number: 3, title: 'Loose idea', labels: [], body: '', createdAt: iso(400 * DAY), comments: [] },
]
const ISSUES = GH.map(toIssue)

const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const fail = (stderr: string) => ({ value: { exitCode: 1, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } })

test('groups by first label, unlabelled last, and filters by label', () => {
  expect(group(ISSUES, '').map(g => g.label)).toEqual(['mods', 'thesis', 'no label'])
  expect(group(ISSUES, '')[0]?.issues.map(i => i.number)).toEqual([12, 15])
  expect(group(ISSUES, 'UI').map(g => g.label)).toEqual(['ui'])
  expect(group(ISSUES, 'nope')).toEqual([])
  expect(keyOf('  Mods ')).toBe('mods')
  expect(prefill('octo/x', 12, 'Backlog command')).toBe('Work on octo/x#12: Backlog command')
})

test('surface labels get columns first, other labels after, unlabelled last', () => {
  const mk = (number: number, labels: string[]) => toIssue({ number, title: `t${number}`, labels: labels.map(name => ({ name })) })
  const gs = group([mk(1, ['mods', 'terminal', 'desktop']), mk(2, ['mods', 'desktop']), mk(3, ['bug']), mk(4, ['mods']), mk(5, []), mk(6, ['Terminal'])], '')
  expect(gs.map(g => g.label)).toEqual(['desktop + terminal', 'desktop', 'terminal', 'bug', 'mods', 'no label'])
  expect(gs[2]?.issues.map(i => i.number)).toEqual([6])
  expect(group([mk(1, ['mods', 'desktop'])], 'mods').map(g => g.label)).toEqual(['mods'])
})

test('issue fields: excerpt, age, comments', () => {
  expect(excerpt('\n\na\nb', 6)).toBe('a\nb')
  expect(ISSUES[1]?.excerpt).toBe('line1\nline2\nline3\nline4\nline5\nline6\n…')
  expect(ISSUES[0]?.comments).toBe(2)
  expect(age(5 * 60_000)).toBe('5m')
  expect(age(3 * DAY)).toBe('3d')
  expect(age(90 * DAY)).toBe('3mo')
  expect(age(400 * DAY)).toBe('1y')
})

test('model text is one line per issue, no bodies', () => {
  const text = asText({ repo: 'octo/x', groups: group(ISSUES, '') }, '', NOW)
  expect(text.split('\n')[0]).toBe('octo/x: 4 open issues')
  expect(text).toContain('  #12 Backlog command (5h)')
  expect(text).toContain('  #15 Pane for the night pass (3d · 2 comments)')
  expect(text).not.toContain('line1')
})

async function listed($: any, on: any, isFilled: boolean) {
  mock.clock(on, { now: NOW })
  on('process.run', async (_$: unknown, e: { argv: string[] }) =>
    e.argv[1] === 'repo' ? ok('octo/project\n') : ok(JSON.stringify(GH)))
  const filled: string[] = []
  on('prompt.fill', async (_$: unknown, e: { text: string }) => {
    filled.push(e.text)
    return isFilled ? { isFilled: true } : { isFilled: false, reason: 'no_composer' }
  })
  const r = await $.command.run({ command: 'backlog', args: 'mods' })
  return { text: String(r.text ?? ''), filled }
}

test('rows expand, collapse and work on it fills the prompt, on terminal and desktop', async ($, on) => {
  const { text, filled } = await listed($, on, true)
  expect(text.split('\n')[0]).toBe('octo/project: 2 open issues labelled mods')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'backlog', surface, component: 'CommandOutput',
      // The engine shows a plugin's answer under its name; the drawing copes either way.
      props: { command: 'backlog', args: 'mods', text: (surface === 'terminal' ? 'backlog: ' : '') + text, isErrored: false } as never,
    })
    expect(await ui.find({ type: 'Text', text: '[ui]' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '3d · 2 comments' })).toBeDefined()
    expect(await ui.find({ key: 'i-7' })).toBeUndefined()
    expect(await ui.find({ key: 'w-12' })).toBeUndefined()
    await ui.press({ key: 'i-12' })
    expect(await ui.find({ key: 'b-12' })).toBeDefined()
    expect(await ui.find({ key: 'b-15' })).toBeUndefined()
    await ui.press({ key: 'w-12' })
    expect(filled.at(-1)).toBe('Work on octo/project#12: Backlog command')
    expect(await ui.find({ key: 'f-12' })).toBeUndefined()
    await ui.press({ key: 'i-12' })
    expect(await ui.find({ key: 'b-12' })).toBeUndefined()
    expect(await ui.find({ key: 'w-12' })).toBeUndefined()
    await ui.unmount()
  }
  expect(filled.length).toBe(2)
})

test('each issue links to GitHub and ↻ refetches in place', async ($, on) => {
  const FRESH = { number: 99, title: 'Fresh one', labels: [{ name: 'mods' }], body: '', createdAt: iso(60_000), comments: [] }
  let answer: 'old' | 'new' | 'down' = 'old'
  mock.clock(on, { now: NOW })
  on('process.run', async (_$: unknown, e: { argv: string[] }) =>
    answer === 'down' ? fail('HTTP 502')
      : e.argv[1] === 'repo' ? ok('octo/project\n')
        : ok(JSON.stringify(answer === 'new' ? [...GH, FRESH] : GH)))
  for (const surface of ['terminal', 'desktop'] as const) {
    answer = 'old'
    const r = await $.command.run({ command: 'backlog', args: 'mods' })
    const ui = await $.ui.mount({
      plugin: 'backlog', surface, component: 'CommandOutput',
      props: { command: 'backlog', args: 'mods', text: String(r.text ?? ''), isErrored: false } as never,
    })
    const drawn = async () => JSON.stringify(await ui.drawn())
    expect(await drawn()).toContain('https://github.com/octo/project/issues/12')
    expect(await drawn()).not.toContain('issues/99')
    answer = 'new'
    await ui.press({ key: 'refresh' })
    expect(await drawn()).toContain('issues/99')
    answer = 'down'
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Text', text: '↻ failed, showing the last list: gh issue list failed for octo/project (HTTP 502)' })).toBeDefined()
    expect(await drawn()).toContain('issues/99')
    await ui.unmount()
  }
})

test('where the prompt cannot be filled, the row shows the text to copy', async ($, on) => {
  const { text } = await listed($, on, false)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'backlog', surface, component: 'CommandOutput',
      props: { command: 'backlog', args: 'mods', text, isErrored: false } as never,
    })
    if (!(await ui.find({ key: 'w-15' }))) await ui.press({ key: 'i-15' })
    await ui.press({ key: 'w-15' })
    expect(await ui.find({ type: 'Text', text: 'Work on octo/project#15: Pane for the night pass' })).toBeDefined()
    await ui.unmount()
  }
})

test('no repo and GitHub not answering read differently', () => {
  expect(whyNoRepo('failed to run git: fatal: not a git repository (or any of the parent directories): .git')).toMatch(/^no GitHub repo here/)
  expect(whyNoRepo('no git remotes found')).toMatch(/^no GitHub repo here/)
  expect(whyNoRepo('HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login')).toBe("couldn't reach GitHub (HTTP 401: Bad credentials (https://api.github.com/graphql))")
  expect(whyNoRepo('error connecting to api.github.com')).toMatch(/^couldn't reach GitHub/)
})

test('outside a GitHub repo it answers one plain line', async ($, on) => {
  on('process.run', async () => fail('no git remotes found\nmore'))
  on('ui.render', async ($$, e) => {
    const { Text } = $$.ui.resolve(e)
    return <Text>engine row</Text>
  })
  const r = await $.command.run({ command: 'backlog' } as never)
  expect(r.text).toBe('no GitHub repo here (no git remotes found)')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'backlog', surface, component: 'CommandOutput',
      props: { command: 'backlog', args: '', text: r.text ?? '', isErrored: false } as never,
    })
    expect(await ui.find({ type: 'Text', text: 'engine row' })).toBeDefined()
    await ui.unmount()
  }
})
