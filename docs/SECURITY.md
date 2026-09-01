# SECURITY — what's protected, how, and the honest limits

## The model in one line

Everything sensitive sits behind **your one passphrase**; everything public contains **no secrets**; everything on the Mac listens only on **localhost**.

## Layer by layer

| Layer | Mechanism |
|---|---|
| Dashboard (GitHub Pages) | Public static HTML — by design it contains **zero secrets**. Without the passphrase it shows a lock screen and nothing works. |
| Passphrase → relay | The passphrase is the relay's Bearer token (`RELAY_TOKEN`), compared with a timing-safe comparison, stored only in `mac-agent/config.env` (`chmod 600`) on the Mac and in your phone's localStorage. Never committed, never logged. |
| Front door → live dashboard handoff | The token crosses origins via the URL **fragment** (`#k=…`). Fragments are never sent to any server and never appear in logs; the dashboard stores it and immediately strips it with `history.replaceState`. |
| VS Code (code-server) | Its own login, password = the same passphrase. Bound to `127.0.0.1` — unreachable except through its tunnel, which still requires the password. |
| Chat relay API | Every endpoint except a trivial `/api/health` requires the Bearer token. There is **no shell/exec/file endpoint** — remote code execution is impossible by design; files and terminal go through code-server's battle-tested auth instead. |
| Tunnel URLs | Cloudflare quick-tunnel hostnames are long random strings that **change on every restart**. Treat them as an obscurity layer, not as security — the passphrase is the security. |
| GitHub token (heartbeat) | Fine-grained PAT, scoped to **this one repository**, permission **Contents: Read & write only**. Worst-case leak = someone edits this repo. Revoke anytime: GitHub → Settings → Developer settings → Fine-grained tokens. |
| Groq key | Optional, lives only in `config.env` on the Mac, used server-side only. |
| Chat transport | WebSocket over the tunnel (TLS to Cloudflare's edge). Note: quick tunnels terminate TLS at Cloudflare — fine for chat with your own Mac; don't paste banking passwords into chat, same rule as any chatbot. |

## What the public repo reveals (accepted risk)

The repo is public **because GitHub Pages is only free for public repos**. Anyone who watches it can see:
- the dashboard source (no secrets in it — verified by a manual secret scan before each delivery: `grep -rniE '(ghp_|github_pat_|sk-|gsk_)' .` over the repo must only match doc placeholders),
- the `live` branch's `link.json` — **but only the `updatedAt` timestamp and the hostname are plaintext**. Everything sensitive in it (service/tunnel URLs, CPU/RAM/battery stats, backend availability) is encrypted **AES-256-GCM** with a key derived from your dashboard passphrase via **PBKDF2-SHA256, 100,000 iterations**. Without the passphrase the file is an opaque blob — a leaked repo URL no longer leaks your tunnel addresses.

Even a stranger who somehow grabs a *currently valid* tunnel URL still hits the passphrase wall at the relay **and** the code-server password — so access stays locked. What they *can* do is nuisance-level: see when your Mac is online (the plaintext heartbeat timestamp). If that ever bothers you:

1. Rotate everything: restart the agent (new tunnel URLs) + change the passphrase in `mac-agent/config.env` → rerun `bash mac-agent/setup.sh`, or
2. Go full stealth: make the repo private (Pages then needs a paid GitHub plan) **or** move the front door onto the relay itself and use a named Cloudflare Tunnel + Cloudflare Access (free, needs your own domain) — notes at the bottom.

## What this setup does NOT do

- **It is not two-factor.** One passphrase = full access. Choose a strong one (the installer generates 24 random chars — keep it).
- **It does not protect a stolen, unlocked Mac.** FileVault + a login password are on you.
- **Quick tunnels are a dev-grade Cloudflare freebie** (no SLA, ~200 concurrent request cap). For personal phone use they're plenty.
- **The "Free Cloud" chat sends messages to Groq** (US) when you use that backend. The Kimi backend sends them through your own Kimi Code session. Pick per-message sensitivity.
- **Uninstall leaves one secret behind**: the code-server password (= your passphrase) stays in plaintext at `~/.config/code-server/config.yaml`. Remove it manually when uninstalling: `rm -rf ~/.config/code-server`.

## Optional hardening paths (all still free)

- **Own domain + named tunnel + Cloudflare Access**: replaces random URLs with fixed ones and adds an email one-time-PIN gate in front of everything (`cloudflared tunnel create` + Access policy, free tier ≤50 users).
- **Tailscale instead of tunnels**: dashboard and Mac join a private tailnet; nothing public at all — but requires the Tailscale app on the phone instead of plain Chrome.
- **Monthly hygiene**: `git pull && bash mac-agent/setup.sh` to refresh code; revoke/regenerate the PAT once in a while.
