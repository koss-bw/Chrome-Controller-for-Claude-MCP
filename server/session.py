"""Drives a headless Claude Code process and normalizes its output.

One subprocess per turn, resumed by session id: the first turn passes
--session-id <uuid4>, every later turn passes --resume <same uuid>. Claude Code
rehydrates context from its own session file, so this module holds no
conversation state — only the id.

The event shapes below were captured from claude 2.1.222 with:

    echo "<prompt>" | claude -p --output-format stream-json \\
        --include-partial-messages --verbose

Verified emissions, in the order a tool-using turn produces them:

    {"type":"system","subtype":"init", session_id, model, cwd, tools,
                                       mcp_servers:[{name,status}], ...}
    {"type":"rate_limit_event","rate_limit_info":{"status":"allowed",...}}
    {"type":"system","subtype":"status","status":"requesting"}
    {"type":"stream_event","event":{"type":"message_start", ...}}
    {"type":"stream_event","event":{"type":"content_block_start",
                                    "content_block":{"type":"tool_use"|"text", ...}}}
    {"type":"stream_event","event":{"type":"content_block_delta",
                                    "delta":{"type":"text_delta","text":...}
                                          | {"type":"input_json_delta","partial_json":...}}}
    {"type":"assistant","message":{...complete Anthropic message...}}
    {"type":"user","message":{"content":[{"type":"tool_result", ...}]},
                   "tool_use_result":{...}}
    {"type":"result","subtype":"success", result, session_id,
                     total_cost_usd, num_turns, duration_ms, is_error, ...}

Two things that are easy to get wrong and cost real debugging time:

  * --allowedTools is variadic ("<tools...>"), so a positional prompt after it
    is swallowed as a tool name and the CLI then blocks waiting on stdin. The
    prompt is written to stdin instead, which sidesteps quoting entirely.
  * There is no [DONE] sentinel. The stream ends at the "result" event, and the
    process exits shortly after.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import signal
import uuid
from typing import AsyncIterator

from . import config

# session_id -> live process, so /interrupt can reach it.
_ACTIVE: dict[str, asyncio.subprocess.Process] = {}


class ClaudeNotFound(RuntimeError):
    """The `claude` executable is not on PATH."""


def claude_path() -> str:
    path = shutil.which("claude")
    if not path:
        raise ClaudeNotFound("`claude` is not on PATH — is Claude Code installed?")
    return path


def build_argv(cfg: dict, session_id: str, resume: bool, model: str | None) -> list[str]:
    argv = [
        claude_path(),
        "-p",
        "--output-format", "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--permission-mode", cfg["permission_mode"],
        "--model", model or cfg["model"],
    ]
    append = (cfg.get("system_prompt_append") or "").strip()
    if append:
        argv += ["--append-system-prompt", append]
    # Keep --allowedTools last among the variadic flags, and never append a
    # positional prompt after it (see module docstring).
    allowed = cfg.get("allowed_tools") or []
    if allowed:
        argv += ["--allowedTools", *allowed]
    argv += ["--resume", session_id] if resume else ["--session-id", session_id]
    return argv


async def probe_slash_commands(cfg: dict, cwd: str) -> dict:
    """Ask the CLI which slash commands exist in `cwd`, without running a turn.

    The init event carries the full list and is emitted before the model is
    called at all, so this spawns a turn, reads until init, and kills the child
    there. That costs a process and ~2s and zero tokens — the alternative is
    globbing ~/.claude and .claude for command and skill files plus hardcoding
    the builtins, which is both more code and wrong the moment the CLI changes.

    The list is already scoped to what print mode can dispatch, so nothing here
    needs a REPL-only deny-list.
    """
    argv = [
        claude_path(),
        "-p",
        "--output-format", "stream-json",
        "--verbose",
        "--model", cfg["model"],
    ]
    proc = await asyncio.create_subprocess_exec(
        *argv,
        cwd=cwd,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        start_new_session=True,
    )
    try:
        # A prompt is required for the CLI to start up at all; it is never sent
        # anywhere, because the process dies at the init event.
        proc.stdin.write(b"noop")
        await proc.stdin.drain()
        proc.stdin.close()
        while True:
            line = await proc.stdout.readline()
            if not line:
                stderr = (await proc.stderr.read()).decode("utf-8", "replace").strip()
                raise RuntimeError(stderr or "claude exited before reporting its commands")
            try:
                raw = json.loads(line)
            except json.JSONDecodeError:
                continue
            if raw.get("type") == "system" and raw.get("subtype") == "init":
                return {
                    "commands": raw.get("slash_commands") or [],
                    "skills": raw.get("skills") or [],
                    "cwd": raw.get("cwd") or cwd,
                }
    finally:
        if proc.returncode is None:
            _kill(proc)
        # Reap it, so a repeated probe doesn't accumulate zombies.
        await proc.wait()


def _text_of(content) -> str:
    """tool_result content is either a string or a list of blocks."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            b.get("text", "") for b in content
            if isinstance(b, dict) and b.get("type") == "text"
        )
    return ""


def normalize(raw: dict) -> dict | None:
    """Map one CLI event onto the panel-facing vocabulary.

    The panel never parses Anthropic block shapes; it only sees:
    init | text | tool | tool_input | tool_result | notice | done | error
    Returns None for events the panel has no use for.
    """
    kind = raw.get("type")

    # Subagent chatter carries a parent id. Keep it out of the main transcript
    # rather than interleaving it with the top-level answer.
    nested = raw.get("parent_tool_use_id") is not None

    if kind == "system":
        if raw.get("subtype") == "init":
            return {
                "t": "init",
                "session_id": raw.get("session_id"),
                "model": raw.get("model"),
                "cwd": raw.get("cwd"),
                "permission_mode": raw.get("permissionMode"),
                "mcp_servers": raw.get("mcp_servers") or [],
                # Every slash command this session can dispatch, already
                # filtered by the CLI to the ones print mode supports — the
                # REPL-only ones (/help, /status, /login, /permissions) are
                # absent from it. Forwarded so the panel's autocomplete stays
                # correct for free on every turn, without a second probe.
                "slash_commands": raw.get("slash_commands") or [],
                "skills": raw.get("skills") or [],
            }
        return None  # subtype "status" is progress noise

    if kind == "rate_limit_event":
        info = raw.get("rate_limit_info") or {}
        if info.get("status") != "allowed":
            return {"t": "notice", "text": f"Rate limit: {info.get('status')}"}
        return None

    if kind == "stream_event":
        if nested:
            return None
        ev = raw.get("event") or {}
        et = ev.get("type")
        if et == "content_block_delta":
            delta = ev.get("delta") or {}
            if delta.get("type") == "text_delta":
                return {"t": "text", "text": delta.get("text", "")}
            return None  # input_json_delta: args arrive complete on "assistant"
        if et == "content_block_start":
            block = ev.get("content_block") or {}
            if block.get("type") == "tool_use":
                # Emitted early so a chip can appear before args finish
                # streaming; "tool_input" fills them in.
                return {"t": "tool", "id": block.get("id"), "name": block.get("name")}
        return None

    if kind == "assistant":
        blocks = ((raw.get("message") or {}).get("content")) or []
        tools = [
            {"id": b.get("id"), "name": b.get("name"), "input": b.get("input") or {}}
            for b in blocks
            if isinstance(b, dict) and b.get("type") == "tool_use"
        ]
        if tools:
            return {"t": "tool_input", "tools": tools, "nested": nested}
        return None  # text already streamed as deltas

    if kind == "user":
        blocks = ((raw.get("message") or {}).get("content")) or []
        results = [
            {
                "id": b.get("tool_use_id"),
                "is_error": bool(b.get("is_error")),
                "text": _text_of(b.get("content")),
            }
            for b in blocks
            if isinstance(b, dict) and b.get("type") == "tool_result"
        ]
        if results:
            return {"t": "tool_result", "results": results, "nested": nested}
        return None

    if kind == "result":
        return {
            "t": "done",
            "session_id": raw.get("session_id"),
            "result": raw.get("result"),
            "is_error": bool(raw.get("is_error")),
            "subtype": raw.get("subtype"),
            "num_turns": raw.get("num_turns"),
            "duration_ms": raw.get("duration_ms"),
            "cost_usd": raw.get("total_cost_usd"),
            "permission_denials": raw.get("permission_denials") or [],
        }

    return None


async def run_turn(
    prompt: str,
    session_id: str | None,
    model: str | None,
    cfg: dict,
) -> AsyncIterator[dict]:
    """Spawn one turn and yield normalized events until the process exits.

    Cancellation (client disconnect, /interrupt) propagates here as
    CancelledError; the finally block guarantees the child dies with it.
    """
    resume = session_id is not None
    sid = session_id or str(uuid.uuid4())
    argv = build_argv(cfg, sid, resume, model)

    proc = await asyncio.create_subprocess_exec(
        *argv,
        cwd=cfg["cwd"],
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        # Own process group, so terminate() reaches the whole tree rather than
        # orphaning MCP children.
        start_new_session=True,
    )
    _ACTIVE[sid] = proc

    # Tell the panel its session id immediately: on the first turn the CLI's
    # own init event is several seconds away, and the panel needs the id to be
    # able to interrupt.
    yield {"t": "accepted", "session_id": sid}

    try:
        proc.stdin.write(prompt.encode("utf-8"))
        await proc.stdin.drain()
        proc.stdin.close()

        saw_result = False
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            line = line.strip()
            if not line:
                continue
            try:
                raw = json.loads(line)
            except json.JSONDecodeError:
                # Non-JSON on stdout is a CLI bug or a version skew. Surface it
                # rather than dropping it silently.
                yield {"t": "error", "text": f"unparseable line: {line[:200]!r}"}
                continue
            event = normalize(raw)
            if event is not None:
                if event["t"] == "done":
                    saw_result = True
                yield event

        code = await proc.wait()
        if not saw_result:
            stderr = (await proc.stderr.read()).decode("utf-8", "replace").strip()
            yield {
                "t": "error",
                "text": stderr or f"claude exited {code} without producing a result",
            }
    finally:
        _ACTIVE.pop(sid, None)
        if proc.returncode is None:
            _kill(proc)


def _kill(proc: asyncio.subprocess.Process) -> None:
    """Terminate the process group; never raise from a cleanup path."""
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            proc.terminate()
        except ProcessLookupError:
            pass


def interrupt(session_id: str) -> bool:
    """Kill the live turn for a session. True if there was one."""
    proc = _ACTIVE.get(session_id)
    if proc is None or proc.returncode is not None:
        return False
    _kill(proc)
    return True


def active_sessions() -> list[str]:
    return list(_ACTIVE)
