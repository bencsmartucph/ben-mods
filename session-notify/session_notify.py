"""session-notify: a Windows toast that says which Claude Code session needs you, and why.

Hook script for Notification, Stop, StopFailure, PreToolUse (AskUserQuestion),
UserPromptSubmit, PostToolUse and PostToolUseFailure. Reads the hook payload on
stdin. One toast per session (tag = session id), laid out for a glance:

    app    "Claude" with its icon: posted under the desktop app's packaged AUMID
           when it is installed (%LOCALAPPDATA%\\Packages\\Claude_pzs8sxrjxfjjc),
           else under PowerShell's. A custom unpackaged AUMID is accepted by
           Windows but never displayed (found 2026-10-19), so v3 has none.
    bold   dot, session name, what it needs: "🟠 MODS_Terminal · Permission".
           Dot: amber = permission, blue = question / waiting on you, green =
           turn ended, red = failed. Name: latest custom-title, else latest
           ai-title in the transcript tail, else the folder name. Needs:
           "Permission", "Question", "Input requested", "Waiting on you",
           "Turn ended", "Failed: rate limit"
    line 2 the most useful sentence, at most 2 lines: the pending tool and what
           it is doing ("Write · memory/notes.md", "Bash · Push main"), the
           question, Claude's closing question, or the first line of its reply
    small  `repo · 4m 12s · 2 files`: time since the last real prompt, and
           distinct paths edited since it (Edit/Write/MultiEdit/NotebookEdit)
    layout no header row and no logo disc (v3.1: denser; v3 had both)
    click  claude://resume?session=<desktop row uuid>, only in desktop sessions
           (CLAUDE_CODE_HOST_SESSION_ID=local_<uuid>)
    sticky permission, elicitation, agent input and AskUserQuestion use
           scenario="reminder": the toast stays until acted on, with "Open"
           (when there is a link) and "Later". Others use duration="long" (~25 s)
    sound  none: left to your own hooks (<audio silent="true"/>)

Stop is honest: if the last paragraph of Claude's message asks something (a "?"
outside code spans and URLs) it is blue "Waiting on you" with that line;
otherwise green "Turn ended", shown only when the turn ran MIN_TURN_SECONDS or
more (or its start is unknown). Blue, amber and red always show.

Clearing: showing a toast writes a marker %LOCALAPPDATA%\\session-notify\\<session id>
holding the AUMID used. UserPromptSubmit, PostToolUse and PostToolUseFailure (you
answered, approved or typed) remove that session's toast from the notification
centre, but only spawn PowerShell when the marker exists; without one they read
stdin, check one file and exit. Tool calls inside a subagent (payload carries
agent_id) never clear.

Never blocks or breaks a session: one try around everything, every subprocess
has a timeout, exit code is always 0, and nothing is written to stdout (stdout
starting with "{" is read by Claude Code as a decision).

SESSION_NOTIFY_DRY_RUN=1 prints what would be shown or cleared (JSON) instead,
and spawns, writes and deletes nothing.

Title recovery and the WinRT toast script are adapted from cc-notify 1.18.0
(notify.py session_title() and windows_script()), MIT licence, copyright its
authors.
"""
import base64
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from xml.sax.saxutils import escape as xml_escape, quoteattr as xml_attr

MIN_TURN_SECONDS = 180  # a green "Turn ended" toast only after a turn at least this long
TAIL = 2 * 1024 * 1024  # bytes of transcript read from the end: titles sit near it,
# and a long turn's first prompt can be ~1 MB back (seen: 636 KB)
CAP = 120
POWERSHELL = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"  # 5.1: has the WinRT projection
UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
# The desktop app's packaged AUMID: toasts show as "Claude" with its icon.
CLAUDE_PACKAGE = "Claude_pzs8sxrjxfjjc"
AUMID_DESKTOP = CLAUDE_PACKAGE + "!Claude"
# PowerShell's own AUMID: lets an unpackaged script post toasts without registering one.
AUMID_PS = r"{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe"
GROUP = "session-notify"
NOTIFY_NEEDS = {"permission_prompt", "elicitation_dialog", "agent_needs_input"}
CLEAR_EVENTS = {"UserPromptSubmit", "PostToolUse", "PostToolUseFailure"}
# need -> colour of the dot that starts the bold line
COLOUR = {"permission_prompt": "amber", "elicitation_dialog": "blue", "agent_needs_input": "blue",
          "ask_user": "blue", "waiting": "blue", "turn_end": "green", "failed": "red"}
DOT = {"amber": "🟠", "blue": "🔵", "green": "🟢", "red": "🔴"}
HEADLINE = {"permission_prompt": "Permission", "elicitation_dialog": "Input requested",
            "agent_needs_input": "Waiting on you", "ask_user": "Question",
            "waiting": "Waiting on you", "turn_end": "Turn ended", "failed": "Failed"}
# scenario="reminder": stays until acted on
STICKY = {"permission_prompt", "elicitation_dialog", "agent_needs_input", "ask_user"}
EDIT_TOOLS = {"Edit": "file_path", "Write": "file_path", "MultiEdit": "file_path",
              "NotebookEdit": "notebook_path"}
# what a pending tool call is doing, most readable first
DETAIL_KEYS = ("description", "command", "file_path", "notebook_path", "url", "pattern", "query", "prompt")
PATH_KEYS = {"file_path", "notebook_path"}  # shown as folder/file
USER_RE = re.compile(r'"type":\s*"user"')
NOT_PROMPTS = ("<system-reminder>", "<task-notification>", "<local-command-stdout>",
               "<local-command-caveat>")
NOT_QUESTIONS = re.compile(r"`[^`]*`|\b\w+://\S+")  # a "?" in code or a URL asks nothing
CODE_FENCE_RE = re.compile(r"```.*?(```|$)", re.S)
TOOL_USE_ID_RE = re.compile(r'"tool_use_id":\s*"([^"]+)"')


def read_tail(path):
    """Lines of the last TAIL bytes of the transcript, or []."""
    if not path or not os.path.isfile(path):
        return []
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            if size > TAIL:
                f.seek(size - TAIL)
                f.readline()  # drop the partial line the seek landed in
            return f.read().decode("utf-8", "replace").splitlines()
    except Exception:
        return []


def session_title(lines):
    """Latest custom-title, else latest ai-title, from the transcript tail."""
    custom = ai = None
    for line in lines:
        if '"custom-title"' not in line and '"ai-title"' not in line:
            continue  # cheap filter before json.loads
        try:
            o = json.loads(line)
        except Exception:
            continue
        if not isinstance(o, dict):
            continue
        if o.get("type") == "custom-title" and o.get("customTitle"):
            custom = str(o["customTitle"])
        elif o.get("type") == "ai-title" and o.get("aiTitle"):
            ai = str(o["aiTitle"])
    return custom or ai


def is_prompt(o):
    """A prompt you typed: not a tool result, meta line, reminder or peer message."""
    if o.get("type") != "user" or o.get("isMeta") or o.get("isSidechain") or o.get("toolUseResult"):
        return False
    origin = o.get("origin")
    if isinstance(origin, dict) and origin.get("kind") != "human":
        return False
    c = (o.get("message") or {}).get("content")
    if isinstance(c, str):
        return bool(c.strip()) and not c.lstrip().startswith(NOT_PROMPTS)
    if isinstance(c, list):
        kinds = {b.get("type") for b in c if isinstance(b, dict)}
        return "tool_result" not in kinds and bool(kinds & {"text", "image"})
    return False


def parse_ts(s):
    try:
        t = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
        return t if t.tzinfo else t.replace(tzinfo=timezone.utc)
    except Exception:
        return None


def turn_stats(lines):
    """(start of the turn, distinct paths edited since). (None, None) when the
    last prompt is not in the tail: then the turn length is unknown."""
    start = files = None
    for line in lines:
        # cheap filters before json.loads: tool results and plain replies are most of the bytes
        if USER_RE.search(line):
            if '"tool_result"' in line:
                continue
        elif '"tool_use"' not in line or not any('"%s"' % n in line for n in EDIT_TOOLS):
            continue
        try:  # an odd line is skipped, never fatal
            o = json.loads(line)
            if not isinstance(o, dict):
                continue
            if is_prompt(o):
                start, files = parse_ts(o.get("timestamp")), set()
            elif files is not None and o.get("type") == "assistant" and not o.get("isSidechain"):
                for b in o["message"]["content"]:
                    if isinstance(b, dict) and b.get("type") == "tool_use" and b.get("name") in EDIT_TOOLS:
                        p = b["input"].get(EDIT_TOOLS[b["name"]])
                        if p:
                            files.add(os.path.normcase(os.path.normpath(str(p))))
        except Exception:
            continue
    return start, files


def pending_detail(lines, tool):
    """What the latest still-unanswered `tool` call in the transcript tail is
    doing (its description, command, path...), or "" when none is there: a
    call that already has a tool_result is never the one asking."""
    recent = lines[-400:]
    answered = set()
    for line in recent:
        if '"tool_result"' in line:
            answered.update(TOOL_USE_ID_RE.findall(line))
    needle = '"name":"%s"' % tool
    for line in reversed(recent):
        if needle not in line.replace('": "', '":"'):
            continue
        try:
            o = json.loads(line)
            for b in reversed(o["message"]["content"]):
                if (isinstance(b, dict) and b.get("type") == "tool_use" and b.get("name") == tool
                        and b.get("id") not in answered):
                    inp = b.get("input") or {}
                    for k in DETAIL_KEYS:
                        if isinstance(inp.get(k), str) and inp[k].strip():
                            return short_path(inp[k]) if k in PATH_KEYS else inp[k]
                    return ""
        except Exception:
            continue
    return ""


def short_path(p):
    """Parent folder and file name: C:/a/memory/notes.md -> memory/notes.md."""
    parts = [x for x in re.split(r"[/\\]", str(p)) if x]
    return "/".join(parts[-2:]) or str(p)


def duration(sec):
    sec = max(0, int(sec))
    if sec < 60:
        return "%ds" % sec
    if sec < 3600:
        return "%dm %02ds" % divmod(sec, 60)
    h, rem = divmod(sec, 3600)
    return "%dh %02dm" % (h, rem // 60)


def stats_line(repo, start, files, now=None):
    parts = [repo] if repo else []
    if start:
        parts.append(duration(((now or datetime.now(timezone.utc)) - start).total_seconds()))
    if files:
        parts.append("%d file%s" % (len(files), "" if len(files) == 1 else "s"))
    return " \u00b7 ".join(parts)


def repo_name(cwd):
    """Folder name of the nearest ancestor holding .git, else of cwd itself."""
    cwd = str(cwd or "").rstrip("/\\")
    try:
        d = os.path.abspath(cwd) if cwd else ""
        for _ in range(40):
            if not d or os.path.exists(os.path.join(d, ".git")):
                break
            parent = os.path.dirname(d)
            if parent == d:
                d = ""
                break
            d = parent
        if d:
            return os.path.basename(d.rstrip("/\\")) or d
    except Exception:
        pass
    return re.split(r"[/\\]", cwd)[-1]


def flatten(v):
    """Text from a string or a list of content blocks."""
    if isinstance(v, str):
        return v
    if isinstance(v, list):
        return "\n".join(flatten(b.get("text") if isinstance(b, dict) else b) for b in v)
    return ""


def clean_line(ln):
    return ln.strip().lstrip("#*-> ").rstrip("* ").strip()  # markdown markers off


def first_line(s):
    for ln in str(s or "").splitlines():
        ln = clean_line(ln)
        if ln:
            return ln
    return ""


def question_line(text):
    """The line of the last paragraph that asks something, or None. A paragraph
    asks when it has a "?" outside code spans and URLs."""
    text = CODE_FENCE_RE.sub("", str(text or ""))  # a closing code block asks nothing
    paras = [p for p in re.split(r"\n\s*\n", text) if p.strip()]
    if not paras:
        return None
    for ln in reversed(paras[-1].splitlines()):
        if "?" in NOT_QUESTIONS.sub("", ln):
            return clean_line(ln)
    return None


def cap(s, n=CAP):
    s = " ".join(str(s).split())
    return s if len(s) <= n else s[: n - 1].rstrip() + "\u2026"


def session_tag(d):
    """Session id made safe for a toast tag and a file name."""
    return re.sub(r"[^0-9A-Za-z-]", "", str(d.get("session_id") or ""))[:64] or "session-notify"


def classify(d, lines):
    """(need, headline, body) for this payload, or None when it gets no toast."""
    event = str(d.get("hook_event_name") or "")
    if event == "Notification":
        need = str(d.get("notification_type") or "")
        if need not in NOTIFY_NEEDS:
            return None
        msg = str(d.get("message") or "Claude Code needs you")
        head = HEADLINE[need]
        if need == "permission_prompt":
            m = re.search(r"\bto use (\S+)", msg)
            if m:
                tool = m.group(1).rstrip(".")
                detail = pending_detail(lines, tool)
                msg = tool + " · " + detail if detail else msg
        return need, head, msg
    if event == "PreToolUse":
        if d.get("tool_name") != "AskUserQuestion":
            return None
        try:
            q = d["tool_input"]["questions"][0]["question"]
        except Exception:
            q = ""
        return "ask_user", HEADLINE["ask_user"], str(q or "Claude has a question")
    if event in ("Stop", "StopFailure") and d.get("stop_hook_active"):
        return None  # a stop hook caused this continuation; not a real turn end
    if event == "Stop":
        text = flatten(d.get("last_assistant_message"))
        q = question_line(text)
        if q:
            return "waiting", HEADLINE["waiting"], q
        return "turn_end", HEADLINE["turn_end"], first_line(text)
    if event == "StopFailure":
        err = str(d.get("error") or "").replace("_", " ")
        head = "Failed: " + err if err else HEADLINE["failed"]
        body = first_line(flatten(d.get("last_assistant_message"))) or str(d.get("error_details") or "")
        return "failed", head, body
    return None


def deep_link():
    """claude://resume for this desktop row, or None outside the desktop app."""
    host = os.environ.get("CLAUDE_CODE_HOST_SESSION_ID", "")
    if host.startswith("local_") and UUID_RE.match(host[6:]):
        return "claude://resume?session=" + host[6:]
    return None


def aumid():
    """The desktop app's AUMID when it is installed, else PowerShell's."""
    local = os.environ.get("LOCALAPPDATA", "")
    if local and os.path.isdir(os.path.join(local, "Packages", CLAUDE_PACKAGE)):
        return AUMID_DESKTOP
    return AUMID_PS


def marker_path(tag):
    local = os.environ.get("LOCALAPPDATA", "")
    return os.path.join(local, "session-notify", tag) if local else None


def build(d, now=None):
    """Payload -> toast fields, or None when this event gets no toast."""
    lines = read_tail(d.get("transcript_path"))
    c = classify(d, lines)
    if not c:
        return None
    need, headline, body = c
    start, files = turn_stats(lines)
    now = now or datetime.now(timezone.utc)
    if need == "turn_end" and start and (now - start).total_seconds() < MIN_TURN_SECONDS:
        return None  # a short turn that just ended: you are probably still watching
    folder = re.split(r"[/\\]", str(d.get("cwd") or "").rstrip("/\\"))[-1]
    repo = repo_name(d.get("cwd")) or folder
    title = session_title(lines) or folder or "Claude Code"
    colour = COLOUR[need]
    return {
        "title": cap(title, 48),
        "headline": cap(headline, 64),
        "body": cap(body),
        "stats": cap(stats_line(repo, start, files, now), 80),
        "need": need,
        "colour": colour,
        "sticky": need in STICKY,
        "url": deep_link(),
        "tag": session_tag(d),
        "aumid": aumid(),
    }


def toast_xml(t):
    """Toast XML; every value is escaped (text with escape, attributes with quoteattr)."""
    url = t.get("url")
    attrs = ' scenario="reminder"' if t.get("sticky") else ' duration="long"'
    if url:
        attrs += ' activationType="protocol" launch=%s' % xml_attr(url)
    bold = " · ".join(x for x in (t.get("title"), t["headline"]) if x)
    dot = DOT.get(t.get("colour"))
    texts = "<text>%s</text>" % xml_escape(dot + " " + bold if dot else bold)
    if t.get("body"):
        texts += '<text hint-maxLines="2">%s</text>' % xml_escape(t["body"])
    if t.get("stats"):
        texts += '<text placement="attribution">%s</text>' % xml_escape(t["stats"])
    actions = ""
    if t.get("sticky"):
        # reminder only sticks with at least one button, so "Later" is always there
        actions = "<actions>%s%s</actions>" % (
            '<action content="Open" activationType="protocol" arguments=%s/>' % xml_attr(url)
            if url else "",
            '<action content="Later" activationType="system" arguments="dismiss"/>')
    return ('<toast%s><visual><binding template="ToastGeneric">%s</binding></visual>'
            '%s<audio silent="true"/></toast>' % (attrs, texts, actions))


def psq(s):
    """A single-quoted PowerShell literal (quote doubled)."""
    return "'" + str(s).replace("'", "''") + "'"


PS_TYPES = ("$ErrorActionPreference='Stop'\n"
            "[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]|Out-Null\n")


def toast_script(t, app_id=AUMID_PS):
    """PowerShell 5.1 script that shows the toast."""
    return PS_TYPES + (
        "[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime]|Out-Null\n"
        "$x=New-Object Windows.Data.Xml.Dom.XmlDocument\n"
        "$x.LoadXml(%s)\n"
        "$t=New-Object Windows.UI.Notifications.ToastNotification $x\n"
        "$t.Tag=%s\n"
        "$t.Group=%s\n"
        "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(%s).Show($t)\n"
        % (psq(toast_xml(t)), psq(t["tag"]), psq(GROUP), psq(app_id))
    )


def clear_script(tag, app_id):
    """PowerShell 5.1 script that removes this session's toast from the notification centre."""
    return PS_TYPES + "[Windows.UI.Notifications.ToastNotificationManager]::History.Remove(%s,%s,%s)\n" % (
        psq(tag), psq(GROUP), psq(app_id))


def run_ps(script):
    # -EncodedCommand (UTF-16LE base64), not -Command: the XML's double quotes
    # do not survive powershell.exe's command-line parsing.
    enc = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    subprocess.run(
        [POWERSHELL, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
         "-EncodedCommand", enc],
        timeout=8, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


def show(t):
    marker = marker_path(t["tag"])
    if marker:
        try:  # written first, so an answer that lands while PowerShell starts still clears
            os.makedirs(os.path.dirname(marker), exist_ok=True)
            with open(marker, "w", encoding="utf-8") as f:
                f.write(t["aumid"])
        except Exception:
            pass
    run_ps(toast_script(t, t["aumid"]))


def clear(d, dry):
    """Remove this session's toast when you are back. Cheap unless a marker exists."""
    if d.get("agent_id"):
        return None  # a subagent's tool call: you have not necessarily answered anything
    tag = session_tag(d)
    marker = marker_path(tag)
    if not marker or not os.path.isfile(marker):
        return {"clear": tag, "marker": False} if dry else None
    try:
        with open(marker, encoding="utf-8") as f:
            app_id = f.read().strip() or aumid()
    except Exception:
        app_id = aumid()
    if dry:
        return {"clear": tag, "marker": True, "group": GROUP, "aumid": app_id}
    try:
        os.remove(marker)  # first: of several concurrent clears, only one spawns PowerShell
    except Exception:
        return None
    run_ps(clear_script(tag, app_id))
    return None


def main():
    try:
        raw = sys.stdin.buffer.read() if sys.stdin else b""
        d = json.loads(raw.decode("utf-8", "replace")) if raw.strip() else {}
        if not isinstance(d, dict):
            return 0
        dry = bool(os.environ.get("SESSION_NOTIFY_DRY_RUN"))
        if d.get("hook_event_name") in CLEAR_EVENTS:
            out = clear(d, dry)
        else:
            out = build(d)
            if out and not dry:
                show(out)
                out = None
        if out and dry:
            sys.stdout.buffer.write((json.dumps(out, ensure_ascii=False) + "\n").encode("utf-8"))
            sys.stdout.flush()  # os._exit below skips the flush
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    try:
        main()
    finally:
        os._exit(0)
