# readable

A calmer Claude Code terminal transcript, in three levels: your prompt, Claude's reply, and the tool calls in between, each easy to tell apart at a glance.

- **Your prompts** get a `▌ you` bar and a rule above them, labelled with the turn's start time, its length and how many tools and agents it used.
- **Tool calls** are one dim line each, with a status dot. In Claude Code's fullscreen layout (`/tui fullscreen`) the whole line is clickable and shows the output; Read, Grep and Glob output shows inline.
- **Claude's replies** get a `claude` label and a bold first sentence.
- **File paths** in replies become links when the file exists: code opens in VS Code at the line, documents in their default app, programs are only shown in Explorer, never run.
- **Code blocks** get a language header and a copy button.

ctrl+o still shows Claude Code's stock view. Colours are ANSI names, so they follow your terminal's colour scheme.

Windows only: path handling and links assume Windows paths and Explorer. Draws in the terminal, not in the desktop app.

**Status:** in daily use. File links and code headers are the newest parts and haven't been tried live yet.

## Install

```
claude plugin marketplace add bencsmartucph/ben-mods
claude plugin install readable@ben-mods
```
