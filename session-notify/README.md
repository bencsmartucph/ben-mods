# session-notify

A Windows toast for each Claude Code session that needs you, saying which session and why, so you can run several at once and only switch when one is waiting.

- **Bold line:** a coloured dot, the session's name and what it needs. Amber = permission, blue = a question or waiting on you, green = turn ended, red = failed.
- **Second line:** the detail that matters: the tool and what it is about to do ("Bash · Push to origin"), the question, or the first line of Claude's reply.
- **Small line:** repo, time since your last prompt, files edited.
- Permission prompts and questions stay until you act; the toast is removed as soon as you answer, approve or type in that session.
- A green "Turn ended" only appears after turns of 3 minutes or more, when you have probably looked away.
- In the desktop app, clicking the toast opens that session.

This is a classic hooks plugin (a Python script), not a TypeScript mod. It needs Windows 10 or 11 and Python 3 on the `py` launcher. To pin an interpreter instead, change `"command": "py"` in `hooks/hooks.json`. It never blocks a session: every error is swallowed and it always exits 0.

`SESSION_NOTIFY_DRY_RUN=1` prints what it would show instead of showing it. Tests: `py -3 -I tests/test_session_notify.py`. Layouts tried along the way are in [docs/options.md](docs/options.md).

**Status:** in daily use.

Title recovery and the toast script are adapted from cc-notify 1.18.0 (MIT). See [LICENSE-cc-notify](LICENSE-cc-notify).

## Install

```
claude plugin marketplace add bencsmartucph/ben-mods
claude plugin install session-notify@ben-mods
```
