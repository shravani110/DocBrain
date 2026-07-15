#!/usr/bin/env bash
# Launches DocBrain on macOS/Linux (no Electron needed).
# Starts the local engine and opens the app in your default browser.
set -u
cd "$(dirname "$0")"

URL="http://127.0.0.1:8756"

open_browser() {
  if command -v open >/dev/null 2>&1; then open "$URL"        # macOS
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"  # Linux
  else echo "DocBrain is running at $URL — open it in your browser."
  fi
}

# Already running? Just open the browser.
if curl -s --max-time 2 "$URL/api/status" >/dev/null 2>&1; then
  open_browser
  exit 0
fi

# Prefer python3 (macOS/Linux convention), fall back to python.
PY="$(command -v python3 || command -v python)"
if [ -z "$PY" ]; then
  echo "Python 3 is required but was not found. Install it and retry."
  exit 1
fi

(cd backend && nohup "$PY" main.py --port 8756 >/dev/null 2>&1 &)

# Wait until the engine answers, then open the app.
for _ in $(seq 1 60); do
  if curl -s --max-time 2 "$URL/api/status" >/dev/null 2>&1; then
    open_browser
    exit 0
  fi
  sleep 1
done

echo "The engine did not start within 60 seconds. Run it manually to see errors:"
echo "  cd backend && $PY main.py"
exit 1
