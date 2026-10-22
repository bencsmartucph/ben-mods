# session-notify: options considered

Kept so later iterations start from what was tried. Ben picked v3.1 on 2026-10-19.

## Layout (tested live on Ben's screen, 2026-10-19)

| Option | What it looked like | Status |
|---|---|---|
| v3 | Large coloured disc (appLogoOverride), header row = session name, bold "Needs permission: Write", full path | replaced: too much empty space |
| B | No disc, emoji dot in bold, header row kept, folder/file | close; header row cost a line |
| C | One bold line only ("🟠 Write ideas.md") + small line | not picked: too little context |
| D | B with `hint-style="captionSubtle"` group for smaller text | not picked; whether Windows honours the style was never confirmed |
| **v3.1** | No disc, no header; bold "🟠 Session · Need"; detail ≤ 2 lines (folder/file for paths); small `repo · time · files`; Open / Later; non-sticky `duration="long"` | **current** |

Trade-off of no header: the notification centre stacks all toasts under one "Claude" group instead of one group per session. Putting `<header id=session>` back restores that.

## What Windows allows (ToastGeneric)

- Fixed: app name and icon row (comes from the AUMID), fonts, text size, colours, background.
- Ours: header row, bold first text, up to 2 more texts, attribution line, `hint-maxLines`, appLogoOverride (fixed size; drop it or keep it, it cannot be made smaller), hero/inline images, up to 5 buttons, input box / selection, progress bar, `duration` short/long, `scenario="reminder"` (sticky).
- Banner time for non-sticky toasts: about 5 s by default, 25 s with `duration="long"`; the system-wide value is Settings → Accessibility → Visual effects → "Dismiss notifications after" (Ben's to change).

## AUMID

- A custom unpackaged AUMID registered only in `HKCU\Software\Classes\AppUserModelId` is accepted but never displayed on Ben's machine (v2, tested 2026-10-19). Might work after a sign-out, or with a Start-menu shortcut carrying the AUMID; not pursued.
- Current: the desktop app's packaged AUMID `Claude_pzs8sxrjxfjjc!Claude` (shows "Claude" + icon), PowerShell's as fallback.

## Not built yet (follow-ups)

- **"Needs you" list**: the marker files in `%LOCALAPPDATA%\session-notify\` are already the list of sessions waiting on Ben; show them persistently (always-on-top strip, tray icon with a count, or a Command Palette entry), one row per session, click opens it. Stale markers (session closed without an answer) need an expiry.
- **Terminal click**: a CLI session's toast has no target; it could focus the right Windows Terminal window/tab.
- Turn the desktop app's "question" banners off once a v3 AskUserQuestion toast has been seen live.
