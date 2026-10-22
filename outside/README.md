# outside

`/outside [question]` asks a reviewer who has not been part of the conversation to read it and say what it sees.

Long sessions drift. You and Claude share the same context, so you tend to miss the same things: a question that never got answered, a decision taken without saying why, a loop around the same problem. `/outside` builds a digest of the session from your prompts and Claude's reply text (tool calls and their output left out, newest turns kept up to 60,000 characters) and sends it to Sonnet with no other history. The answer comes back in about 150 words.

- `/outside` asks the default question: what is this session trying to do, is it getting there, what looks off, and what would you do next?
- `/outside is the plan in the last reply sound?` asks your own question instead.

It is not a fork of the conversation (unlike `/btw`), so its cost scales with the digest, not with the session.

**Status:** used live in the Claude Code desktop app. Works in the terminal too.

## Install

```
claude plugin marketplace add bencsmartucph/ben-mods
claude plugin install outside@ben-mods
```
