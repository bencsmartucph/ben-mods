// cache-dot: minutes left on the prompt cache, as a dot after the mode labels in the prompt
// footer (`◕ 47m`), so you know before you send whether the next message reads the cache or
// writes it again. Grey with time to spare, yellow under 10 min (under 2 min on a 5m TTL), red
// `○ cold` once expired: the colour logic of the author's statusline.
//
// The statusline reads Claude Code's own `prompt_cache` figures; a mod can't (no `$` method
// carries them, as of 2.1.301), so this estimates them the same way the engine does: the
// countdown restarts when a main-conversation request that read or wrote the cache is sent.
// A resumed session starts from SessionStart's `seconds_since_last_response`, and trusts its
// `prompt_cache_likely_expired`. TTL defaults to 1h (ENABLE_PROMPT_CACHING_1H=1); a model
// switch reports the real one.
//
// Structure (turn.step timing, SessionMode drawing, the draining glyphs) adapted from
// WQGGSEY's Cache TTL Timer 1.0.0, MIT, see LICENSE.
import type { Register } from 'claude-code'

type Ttl = '5m' | '1h'
const TTL_MS: Record<Ttl, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 }
const WARN_MS: Record<Ttl, number> = { '5m': 2 * 60_000, '1h': 10 * 60_000 } // statusline CACHE_SHOW_MIN
const GLYPHS = ['●', '◕', '◑', '◔']
const STYLE = { warm: { dimColor: true }, warn: { color: 'warning' }, cold: { color: 'error' } } as const

// Module state: reset by a --plugin-dir hot reload until the next request; an installed copy keeps it.
let lastHit: number | null = null // when the last cache-using main request was sent, $.clock ms
let cold = false // the engine or the last response says the cache is gone
let ttl: Ttl = '1h'
let drawn = ''

export type Readout = { level: 'warm' | 'warn' | 'cold'; text: string }

// Pure, so the tests can check the thresholds directly.
export function readout(hit: number | null, isCold: boolean, t: Ttl, now: number): Readout | null {
  if (hit === null && !isCold) return null // caching not observed yet: nothing to warn about
  const left = hit === null ? 0 : hit + TTL_MS[t] - now
  if (isCold || left <= 0) return { level: 'cold', text: '○ cold' }
  const minutes = left < 60_000 ? '<1m' : `${Math.floor(left / 60_000)}m`
  const glyph = GLYPHS[Math.min(GLYPHS.length - 1, Math.floor((1 - left / TTL_MS[t]) * GLYPHS.length))]
  return { level: left <= WARN_MS[t] ? 'warn' : 'warm', text: `${glyph} ${minutes}` }
}

// Context used, the statusline's context% (same figure: the window's used_percentage). Null before the
// first response, or if the engine can't say. Statusline colours: cyan, yellow from 60%, red from 85%.
const CTX_WARN = 60
const CTX_CRIT = 85
export function ctxStyle(pct: number) {
  return pct >= CTX_CRIT ? { color: 'error' } : pct >= CTX_WARN ? { color: 'warning' } : { color: 'cyan' }
}
async function contextPercent($: any): Promise<number | null> {
  try {
    const p = (await $.session.usage()).context?.percent
    return typeof p === 'number' ? Math.round(p) : null
  } catch {
    return null
  }
}

async function current($: any): Promise<Readout | null> {
  return readout(lastHit, cold, ttl, await $.clock.now())
}

async function tick($: any) {
  const r = await current($)
  const key = (r ? r.text : '') + '|' + (await contextPercent($))
  if (key === drawn) return
  drawn = key
  $.ui.invalidate('ui.render')
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    $.clock.every(10_000, () => tick($))
    return next(e)
  })

  // Each request to the model; a subagent caches its own prefix, so only the main loop counts.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    const sentAt = await $.clock.now()
    const result = yield* next(e)
    const u = result.usage
    if (u) {
      // As the engine's summary: warm only if the last response read or wrote the cache.
      if (u.cache_read_input_tokens + u.cache_creation_input_tokens > 0) {
        lastHit = Math.max(lastHit ?? 0, sentAt)
        cold = false
      } else if (lastHit !== null) {
        cold = true
      }
      await tick($)
    }
    return result
  })

  // Startup, /resume, /clear, compaction.
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear') {
      lastHit = null
      cold = false
    } else if (e.source === 'compact') {
      cold = lastHit !== null // the next message writes the compacted prompt afresh
    } else if (typeof e.seconds_since_last_response === 'number') {
      lastHit = (await $.clock.now()) - e.seconds_since_last_response * 1000
      cold = e.prompt_cache_likely_expired === true
    }
    await tick($)
    return next(e)
  })

  // A model switch is the one hook input that names the TTL in use.
  on('classic.PostModelSwitch', async ($, e, next) => {
    if (e.cache_ttl === '5m' || e.cache_ttl === '1h') ttl = e.cache_ttl
    await tick($)
    return next(e)
  })

  // The dim mode labels at the right of the prompt footer: keep them, then the dot and context %.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const r = await current($)
    const pct = await contextPercent($)
    if (!r && pct === null) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const sep = () => Text({ dimColor: true, children: [' · '] })
    const parts: any[] = []
    if (r) parts.push(Text({ ...STYLE[r.level], children: [r.text] }))
    if (pct !== null) parts.push(...(parts.length ? [sep()] : []), Text({ ...ctxStyle(pct), children: [`${pct}%`] }))
    const mine = parts.length === 1 ? parts[0] : Box({ flexDirection: 'row', alignItems: 'center', children: parts })
    if (e.props.modes.length === 0) return mine
    const theirs = await next(e)
    return Box({ flexDirection: 'row', alignItems: 'center', children: [theirs, sep(), mine] })
  })
}
