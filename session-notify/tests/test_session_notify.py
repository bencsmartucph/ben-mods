"""Dry-run tests: pipe payloads into the script as a hook would; no toasts shown,
nothing spawned. LOCALAPPDATA points at a temp dir, so markers and the
desktop-app check never touch the real machine state.

Run: py -3 -I tests/test_session_notify.py
"""
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from xml.dom import minidom

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(os.path.dirname(HERE), "session_notify.py")
sys.path.insert(0, os.path.dirname(HERE))
import session_notify as sn  # noqa: E402

LOCAL = tempfile.mkdtemp()  # stands in for %LOCALAPPDATA%


def run(payload, env_extra=None):
    env = dict(os.environ, SESSION_NOTIFY_DRY_RUN="1", LOCALAPPDATA=LOCAL)
    env.pop("CLAUDE_CODE_HOST_SESSION_ID", None)
    env.update(env_extra or {})
    data = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
    p = subprocess.run([sys.executable, SCRIPT], input=data, capture_output=True, env=env, timeout=10)
    assert p.returncode == 0, p
    out = p.stdout.decode("utf-8").strip()
    return json.loads(out) if out else None


def transcript(lines):
    f = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False, encoding="utf-8")
    f.write("\n".join(json.dumps(x) for x in lines) + "\n")
    f.close()
    return f.name


ago = lambda s: (datetime.now(timezone.utc) - timedelta(seconds=s)).isoformat().replace("+00:00", "Z")
prompt = lambda s: {"type": "user", "origin": {"kind": "human"}, "timestamp": ago(s),
                    "message": {"content": "go"}}


def main():
    tp = transcript([
        {"type": "ai-title", "aiTitle": "old ai"},
        {"type": "custom-title", "customTitle": "My <Session> & 'co'"},
        {"type": "user", "message": "x" * 1000},
        {"type": "ai-title", "aiTitle": "newer ai"},
    ])
    base = {"session_id": "abc-123", "transcript_path": tp, "cwd": r"C:\repos\thesis"}
    long_tp = transcript([prompt(600)])
    short_tp = transcript([prompt(30)])
    host = {"CLAUDE_CODE_HOST_SESSION_ID": "local_9cc9cbe2-2dea-4e2b-a9fc-5682b25c0fa2"}
    link = "claude://resume?session=9cc9cbe2-2dea-4e2b-a9fc-5682b25c0fa2"

    # permission: the pending call's tool and description in the body when found
    t = run(dict(base, hook_event_name="Notification", notification_type="permission_prompt",
                 message="Claude needs your permission to use Bash"))
    assert t["title"] == "My <Session> & 'co'", t  # custom beats a later ai-title
    assert t["headline"] == "Permission", t
    assert t["body"] == "Claude needs your permission to use Bash", t  # call not in the tail
    assert (t["colour"], t["sticky"], t["url"], t["tag"]) == ("amber", True, None, "abc-123"), t
    assert t["aumid"] == sn.AUMID_PS, t  # no Claude package under the temp LOCALAPPDATA
    call = {"type": "assistant", "message": {"content": [
        {"type": "text", "text": "x"},
        {"type": "tool_use", "name": "Bash", "input": {"command": "git push", "description": "Push to origin"}}]}}
    perm_tp = transcript([prompt(10), call])
    t = run(dict(base, transcript_path=perm_tp, hook_event_name="Notification",
                 notification_type="permission_prompt", message="Claude needs your permission to use Bash"))
    assert t["body"] == "Bash · Push to origin", t
    wcall = {"type": "assistant", "message": {"content": [
        {"type": "tool_use", "name": "Write", "input": {"file_path": r"C:\Users\me\memory\notes.md"}}]}}
    write_tp = transcript([prompt(10), wcall])
    t = run(dict(base, transcript_path=write_tp, hook_event_name="Notification",
                 notification_type="permission_prompt", message="Claude needs your permission to use Write"))
    assert t["body"] == "Write · memory/notes.md", t  # a path shows as folder/file
    os.unlink(write_tp)
    assert sn.short_path("C:/a/b/c.py") == "b/c.py" and sn.short_path("c.py") == "c.py"
    done_call = {"type": "assistant", "message": {"content": [
        {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"description": "Old finished call"}}]}}
    result = {"type": "user", "toolUseResult": {}, "message": {"content": [
        {"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]}}
    stale_tp = transcript([prompt(10), done_call, result])
    t = run(dict(base, transcript_path=stale_tp, hook_event_name="Notification",
                 notification_type="permission_prompt", message="Claude needs your permission to use Bash"))
    assert t["body"] == "Claude needs your permission to use Bash", t  # answered call: not it
    os.unlink(stale_tp)
    t = run(dict(base, hook_event_name="Notification", notification_type="permission_prompt",
                 message="Permission needed"))
    assert t["headline"] == "Permission" and t["body"] == "Permission needed", t

    # Stop: a closing question is blue "Waiting on you", whatever the turn length
    ask = "Done the refactor.\n\nI found two callers.\nShould I update both, or just the CLI one?"
    for tpath in (short_tp, long_tp):
        t = run(dict(base, transcript_path=tpath, hook_event_name="Stop", last_assistant_message=ask), host)
        assert (t["need"], t["colour"], t["headline"]) == ("waiting", "blue", "Waiting on you"), t
        assert t["body"] == "Should I update both, or just the CLI one?", t
        assert not t["sticky"] and t["url"] == link, t
    # no question: green "Turn ended" only after MIN_TURN_SECONDS, or when the start is unknown
    done = "\n## Done: tests pass\n\nSee `x?y` and https://a.b/c?d=1"
    assert run(dict(base, transcript_path=short_tp, hook_event_name="Stop", last_assistant_message=done)) is None
    t = run(dict(base, transcript_path=long_tp, hook_event_name="Stop", last_assistant_message=done))
    assert (t["need"], t["colour"], t["headline"], t["body"]) == ("turn_end", "green", "Turn ended",
                                                                   "Done: tests pass"), t
    t = run(dict(base, hook_event_name="Stop", last_assistant_message="y" * 500))  # start unknown
    assert t["need"] == "turn_end" and len(t["body"]) == 120, t
    assert "completed" not in json.dumps(t).lower()

    # question heuristic, directly
    q = sn.question_line
    assert q("Fixed it.\n\nWant me to push?") == "Want me to push?"
    assert q("Is it ok?\n\nDone.") is None  # only the last paragraph counts
    assert q("Ran `ls *?`.") is None and q("See claude://resume?session=x") is None
    assert q("- **Which one?**") == "Which one?"
    assert q("Run this:\n\n```\nls ?x\n```") is None  # a closing code block asks nothing
    assert q("Run it now?\n\n```\nls\n```") == "Run it now?"
    assert q("") is None and q(None) is None

    # StopFailure: red, error in the headline, Claude Code's error text in the body
    t = run(dict(base, hook_event_name="StopFailure", error="rate_limit",
                 error_details="429 Too Many Requests", last_assistant_message="API Error: Rate limit reached"))
    assert (t["colour"], t["headline"], t["body"]) == ("red", "Failed: rate limit", "API Error: Rate limit reached"), t
    t = run(dict(base, hook_event_name="StopFailure", error="server_error", error_details="500"))
    assert t["body"] == "500", t

    # AskUserQuestion (PreToolUse): blue, sticky, first question's text
    aq = {"questions": [{"question": "Which backup mode?", "header": "Backup", "multiSelect": False,
                         "options": [{"label": "A", "description": "a"}]},
                        {"question": "second", "header": "x", "options": []}]}
    t = run(dict(base, hook_event_name="PreToolUse", tool_name="AskUserQuestion", tool_input=aq), host)
    assert (t["need"], t["colour"], t["sticky"], t["headline"], t["body"]) == (
        "ask_user", "blue", True, "Question", "Which backup mode?"), t
    assert run(dict(base, hook_event_name="PreToolUse", tool_name="Bash", tool_input={})) is None
    t = run(dict(base, hook_event_name="PreToolUse", tool_name="AskUserQuestion", tool_input={}))
    assert t["body"] == "Claude has a question", t

    no_title = transcript([{"type": "user"}])
    t = run(dict(base, transcript_path=no_title, hook_event_name="Notification",
                 notification_type="elicitation_dialog", message="Pick a repo"))
    assert t["title"] == "thesis" and t["headline"] == "Input requested", t  # folder fallback

    # silent: idle_prompt and other notification types, stop_hook_active, bad input
    for nt in ("idle_prompt", "auth_success", "agent_completed"):
        assert run(dict(base, hook_event_name="Notification", notification_type=nt, message="m")) is None, nt
    assert run(dict(base, hook_event_name="Stop", stop_hook_active=True)) is None
    for junk in (b"", b"not json", b"[1,2]", b"\xff\xfe"):
        assert run(junk) is None
    t = run(dict(base, hook_event_name="Stop"), {"CLAUDE_CODE_HOST_SESSION_ID": "local_bogus\"><x"})
    assert t["url"] is None, t

    # colour and stickiness by need
    for payload, colour, sticky in [
        (dict(hook_event_name="Notification", notification_type="permission_prompt"), "amber", True),
        (dict(hook_event_name="Notification", notification_type="elicitation_dialog"), "blue", True),
        (dict(hook_event_name="Notification", notification_type="agent_needs_input"), "blue", True),
        (dict(hook_event_name="PreToolUse", tool_name="AskUserQuestion"), "blue", True),
        (dict(hook_event_name="Stop", last_assistant_message="ok?"), "blue", False),
        (dict(hook_event_name="Stop"), "green", False),
        (dict(hook_event_name="StopFailure"), "red", False),
    ]:
        t = run(dict(base, message="m", **payload))
        assert (t["colour"], t["sticky"]) == (colour, sticky), (payload, t)

    # clearing: only with a marker; never for a subagent's tool call
    marker = os.path.join(LOCAL, "session-notify", "abc-123")
    for ev in ("UserPromptSubmit", "PostToolUse", "PostToolUseFailure"):
        assert run(dict(base, hook_event_name=ev)) == {"clear": "abc-123", "marker": False}, ev
    os.makedirs(os.path.dirname(marker), exist_ok=True)
    with open(marker, "w") as f:
        f.write(sn.AUMID_DESKTOP)
    for ev in ("UserPromptSubmit", "PostToolUse", "PostToolUseFailure"):
        assert run(dict(base, hook_event_name=ev, prompt="hi")) == {
            "clear": "abc-123", "marker": True, "group": "session-notify", "aumid": sn.AUMID_DESKTOP}, ev
    assert run(dict(base, hook_event_name="PostToolUse", agent_id="a1", agent_type="Explore")) is None
    assert os.path.isfile(marker)  # dry run deletes nothing
    s = sn.clear_script("abc-123", sn.AUMID_DESKTOP)
    assert "History.Remove('abc-123','session-notify','Claude_pzs8sxrjxfjjc!Claude')" in s, s

    # AUMID: the desktop app's when its package folder exists, else PowerShell's
    old = os.environ.get("LOCALAPPDATA")
    try:
        os.environ["LOCALAPPDATA"] = LOCAL
        assert sn.aumid() == sn.AUMID_PS
        os.makedirs(os.path.join(LOCAL, "Packages", "Claude_pzs8sxrjxfjjc"))
        assert sn.aumid() == sn.AUMID_DESKTOP == "Claude_pzs8sxrjxfjjc!Claude"
    finally:
        if old is None:
            os.environ.pop("LOCALAPPDATA", None)
        else:
            os.environ["LOCALAPPDATA"] = old
    t = run(dict(base, hook_event_name="Stop"))
    assert t["aumid"] == sn.AUMID_DESKTOP, t

    # escaping: the script must carry text only as escaped XML in a PS literal
    s = sn.toast_script({"title": "x", "headline": "a'b<c>&\"", "body": "b", "url": None, "tag": "t"})
    assert "a''b&lt;c&gt;&amp;\"" in s, s

    # turn stats: time since the last real prompt, distinct edited paths since it
    edit = lambda name, key, path: {"type": "assistant", "message": {"content": [
        {"type": "text", "text": "x"}, {"type": "tool_use", "name": name, "input": {key: path}}]}}
    stats_tp = transcript([
        {"type": "user", "origin": {"kind": "human"}, "timestamp": ago(900), "message": {"content": "old"}},
        edit("Write", "file_path", "C:/x/before.py"),                      # before the prompt: not counted
        {"type": "user", "origin": {"kind": "human"}, "timestamp": ago(252),
         "message": {"content": [{"type": "text", "text": "do it"}]}},
        edit("Edit", "file_path", "C:/x/a.py"),
        {"type": "user", "toolUseResult": {}, "timestamp": ago(200),
         "message": {"content": [{"type": "tool_result", "content": "ok"}]}},  # not a prompt
        {"type": "user", "isMeta": True, "timestamp": ago(150), "message": {"content": "meta"}},
        {"type": "user", "origin": {"kind": "peer"}, "timestamp": ago(120), "message": {"content": "peer"}},
        {"type": "user", "timestamp": ago(100), "message": {"content": "<system-reminder>x</system-reminder>"}},
        edit("Edit", "file_path", r"c:\x\A.py"),                     # same file, other spelling
        edit("MultiEdit", "file_path", "C:/x/b.py"),
        edit("NotebookEdit", "notebook_path", "C:/x/n.ipynb"),
        edit("Read", "file_path", "C:/x/r.py"),                            # reads don't count
    ])
    t = run(dict(base, transcript_path=stats_tp, hook_event_name="Stop"))
    assert re.fullmatch(r"thesis · 4m 1[2-9]s · 3 files", t["stats"]), t["stats"]
    t = run(dict(base, transcript_path=no_title, hook_event_name="Stop"))
    assert t["stats"] == "thesis", t  # no prompt in the tail: repo only
    now = datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)
    assert sn.stats_line("r", now - timedelta(seconds=42), {"a"}, now) == "r · 42s · 1 file"
    assert sn.stats_line("r", now - timedelta(seconds=3725), set(), now) == "r · 1h 02m"

    # repo = nearest folder holding .git, else the folder itself
    root = tempfile.mkdtemp()
    os.makedirs(os.path.join(root, "myrepo", ".git"))
    os.makedirs(os.path.join(root, "myrepo", "sub", "deep"))
    assert sn.repo_name(os.path.join(root, "myrepo", "sub", "deep")) == "myrepo"
    assert sn.repo_name(r"C:\nowhere\thesis") == "thesis"

    # XML: well-formed; no header or logo; dot + session + need in bold; reminder + buttons only when sticky
    t = run(dict(base, transcript_path=stats_tp, hook_event_name="Notification",
                 notification_type="permission_prompt", message="Allow <Bash> & co?"), host)
    doc = minidom.parseString(sn.toast_xml(t)).documentElement
    assert doc.getAttribute("scenario") == "reminder" and doc.getAttribute("launch") == link
    acts = [(a.getAttribute("content"), a.getAttribute("activationType"), a.getAttribute("arguments"))
            for a in doc.getElementsByTagName("action")]
    assert acts == [("Open", "protocol", link), ("Later", "system", "dismiss")], acts
    assert not doc.getElementsByTagName("header") and not doc.getElementsByTagName("image")
    texts = [(x.getAttribute("placement"), x.firstChild.data) for x in doc.getElementsByTagName("text")]
    assert texts == [("", "🟠 thesis · Permission"), ("", "Allow <Bash> & co?"),
                     ("attribution", t["stats"])], texts
    assert doc.getElementsByTagName("text")[1].getAttribute("hint-maxLines") == "2"
    assert doc.getElementsByTagName("audio")[0].getAttribute("silent") == "true"

    t = run(dict(base, hook_event_name="Notification", notification_type="elicitation_dialog", message="q"))
    doc = minidom.parseString(sn.toast_xml(t)).documentElement  # no link: Later only, still sticky
    assert doc.getAttribute("scenario") == "reminder" and not doc.hasAttribute("launch")
    assert [a.getAttribute("content") for a in doc.getElementsByTagName("action")] == ["Later"]

    t = run(dict(base, hook_event_name="Stop"), host)
    doc = minidom.parseString(sn.toast_xml(t)).documentElement  # turn ends fade normally
    assert not doc.hasAttribute("scenario") and not doc.getElementsByTagName("actions")
    assert doc.getAttribute("duration") == "long"
    texts = [(x.getAttribute("placement"), x.firstChild.data) for x in doc.getElementsByTagName("text")]
    assert texts == [("", "🟢 My <Session> & 'co' · Turn ended"), ("attribution", "thesis")], texts  # empty body: no line 2

    odd = dict(t, url='claude://x"<&>', title='s"<&>', headline="h", body="b", stats="x")
    doc = minidom.parseString(sn.toast_xml(odd)).documentElement  # attributes escaped too
    assert doc.getAttribute("launch") == 'claude://x"<&>'

    for p in (tp, long_tp, short_tp, perm_tp, no_title, stats_tp):
        os.unlink(p)
    print("ok")


if __name__ == "__main__":
    main()
