# SETUP — from zero to dashboard in ±10 minutes

Do these steps in order. Each one tells you exactly what to type and what you should see.

---

## Step 0 — Prerequisites on the Mac (2 min)

1. **Homebrew** — you almost surely have it. Check: `brew --version`. If not:
   ```bash
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
   ```
2. **Kimi Code CLI, logged in** — this powers the "Kimi" chat brain:
   ```bash
   kimi --version || curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash
   kimi login        # follow the device-code prompt once
   ```
   (Already using Kimi Code in VS Code on this Mac? Then you're logged in — `~/.kimi-code` is shared.)
3. **Keep the Mac awake**: System Settings → **Displays → Advanced…** → turn ON **"Prevent automatic sleeping on power adapter when the display is off"**. The dashboard tells you the truth when the Mac is off — but it's better when it never is.
4. **Optional — free backup brain (Groq)**: console.groq.com → sign up (free, no card) → API Keys → create. Keep the `gsk_…` key for step 2. Without it, chat still works via Kimi; the "Free Cloud" option just stays disabled.
5. **Optional — Ron Claw**: if your OpenClaw is running on this Mac (port 18789), setup will offer to tunnel it so the dashboard gets a one-tap, auto-logged-in Claw button.

---

## Step 1 — Get this repo on the Mac (1 min)

```bash
cd ~/Documents/Claude/Projects        # or wherever you keep projects
git clone https://github.com/wrcron2/ron-kimi-dasboard.git
cd ron-kimi-dasboard
```
(No git? Download ZIP from the repo page → Code → Download ZIP → unzip → `cd` into the folder.)

## Step 2 — Run the installer (3 min)

```bash
bash mac-agent/setup.sh
```

It installs what's missing (`node`, `cloudflared`, `code-server`), then asks 5 things:

| Prompt | What to do |
|---|---|
| **GitHub token** | The script prints the exact click-path. Short version: github.com → your avatar → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token** → **Expiration: 1 year** (GitHub defaults to 30 days and offers no "never" — pick the longest and put the renewal date in your calendar) → *Repository access: Only select repositories* → pick `wrcron2/ron-kimi-dasboard` → *Repository permissions → Contents: Read and write* → Generate. Paste the `github_pat_…`. (It only ever touches this one repo.) |
| **Groq key** | Paste the `gsk_…` from step 0, or press Enter to skip. |
| **Dashboard passphrase** | Press Enter to accept the generated one, or type your own. **This one phrase unlocks everything: dashboard, chat, and the VS Code password.** Save it in your notes. |
| **Workspace folder** | Where VS Code opens. Default `~/Documents/Claude/Projects`. |
| **Claw port** | If OpenClaw is detected on 18789 it's suggested; Enter to skip otherwise. |

Then it configures code-server (password = your passphrase), installs the **Kimi Code extension** into it, registers a launchd service (starts at login, auto-restarts), starts everything, and **self-tests**: you want four green ✓ (relay alive · code-server alive · cloudflared present · first heartbeat visible on GitHub).

The final block prints your dashboard URL and passphrase again. Re-running `bash mac-agent/setup.sh` later is safe — it remembers your answers and just updates/restarts.

## Step 3 — Turn on GitHub Pages (one click, once)

The dashboard's front door is served by GitHub Pages — flip it on:

Repo page → **Settings → Pages** → *Build and deployment* → **Source: Deploy from a branch** → Branch: **main**, folder: **/ (root)** → **Save**. First deploy takes ~60 seconds.

(Prefer the terminal? With the GitHub CLI logged in:
`gh api repos/wrcron2/ron-kimi-dasboard/pages -X POST -f "source[branch]=main" -f "source[path]=/"` )

## Step 4 — iPhone (1 min)

1. Chrome → `https://wrcron2.github.io/ron-kimi-dasboard/`
2. Enter your passphrase.
3. If the Mac is online it offers to **Enter** (auto after 5 s) — now you're on the live dashboard served by your Mac.
4. Share → **Add to Home Screen** → it becomes a full-screen app icon.

Bookmark the **github.io** address — it's the stable front door that always knows where your Mac is. (The `trycloudflare.com` address changes when the Mac restarts; the front door re-learns it within a minute.)

---

## Daily use

- **Chat** tab — talk to Kimi (runs through your Mac's Kimi Code). Picker: *Auto* · *Kimi (Mac)* · *Free Cloud* (Groq backup brain). "New chat" starts a fresh session.
- **Mac** tab — live CPU/RAM/battery/uptime + buttons: **VS Code**, **Ron Claw** (opens already-logged-in), relay.
- **Code** tab — tap **Open VS Code**. It opens in its own tab (Apple blocks embedded logins — this is the reliable way). Password = your dashboard passphrase. Inside: your files, a terminal with `kimi`, and the Kimi Code extension panel.

## Troubleshooting

| Symptom | Do this |
|---|---|
| Dashboard says **offline** | On the Mac: `tail -50 mac-agent/logs/agent.log`. Service down? `launchctl kickstart -k gui/$(id -u)/com.ron.kimidash.agent`. Mac asleep = step 0.3. |
| The dashboard URL shows a **GitHub 404 page** | Pages isn't enabled yet or is still deploying: repo → **Settings → Pages** → *Deploy from a branch* → **main** / **(root)** → Save; wait 2–5 min; hard-refresh. |
| Computer shows **offline ~30 days after setup** | The PAT expired (GitHub's default). Fix: create a new token (same scopes, step 2 table — pick **Expiration: 1 year**), update `GITHUB_PAT` in `mac-agent/config.env`, then: `launchctl kickstart -k gui/$UID/com.ron.kimidash.agent`. |
| ✗ heartbeat in self-test | Token wrong scope → recreate it with **Contents: Read and write** on this repo (step 2 table), rerun setup. |
| **401 / wrong passphrase** | Tap the lock icon → re-enter. Forgot it? It's in `mac-agent/config.env` as `RELAY_TOKEN` on the Mac. |
| Chat: `no_backend` | Neither `kimi` CLI nor a Groq key is available → `kimi login` on the Mac, or add `GROQ_API_KEY` to `mac-agent/config.env` and rerun setup. |
| Chat: `kimi_failed:…` | Run `kimi -p "hi"` on the Mac to see the real error (usually login/quota). |
| VS Code asks for a password | It's your dashboard passphrase. |
| Claw button gray | OpenClaw not running / not configured (`CLAW_PORT` empty). Start it, rerun setup, accept port 18789. |
| Tunnel page shows error 1033 | Tunnel hiccup — watchdog restarts it within ~30 s; refresh. |
| Updating the repo | `git pull && bash mac-agent/setup.sh` (idempotent). |

## Uninstall

```bash
launchctl bootout gui/$(id -u)/com.ron.kimidash.agent
rm ~/Library/LaunchAgents/com.ron.kimidash.agent.plist
```
Optionally `brew uninstall code-server cloudflared` and delete the repo folder. Nothing else was touched.
