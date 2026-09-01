#!/bin/bash
# setup.sh — ron-kimi-dasboard interactive, idempotent installer (CONTRACTS.md v2)
# Safe to re-run: existing config.env values become prompt defaults.
set -euo pipefail

cd "$(dirname "$0")"
AGENT_DIR="$PWD"
REPO_DIR="$(cd "$AGENT_DIR/.." && pwd)"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
note() { printf '  %s\n' "$*"; }

# ------------------------------------------------------------ --uninstall ---
# Non-interactive, idempotent, always exits 0. Keeps config.env on purpose.
if [ "${1:-}" = "--uninstall" ]; then
  bold "ron-kimi-dasboard — uninstall"
  echo "Repo: $REPO_DIR"
  echo

  # 1) stop the LaunchAgent (correct gui/<uid>/<label> syntax; ok if not loaded)
  UID_NUM="$(id -u)"
  if command -v launchctl >/dev/null 2>&1; then
    if launchctl bootout "gui/$UID_NUM/com.ron.kimidash.agent" 2>/dev/null; then
      ok "LaunchAgent stopped (gui/$UID_NUM/com.ron.kimidash.agent)"
    else
      note "LaunchAgent was not loaded — already stopped"
    fi
  else
    note "launchctl not available here — skipping bootout"
  fi

  # 2) kill the agent and the children it starts (relay, heartbeat, tunnels)
  #    Patterns match this repo's agent plus the exact child command lines it
  #    spawns (`node relay.js`, `node heartbeat.js`, `cloudflared tunnel --url …`).
  kill_pat() {
    # $1 = pkill -f pattern, $2 = human label
    if pkill -f "$1" 2>/dev/null; then
      ok "killed: $2"
    else
      note "not running: $2"
    fi
    return 0
  }
  kill_pat "$AGENT_DIR/agent.sh"                    "agent supervisor ($AGENT_DIR/agent.sh)"
  kill_pat "$AGENT_DIR/relay\.js"                   "relay (path form)"
  kill_pat "node relay\.js"                         "relay (node relay.js)"
  kill_pat "$AGENT_DIR/heartbeat\.js"               "heartbeat (path form)"
  kill_pat "node heartbeat\.js"                     "heartbeat (node heartbeat.js)"
  kill_pat "cloudflared tunnel --url http://127\.0\.0\.1:" "cloudflared quick tunnels"

  # 3) remove the LaunchAgent plist
  PLIST_DST="$HOME/Library/LaunchAgents/com.ron.kimidash.agent.plist"
  if [ -f "$PLIST_DST" ]; then
    rm -f "$PLIST_DST" && ok "removed $PLIST_DST"
  else
    note "plist already absent: $PLIST_DST"
  fi

  # 4) report EXACTLY what remains (deliberately kept) + how to remove it
  echo
  bold "Removed: LaunchAgent + running processes. Left in place on purpose:"
  note "• config.env (your tokens/passphrase — kept so a reinstall just works):"
  note "    $AGENT_DIR/config.env"
  note "    remove with: rm -f \"$AGENT_DIR/config.env\""
  note "• code-server config — CONTAINS YOUR DASHBOARD PASSWORD:"
  note "    $HOME/.config/code-server/config.yaml"
  note "    remove with: rm -f \"$HOME/.config/code-server/config.yaml\""
  note "• logs + state:"
  note "    $AGENT_DIR/logs  $AGENT_DIR/state"
  note "    remove with: rm -rf \"$AGENT_DIR/logs\" \"$AGENT_DIR/state\""
  note "• the repo checkout itself:"
  note "    $REPO_DIR"
  note "    remove with: rm -rf \"$REPO_DIR\""
  note "• brew packages installed by setup (remove if unwanted):"
  note "    brew uninstall node cloudflared code-server"
  echo
  ok "uninstall complete"
  exit 0
fi

bold "ron-kimi-dasboard — Mac agent setup"
echo "Repo: $REPO_DIR"
echo

# ----------------------------------------------------------- 1) preflight ---
bold "1/8 Preflight"
if [ "$(uname -s)" != "Darwin" ]; then
  bad "This installer only runs on macOS. Detected: $(uname -s)."
  echo "    Fix: run this script on your MacBook:  bash mac-agent/setup.sh"
  exit 1
fi
ok "macOS detected ($(uname -m))"

if ! command -v brew >/dev/null 2>&1; then
  bad "Homebrew is not installed."
  echo "    Fix: run this exact command, then re-run setup:"
  echo '    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
  exit 1
fi
ok "Homebrew present"

# ------------------------------------------------- 2) install dependencies ---
bold "2/8 Dependencies (brew)"
brew_ensure() {
  local formula="$1"
  if brew list --formula "$formula" >/dev/null 2>&1; then
    ok "$formula already installed"
  else
    note "installing $formula …"
    if brew install "$formula"; then
      ok "$formula installed"
    else
      bad "brew install $formula failed."
      echo "    Fix: run 'brew update && brew install $formula' manually, then re-run setup."
      exit 1
    fi
  fi
}
brew_ensure node
brew_ensure cloudflared
brew_ensure code-server

if command -v "${KIMI_BIN:-kimi}" >/dev/null 2>&1; then
  ok "kimi CLI found ($(command -v "${KIMI_BIN:-kimi}"))"
else
  bad "kimi CLI not found — chat will use the Groq cloud fallback until it is installed."
  echo "    Fix (recommended): run this exact command:"
  echo "    curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash"
  echo "    then 'kimi login' once. Continuing setup anyway."
fi

# -------------------------------------------- 3) prompts (idempotent defs) ---
bold "3/8 Configuration"
mkdir -p state logs state/kimi-sessions

# load existing config as defaults (idempotent re-runs)
if [ -f config.env ]; then
  set -a; # shellcheck disable=SC1091
  . ./config.env; set +a
  ok "existing config.env loaded — current values are the defaults below"
fi

: "${REPO_OWNER:=wrcron2}"
: "${REPO_NAME:=ron-kimi-dasboard}"
: "${LIVE_BRANCH:=live}"
: "${GROQ_MODEL:=openai/gpt-oss-120b}"
: "${CODE_SERVER_PORT:=8080}"
: "${RELAY_PORT:=8790}"
: "${KIMI_BIN:=kimi}"
: "${GROQ_API_KEY:=}"
: "${CLAW_PORT:=}"
: "${CLAW_TOKEN:=}"
: "${RELAY_TOKEN:=}"
: "${GITHUB_PAT:=}"
: "${WORKSPACE_DIR:=}"

echo
echo "GITHUB_PAT — a fine-grained GitHub token so the Mac can publish link.json."
echo "  Exact click-path:"
echo "    github.com → profile pic (top right) → Settings → Developer settings"
echo "    → Personal access tokens → Fine-grained tokens → Generate new token"
echo "    → Repository access: Only select repositories → ${REPO_OWNER}/${REPO_NAME}"
echo "    → Repository permissions → Contents: Read and write"
echo "    → Expiration: 1 YEAR  ⚠ fine-grained PATs default to 30 days and CANNOT"
echo "      be never-expire — with the default the heartbeat silently dies after"
echo "      30 days and your iPhone dashboard goes dark. Pick '1 year'."
echo "    → Generate token"
if [ -n "$GITHUB_PAT" ]; then
  read -r -p "  GITHUB_PAT [keep existing]: " in_pat || true
  GITHUB_PAT="${in_pat:-$GITHUB_PAT}"
else
  read -r -p "  GITHUB_PAT (paste, required for live status): " GITHUB_PAT || true
fi
if [ -z "$GITHUB_PAT" ]; then
  bad "No GITHUB_PAT entered — the iPhone dashboard will NOT see live status until you fix this."
  echo "    Fix: create the token as shown above and re-run setup.sh (or edit mac-agent/config.env)."
fi

echo
echo "GROQ_API_KEY — optional free cloud chat fallback (console.groq.com → API Keys)."
read -r -p "  GROQ_API_KEY [${GROQ_API_KEY:+keep existing}${GROQ_API_KEY:-empty/skip}]: " in_groq || true
GROQ_API_KEY="${in_groq:-$GROQ_API_KEY}"

echo
echo "Dashboard key (passphrase) — also used as the code-server password."
if [ -z "$RELAY_TOKEN" ]; then
  GENERATED="$(openssl rand -base64 18 | tr -d '=\n' | cut -c1-24)"
  read -r -p "  Choose a passphrase [Enter = generate: $GENERATED]: " in_tok || true
  RELAY_TOKEN="${in_tok:-$GENERATED}"
else
  read -r -p "  Passphrase [Enter = keep existing]: " in_tok || true
  RELAY_TOKEN="${in_tok:-$RELAY_TOKEN}"
fi

echo
DEF_WS="${WORKSPACE_DIR:-$HOME/Documents/Claude/Projects}"
read -r -p "  VS Code workspace dir [$DEF_WS]: " in_ws || true
WORKSPACE_DIR="${in_ws:-$DEF_WS}"
WORKSPACE_DIR="${WORKSPACE_DIR/#\~/$HOME}"
mkdir -p "$WORKSPACE_DIR"

echo
SUGGEST_CLAW=""
if nc -z 127.0.0.1 18789 2>/dev/null; then SUGGEST_CLAW="18789"; fi
if [ -n "$SUGGEST_CLAW" ] && [ -z "$CLAW_PORT" ]; then
  note "Something is listening on 127.0.0.1:18789 (OpenClaw Control UI?)."
fi
read -r -p "  CLAW_PORT (OpenClaw port, empty = disabled) [${CLAW_PORT:-$SUGGEST_CLAW}]: " in_claw || true
CLAW_PORT="${in_claw:-${CLAW_PORT:-$SUGGEST_CLAW}}"
if [ -n "$CLAW_PORT" ]; then
  read -r -p "  CLAW_TOKEN (OpenClaw gateway token for deep-link login, optional) [${CLAW_TOKEN:+keep existing}]: " in_ct || true
  CLAW_TOKEN="${in_ct:-$CLAW_TOKEN}"
fi

# ------------------------------------------------------- 4) write config ---
bold "4/8 Writing config.env (chmod 600)"
umask 077
cat > config.env <<EOF
RELAY_TOKEN=$RELAY_TOKEN
GITHUB_PAT=$GITHUB_PAT
REPO_OWNER=$REPO_OWNER
REPO_NAME=$REPO_NAME
LIVE_BRANCH=$LIVE_BRANCH
GROQ_API_KEY=$GROQ_API_KEY
GROQ_MODEL=$GROQ_MODEL
KIMI_BIN=$KIMI_BIN
CODE_SERVER_PORT=$CODE_SERVER_PORT
RELAY_PORT=$RELAY_PORT
CLAW_PORT=$CLAW_PORT
CLAW_TOKEN=$CLAW_TOKEN
WORKSPACE_DIR=$WORKSPACE_DIR
EOF
chmod 600 config.env
ok "config.env written ($AGENT_DIR/config.env)"

# -------------------------------------------------- 5) code-server config ---
bold "5/8 code-server config"
mkdir -p "$HOME/.config/code-server"
cat > "$HOME/.config/code-server/config.yaml" <<EOF
bind-addr: 127.0.0.1:$CODE_SERVER_PORT
auth: password
password: $RELAY_TOKEN
cert: false
EOF
ok "~/.config/code-server/config.yaml written (password = dashboard key)"
note "installing Kimi Code extension (best-effort)…"
if code-server --install-extension moonshot-ai.kimi-code >/dev/null 2>&1; then
  ok "moonshot-ai.kimi-code extension installed"
else
  bad "extension install failed (non-fatal)."
  echo "    Fix later: code-server --install-extension moonshot-ai.kimi-code"
fi

# ----------------------------------------------------- 6) LaunchAgent ------
bold "6/8 LaunchAgent (auto-start at login)"
PLIST_SRC="$AGENT_DIR/com.ron.kimidash.agent.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.ron.kimidash.agent.plist"
mkdir -p "$HOME/Library/LaunchAgents"
sed "s|__REPO_DIR__|$REPO_DIR|g" "$PLIST_SRC" > "$PLIST_DST"
ok "plist installed → $PLIST_DST"

UID_NUM="$(id -u)"
launchctl bootout "gui/$UID_NUM/com.ron.kimidash.agent" 2>/dev/null || true
if launchctl bootstrap "gui/$UID_NUM" "$PLIST_DST"; then
  ok "agent bootstrapped (launchctl) — it will now keep itself alive"
else
  bad "launchctl bootstrap failed."
  echo "    Fix: run these two commands:"
  echo "    launchctl bootout gui/$UID_NUM/com.ron.kimidash.agent 2>/dev/null || true"
  echo "    launchctl bootstrap gui/$UID_NUM $PLIST_DST"
  echo "    Then check: tail -f $AGENT_DIR/logs/agent.log"
fi

# ----------------------------------------------------- icons (local PNGs) --
# PNG icons are rendered locally (pure stdlib python — deterministic output,
# so re-rendering is idempotent). They must be pushed from THIS Mac clone:
# the orchestrator's push channel is text-only and corrupts binary files.
if command -v python3 >/dev/null 2>&1; then
  python3 "$AGENT_DIR/render_icons.py" >/dev/null 2>&1 \
    && ok "PNG icons rendered" || note "icon render skipped (cosmetic only)"
else
  note "python3 not found — PNG icons skipped (cosmetic only)"
fi

# Push assets/icon-*.png to origin — idempotent, best-effort. The PAT is used
# ONLY as a one-shot http.extraHeader basic-auth header: nothing lands in
# .git/config, credential helpers, or the remote URL.
push_icons() {
  command -v git >/dev/null 2>&1 || return 0
  git -C "$REPO_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0
  [ -f "$REPO_DIR/assets/icon-180.png" ] || return 0

  # (a) stale = missing from the git index, differs from the freshly rendered
  #     file, or committed locally but never reached origin.
  local stale=0 png
  for png in icon-180.png icon-192.png icon-512.png; do
    [ -f "$REPO_DIR/assets/$png" ] || continue
    if ! git -C "$REPO_DIR" ls-files --error-unmatch "assets/$png" >/dev/null 2>&1; then
      stale=1; break
    fi
    if ! git -C "$REPO_DIR" diff --quiet -- "assets/$png" 2>/dev/null; then
      stale=1; break
    fi
  done
  if [ "$stale" -eq 0 ]; then
    local br; br="$(git -C "$REPO_DIR" symbolic-ref --quiet --short HEAD 2>/dev/null || echo '')"
    if [ -n "$br" ] && git -C "$REPO_DIR" rev-parse --verify "origin/$br" >/dev/null 2>&1; then
      local unpushed
      unpushed="$(git -C "$REPO_DIR" rev-list --count "origin/$br..HEAD" -- assets/ 2>/dev/null || echo 0)"
      [ "${unpushed:-0}" != "0" ] && stale=1
    fi
  fi
  if [ "$stale" -eq 0 ]; then
    ok "touch icons already up to date on github"
    return 0
  fi

  if [ -z "$GITHUB_PAT" ]; then
    bad "touch icons changed/missing on github but no GITHUB_PAT configured — cannot push."
    echo "    icons will be missing on github.io until this succeeds — re-run setup.sh"
    return 0
  fi

  note "pushing rendered touch icons to ${REPO_OWNER}/${REPO_NAME} (one-shot auth — token is NOT stored)…"
  local ok_push=1
  git -C "$REPO_DIR" add assets/icon-180.png assets/icon-192.png assets/icon-512.png >/dev/null 2>&1 || ok_push=0
  # commit only if the add staged something (a pure re-push needs no commit)
  if [ "$ok_push" -eq 1 ] && ! git -C "$REPO_DIR" diff --cached --quiet -- assets/ 2>/dev/null; then
    git -C "$REPO_DIR" \
      -c user.name="ron-kimi-dasboard setup" -c user.email="setup@localhost" \
      commit -m "assets: rendered touch icons" >/dev/null 2>&1 || ok_push=0
  fi
  if [ "$ok_push" -eq 1 ]; then
    git -C "$REPO_DIR" -c credential.helper= \
      -c http.extraHeader="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GITHUB_PAT" | base64)" \
      push origin HEAD >/dev/null 2>&1 || ok_push=0
  fi
  if [ "$ok_push" -eq 1 ]; then
    ok "touch icons pushed to ${REPO_OWNER}/${REPO_NAME}"
  else
    bad "icon push failed (non-fatal)."
    echo "    icons will be missing on github.io until this succeeds — re-run setup.sh"
  fi
  return 0
}
push_icons

# -------------------------------------------------------- 7) self-test -----
bold "7/8 Self-test"

note "waiting for relay /api/health (up to 20s)…"
HEALTH_OK=0
for _ in $(seq 1 20); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$RELAY_PORT/api/health" 2>/dev/null | grep -q '"ok":true'; then
    HEALTH_OK=1; break
  fi
  sleep 1
done
if [ "$HEALTH_OK" -eq 1 ]; then
  ok "relay healthy on 127.0.0.1:$RELAY_PORT"
else
  bad "relay did not answer on 127.0.0.1:$RELAY_PORT/api/health within 20s."
  echo "    Fix: run 'tail -50 $AGENT_DIR/logs/relay.log' and 'tail -50 $AGENT_DIR/logs/agent.log';"
  echo "    most common cause: port $RELAY_PORT already used → change RELAY_PORT in config.env and re-run setup."
fi

if nc -z 127.0.0.1 "$CODE_SERVER_PORT" 2>/dev/null; then
  ok "code-server listening on 127.0.0.1:$CODE_SERVER_PORT"
else
  bad "code-server not listening on 127.0.0.1:$CODE_SERVER_PORT."
  echo "    Fix: run 'tail -50 $AGENT_DIR/logs/code-server.log'; try 'code-server --bind-addr 127.0.0.1:$CODE_SERVER_PORT $WORKSPACE_DIR' manually to see the error."
fi

if command -v cloudflared >/dev/null 2>&1 && cloudflared --version >/dev/null 2>&1; then
  ok "cloudflared works ($(cloudflared --version 2>&1 | head -1))"
else
  bad "cloudflared missing/broken."
  echo "    Fix: brew install cloudflared, then re-run setup."
fi

if [ -n "$GITHUB_PAT" ]; then
  note "waiting for first link.json on branch '$LIVE_BRANCH' (up to 90s)…"
  LINK_OK=0
  for _ in $(seq 1 10); do
    CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
      "https://api.github.com/repos/$REPO_OWNER/$REPO_NAME/contents/link.json?ref=$LIVE_BRANCH")"
    if [ "$CODE" = "200" ]; then LINK_OK=1; break; fi
    sleep 9
  done
  if [ "$LINK_OK" -eq 1 ]; then
    ok "link.json is live on github ($REPO_OWNER/$REPO_NAME@$LIVE_BRANCH)"
  else
    bad "link.json not visible after 90s."
    echo "    Fix: run 'tail -20 $AGENT_DIR/logs/heartbeat.log'; most common cause: PAT missing 'Contents: Read and write'"
    echo "    on $REPO_OWNER/$REPO_NAME — recreate the token with the exact click-path shown above, put it in config.env, then: node $AGENT_DIR/heartbeat.js"
  fi
else
  bad "skipped link.json check (no GITHUB_PAT configured)."
fi

# --------------------------------------------------------- 8) summary ------
bold "8/8 Done — how to use"
cat <<EOF

  Dashboard URL (iPhone):   https://wrcron2.github.io/ron-kimi-dasboard/
  Dashboard key:            $RELAY_TOKEN

  On your iPhone:
    1. Open the dashboard URL in Chrome.
    2. Enter the dashboard key above when prompted.
    3. Tap the Share icon → "Add to Home Screen" for a full-screen app icon.

  The agent starts at login and keeps running (LaunchAgent com.ron.kimidash.agent).
  Useful commands:
    tail -f $AGENT_DIR/logs/agent.log        # supervisor log
    tail -f $AGENT_DIR/logs/heartbeat.log    # link.json publisher log
    bash $AGENT_DIR/setup.sh                 # re-run this setup any time (idempotent)
EOF
