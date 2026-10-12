#!/usr/bin/env bash
# dev.sh: bring up the whole stack (MongoDB, kg seed, sim server, harness, gateway, dashboard).
#
#   ./dev.sh          set up what is missing, seed, start every service whose port is free
#   ./dev.sh status   show which ports are listening (starts nothing)
#   ./dev.sh stop     kill the processes this script started (pids in .logs/)
#
# Logs go to .logs/<name>.log and pids to .logs/<name>.pid. A service whose port is already in use is
# skipped, so this script is safe to run while some services are already up.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
LOGS="$ROOT/.logs"

# ── env ──────────────────────────────────────────────────────────────────────────────────────────
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

# ── helpers ──────────────────────────────────────────────────────────────────────────────────────
port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

start_bg() {
  # start_bg <name> <port> <dir> <command...>
  local name="$1" port="$2" dir="$3"; shift 3
  if port_busy "$port"; then
    echo "[$name] port $port already in use, skipping"
    return 0
  fi
  echo "[$name] starting on :$port  (log: .logs/$name.log)"
  ( cd "$dir" && nohup "$@" >"$LOGS/$name.log" 2>&1 & echo $! >"$LOGS/$name.pid" )
}

wait_for() {
  # wait_for <url> <seconds>
  local url="$1" secs="$2" i
  for ((i = 0; i < secs; i++)); do
    if curl -sf "$url" >/dev/null 2>&1; then
      echo "ready: $url"
      return 0
    fi
    sleep 1
  done
  echo "timed out after ${secs}s waiting for $url" >&2
  return 1
}

show_status() {
  local name port
  for entry in "mongo:27027" "sim-server:8790" "harness:8000" "gateway-api:8787" "gateway-web:5173" "dashboard:5180"; do
    name="${entry%%:*}"; port="${entry##*:}"
    if port_busy "$port"; then
      printf '  %-12s :%-5s listening\n' "$name" "$port"
    else
      printf '  %-12s :%-5s down\n' "$name" "$port"
    fi
  done
}

# ── subcommands ──────────────────────────────────────────────────────────────────────────────────
case "${1:-start}" in
  status)
    show_status
    exit 0
    ;;
  stop)
    for f in "$LOGS"/*.pid; do
      [ -f "$f" ] || continue
      pid="$(cat "$f")"
      name="$(basename "$f" .pid)"
      if kill -0 "$pid" 2>/dev/null; then
        # kill the process group when possible so vite/tsx children go too
        pkill -P "$pid" 2>/dev/null || true
        kill "$pid" 2>/dev/null && echo "[$name] stopped pid $pid"
      else
        echo "[$name] pid $pid not running"
      fi
      rm -f "$f"
    done
    exit 0
    ;;
  start) ;;
  *)
    echo "usage: $0 [start|status|stop]" >&2
    exit 2
    ;;
esac

# ── .logs and .gitignore ─────────────────────────────────────────────────────────────────────────
mkdir -p "$LOGS"
if ! grep -qxF '.logs/' .gitignore 2>/dev/null; then
  echo '.logs/' >>.gitignore
fi

# ── MongoDB ──────────────────────────────────────────────────────────────────────────────────────
GATE_URI="${KG_MONGODB_URI_GATE:-}"
if [ -z "$GATE_URI" ] || [[ "$GATE_URI" == *"127.0.0.1:27027"* ]]; then
  if port_busy 27027; then
    echo "[mongo] something already listens on 27027, reusing it"
  else
    if ! docker info >/dev/null 2>&1; then
      echo "[mongo] docker is not running and KG_MONGODB_URI_GATE is local or empty; start Docker or set Atlas URIs in .env" >&2
      exit 1
    fi
    kg/tools/test_mongo.sh
  fi
else
  echo "[mongo] using the URI in KG_MONGODB_URI_GATE (Atlas or remote)"
fi

# ── Python environments ──────────────────────────────────────────────────────────────────────────
if [ ! -x kg/.venv/bin/python ]; then
  echo "[kg] creating kg/.venv"
  uv venv kg/.venv --python 3.11
  uv pip install -p kg/.venv --exclude-newer 2026-10-04 -r kg/requirements.txt
fi
if [ ! -x harness/.venv/bin/python ]; then
  echo "[harness] creating harness/.venv"
  uv venv harness/.venv --python 3.11
  uv pip install -p harness/.venv --exclude-newer 2026-10-04 -r kg/requirements.txt \
    claude-agent-sdk fastapi 'uvicorn[standard]' httpx python-dotenv
fi

# ── Node packages ────────────────────────────────────────────────────────────────────────────────
[ -d sitesim/node_modules ] || (cd sitesim && npm ci)
[ -d gateway/node_modules ] || (cd gateway && npm ci)

# ── Seed ─────────────────────────────────────────────────────────────────────────────────────────
echo "[kg] seeding brain v1 and the playbook"
kg/.venv/bin/python -m kg seed --v1-brain sitesim/brains/v1.json
harness/.venv/bin/python -m harness.playbook

# ── Services ─────────────────────────────────────────────────────────────────────────────────────
start_bg sim-server 8790 sitesim env PORT=8790 npx tsx src/harness/server.ts
wait_for http://localhost:8790/health 60

# The supervisor bills the Claude subscription (CLAUDE_CODE_OAUTH_TOKEN); an API key would outrank it.
unset ANTHROPIC_API_KEY
start_bg harness 8000 "$ROOT" harness/.venv/bin/python -m uvicorn harness.app:app --port 8000
wait_for http://localhost:8000/api/health 60

start_bg gateway-api 8787 gateway npm run dev:server
start_bg gateway-web 5173 gateway npm run dev:web
start_bg dashboard 5180 sitesim npx vite --port 5180

# ── Summary ──────────────────────────────────────────────────────────────────────────────────────
echo
echo "Everything is up. Status:"
show_status
echo
echo "  dashboard   http://localhost:5180/?spec=warehouse   (add &worker=1 for the live worker)"
echo "  call UI     http://localhost:5173"
echo "  harness     http://localhost:8000/api/health"
echo "  sim server  http://localhost:8790/health"
echo "  gateway     http://localhost:8787/api/config"
echo
echo "Logs: .logs/<name>.log    Stop: ./dev.sh stop"
