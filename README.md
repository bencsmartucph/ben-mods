# ben-mods

Claude Code mods I built for my own work, published as a plugin marketplace.

A **mod** is a Claude Code plugin whose hooks are TypeScript functions rather than shell commands. It runs inside Claude Code (2.1.287 or later), so it can add slash commands, ask a model a side question, and draw on the transcript: your prompts, Claude's replies, tool rows and the prompt footer. See the [mods documentation](https://code.claude.com/docs/en/plugins/mods/overview).

## Install

```
claude plugin marketplace add bencsmartucph/ben-mods
claude plugin install outside@ben-mods
```

Swap `outside` for any mod in the table. Turn one off again with `/plugin`, or remove it with `claude plugin uninstall <mod>@ben-mods`. To try a mod for one session without installing it, clone this repo and run `claude --plugin-dir <path-to-mod>`.

## The mods

| Mod | What it does | Where | Tried live? |
|---|---|---|---|
| [`outside`](outside/) | `/outside [question]`: a second reviewer that has not been part of the conversation. A digest of your prompts and Claude's replies (no tool calls) goes to Sonnet with no history, and it answers in about 150 words: what the session is doing, whether it is getting there, what looks off. | terminal and desktop | yes |
| [`backlog`](backlog/) | `/backlog [label]`: the repo's open GitHub issues as a working board. Issues labelled `desktop` or `terminal` get columns of their own, the rest group by label; each issue links to GitHub, press one to read it, and "work on it" fills the prompt. | terminal and desktop | terminal list yes; desktop board not yet seen |
| [`readable`](readable/) | A calmer terminal transcript: a bar on each of your prompts, one dim line per tool call, a label above Claude's replies, file paths as links, code blocks with a language header. | terminal, Windows | yes, except file links and code headers |
| [`dictation`](dictation/) | `/fix <text>`: rewrites a dictated reply using the conversation, so misheard names are fixed and answers line up with Claude's numbered questions. Fills the prompt box for you to check. | terminal and desktop | not yet; unit tests only |
| [`cache-dot`](cache-dot/) | `◕ 47m` in the prompt footer: an estimate of the minutes left on the prompt cache, yellow under 10 minutes, red when cold, with the context window's % used beside it. | terminal and desktop | yes |
| [`session-notify`](session-notify/) | A Windows toast per session saying which session needs you and why (permission, a question, finished, failed), cleared when you answer. | Windows | yes |

"Tried live" means I have used it in a real session. Every mod's own tests pass (`claude plugin test <mod>`; session-notify's are in Python).

## Credits

- `cache-dot` adapts the structure of WQGGSEY's Cache TTL Timer (MIT). Its licence is in [`cache-dot/LICENSE`](cache-dot/LICENSE).
- `session-notify` adapts title recovery and the toast script from cc-notify 1.18.0 (MIT). Its licence is in [`session-notify/LICENSE-cc-notify`](session-notify/LICENSE-cc-notify).
- The file links in `readable` follow the idea of kiankhooban/open-paths (MIT); the code is new.

## Licence

MIT, see [LICENSE](LICENSE).
