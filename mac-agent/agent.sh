#!/bin/bash
# agent.sh — ron-kimi-dasboard supervisor (CONTRACTS.md v2)
# Starts relay + code-server (127.0.0.1 only), one cloudflared quick tunnel
# per enabled service, keeps state/tunnels.json fresh, watchdogs tunnels,
# and runs heartbeat.js on tunnel change + every 60s.
# Compatible with macOS /bin/bash 3.2 (no associative arrays).
set -u

# launchd agents get a minimal PATH (/usr/bin:/bin:...) that hides Homebrew —
# without this, node/code-server/cloudflared are "not found" when started by
# launchd even though they work fine in an interactive shell.
export PATH="/opt/homebrew/bin:/usr/local/bin:/opt/homebrew/sbin:/usr/local/sbin:$PATH"

# macOS fork-safety: node processes spawned by launchd SIGABRT ("Abort trap: 6")
# as soon as they fork a child (kimi probe, pmset) because the ObjC runtime
# initializes differently under launchd. This var disables that abort.
export OBJC_DISABLE_INITIALIZE_FORK_SAFETY=YES

cd "$(dirname "$0")" || exit 1
AGENT_DIR="$PWD"
mkdir -p logs state state/kimi-sessions

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# --- config (defensive: config.env may be missing; env vars win) -----------
if [ -f config.env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./config.env
  set +a
else
  log "WARNING: config.env not found — run setup.sh first. Using defaults."
fi
: "${RELAY_PORT:=8790}"
: "${CODE_SERVER_PORT:=8080}"
: "${KIMI_BIN:=kimi}"
: "${CLAW_PORT:=}"
: "${KEEP_AWAKE:=1}"
: "${WORKSPACE_DIR:=$HOME/Documents/Claude/Projects}"
WORKSPACE_DIR="${WORKSPACE_DIR/#\~/$HOME}"
mkdir -p "$WORKSPACE_DIR" 2>/dev/null || true

CHILD_PIDS=""
TUNNEL_IDS=""
CAFFEINATE_PID=""
# per-service state kept in dynamically named vars: TPID_<id>, TPORT_<id>, TURL_<id>
# (bash 3.2 has no assoc arrays — use eval indirection instead)
tset() { eval "$1_$2=\"$3\""; }              # tset TPID relay 1234
tget() { eval "printf '%s' \"\${$1_$2:-}\""; }

port_in_use() { nc -z 127.0.0.1 "$1" 2>/dev/null; }

# --- services ---------------------------------------------------------------
start_relay() {
  if port_in_use "$RELAY_PORT"; then
    log "relay: port $RELAY_PORT already in use — assuming relay already running"
    return
  fi
  if ! command -v node >/dev/null 2>&1; then
    log "ERROR: node not found. Install with: brew install node"
    return
  fi
  node relay.js >> logs/relay.log 2>&1 &
  CHILD_PIDS="$CHILD_PIDS $!"
  log "relay: started (pid $!) on 127.0.0.1:$RELAY_PORT"
}

start_code_server() {
  if ! command -v code-server >/dev/null 2>&1; then
    log "code-server: not installed (brew install code-server) — skipping"
    return 1
  fi
  if port_in_use "$CODE_SERVER_PORT"; then
    log "code-server: port $CODE_SERVER_PORT already in use — assuming already running"
    return 0
  fi
  code-server --bind-addr "127.0.0.1:$CODE_SERVER_PORT" "$WORKSPACE_DIR" >> logs/code-server.log 2>&1 &
  CHILD_PIDS="$CHILD_PIDS $!"
  log "code-server: started (pid $!) on 127.0.0.1:$CODE_SERVER_PORT workspace=$WORKSPACE_DIR"
  return 0
}

# --- keep-awake (macOS only; no-op elsewhere) --------------------------------
# The Mac must stay reachable 24/7 — prevent system/display/disk sleep while
# the agent runs (`caffeinate -dims`). Supervised like every other child.
start_caffeinate() {
  [ "$KEEP_AWAKE" = "1" ] || return 0
  if ! command -v caffeinate >/dev/null 2>&1; then
    return 0   # not macOS — graceful no-op
  fi
  caffeinate -dims >> logs/agent.log 2>&1 &
  CAFFEINATE_PID=$!
  log "keep-awake: caffeinate -dims started (pid $CAFFEINATE_PID)"
}

# --- tunnels ----------------------------------------------------------------
start_tunnel() {
  local id="$1" port="$2"
  cloudflared tunnel --url "http://127.0.0.1:$port" --no-autoupdate > "logs/cloudflared-$id.log" 2>&1 &
  tset TPID "$id" "$!"
  tset TURL "$id" ""
  log "tunnel $id: started (pid $(tget TPID "$id")) -> 127.0.0.1:$port (URL pending, see logs/cloudflared-$id.log)"
}

harvest_url() {
  # prints first trycloudflare URL found in the tunnel log, if any
  grep -o -m1 'https://[a-z0-9-]*\.trycloudflare\.com' "logs/cloudflared-$1.log" 2>/dev/null | head -1
}

write_tunnels_json() {
  local tmp="state/.tunnels.json.tmp"
  local stamp; stamp=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  local first=1 id url port
  {
    printf '{"updatedAt":"%s","tunnels":{' "$stamp"
    for id in $TUNNEL_IDS; do
      [ "$first" -eq 0 ] && printf ','
      first=0
      url="$(tget TURL "$id")"
      port="$(tget TPORT "$id")"
      if [ -n "$url" ]; then
        printf '"%s":{"url":"%s","localPort":%s}' "$id" "$url" "$port"
      else
        printf '"%s":{"url":null,"localPort":%s}' "$id" "$port"
      fi
    done
    printf '}}'
  } > "$tmp" && mv "$tmp" state/tunnels.json   # atomic publish
}

HB_PID=""
HB_PIDS=""   # every background heartbeat pid ever spawned (for shutdown)
run_heartbeat() {
  if ! command -v node >/dev/null 2>&1; then return; fi
  # single-flight guard: a slow heartbeat (e.g. backoff sleep) must never
  # overlap the next 60s tick — skip this tick while one is still running.
  if [ -n "$HB_PID" ] && kill -0 "$HB_PID" 2>/dev/null; then
    return   # previous heartbeat still running — skip, avoid sha race
  fi
  node heartbeat.js >> logs/heartbeat.log 2>&1 &
  HB_PID=$!
  HB_PIDS="$HB_PIDS $HB_PID"
}

# --- shutdown ---------------------------------------------------------------
SHUTTING_DOWN=0
shutdown() {
  [ "$SHUTTING_DOWN" -eq 1 ] && return 0   # idempotent (trap may fire twice)
  SHUTTING_DOWN=1
  log "shutting down…"
  local id pid
  for id in $TUNNEL_IDS; do
    pid="$(tget TPID "$id")"
    [ -n "$pid" ] && kill "$pid" 2>/dev/null
  done
  for pid in $CHILD_PIDS; do
    kill "$pid" 2>/dev/null
  done
  [ -n "$CAFFEINATE_PID" ] && kill "$CAFFEINATE_PID" 2>/dev/null
  for pid in $HB_PIDS; do                  # kill any tracked heartbeat (running or zombie-safe)
    kill "$pid" 2>/dev/null
  done
  exit 0
}
trap shutdown INT TERM

# --- boot -------------------------------------------------------------------
log "=== ron-kimi-dasboard agent starting (dir=$AGENT_DIR) ==="
start_relay
start_caffeinate
CODE_ENABLED=0
if start_code_server; then CODE_ENABLED=1; fi

# one quick tunnel per enabled service
CLOUDFLARED_OK=0
if command -v cloudflared >/dev/null 2>&1; then
  CLOUDFLARED_OK=1
else
  log "cloudflared not installed (brew install cloudflared) — tunnels disabled this run"
fi
enable_tunnel() {
  local id="$1" port="$2"
  tset TPORT "$id" "$port"
  tset TURL "$id" ""
  if [ "$CLOUDFLARED_OK" -eq 0 ]; then return; fi   # not in TUNNEL_IDS: no watchdog churn
  TUNNEL_IDS="$TUNNEL_IDS $id"
  start_tunnel "$id" "$port"
}
enable_tunnel relay "$RELAY_PORT"
if [ "$CODE_ENABLED" -eq 1 ]; then enable_tunnel code "$CODE_SERVER_PORT"; fi
if [ -n "$CLAW_PORT" ]; then enable_tunnel claw "$CLAW_PORT"; fi

write_tunnels_json
run_heartbeat

# --- watchdog loop ----------------------------------------------------------
TICKS=0
while true; do
  sleep 15 & wait $!    # background+wait so TERM/INT traps fire immediately
  TICKS=$((TICKS + 1))
  CHANGED=0
  # watchdog: keep-awake child
  if [ "$KEEP_AWAKE" = "1" ] && command -v caffeinate >/dev/null 2>&1; then
    if [ -z "$CAFFEINATE_PID" ] || ! kill -0 "$CAFFEINATE_PID" 2>/dev/null; then
      log "keep-awake: caffeinate dead — restarting"
      start_caffeinate
    fi
  fi
  for id in $TUNNEL_IDS; do
    pid="$(tget TPID "$id")"
    if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
      log "tunnel $id: process dead — restarting"
      start_tunnel "$id" "$(tget TPORT "$id")"
      CHANGED=1
      continue
    fi
    if [ -z "$(tget TURL "$id")" ]; then
      url="$(harvest_url "$id")"
      if [ -n "$url" ]; then
        tset TURL "$id" "$url"
        log "tunnel $id: live at $url"
        CHANGED=1
      fi
    fi
  done
  if [ "$CHANGED" -eq 1 ]; then
    write_tunnels_json
    run_heartbeat          # immediate heartbeat on tunnel URL change
  fi
  if [ $((TICKS % 4)) -eq 0 ]; then
    run_heartbeat          # steady-state heartbeat every 60s
  fi
done
