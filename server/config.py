"""Configuration and auth token for the side-panel sidecar.

Settings live in ~/.config/chrome-controller-mcp/panel.json, the same config
directory host/native-host.js already reads for the TCP port. Everything has a
default, so the file is optional.
"""

from __future__ import annotations

import json
import os
import secrets
import stat
from pathlib import Path

CONFIG_DIR = Path.home() / ".config" / "chrome-controller-mcp"
CONFIG_PATH = CONFIG_DIR / "panel.json"
TOKEN_PATH = CONFIG_DIR / "panel-token"

DEFAULTS = {
    # Working directory for the Claude Code session. Overridable per turn from
    # the panel (see ChatRequest.cwd in server/app.py); this is only the
    # startup default.
    "cwd": str(Path(__file__).resolve().parent.parent),
    # Model alias ("opus", "sonnet", "haiku", "fable") or a full model id.
    "model": "sonnet",
    # Passed to --permission-mode.
    "permission_mode": "acceptEdits",
    # Passed to --allowedTools. Scoped on purpose: the browser tools plus
    # read-only filesystem access. Add Edit/Write here deliberately, not by
    # accident.
    "allowed_tools": [
        "mcp__browse__*",
        "Read",
        "Grep",
        "Glob",
    ],
    # Passed to --append-system-prompt. Makes "reuse the browser the user is
    # already in" the default for panel-launched sessions, rather than relying
    # on the model to infer it from the tool descriptions alone. Set to "" to
    # drop the flag.
    "system_prompt_append": (
        "Browser sessions: the user's Chrome window is already open and is the "
        "browser you work in. Start browser work by calling "
        "mcp__browse__tabs_context_mcp with no arguments — it lists every open "
        "tab and reports `currentTab`, the tab the user is looking at — and do "
        "the work in that tab. Any listed tab can be read and driven; no "
        "attach step is needed. Do not open a new tab or window unless the user "
        "asks, and never close a tab you did not open unless the user "
        "explicitly asks for that tab to be closed."
    ),
    # Hard ceiling on a single turn, in seconds.
    "turn_timeout_s": 900,
    # Let an extension-origin caller fetch the token from /auth/bootstrap so
    # the panel works with no setup. This trusts any extension installed in the
    # browser, which is a weaker claim than trusting only this one. Set false to
    # require pasting the token from ~/.config/chrome-controller-mcp/panel-token
    # into the panel by hand.
    "bootstrap": True,
}


def load() -> dict:
    """Read panel.json over the defaults. Missing file is not an error."""
    cfg = dict(DEFAULTS)
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
            cfg.update(json.load(fh))
    except FileNotFoundError:
        pass
    except (OSError, json.JSONDecodeError) as exc:
        # A malformed config should be loud, not silently ignored — otherwise
        # you debug the wrong layer for an hour.
        raise RuntimeError(f"{CONFIG_PATH} is unreadable: {exc}") from exc
    return cfg


def load_or_create_token() -> str:
    """Return the shared token, generating it on first run.

    The panel sends this as X-OCIC-Token. Without it any web page could fire a
    no-CORS POST at this server and drive Claude Code silently; requiring a
    custom header forces a preflight the page cannot satisfy.
    """
    try:
        token = TOKEN_PATH.read_text(encoding="utf-8").strip()
        if token:
            return token
    except FileNotFoundError:
        pass

    token = secrets.token_urlsafe(32)
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    TOKEN_PATH.write_text(token, encoding="utf-8")
    os.chmod(TOKEN_PATH, stat.S_IRUSR | stat.S_IWUSR)  # 0600
    return token


def command_descriptions(cwd: str) -> dict[str, str]:
    """Map slash-command name -> description, for the ones backed by a file.

    The CLI's init event names every available command but says nothing about
    what any of them does, and there is no flag that will tell us. User- and
    project-defined commands and skills do carry a `description:` in their
    frontmatter though, and those are exactly the ones a name alone fails to
    explain — a builtin like /compact needs no gloss, `/jira-ticket` does.

    Best-effort by design: an unreadable or frontmatter-less file simply has no
    description, and the command still appears in the list.
    """
    out: dict[str, str] = {}
    roots = [Path.home() / ".claude", Path(cwd).expanduser() / ".claude"]
    for root in roots:
        # <root>/commands/<name>.md, including nested namespaced dirs.
        for path in _safe_glob(root / "commands", "**/*.md"):
            desc = _frontmatter_description(path)
            if desc:
                out.setdefault(path.stem, desc)
        # <root>/skills/<name>/SKILL.md
        for path in _safe_glob(root / "skills", "*/SKILL.md"):
            desc = _frontmatter_description(path)
            if desc:
                out.setdefault(path.parent.name, desc)
    return out


def _safe_glob(directory: Path, pattern: str) -> list[Path]:
    try:
        return sorted(directory.glob(pattern))
    except OSError:
        return []


def _frontmatter_description(path: Path) -> str | None:
    """Pull `description:` out of a leading --- fenced YAML block.

    Parsed by hand rather than with a YAML dependency: the sidecar has none
    today, and one key off the top of a small file does not justify adding one.
    """
    try:
        with open(path, "r", encoding="utf-8") as fh:
            if fh.readline().strip() != "---":
                return None
            for _ in range(40):  # frontmatter, not the whole document
                line = fh.readline()
                if not line or line.strip() == "---":
                    return None
                key, sep, value = line.partition(":")
                if sep and key.strip() == "description":
                    return value.strip().strip("'\"") or None
    except OSError:
        return None
    return None


def load_commands() -> list[dict]:
    """Palette definitions. Adding a command is a config edit, not code."""
    path = Path(__file__).resolve().parent / "commands.json"
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return []
