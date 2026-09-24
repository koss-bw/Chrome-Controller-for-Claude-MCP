#!/usr/bin/env bash
# refresh-mcp.sh — make sure a test runs on the LATEST MCP server code.
#
# Scope: this only refreshes the MCP server processes (knob K5). It is the
# correct and sufficient refresh for any edit under host/ that is NOT in the
# extension (extension/* needs K2) or in install.sh (needs K4/K3). For the
# execute_code instruction work, K5 -> K6 is all that is needed.
#
#   K5 (this script)  kill the stale MCP servers + their wrangler/workerd kids
#   K6 (you)          reconnect: run `/mcp` in your session, OR just start the
#                     test in a fresh session — either way Claude Code respawns
#                     the server FROM DISK, picking up the new code.
#
# Usage:
#   ./refresh-mcp.sh            kill stale servers, then tell you to reconnect
#   ./refresh-mcp.sh --check    verify on-disk wiring + show what's running; no kill

set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="$REPO/host"
# scope every match to THIS repo so we never touch unrelated node/wrangler procs
SCOPE="$REPO/host"

bold() { printf "\033[1m%s\033[0m\n" "$1"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
bad()  { printf "  \033[31m✗\033[0m %s\n" "$1"; }

# ---- 1. pre-flight: is the new instruction wiring actually on disk? ----
bold "pre-flight — instruction wiring on disk"
PASS=1
grep -q "export const SERVER_INSTRUCTIONS" "$HOST/codemode/common.js" \
  && ok "common.js exports SERVER_INSTRUCTIONS (L1 source)" \
  || { bad "common.js missing SERVER_INSTRUCTIONS"; PASS=0; }
grep -q "instructions: SERVER_INSTRUCTIONS" "$HOST/codemode/server-hybrid.js" \
  && ok "server-hybrid.js wires instructions into the Server (L1)" \
  || { bad "server-hybrid.js does not set instructions"; PASS=0; }
grep -q "instructions: SERVER_INSTRUCTIONS" "$HOST/codemode/server-codemode.js" \
  && ok "server-codemode.js wires instructions into the McpServer (L1)" \
  || { bad "server-codemode.js does not set instructions"; PASS=0; }
# syntax sanity so a relaunch can't fail on a typo
for f in common.js server-hybrid.js server-codemode.js; do
  node --check "$HOST/codemode/$f" 2>/dev/null \
    && ok "syntax OK: codemode/$f" \
    || { bad "SYNTAX ERROR: codemode/$f — fix before refreshing"; PASS=0; }
done
[ "$PASS" = 1 ] || { echo; bad "on-disk code is not ready; not killing anything."; exit 1; }

# ---- 2. what's running right now ----
echo
bold "running MCP servers (this repo)"
HY=$(pgrep -f "$SCOPE/codemode/server-hybrid.js" | wc -l | tr -d ' ')
CM=$(pgrep -f "$SCOPE/codemode/server-codemode.js" | wc -l | tr -d ' ')
DF=$(pgrep -f "$SCOPE/mcp-server.js" | wc -l | tr -d ' ')
printf "  hybrid: %s   codemode: %s   default: %s\n" "$HY" "$CM" "$DF"
TOTAL=$(( HY + CM + DF ))
[ "$TOTAL" -gt 1 ] && printf "  \033[33m%s\033[0m\n" "note: $TOTAL servers alive — stale instances accumulate across sessions; this clears them."

if [ "${1:-}" = "--check" ]; then
  echo; bold "--check only — nothing killed. Run without --check to refresh."
  exit 0
fi

# ---- 3. K5: kill servers + their sandbox children, scoped to this repo ----
echo
bold "K5 — killing stale MCP servers + wrangler/workerd sandboxes"
# order: sandboxes first (children), then the servers (parents)
pkill -9 -f "$SCOPE/codemode/worker" 2>/dev/null && ok "killed wrangler/workerd under host/codemode/worker" || ok "no wrangler/workerd to kill"
pkill -9 -f "$SCOPE/codemode/server-hybrid.js"   2>/dev/null && ok "killed server-hybrid.js"   || ok "no server-hybrid.js running"
pkill -9 -f "$SCOPE/codemode/server-codemode.js" 2>/dev/null && ok "killed server-codemode.js" || ok "no server-codemode.js running"
pkill -9 -f "$SCOPE/mcp-server.js"               2>/dev/null && ok "killed mcp-server.js"       || ok "no default mcp-server.js running"
sleep 1

# ---- 4. confirm clean ----
echo
bold "verify"
LEFT=$(pgrep -f "$SCOPE/codemode/server-hybrid.js|$SCOPE/codemode/server-codemode.js|$SCOPE/mcp-server.js" | wc -l | tr -d ' ')
if [ "$LEFT" = "0" ]; then
  ok "no MCP servers from this repo are running — next connect loads fresh code"
else
  bad "$LEFT server(s) still alive; re-run, or pkill -9 -f \"$SCOPE\""
fi

echo
bold "K6 — now reconnect (one of):"
echo "  • in your current session:  run  /mcp"
echo "  • or just start the test in a NEW session (it spawns a fresh server on its own)"
echo
echo "Either way the chrome-controller-mcp MCP relaunches from disk with the new"
echo "instructions + execute_code playbook. You are then on the latest version."
