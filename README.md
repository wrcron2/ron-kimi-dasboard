# ron-kimi-dasboard

My iPhone dashboard for everything Kimi — one URL in Chrome:

**https://wrcron2.github.io/ron-kimi-dasboard/**

- **Chat** — a Kimi Claw-style chat. The "Kimi" brain runs through my Mac's own **Kimi Code** login (real Kimi, $0 extra); a free **Groq** model is the backup brain.
- **Code** — full **VS Code + Kimi Code extension** running on my Mac, opened from the dashboard in its own full-screen tab (files + terminal + `kimi` CLI included).
- **Mac** — live status of my MacBook: online pulse, CPU / RAM / battery / uptime, and one-tap buttons for every service (including **Ron Claw** when it's running).

Everything is **free** and **self-hosted**. The phone never talks to kimi.com directly — handy on networks where Kimi pages are blocked, because the Mac does the talking.

## How it works

```
iPhone Chrome
   │  1. open github.io front door (always up, static)
   ▼
GitHub Pages ──reads live/link.json (branch `live`)──▶ "Mac online? enter ▶"
   │  2. one tap → tunnel URL (token handed via #hash, never logged)
   ▼
MacBook (always on)
   ├─ mac-agent/relay.js      → serves this dashboard + WebSocket chat + status API  (127.0.0.1:8790)
   ├─ code-server             → VS Code in browser + Kimi Code extension             (127.0.0.1:8080)
   ├─ Ron Claw (OpenClaw)     → optional, its own tunnel                             (127.0.0.1:18789)
   ├─ cloudflared ×2-3        → free random *.trycloudflare.com tunnels (WS-friendly)
   └─ heartbeat.js            → re-publishes tunnel URLs + stats (encrypted) every 60s
```

If the Mac is asleep you get an honest "offline — last seen" page. Everything else self-heals: tunnels rotate URLs on restart and the heartbeat repoints the dashboard automatically within ~1 minute.

## Setup (once, ±10 minutes)

See **[docs/SETUP.md](docs/SETUP.md)**. Short version:

1. On the Mac: `git clone https://github.com/wrcron2/ron-kimi-dasboard.git && cd ron-kimi-dasboard && bash mac-agent/setup.sh`
2. It asks for: a fine-grained GitHub token (guides you click-by-click), an optional free Groq key, and a dashboard passphrase.
3. On GitHub: Settings → Pages → deploy from branch `main` (one click — needed once).
4. On the iPhone: open the URL → enter passphrase → Share → **Add to Home Screen**.

## Repo layout

| Path | What it is |
|---|---|
| `index.html`, `assets/` | The dashboard (zero-build, no CDNs, works on Pages and served by the relay) |
| `mac-agent/relay.js` | Zero-dependency Node server: dashboard host + chat (WebSocket) + status API |
| `mac-agent/agent.sh` | Supervisor: services + tunnels + watchdog + heartbeat |
| `mac-agent/heartbeat.js` | Publishes `live/link.json` every 60 s via GitHub API |
| `mac-agent/setup.sh` | Idempotent interactive installer (brew, code-server, cloudflared, launchd) |
| `docs/SETUP.md` · `docs/SECURITY.md` | Full guide · threat model |
| `CONTRACTS.md` | The internal spec everything was built and verified against |

## Cost

$0. GitHub Pages, Cloudflare quick tunnels, code-server and the GitHub API usage are all free. The Kimi brain uses the existing Kimi Code login on the Mac. The optional Groq fallback is a free tier (note: Groq retired its Kimi models in April 2026, so the fallback is `openai/gpt-oss-120b`, clearly labeled "Free Cloud" in the UI).

## Security in one paragraph

The dashboard is public HTML but **useless without the passphrase**: the relay and VS Code both demand it, tokens never live in the repo, services bind to localhost, and the public `link.json` heartbeat encrypts the tunnel URLs + stats with AES-256-GCM under your passphrase (only the timestamp and hostname are plaintext). Full details in **[docs/SECURITY.md](docs/SECURITY.md)**.
