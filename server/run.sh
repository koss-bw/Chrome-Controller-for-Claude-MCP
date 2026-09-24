#!/usr/bin/env bash
# Start the side-panel sidecar. One worker only — see server/app.py.
set -euo pipefail

cd "$(dirname "$0")/.."

VENV="${OCIC_VENV:-server/.venv}"
if [ ! -d "$VENV" ]; then
  echo "Creating virtualenv at $VENV"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet --upgrade pip
  "$VENV/bin/pip" install --quiet -r server/requirements.txt
fi

# --reload by default: this is a local dev sidecar, and a server silently
# serving stale code is the failure mode that actually bites — an added route
# comes back 404 with nothing to suggest the process is the problem. Set
# OCIC_RELOAD=0 for a long-lived run where an edit shouldn't drop in-flight turns.
RELOAD_FLAG="--reload"
[ "${OCIC_RELOAD:-1}" = "0" ] && RELOAD_FLAG=""

exec "$VENV/bin/uvicorn" server.app:app \
  --host 127.0.0.1 \
  --port "${OCIC_PANEL_PORT:-8765}" \
  --workers 1 \
  $RELOAD_FLAG \
  "$@"
