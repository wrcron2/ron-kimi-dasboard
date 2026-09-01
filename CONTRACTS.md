# CONTRACTS v2 — ron-kimi-dasboard
Single source of truth. Both builders MUST implement exactly to this file. Ground-truth research (2026-09-01) is baked in — do not "re-decide" these decisions.

Repo: github.com/wrcron2/ron-kimi-dasboard (public) · Pages: https://wrcron2.github.io/ron-kimi-dasboard/ served from `main` root · User: iPhone 14 Chrome (WebKit — ITP blocks 3rd-party cookies!)

## VERIFIED FACTS (binding)
- Cloudflare quick tunnels: NO SSE (text/event-stream buffered); WebSockets DO work; URL = random `https://<words>.trycloudflare.com` per process start; parse URL from cloudflared **stderr**; multiple concurrent quick-tunnel processes work; ~200 concurrent req cap.
- iPhone Chrome = WebKit → third-party cookies blocked → code-server (SameSite=Lax auth cookie) inside a cross-site iframe WILL fail to log in. Therefore: VS Code opens in a NEW TAB (same-site → works). iframe embed allowed only on desktop-class browsers.
- GitHub Pages: Cache-Control max-age=600 fixed. Pages builds only happen on pushes to the publishing branch (`main`) → heartbeat writes to a separate `live` branch = zero Pages builds, unlimited cadence.
- api.github.com: CORS `*`, 60 req/hour per IP unauthenticated. raw.githubusercontent.com: CDN ~5min cache, query-string bust works in practice.
- Kimi CLI: `kimi -p "<prompt>"` headless; `--output-format text|stream-json` (NDJSON, only with -p); `--session <id>` resume, `-c/--continue` latest-in-cwd; `-m <model>`; auth via `kimi login` (device-code) or ~/.kimi-code/config.toml. `-p` implies auto tool permissions; --yolo/--plan are REJECTED with -p.
- code-server: `brew install code-server` (formula); port 8080 127.0.0.1; password auth via ~/.config/code-server/config.yaml; NO X-Frame-Options/frame-ancestors (iframe-able on desktop); `code-server --install-extension moonshot-ai.kimi-code` works (Open VSX default gallery); websockets fine via tunnel.
- cloudflared: `brew install cloudflared` (formula).
- OpenClaw ("Ron Claw" if self-hosted): Control UI on port 18789 at `/`, deep-link login via `?token=<gateway token>`.
- Groq: NO Kimi models anymore. Free fallback model = `openai/gpt-oss-120b` (30 RPM / 1K RPD free), OpenAI-compatible `https://api.groq.com/openai/v1/chat/completions`, stream:true works. Key from console.groq.com (free, phone verify).

## ARCHITECTURE (two modes, one codebase)
**Front-door mode** (github.io, always up): status view + auto-redirect (5s countdown + cancel + "Enter now") to the relay tunnel URL when Mac online; full offline view when not.
**Full mode** (served by relay from the tunnel origin = SAME-ORIGIN): chat via same-origin WebSocket, status via same-origin fetch, Code/Claw cards open in new tabs. The relay serves the SAME index.html + assets/ from the repo checkout on the Mac — one source of truth. app.js picks mode by hostname (`*.github.io` → front-door; else → full).

## Repo layout
```
index.html  assets/styles.css  assets/app.js  assets/manifest.webmanifest
assets/icon.svg              # favicon (vector, committed)
assets/icon-180.png / icon-192.png / icon-512.png  # PNG icons ARE committed (rendered once by mac-agent/render_icons.py, tiny) — index.html + manifest reference them and Pages serves the front door from `main`
mac-agent/relay.js        # Node ≥18, ZERO npm deps: static server + WS chat + REST status
mac-agent/agent.sh        # supervisor: services + tunnels + heartbeat loop
mac-agent/heartbeat.js    # stats + link.json publisher (Contents API, branch `live`)
mac-agent/setup.sh        # interactive idempotent installer
mac-agent/render_icons.py # stdlib-only PNG icon renderer (no binaries in repo)
mac-agent/config.env.example
mac-agent/com.ron.kimidash.agent.plist   # __REPO_DIR__ placeholder
.gitignore                # mac-agent/config.env, mac-agent/logs/, mac-agent/state/, .DS_Store
README.md  docs/SETUP.md  docs/SECURITY.md  CONTRACTS.md   # written by orchestrator
```

## live/link.json (heartbeat every 60s + immediately on tunnel URL change)
**v3 (current) — encrypted.** Only `updatedAt` + `host` are plaintext (so freshness/last-seen logic works without the key); everything sensitive is inside `enc`:
```json
{ "version": 3, "updatedAt": "<ISO>", "host": "<hostname>",
  "enc": { "alg": "PBKDF2-SHA256-100000/AES-256-GCM",
           "nonce": "<b64 12B>", "payload": "<b64 ciphertext||tag>" } }
```
Decryption: key = PBKDF2-SHA256 (100,000 iterations, salt `ron-kimi-dasboard-v1`) over the dashboard passphrase → AES-256-GCM, iv = nonce. Plaintext is JSON:
```json
{ "computer": { "hostname":"…","os":"macOS … (arm64)","uptimeSec":0,"cpuPercent":0.0,
    "memUsedGB":0.0,"memTotalGB":16.0,"battery":{"percent":87,"charging":true} },
  "services": [
    {"id":"relay","name":"Relay + Dashboard","url":"https://<rand>.trycloudflare.com"|null,"ok":true},
    {"id":"code","name":"VS Code (Kimi Code)","url":"https://<rand>.trycloudflare.com"|null,"ok":true},
    {"id":"claw","name":"Ron Claw","url":null,"ok":false,"note":"not configured"}
  ],
  "backends": {"kimi-cli": true, "groq": false} }
```
**v2 (legacy, accepted):** the same `{computer, services, backends}` fields in PLAINTEXT at top level with `"version": 2` — dashboards must still render it as-is. `battery` null when unavailable. NEVER any token/key in this file (the v3 ciphertext is derived from the passphrase but reveals nothing without it). Decryption failure client-side = wrong dashboard key → clear stored token + re-gate.

## Relay (mac-agent/relay.js) — listen 127.0.0.1:$RELAY_PORT (8790), zero-dep Node
Static: `GET /` and `/assets/*` serve repo-root index.html/assets (resolve `__dirname/..`). Correct MIME (html/css/js/png/webmanifest/json). Deny path traversal.
CORS: `Access-Control-Allow-Origin: *` on all REST answers + OPTIONS 204 (covers front-door direct-call edge cases).
Auth: every `/api/*` and the WS upgrade require `Bearer <RELAY_TOKEN>` — WS reads it from `?token=` query OR Authorization header; REST from Authorization header. Timing-safe compare. `401 {"error":"unauthorized"}`.
- `GET /api/health` (NO auth) → `{"ok":true,"service":"ron-relay","version":2,"time":"<ISO>"}`
- `GET /api/status` → `{"ok":true,"now":"<ISO>","host":{hostname,os,uptimeSec,cpuPercent,memUsedGB,memTotalGB,battery},"kimiCli":{"installed":bool,"version":"…"|null},"services":[{"id","name","localPort","ok","url","openUrl"}],"backends":{"kimi-cli":{"available":bool},"groq":{"available":bool,"model":"openai/gpt-oss-120b"}}}`
  - services[].url from `state/tunnels.json` (written by agent.sh). `openUrl` for claw = `<clawTunnelUrl>/?token=<CLAW_TOKEN>` when CLAW_TOKEN set (deep-link login); for code = code tunnel url. Never expose RELAY_TOKEN itself.
- `POST /api/chat` (NON-stream fallback) body `{"messages":[...],"backend":"auto|kimi|groq","sessionId":null|"…"}` → `200 {"text":"…","sessionId":"…"|null,"backend":"kimi-cli"|"groq"}` or `{"error":"…"}`.
- `GET|POST /ws/chat` WebSocket (implement RFC6455 server manually: Sec-WebSocket-Accept SHA-1+base64, parse masked client frames incl. opcode 1/8/9/10 + continuation, send unmasked text frames; server ping every 25s):
  - client → `{"type":"chat","id":"<uuid>","backend":"auto|kimi|groq","sessionId":null|"…","messages":[{"role","content"}]}`
  - server → `{"type":"delta","id","delta":"…"}`* then `{"type":"done","id","sessionId":"…"|null,"backend":"…"}` or `{"type":"error","id","error":"…"}`
Chat engines:
  - kimi-cli: spawn `kimi -p <prompt> --output-format stream-json` (cwd = mac-agent/state/kimi-sessions; append `--session <sessionId>` when provided and send ONLY the last user message; else send last user message, kimi keeps per-cwd sessions). Parse NDJSON defensively: any obj containing session id (keys like session_id/sessionId/session.id) → capture; assistant text (message/content/delta shapes) → stream deltas. If zero structured events parse, fall back to piping raw stdout text. Kill child on WS close; 180s timeout → error `kimi_timeout`; non-zero exit w/o output → `kimi_failed:<stderr tail 200c>`.
  - groq: POST Groq chat/completions `{model:$GROQ_MODEL,messages,stream:true}`; parse SSE `data:` lines → `choices[0].delta.content`; error passthrough. Unavailable (no key) → error `groq_no_key`.
  - `auto` = kimi if `kimiCli.installed` else groq if key else `no_backend`.
- NO exec/file/proxy endpoints. Rate-limit chat: max 4 concurrent, else `busy`.

## config.env (gitignored, chmod 600; .example committed w/ comments)
```
RELAY_TOKEN=            # = dashboard passphrase = code-server password; setup.sh offers generated 24-char default
GITHUB_PAT=             # fine-grained PAT: repo access = only ron-kimi-dasboard, Permission: Contents Read&Write
REPO_OWNER=wrcron2
REPO_NAME=ron-kimi-dasboard
LIVE_BRANCH=live
GROQ_API_KEY=           # optional
GROQ_MODEL=openai/gpt-oss-120b
KIMI_BIN=kimi           # path override if not on PATH
CODE_SERVER_PORT=8080
RELAY_PORT=8790
CLAW_PORT=              # optional, e.g. 18789; empty = disabled
CLAW_TOKEN=             # optional OpenClaw gateway token (for openUrl deep-link)
WORKSPACE_DIR=~/Documents/Claude/Projects
```

## Dashboard (index.html + assets/app.js + assets/styles.css) — vanilla, zero external resources
Visual: dark `#0b0e14` bg, `#12161f` cards, `#e8b04b` amber accent, `#34c77b` online green, `#e5534b` error red, system font stack, 16px radius, bottom tab bar (Chat | Mac | Code) with iOS safe-area padding. Feels like a premium ops console, NOT a landing page. Manifest + apple-touch-icon (assets/icon-*.png) + theme-color.
**Gate**: no `localStorage.rkd_token` → centered passphrase card ("Dashboard key"), stored on submit. Any 401 → clear + re-gate with error. Small lock icon → "forget key".
**Front-door mode** (hostname endsWith github.io): fetch link.json — primary `https://raw.githubusercontent.com/wrcron2/ron-kimi-dasboard/live/link.json?ts=<ms>` every 30s while visible; every 3rd poll use `https://api.github.com/repos/wrcron2/ron-kimi-dasboard/contents/link.json?ref=live` (base64 decode) instead. Online = now-updatedAt < 150000 && services.relay.url. Online → hero card "Mac is online" + auto-redirect countdown 5s → location = relay url (+ `#tk` NOT used — token stays in localStorage of github.io origin! So redirect target = relayUrl and FULL mode must run its own gate (different origin localStorage). To avoid double-entry annoyance: redirect carries `#k=<token>` hash; full mode reads hash → stores → history.replaceState strips it. Hash never hits servers/logs.) Cancel button stops countdown. Offline → offline card, last-seen, stats from last link.json.
**Full mode**: same-origin calls only. Tabs:
- **Chat**: WS `wss://<host>/ws/chat?token=…` (reconnect w/ backoff; fallback POST /api/chat when WS fails twice). Bubbles, streaming cursor, ``` fences → <pre> (HTML-escaped), timestamps, backend picker (Auto / Kimi (Mac) / Free Cloud), New chat button (clears sessionId+history), sessionId persisted per conversation, history ≤100 msgs localStorage (full-origin). Offline/backend errors → inline error bubble with plain-language text.
- **Mac**: pulse dot ONLINE, hostname/os/uptime, CPU & RAM bars, battery, service cards (Relay/VS Code/Ron Claw) each with Open button (openUrl, new tab) or grayed note, "last updated". Poll GET /api/status every 10s.
- **Code**: explainer card ("Full VS Code + Kimi Code runs in its own tab — Apple blocks embedded logins"), big "Open VS Code" button (code openUrl new tab), PASSWORD hint text ("password = your dashboard key"), and on non-touch desktop UA only: an iframe embed toggle. Iframe caveat: code-server's auth cookie is SameSite=Lax, so cross-site iframe login is unreliable even on desktop — the toggle copy must present embedding as experimental and "Open VS Code" (new tab) as the supported path.
**Offline/degraded**: relay unreachable → toast + auto return to bootstrap polling (via link.json) after 3 failures.

## mac-agent scripts
**setup.sh** (idempotent; `bash setup.sh`): 1) preflight macOS+brew (else print brew install line, exit 1) 2) brew install missing: node cloudflared code-server; verify `kimi` CLI presence (warn+instructions if absent — relay still works via groq) 3) prompts: GITHUB_PAT (print exact steps: github.com → Settings → Developer settings → Personal access tokens → Fine-grained → repo = wrcron2/ron-kimi-dasboard → Permissions: Contents = Read and write), GROQ_API_KEY (optional, skippable), passphrase (Enter = generated), WORKSPACE_DIR (default ~/Documents/Claude/Projects), CLAW_PORT (default empty; if :18789 listening suggest it) 4) write config.env (600) 5) write ~/.config/code-server/config.yaml (bind-addr 127.0.0.1:PORT, auth password, password=RELAY_TOKEN) + `code-server --install-extension moonshot-ai.kimi-code` (best-effort) 6) install LaunchAgent plist (expand __REPO_DIR__, RunAtLoad, KeepAlive, ThrottleInterval 30, logs to mac-agent/logs/) + `launchctl bootout||true` + bootstrap 7) SELF-TEST with green ✓/red ✗ lines: relay /api/health local, code-server port listening, cloudflared present, link.json first push within 90s (poll raw once) 8) print dashboard URL + next steps. All failure messages must say exactly what to do.
**agent.sh**: start relay (if port free), code-server (if port free; WORKSPACE_DIR), cloudflared per enabled service (relay/code/claw) capturing stderr→logs/cloudflared-<id>.log, regex-first `https://[a-z0-9-]+\.trycloudflare\.com` → state/tunnels.json (atomic write); watchdog every 15s: restart dead tunnel processes; every 60s run `node heartbeat.js`; immediate heartbeat on tunnel URL change. Everything logged with timestamps.
**heartbeat.js**: stats via os module (loadavg→cpuPercent estimate, freemem), battery via `pmset -g batt` (try/catch→null), read state/tunnels.json + config.env, build link.json, Contents API PUT on LIVE_BRANCH (GET sha first; 404 branch → create ref refs/heads/live from REPO default branch sha via /git/refs, then PUT). Exponential backoff on 403/rate-limit; clear error logs. Never crash the loop (agent.sh reruns it).
**plist**: label com.ron.kimidash.agent; ProgramArguments [/bin/bash, __REPO_DIR__/mac-agent/agent.sh]; RunAtLoad+KeepAlive true; ThrottleInterval 30; WorkingDirectory __REPO_DIR__/mac-agent; StandardOut/Err → logs/agent.log.

## Security (verifier enforces)
Zero secrets in committed files (grep gate). RELAY_TOKEN only in config.env + user head. `#k=` hash transfer stripped by replaceState. Timing-safe token compare. No exec endpoints. link.json carries no secrets. code-server bound 127.0.0.1 (only reachable via its tunnel + password). All relays bound 127.0.0.1.
