#!/usr/bin/env node
'use strict';
/*
 * heartbeat.js — ron-kimi-dasboard link.json publisher (CONTRACTS.md v2)
 * Zero npm dependencies. Node >= 18.
 * Collects host stats + tunnel URLs, builds live/link.json and publishes it
 * to the LIVE_BRANCH via the GitHub Contents API (GET sha -> PUT; creates the
 * branch from the repo default branch when missing).
 * NEVER crashes: every failure prints an actionable stderr message and exits
 * cleanly — agent.sh owns the cadence.
 */

const https = require('node:https');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const AGENT_DIR = __dirname;
const TUNNELS_FILE = path.join(AGENT_DIR, 'state', 'tunnels.json');

function ts() { return new Date().toISOString(); }
function info(...a) { console.log(`[${ts()}]`, ...a); }
function fail(msg) { console.error(`[${ts()}] HEARTBEAT FAILED: ${msg}`); }

// ---------------------------------------------------------------- config ---
function loadConfigFile() {
  const p = path.join(AGENT_DIR, 'config.env');
  if (!fs.existsSync(p)) return;
  try {
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let v = m[2].replace(/\s+#.*$/, '').trim();
      v = v.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch {}
}
loadConfigFile();

const GITHUB_PAT = process.env.GITHUB_PAT || '';
const REPO_OWNER = process.env.REPO_OWNER || 'wrcron2';
const REPO_NAME = process.env.REPO_NAME || 'ron-kimi-dasboard';
const LIVE_BRANCH = process.env.LIVE_BRANCH || 'live';
const RELAY_PORT = parseInt(process.env.RELAY_PORT || '8790', 10);
const CODE_SERVER_PORT = parseInt(process.env.CODE_SERVER_PORT || '8080', 10);
const CLAW_PORT = (process.env.CLAW_PORT || '').trim();
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const KIMI_BIN = process.env.KIMI_BIN || 'kimi';
const RELAY_TOKEN = process.env.RELAY_TOKEN || '';   // = dashboard key; encrypts the link.json payload

// --------------------------------------------------------- payload crypto ---
// link.json v3: computer/services/backends are encrypted with the dashboard
// key (RELAY_TOKEN) so the public `live` branch leaks nothing. The dashboard
// decrypts this EXACT format in WebCrypto — do not change the parameters.
const ENC_SALT = 'ron-kimi-dasboard-v1';
const ENC_ITER = 100000;
function encryptPayload(obj, token) {
  const key = crypto.pbkdf2Sync(token, ENC_SALT, ENC_ITER, 32, 'sha256');
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { alg: 'PBKDF2-SHA256-100000/AES-256-GCM',
           nonce: nonce.toString('base64'),
           payload: Buffer.concat([ct, tag]).toString('base64') };
}

// ----------------------------------------------------------------- stats ---
function cpuPercent() {
  const cpus = os.cpus().length || 1;
  const pct = (os.loadavg()[0] / cpus) * 100;
  return Math.round(Math.min(100, Math.max(0, pct)) * 10) / 10;
}
function getBattery() {
  try {
    const out = execFileSync('pmset', ['-g', 'batt'], { timeout: 3000 }).toString();
    const m = out.match(/(\d+)%/);
    if (!m) return null;
    const discharging = /discharging/i.test(out);
    return { percent: parseInt(m[1], 10), charging: !discharging && /charging|AC Power/i.test(out) };
  } catch { return null; }
}
function kimiInstalled() {
  try {
    if (KIMI_BIN.includes('/')) { fs.accessSync(KIMI_BIN, fs.constants.X_OK); return true; }
    return !!execFileSync('which', [KIMI_BIN], { timeout: 3000 }).toString().trim();
  } catch { return false; }
}
function readTunnels() {
  try {
    const j = JSON.parse(fs.readFileSync(TUNNELS_FILE, 'utf8'));
    return (j && j.tunnels) || {};
  } catch { return {}; }
}
function probePort(port) {
  return new Promise((resolve) => {
    if (!port) return resolve(false);
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function buildLinkJson() {
  const tunnels = readTunnels();
  const [relayOk, codeOk, clawOk] = await Promise.all([
    probePort(RELAY_PORT),
    probePort(CODE_SERVER_PORT),
    CLAW_PORT ? probePort(parseInt(CLAW_PORT, 10)) : Promise.resolve(false),
  ]);
  const total = os.totalmem() / (1024 ** 3);
  const used = (os.totalmem() - os.freemem()) / (1024 ** 3);
  const services = [
    { id: 'relay', name: 'Relay + Dashboard', url: (tunnels.relay && tunnels.relay.url) || null, ok: relayOk },
    { id: 'code', name: 'VS Code (Kimi Code)', url: (tunnels.code && tunnels.code.url) || null, ok: codeOk },
  ];
  if (CLAW_PORT) {
    services.push({ id: 'claw', name: 'Ron Claw', url: (tunnels.claw && tunnels.claw.url) || null, ok: clawOk });
  } else {
    services.push({ id: 'claw', name: 'Ron Claw', url: null, ok: false, note: 'not configured' });
  }
  const computer = {
    hostname: os.hostname(),
    os: `macOS ${os.release()} (${os.arch()})`,
    uptimeSec: Math.floor(os.uptime()),
    cpuPercent: cpuPercent(),
    memUsedGB: Math.round(used * 10) / 10,
    memTotalGB: Math.round(total * 10) / 10,
    battery: getBattery(),
  };
  // groq availability = key configured (never expose the key itself)
  const backends = { 'kimi-cli': kimiInstalled(), 'groq': !!GROQ_API_KEY };
  // v3 envelope: updatedAt + host stay plaintext (front-door shows last-seen
  // before unlock); everything else is encrypted with the dashboard key.
  return {
    version: 3,
    updatedAt: new Date().toISOString(),
    host: os.hostname(),
    enc: encryptPayload({ computer, services, backends }, RELAY_TOKEN),
  };
}

// ------------------------------------------------------------ github api ---
function gh(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      method,
      hostname: 'api.github.com',
      path: apiPath,
      headers: {
        'Authorization': `Bearer ${GITHUB_PAT}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ron-kimi-dasboard-heartbeat/2',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: 20000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode || 0, json, raw: data });
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('request timeout')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function explainStatus(status, json) {
  const ghMsg = json && json.message ? ` GitHub says: "${json.message}".` : '';
  if (status === 401) return `GitHub rejected the PAT (401 — expired or revoked?).${ghMsg} Fix: create a new fine-grained PAT at github.com -> Settings -> Developer settings -> Personal access tokens -> Fine-grained tokens, repo access = only ${REPO_OWNER}/${REPO_NAME}, Repository permissions -> Contents: Read and write, Expiration: 1 year (fine-grained PATs default to 30 days and cannot be never-expire). Then update GITHUB_PAT in mac-agent/config.env (or re-run setup.sh).`;
  if (status === 403) return `GitHub returned 403 (forbidden/rate-limited).${ghMsg} Fix: check the PAT has Contents: Read and write on ${REPO_OWNER}/${REPO_NAME}; if rate-limited, wait for the window to reset.`;
  if (status === 404) return `Repo or path not found (404).${ghMsg} Fix: verify REPO_OWNER=${REPO_OWNER} and REPO_NAME=${REPO_NAME} in config.env and that the PAT can see the repo.`;
  if (status === 422) return `GitHub validation failed (422).${ghMsg} Fix: re-run mac-agent/setup.sh to repair config.env.`;
  if (status === 429 || status >= 500) return `GitHub is unavailable/rate-limiting (HTTP ${status}).${ghMsg} Will retry with backoff; no action usually needed.`;
  return `Unexpected GitHub HTTP ${status}.${ghMsg}`;
}

async function ensureBranch() {
  // Create refs/heads/<LIVE_BRANCH> from the default branch sha.
  const repo = await gh('GET', `/repos/${REPO_OWNER}/${REPO_NAME}`);
  if (repo.status !== 200 || !repo.json) throw Object.assign(new Error(explainStatus(repo.status, repo.json)), { status: repo.status });
  const def = repo.json.default_branch || 'main';
  const ref = await gh('GET', `/repos/${REPO_OWNER}/${REPO_NAME}/git/refs/heads/${encodeURIComponent(def)}`);
  if (ref.status !== 200 || !ref.json || !ref.json.object) throw Object.assign(new Error(explainStatus(ref.status, ref.json)), { status: ref.status });
  const sha = ref.json.object.sha;
  const created = await gh('POST', `/repos/${REPO_OWNER}/${REPO_NAME}/git/refs`, {
    ref: `refs/heads/${LIVE_BRANCH}`,
    sha,
  });
  if (created.status !== 201 && created.status !== 422) { // 422 = ref already exists
    throw Object.assign(new Error(explainStatus(created.status, created.json)), { status: created.status });
  }
  info(`created branch '${LIVE_BRANCH}' from '${def}' (${String(sha).slice(0, 7)})`);
}

async function publish(linkJson) {
  const content = Buffer.from(JSON.stringify(linkJson, null, 2) + '\n', 'utf8').toString('base64');
  const encPath = `/repos/${REPO_OWNER}/${REPO_NAME}/contents/link.json`;

  let sha = null;
  const get = await gh('GET', `${encPath}?ref=${encodeURIComponent(LIVE_BRANCH)}`);
  if (get.status === 200 && get.json && get.json.sha) {
    sha = get.json.sha;
  } else if (get.status === 404) {
    await ensureBranch(); // branch (or file) missing: create branch, then PUT without sha
  } else {
    throw Object.assign(new Error(explainStatus(get.status, get.json)), { status: get.status });
  }

  const put = await gh('PUT', encPath, {
    message: 'chore: heartbeat link.json',
    content,
    branch: LIVE_BRANCH,
    ...(sha ? { sha } : {}),
  });
  if (put.status === 200 || put.status === 201) {
    info(`link.json published to ${REPO_OWNER}/${REPO_NAME}@${LIVE_BRANCH}`);
    return;
  }
  throw Object.assign(new Error(explainStatus(put.status, put.json)), { status: put.status });
}

// ------------------------------------------------------------------ main ---
async function main() {
  if (!GITHUB_PAT) {
    fail(`GITHUB_PAT is not set in mac-agent/config.env — link.json was NOT published. Fix: create a fine-grained PAT (repo ${REPO_OWNER}/${REPO_NAME}, Contents: Read and write, Expiration: 1 year) and re-run mac-agent/setup.sh.`);
    return;
  }
  if (!RELAY_TOKEN) {
    fail(`RELAY_TOKEN is not set in mac-agent/config.env — the link.json payload cannot be encrypted (the dashboard unlocks it with the dashboard key). Fix: re-run mac-agent/setup.sh and set a passphrase.`);
    return;
  }
  const linkJson = await buildLinkJson();
  const attempts = [0, 5000, 20000, 60000]; // immediate + backoff on 403/429/5xx
  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    if (attempts[i]) await sleep(attempts[i]);
    try {
      await publish(linkJson);
      return;
    } catch (e) {
      lastErr = e;
      const status = e && e.status;
      const retryable = status === 403 || status === 429 || (status >= 500) || status === undefined;
      if (!retryable || i === attempts.length - 1) break;
      info(`transient GitHub error (HTTP ${status}); retrying in ${attempts[i + 1] / 1000}s…`);
    }
  }
  fail((lastErr && lastErr.message) || 'unknown error');
  process.exitCode = 1;
}

main().catch((e) => {
  fail(`unexpected error: ${e && e.message ? e.message : e}`);
  process.exitCode = 1;
});
