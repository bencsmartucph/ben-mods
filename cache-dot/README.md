# cache-dot

A small dot in the prompt footer, after the mode labels, that tells you how long the prompt cache has left: `◕ 47m`.

The prompt cache makes the next message cheaper and faster, but only while it is warm. If it has gone cold, the next message pays to write it again. The dot answers "will this message hit the cache?" before you send it.

- Grey with time to spare, yellow under 10 minutes (under 2 minutes on a 5-minute cache), red `○ cold` once it has expired. The glyph drains as time passes.
- The context window's % used sits beside it, coloured at 60% and 85%.
- It appears after the first reply, once caching has been seen.

It is an estimate. No mod API exposes the statusline's cache figures, so the countdown restarts whenever a main-conversation request that read or wrote the cache is sent, and a resumed session starts from what Claude Code reports at start-up. The TTL defaults to 1 hour (`ENABLE_PROMPT_CACHING_1H=1`); a model switch reports the real one.

**Status:** used live in the desktop app.

Adapted from WQGGSEY's Cache TTL Timer 1.0.0 (MIT): the step timing, footer drawing and draining glyphs. See [LICENSE](LICENSE).

## Install

```
claude plugin marketplace add bencsmartucph/ben-mods
claude plugin install cache-dot@ben-mods
```
