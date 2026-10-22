import { describe, expect, mock, test } from 'claude-code/testing'
import { readout } from './register'

const MIN = 60_000
const START = Date.parse('2026-10-18T06:00:00Z')
const SURFACES = ['desktop', 'terminal'] as const
const CACHED = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, model: 'claude-opus-5-5' }
const UNCACHED = { ...CACHED, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const DOT = /^([●◕◑◔] (\d+m|<1m)|○ cold)$/

function world(on: any) {
  let usage: any = CACHED
  const clock = mock.clock(on, { now: START })
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('classic.SessionStart', () => ({}))
  on('classic.PostModelSwitch', () => ({}))
  on('ui.render', () => ({ type: 'engine', ref: 0 })) // Claude Code's own mode labels
  on('turn.step', async function* (_$: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage }
  })
  return { clock, setUsage: (u: any) => (usage = u) }
}

async function start($: any) {
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
}

async function step($: any, agentId?: string) {
  const s = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 2, ...(agentId ? { agentId } : {}) })
  for await (const _ of s) {
  }
  return s.result
}

const footer = ($: any, surface: string, modes: string[] = ['focus']) =>
  $.ui.mount({ plugin: 'cache-dot', surface, component: 'SessionMode', props: { modes } })

// The dot's text and props on each surface; the footer is text alone, no Svg on either.
async function dotOn($: any, surface: string, modes?: string[]) {
  const ui = await footer($, surface, modes)
  const t = await ui.find({ type: 'Text', text: DOT })
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  await ui.unmount()
  return t ? { text: String(t.text), props: t.props } : undefined
}

async function expectBoth($: any, text: string, style?: Record<string, unknown>) {
  for (const surface of SURFACES) {
    const d = await dotOn($, surface)
    expect(d?.text).toBe(text)
    if (style) expect(d?.props).toEqual(expect.objectContaining(style))
  }
}

describe('readout (statusline thresholds)', () => {
  test('1h: grey, yellow from 10 min left, <1m, cold', () => {
    expect(readout(START, false, '1h', START + 1000)).toEqual({ level: 'warm', text: '● 59m' })
    expect(readout(START, false, '1h', START + 13 * MIN)).toEqual({ level: 'warm', text: '● 47m' })
    expect(readout(START, false, '1h', START + 20 * MIN)).toEqual({ level: 'warm', text: '◕ 40m' })
    expect(readout(START, false, '1h', START + 50 * MIN - 1000)).toEqual({ level: 'warm', text: '◔ 10m' })
    expect(readout(START, false, '1h', START + 50 * MIN)).toEqual({ level: 'warn', text: '◔ 10m' })
    expect(readout(START, false, '1h', START + 59 * MIN + 30_000)).toEqual({ level: 'warn', text: '◔ <1m' })
    expect(readout(START, false, '1h', START + 60 * MIN)).toEqual({ level: 'cold', text: '○ cold' })
  })
  test('5m: yellow only under 2 min', () => {
    expect(readout(START, false, '5m', START + 2 * MIN)).toEqual({ level: 'warm', text: '◕ 3m' })
    expect(readout(START, false, '5m', START + 3 * MIN)).toEqual({ level: 'warn', text: '◑ 2m' })
  })
  test('nothing before caching is observed', () => {
    expect(readout(null, false, '1h', START)).toBeNull()
  })
})

describe('cache-dot in the footer', () => {
  test('draws nothing of its own before the first request', async ($, on) => {
    world(on)
    await start($)
    for (const surface of SURFACES) expect(await dotOn($, surface)).toBeUndefined()
  })

  test('counts down on both surfaces with the clock: grey, yellow, red cold', { timeoutMs: 30_000 }, async ($, on) => {
    const { clock } = world(on)
    await start($)
    await step($)
    await clock.advance(1000)
    await expectBoth($, '● 59m', { dimColor: true })
    await clock.set(START + 50 * MIN)
    await expectBoth($, '◔ 10m', { color: 'warning' })
    await clock.set(START + 59 * MIN + 30_000)
    await expectBoth($, '◔ <1m', { color: 'warning' })
    await clock.set(START + 60 * MIN + 1000)
    await expectBoth($, '○ cold', { color: 'error' })
    // The next cached request warms it again
    await step($)
    await expectBoth($, '● 60m', { dimColor: true })
  })

  test('keeps the mode labels and sits after them; stands alone when there are none', async ($, on) => {
    world(on)
    await start($)
    await step($)
    for (const surface of SURFACES) {
      const withModes = await footer($, surface, ['focus'])
      expect(await withModes.find({ type: 'Text', text: /^ · $/ })).toBeDefined()
      expect((await withModes.find({ type: 'Text', text: DOT }))?.text).toBe('● 60m')
      await withModes.unmount()
      const alone = await footer($, surface, [])
      expect(await alone.find({ type: 'Text', text: /^ · $/ })).toBeUndefined()
      expect((await alone.find({ type: 'Text', text: DOT }))?.text).toBe('● 60m')
      await alone.unmount()
    }
  })

  test("a subagent's request doesn't restart the countdown", async ($, on) => {
    const { clock } = world(on)
    await start($)
    await step($)
    await clock.advance(30 * MIN)
    await step($, 'agent-1')
    await expectBoth($, '◑ 30m')
    await step($)
    await expectBoth($, '● 60m')
  })

  test('a response with no cache tokens leaves it cold, as the statusline would', async ($, on) => {
    const w = world(on)
    await start($)
    await step($)
    w.setUsage(UNCACHED)
    await step($)
    await expectBoth($, '○ cold', { color: 'error' })
  })

  test('a resumed session starts from seconds_since_last_response', async ($, on) => {
    world(on)
    await start($)
    await $.classic.SessionStart({ hook_event_name: 'SessionStart', source: 'resume', seconds_since_last_response: 15 * 60, prompt_cache_likely_expired: false })
    await expectBoth($, '◕ 45m')
  })

  test("a resume the engine calls expired shows cold, whatever the arithmetic says", async ($, on) => {
    world(on)
    await start($)
    await $.classic.SessionStart({ hook_event_name: 'SessionStart', source: 'resume', seconds_since_last_response: 60, prompt_cache_likely_expired: true })
    await expectBoth($, '○ cold')
  })

  test('/clear hides it until the next request; compaction makes it cold', async ($, on) => {
    world(on)
    await start($)
    await step($)
    await $.classic.SessionStart({ hook_event_name: 'SessionStart', source: 'compact' })
    await expectBoth($, '○ cold')
    await $.classic.SessionStart({ hook_event_name: 'SessionStart', source: 'clear' })
    for (const surface of SURFACES) expect(await dotOn($, surface)).toBeUndefined()
  })

  test('a model switch that reports a 5m TTL shortens the countdown', async ($, on) => {
    const { clock } = world(on)
    await start($)
    await step($)
    await $.classic.PostModelSwitch({ hook_event_name: 'PostModelSwitch', cache_ttl: '5m', prompt_cache_warm: true })
    await clock.advance(3 * MIN)
    await expectBoth($, '◑ 2m', { color: 'warning' })
  })
})

describe('context % beside the dot', () => {
  for (const surface of SURFACES) {
    test(`${surface}: shows the statusline's percent, coloured at 60 and 85`, async ($: any, on: any) => {
      world(on)
      let pct = 41
      on('session.usage', async () => ({ value: { startedAt: START, context: { tokens: 82_000, window: 200_000, percent: pct }, rateLimits: [] } }))
      await start($)
      await step($)
      const pctOf = async () => {
        const ui = await footer($, surface)
        const t = await ui.find({ type: 'Text', text: /^\d+%$/ })
        await ui.unmount()
        return t ? { text: String(t.text), props: t.props } : undefined
      }
      expect((await pctOf())?.text).toBe('41%')
      expect((await pctOf())?.props).toEqual(expect.objectContaining({ color: 'cyan' }))
      pct = 72
      expect((await pctOf())?.props).toEqual(expect.objectContaining({ color: 'warning' }))
      pct = 90
      expect((await pctOf())?.props).toEqual(expect.objectContaining({ color: 'error' }))
    })
  }
})
