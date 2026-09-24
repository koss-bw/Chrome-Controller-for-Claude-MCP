"""FastAPI sidecar: bridges the extension side panel to a Claude Code session.

Run one worker only. Session-id -> subprocess state lives in this process, so a
second worker would route /interrupt to a process that does not own the child.
"""

from __future__ import annotations

import asyncio
import json
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import AsyncIterator

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import config, session

CFG = config.load()
TOKEN = config.load_or_create_token()

app = FastAPI(title="chrome-controller-mcp panel sidecar")

# Chrome extension ids are exactly 32 chars from [a-p]. This keeps ordinary web
# origins out; the token below is what actually authorizes a request.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^chrome-extension://[a-p]{32}$",
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "X-OCIC-Token", "X-OCIC-Client"],
)

# session_id -> last-used epoch seconds.
_SEEN: dict[str, float] = {}


def require_token(x_ocic_token: str | None = Header(default=None)) -> None:
    if x_ocic_token != TOKEN:
        raise HTTPException(status_code=401, detail="bad or missing X-OCIC-Token")


class ChatRequest(BaseModel):
    prompt: str = ""
    session_id: str | None = None
    command: str | None = None
    args: dict = Field(default_factory=dict)
    model: str | None = None
    # Overrides CFG["cwd"] for this turn only; the panel sends the session's
    # chosen directory (or omits it to use the server default). Resumed
    # sessions can switch directories turn to turn since each turn is its own
    # subprocess (see server/session.py's module docstring).
    cwd: str | None = None


class InterruptRequest(BaseModel):
    session_id: str


class BrowseDirectoryRequest(BaseModel):
    # Directory the native picker opens on; falls back to CFG["cwd"] if unset
    # or no longer a directory.
    start: str | None = None


@app.get("/health")
async def health() -> dict:
    """Unauthenticated on purpose — the panel calls it to decide whether the
    Code backend is available, before it has any reason to hold a token."""
    try:
        claude = session.claude_path()
    except session.ClaudeNotFound as exc:
        return {"ok": False, "error": str(exc)}
    return {
        "ok": True,
        "claude": claude,
        "cwd": CFG["cwd"],
        "model": CFG["model"],
        "permission_mode": CFG["permission_mode"],
        "allowed_tools": CFG["allowed_tools"],
    }


EXTENSION_ORIGIN = re.compile(r"^chrome-extension://[a-p]{32}$")


@app.get("/auth/bootstrap")
async def bootstrap(
    origin: str | None = Header(default=None),
    x_ocic_client: str | None = Header(default=None),
) -> dict:
    """Hand the token to the panel so it needs no setup.

    The gate is the custom X-OCIC-Client header, NOT the Origin header. An
    extension page with host permission for this URL gets a CORS bypass, so
    Chrome sends the request privileged and omits Origin entirely — requiring
    Origin would reject the one caller this is meant for.

    A custom header is the sound gate anyway: a web page cannot send one
    cross-origin without a successful preflight, and CORSMiddleware above only
    answers preflights from extension origins. The extension skips the preflight
    because of its host permission. That is the same mechanism protecting every
    other route via X-OCIC-Token.

    What this does not do is distinguish *this* extension from any other one the
    user has installed — the price of zero setup. `"bootstrap": false` in
    panel.json turns it off in favour of pasting the token by hand.
    """
    if not CFG.get("bootstrap", True):
        raise HTTPException(status_code=403, detail="bootstrap disabled; paste the token manually")
    if x_ocic_client != "panel" and not (origin and EXTENSION_ORIGIN.match(origin)):
        raise HTTPException(
            status_code=403,
            detail="bootstrap needs the X-OCIC-Client header or an extension Origin",
        )
    return {"token": TOKEN}


@app.get("/commands", dependencies=[Depends(require_token)])
async def commands() -> list[dict]:
    return config.load_commands()


# Slash commands are a property of a working directory (project .claude/ plus
# the user's own), and probing costs a subprocess, so results are cached per
# cwd. Short TTL rather than forever: /reload-skills and a new file on disk both
# change the answer, and 60s is short enough that nobody notices the staleness.
_SLASH_CACHE: dict[str, tuple[float, list[dict]]] = {}
_SLASH_TTL_S = 60

# Plumbing the CLI exposes but a person would never type.
_SLASH_HIDDEN = {"__remote-workflow", "workflow-launch-exec"}


@app.get("/slash-commands", dependencies=[Depends(require_token)])
async def slash_commands(cwd: str | None = None) -> dict:
    """Every slash command the CLI can dispatch in `cwd`, for the composer's
    autocomplete.

    The list comes from the CLI itself (see session.probe_slash_commands), so it
    covers builtins, bundled skills, user and project commands, and plugin
    commands, and it is already filtered to what print mode supports — the panel
    never offers a command that would answer "isn't available in this
    environment".
    """
    target = cwd or CFG["cwd"]
    if not Path(target).expanduser().is_dir():
        raise HTTPException(status_code=400, detail=f"not a directory: {target}")

    hit = _SLASH_CACHE.get(target)
    if hit and time.time() - hit[0] < _SLASH_TTL_S:
        return {"cwd": target, "commands": hit[1], "cached": True}

    try:
        probed = await session.probe_slash_commands(CFG, target)
    except session.ClaudeNotFound as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except (RuntimeError, OSError) as exc:
        raise HTTPException(status_code=502, detail=f"could not list commands: {exc}") from exc

    descriptions = config.command_descriptions(target)
    skills = set(probed["skills"])
    commands = [
        {"name": name, "skill": name in skills, "description": descriptions.get(name)}
        for name in sorted(probed["commands"])
        if name not in _SLASH_HIDDEN and not name.startswith("__")
    ]
    _SLASH_CACHE[target] = (time.time(), commands)
    return {"cwd": target, "commands": commands, "cached": False}


@app.get("/sessions", dependencies=[Depends(require_token)])
async def sessions() -> dict:
    active = set(session.active_sessions())
    return {
        "sessions": sorted(
            (
                {"session_id": sid, "last_used": ts, "running": sid in active}
                for sid, ts in _SEEN.items()
            ),
            key=lambda s: s["last_used"],
            reverse=True,
        )
    }


@app.post("/interrupt", dependencies=[Depends(require_token)])
async def interrupt(body: InterruptRequest) -> dict:
    return {"stopped": session.interrupt(body.session_id)}


PICKER_TITLE = "Working directory for Claude Code"
# A dialog left open shouldn't pin a worker thread forever.
PICKER_TIMEOUT_S = 300


def _picker_start_dir(start: str | None) -> Path:
    initial = Path(start or CFG["cwd"]).expanduser()
    return initial if initial.is_dir() else Path.home()


def _pick_macos(initial: Path) -> str | None:
    """Real Finder folder chooser via AppleScript.

    Preferred over tkinter on macOS for two reasons: it needs no dependency
    (Homebrew's Python ships without Tk, so `import tkinter` fails outright on
    a stock install), and it is the actual Finder dialog rather than a Tk
    imitation of one. `activate` is what stops it opening behind the browser.
    """
    script = (
        'tell application "System Events"\n'
        "  activate\n"
        f'  set chosen to choose folder with prompt "{PICKER_TITLE}" '
        f'default location POSIX file "{initial}"\n'
        "  return POSIX path of chosen\n"
        "end tell"
    )
    proc = subprocess.run(
        ["osascript", "-e", script],
        capture_output=True,
        text=True,
        timeout=PICKER_TIMEOUT_S,
    )
    if proc.returncode != 0:
        # -128 is the documented "user cancelled" code; anything else is real.
        if "-128" in proc.stderr or "User canceled" in proc.stderr:
            return None
        raise HTTPException(
            status_code=500,
            detail=f"folder picker failed: {proc.stderr.strip() or 'osascript error'}",
        )
    # choose folder yields a trailing slash; normalize so the path compares
    # equal to what the rest of the system passes around.
    picked = proc.stdout.strip()
    return picked.rstrip("/") or "/" if picked else None


def _pick_tk(initial: Path) -> str | None:
    """Cross-platform fallback for anything that isn't macOS."""
    try:
        import tkinter as tk
        from tkinter import filedialog
    except ImportError as exc:
        raise HTTPException(
            status_code=501,
            detail=(
                "no native folder picker on this machine "
                f"(tkinter unavailable: {exc}). Install your platform's python3-tk "
                "package, or set `cwd` in ~/.config/chrome-controller-mcp/panel.json."
            ),
        ) from exc

    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)  # otherwise it can open behind the browser
    try:
        chosen = filedialog.askdirectory(title=PICKER_TITLE, initialdir=str(initial))
    finally:
        root.destroy()
    return chosen or None


def _pick_directory(start: str | None) -> str | None:
    """Block on a native folder-choose dialog on the machine this sidecar runs
    on, and return the picked absolute path (None if cancelled).

    The panel can't do this itself: the browser's File System Access API opens
    a real picker too, but deliberately withholds the OS path of whatever gets
    chosen, and `claude` needs a real path to chdir into. So the dialog has to
    live here instead of in the extension.
    """
    initial = _picker_start_dir(start)
    try:
        if sys.platform == "darwin":
            return _pick_macos(initial)
        return _pick_tk(initial)
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(
            status_code=504, detail="folder picker timed out waiting for a selection"
        ) from exc


@app.post("/browse-directory", dependencies=[Depends(require_token)])
async def browse_directory(body: BrowseDirectoryRequest) -> dict:
    # Runs on a worker thread: the dialog blocks until the user picks or
    # cancels, and this must not stall the event loop for other sessions.
    path = await asyncio.to_thread(_pick_directory, body.start)
    return {"path": path}


def _resolve_prompt(body: ChatRequest) -> str:
    """A palette command supplies the prompt; free-form text overrides it."""
    if body.prompt.strip():
        return body.prompt
    if body.command:
        for cmd in config.load_commands():
            if cmd.get("id") == body.command:
                return cmd.get("prompt", "")
        raise HTTPException(status_code=404, detail=f"unknown command {body.command!r}")
    raise HTTPException(status_code=400, detail="prompt or command is required")


def _frame(event: dict) -> bytes:
    return f"data: {json.dumps(event)}\n\n".encode("utf-8")


def _resolve_cwd(raw: str | None) -> dict:
    """CFG with `cwd` overridden for one turn, or CFG itself if unset.

    Validated here rather than left to the `claude` subprocess so a typo'd path
    fails fast with a clear message instead of a cryptic spawn error.
    """
    if raw is None or not raw.strip():
        return CFG
    path = Path(raw).expanduser()
    if not path.is_dir():
        raise HTTPException(status_code=400, detail=f"not a directory: {raw!r}")
    return {**CFG, "cwd": str(path)}


@app.post("/chat", dependencies=[Depends(require_token)])
async def chat(body: ChatRequest, request: Request) -> StreamingResponse:
    prompt = _resolve_prompt(body)
    cfg = _resolve_cwd(body.cwd)

    async def stream() -> AsyncIterator[bytes]:
        sid = body.session_id
        turn = session.run_turn(prompt, sid, body.model, cfg)
        watchdog: asyncio.Task | None = None
        try:
            async for event in turn:
                if event["t"] == "accepted":
                    sid = event["session_id"]
                    _SEEN[sid] = time.time()
                    # Starlette cancels this generator on disconnect, but only
                    # once it next tries to write. A turn can go minutes
                    # without output mid-tool-call, so poll explicitly too.
                    watchdog = asyncio.create_task(_watch_disconnect(request, sid))
                yield _frame(event)
        except asyncio.CancelledError:
            if sid:
                session.interrupt(sid)
            raise
        finally:
            if watchdog is not None:
                watchdog.cancel()
            await turn.aclose()

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


async def _watch_disconnect(request: Request, session_id: str) -> None:
    """Kill the turn when the panel goes away (closed, navigated, reloaded)."""
    try:
        while True:
            if await request.is_disconnected():
                session.interrupt(session_id)
                return
            await asyncio.sleep(0.5)
    except asyncio.CancelledError:
        pass
