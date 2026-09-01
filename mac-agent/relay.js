#!/usr/bin/env node
'use strict';
/*
 * relay.js — ron-kimi-dasboard Mac relay (CONTRACTS.md v2)
 * Zero npm dependencies. Node >= 18.
 * Serves repo-root index.html + assets/, exposes /api/* REST and a
 * hand-rolled RFC6455 WebSocket chat endpoint at /ws/chat.
 * Chat engines: kimi-cli (spawn) and Groq (HTTPS SSE). Never logs secrets;
 * prompts are truncated to 80 chars in logs.
 */

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile, execFileSync } = require('node:child_process');

// ---------------------------------------------------------------- config ---
const AGENT_DIR = __dirname;
const REPO_ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(AGENT_DIR, 'state');
const TUNNELS_FILE = path.join(STATE_DIR, 'tunnels.json');
const KIMI_SESSIONS_DIR = path.join(STATE_DIR, 'kimi-sessions');

function loadConfigFile() {
  const p = path.join(AGENT_DIR, 'config.env');
  if (!fs.existsSync(p)) return;
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].replace(/\s+#.*$/, '').trim();       // strip inline comment
    v = v.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadConfigFile();

const RELAY_PORT = parseInt(process.env.RELAY_PORT || '8790', 10);
const CODE_SERVER_PORT = parseInt(process.env.CODE_SERVER_PORT || '8080', 10);
const RELAY_TOKEN = process.env.RELAY_TOKEN || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const KIMI_BIN = process.env.KIMI_BIN || 'kimi';
const CLAW_PORT = (process.env.CLAW_PORT || '').trim();
const CLAW_TOKEN = process.env.CLAW_TOKEN || '';
const KIMI_TIMEOUT_MS = 180000;
const MAX_CONCURRENT_CHATS = 4;
const WS_MAX_MESSAGE = 1024 * 1024;                      // 1MB cap per WS message
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

try { fs.mkdirSync(KIMI_SESSIONS_DIR, { recursive: true }); } catch {}

// ---------------------------------------------------------------- logging --
function ts() { return new Date().toISOString(); }
function log(...a) { console.log(`[${ts()}]`, ...a); }
function logErr(...a) { console.error(`[${ts()}]`, ...a); }
function brief(s, n = 80) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// ------------------------------------------------------------------ auth ---
function tokenOk(given) {
  if (!RELAY_TOKEN || !given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(RELAY_TOKEN));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
function bearerFrom(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// ------------------------------------------------------------- host stats --
function cpuPercent() {
  const cpus = os.cpus().length || 1;
  const pct = (os.loadavg()[0] / cpus) * 100;
  return Math.round(Math.min(100, Math.max(0, pct)) * 10) / 10;
}
function memStats() {
  const total = os.totalmem() / (1024 ** 3);
  const used = (os.totalmem() - os.freemem()) / (1024 ** 3);
  return { memUsedGB: Math.round(used * 10) / 10, memTotalGB: Math.round(total * 10) / 10 };
}
function getBattery() {
  try {
    const out = execFileSync('pmset', ['-g', 'batt'], { timeout: 3000 }).toString();
    const m = out.match(/(\d+)%/);
    if (!m) return null;
    const discharging = /discharging/i.test(out);
    return { percent: parseInt(m[1], 10), charging: !discharging && /charging|AC Power/i.test(out) };
  } catch { return null; } // pmset missing/failing (non-macOS) -> null per contract
}

/*
 * kimi-cli detection. NEVER blocks the event loop:
 *  - existence/executability is a synchronous fs check (no child processes):
 *    absolute KIMI_BIN must exist + be executable; a bare name is searched
 *    on PATH the same way (mirrors heartbeat.js kimiInstalled()).
 *  - the `--version` probe runs ASYNC with a hard 3s timeout (SIGKILL), and
 *    its result is cached — the probe repeats at most once every 60s.
 */
let kimiCache = { at: 0, value: { installed: false, version: null } };
let kimiProbing = false;

function resolveKimiBin() {
  try {
    if (KIMI_BIN.includes('/')) {              // explicit path: verify it exists + is executable
      fs.accessSync(KIMI_BIN, fs.constants.X_OK);
      return KIMI_BIN;
    }
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      if (!dir) continue;
      const p = path.join(dir, KIMI_BIN);
      try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
    }
  } catch {}
  return null;
}

function detectKimi() {
  const resolved = resolveKimiBin();
  const installed = !!resolved;
  const now = Date.now();
  if (kimiCache.value.installed !== installed) {
    kimiCache = { at: kimiCache.at, value: { installed, version: null } };
  }
  // Probe at most once per 60s — even when the previous probe failed/timed
  // out (version stays null), so a hung CLI can never spawn probe storms.
  if (installed && !kimiProbing && now - kimiCache.at >= 60000) {
    kimiProbing = true;
    kimiCache = { at: now, value: kimiCache.value };
    execFile(resolved, ['--version'], { timeout: 3000, killSignal: 'SIGKILL' }, (err, stdout) => {
      kimiProbing = false;
      const version = err ? null
        : (String(stdout || '').trim().split('\n')[0].slice(0, 80) || null);
      kimiCache = { at: Date.now(), value: { installed: true, version } };
    });
  }
  return kimiCache.value;
}

function readTunnels() {
  try {
    const j = JSON.parse(fs.readFileSync(TUNNELS_FILE, 'utf8'));
    return (j && j.tunnels) || {};
  } catch { return {}; }
}

// GET probe: is something HTTP-listening on 127.0.0.1:port?
function probePort(port, cb) {
  if (!port) return cb(false);
  const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, (res) => {
    res.resume();
    cb(true);
  });
  req.on('timeout', () => { req.destroy(); cb(false); });
  req.on('error', () => cb(false));
}

function buildServices(cb) {
  const tunnels = readTunnels();
  const defs = [
    { id: 'relay', name: 'Relay + Dashboard', localPort: RELAY_PORT, self: true },
    { id: 'code', name: 'VS Code (Kimi Code)', localPort: CODE_SERVER_PORT },
    { id: 'claw', name: 'Ron Claw', localPort: CLAW_PORT ? parseInt(CLAW_PORT, 10) : null },
  ];
  const out = [];
  let pending = defs.length;
  for (const d of defs) {
    const t = tunnels[d.id] || {};
    const url = t.url || null;
    let openUrl = url;
    if (d.id === 'claw' && url && CLAW_TOKEN) openUrl = `${url}/?token=${CLAW_TOKEN}`;
    const finish = (ok) => {
      out.push({ id: d.id, name: d.name, localPort: d.localPort, ok, url, openUrl });
      if (--pending === 0) {
        out.sort((a, b) => defs.findIndex((x) => x.id === a.id) - defs.findIndex((x) => x.id === b.id));
        cb(out);
      }
    };
    if (d.self) finish(true);
    else if (!d.localPort) finish(false);
    else probePort(d.localPort, finish);
  }
}

// --------------------------------------------------------------- JSON ------
function sendJson(res, code, obj) {
  if (res.writableEnded || res.destroyed) return;   // client already gone (e.g. killed chat)
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
function readBody(req, limit, cb) {
  let size = 0;
  let finished = false;
  const chunks = [];
  const done = (err, body) => {
    if (finished) return;               // guard: destroy/error must not double-fire cb
    finished = true;
    cb(err, body);
  };
  req.on('data', (c) => {
    size += c.length;
    if (size > limit) {
      req.pause();                      // stop the flood; caller sends 413, THEN destroys
      return done(new Error('too_large'));
    }
    chunks.push(c);
  });
  req.on('end', () => done(null, Buffer.concat(chunks).toString('utf8')));
  req.on('error', (e) => done(e));
}

// ---------------------------------------------------------- chat engines ---
let activeChats = 0;

function resolveBackend(requested) {
  if (requested === 'kimi') return detectKimi().installed ? 'kimi-cli' : null;
  if (requested === 'groq') return 'groq';
  // auto
  if (detectKimi().installed) return 'kimi-cli';
  if (GROQ_API_KEY) return 'groq';
  return null;
}

function lastUserPrompt(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === 'user' && typeof messages[i].content === 'string') {
      return messages[i].content;
    }
  }
  const last = messages[messages.length - 1];
  return last && typeof last.content === 'string' ? last.content : '';
}

// Extract a session id from any NDJSON event shape, defensively.
function extractSessionId(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (typeof obj.session_id === 'string') return obj.session_id;
  if (typeof obj.sessionId === 'string') return obj.sessionId;
  if (obj.session && typeof obj.session.id === 'string') return obj.session.id;
  if (obj.session && typeof obj.session.session_id === 'string') return obj.session.session_id;
  if (typeof obj.conversation_id === 'string') return obj.conversation_id;
  return null;
}

// Extract assistant text from common stream-json shapes.
function extractText(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (typeof obj.delta === 'string') return obj.delta;
  if (obj.delta && typeof obj.delta.text === 'string') return obj.delta.text;
  if (typeof obj.text === 'string' && (obj.type === 'assistant' || obj.role === 'assistant' || obj.type === 'text')) return obj.text;
  if (typeof obj.content === 'string' && (obj.type === 'assistant' || obj.role === 'assistant')) return obj.content;
  const msg = obj.message;
  if (msg && typeof msg === 'object') {
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      const parts = msg.content
        .filter((c) => c && typeof c === 'object' && (c.type === 'text' || c.type === 'output_text') && typeof c.text === 'string')
        .map((c) => c.text);
      if (parts.length) return parts.join('');
    }
    if (typeof msg.text === 'string') return msg.text;
  }
  if (Array.isArray(obj.content)) {
    const parts = obj.content
      .filter((c) => c && typeof c === 'object' && typeof c.text === 'string')
      .map((c) => c.text);
    if (parts.length) return parts.join('');
  }
  return null;
}

/*
 * kimi-cli engine: `kimi -p <prompt> --output-format stream-json`
 * (+ `--session <id>` when resuming). Defensive NDJSON parse; raw stdout
 * fallback; SIGTERM on timeout/disconnect.
 * Returns { promise, kill } — promise resolves {text, sessionId} or {error}.
 */
function runKimi({ messages, sessionId, onDelta }) {
  const prompt = lastUserPrompt(messages);
  log(`kimi chat start session=${sessionId ? 'resume' : 'cwd'} prompt="${brief(prompt)}"`);
  const args = ['-p', prompt, '--output-format', 'stream-json'];
  if (sessionId) args.push('--session', sessionId);

  let child;
  try {
    child = spawn(KIMI_BIN, args, { cwd: KIMI_SESSIONS_DIR, env: process.env });
  } catch (e) {
    return { promise: Promise.resolve({ error: `kimi_failed:${brief(e.message, 200)}` }), kill() {} };
  }

  let settled = false;
  let killTimer = null;
  let timeoutFired = false;
  const state = {
    lineBuf: '', rawBuf: '', stderrBuf: '', text: '',
    parsed: 0, gotText: false, sessionId: sessionId || null,
  };

  const promise = new Promise((resolve) => {
    const done = (result) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      try { child.kill('SIGKILL'); } catch {}
      resolve(result);
    };

    const handleLine = (line) => {
      if (!line.trim()) return;
      let obj;
      try { obj = JSON.parse(line); } catch { return; }
      state.parsed++;
      const sid = extractSessionId(obj);
      if (sid && !state.sessionId) state.sessionId = sid;
      const text = extractText(obj);
      if (typeof text === 'string' && text.length) {
        state.gotText = true;
        state.text += text;
        try { onDelta(text); } catch {}
      }
    };

    child.stdout.on('data', (chunk) => {
      const s = chunk.toString('utf8');
      state.rawBuf += s;
      state.lineBuf += s;
      let idx;
      while ((idx = state.lineBuf.indexOf('\n')) >= 0) {
        handleLine(state.lineBuf.slice(0, idx));
        state.lineBuf = state.lineBuf.slice(idx + 1);
      }
    });
    child.stderr.on('data', (chunk) => {
      state.stderrBuf = (state.stderrBuf + chunk.toString('utf8')).slice(-2000);
    });
    child.on('error', (e) => {
      done({ error: `kimi_failed:${brief(e.message, 200)}` });
    });
    child.on('close', (code) => {
      if (state.lineBuf.trim()) handleLine(state.lineBuf);
      if (timeoutFired) return done({ error: 'kimi_timeout' });
      if (state.parsed === 0 && state.rawBuf.trim()) {
        // Fallback: zero structured events -> pipe raw stdout text through.
        const raw = state.rawBuf;
        state.text += raw;
        try { onDelta(raw); } catch {}
        state.gotText = true;
      }
      if (code !== 0 && !state.gotText) {
        return done({ error: `kimi_failed:${brief(state.stderrBuf.trim() || `exit ${code}`, 200)}` });
      }
      done({ text: state.text, sessionId: state.sessionId });
    });

    killTimer = setTimeout(() => {
      timeoutFired = true;
      logErr('kimi chat timeout after 180s — killing child');
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        // Let 'close' fire even if a spawned grandchild keeps our pipes open.
        try { child.stdout.destroy(); child.stderr.destroy(); } catch {}
      }, 3000).unref();
    }, KIMI_TIMEOUT_MS);
    killTimer.unref();
  });

  return {
    promise,
    kill() {
      try { child.kill('SIGTERM'); } catch {}
      // Free the concurrency slot promptly: Node's child 'close' (which
      // resolves the promise) waits for stdio, and a detached grandchild
      // can hold our stdout pipe open — destroy the streams shortly after.
      setTimeout(() => {
        try { child.stdout.destroy(); child.stderr.destroy(); } catch {}
      }, 300).unref();
    },
  };
}

/*
 * groq engine: OpenAI-compatible SSE streaming from api.groq.com.
 * Returns { promise, kill } — promise resolves {text} or {error}.
 */
function runGroq({ messages, onDelta }) {
  if (!GROQ_API_KEY) {
    return { promise: Promise.resolve({ error: 'groq_no_key' }), kill() {} };
  }
  log(`groq chat start model=${GROQ_MODEL} msgs=${messages.length}`);
  const payload = JSON.stringify({ model: GROQ_MODEL, messages, stream: true });
  const url = new URL(GROQ_URL);

  let settled = false;
  let killTimer = null;
  let req = null;
  const state = { buf: '', text: '', errBuf: '', statusCode: 0 };

  const promise = new Promise((resolve) => {
    const done = (result) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (req) try { req.destroy(); } catch {}
      resolve(result);
    };

    const handleDataLine = (data) => {
      if (data === '[DONE]') return;
      let obj;
      try { obj = JSON.parse(data); } catch { return; }
      const delta = obj && obj.choices && obj.choices[0] && obj.choices[0].delta;
      const content = delta && typeof delta.content === 'string' ? delta.content : null;
      if (content) {
        state.text += content;
        try { onDelta(content); } catch {}
      }
    };

    req = https.request({
      method: 'POST',
      hostname: url.hostname,
      path: url.pathname,
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'User-Agent': 'ron-kimi-dasboard-relay/2',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: KIMI_TIMEOUT_MS,
    }, (res) => {
      state.statusCode = res.statusCode || 0;
      if (state.statusCode !== 200) {
        res.on('data', (c) => { state.errBuf = (state.errBuf + c.toString('utf8')).slice(-2000); });
        res.on('end', () => {
          let msg = `groq_http_${state.statusCode}`;
          try {
            const j = JSON.parse(state.errBuf);
            const em = j && j.error && (j.error.message || j.error.code);
            if (em) msg = `groq_failed:${brief(em, 200)}`;
          } catch {}
          done({ error: msg });
        });
        return;
      }
      res.on('data', (chunk) => {
        state.buf += chunk.toString('utf8');
        let idx;
        while ((idx = state.buf.indexOf('\n')) >= 0) {
          const line = state.buf.slice(0, idx).replace(/\r$/, '');
          state.buf = state.buf.slice(idx + 1);
          if (line.startsWith('data:')) handleDataLine(line.slice(5).trim());
        }
      });
      res.on('end', () => {
        if (state.buf.startsWith('data:')) handleDataLine(state.buf.slice(5).trim());
        if (!state.text) return done({ error: 'groq_failed:empty_response' });
        done({ text: state.text });
      });
    });
    req.on('timeout', () => done({ error: 'groq_timeout' }));
    req.on('error', (e) => done({ error: `groq_failed:${brief(e.message, 200)}` }));
    req.write(payload);
    req.end();

    killTimer = setTimeout(() => done({ error: 'groq_timeout' }), KIMI_TIMEOUT_MS);
    killTimer.unref();
  });

  return {
    promise,
    kill() {
      if (req) try { req.destroy(); } catch {}
    },
  };
}

/*
 * Start a chat. onDelta receives text chunks.
 * Returns synchronously: { backend, promise, kill } or { error }.
 * promise resolves {text, sessionId|null, backend} or {error}.
 */
function startChat({ backend, messages, sessionId, onDelta }) {
  if (activeChats >= MAX_CONCURRENT_CHATS) return { error: 'busy' };
  const requested = backend || 'auto';
  const resolved = resolveBackend(requested);
  if (!resolved) {
    if (requested === 'kimi') return { error: 'kimi_not_installed' };
    if (requested === 'groq') return { error: 'groq_no_key' };
    return { error: 'no_backend' };
  }
  if (resolved === 'groq' && !GROQ_API_KEY) return { error: 'groq_no_key' };
  activeChats++;
  const engine = resolved === 'kimi-cli' ? runKimi : runGroq;
  const handle = engine({ messages, sessionId, onDelta });
  const promise = handle.promise
    .then((r) => (r.error ? { error: r.error } : { text: r.text || '', sessionId: r.sessionId || null, backend: resolved }))
    .catch(() => ({ error: 'engine_crash' }))
    .finally(() => { activeChats--; });
  return { backend: resolved, promise, kill: handle.kill };
}

// ------------------------------------------- RFC6455 WebSocket (by hand) ---
function wsAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}
function wsFrame(data, opcode) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}
function wsSendJson(ws, obj) {
  if (ws.dead) return;
  try { ws.socket.write(wsFrame(JSON.stringify(obj), 0x1)); } catch { ws.dead = true; }
}
// Kill every running chat child for this socket and free its concurrency
// slots. Must run on ANY socket end: clean close frame, TCP close, error.
function wsKillChats(ws) {
  if (!ws.chats) return;
  for (const chat of ws.chats.values()) { try { chat.kill(); } catch {} }
  ws.chats.clear();
}
function wsClose(ws, code) {
  wsKillChats(ws);          // clean close frame must not orphan chat children
  if (ws.dead) return;
  ws.dead = true;
  try {
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code || 1000, 0);
    ws.socket.write(wsFrame(payload, 0x8));
    ws.socket.end();
  } catch {}
}

// Incremental frame parser; handles fragmentation, masking, ping/pong/close.
function wsOnData(ws, chunk) {
  ws.buf = ws.buf ? Buffer.concat([ws.buf, chunk]) : chunk;
  for (;;) {
    const buf = ws.buf;
    if (!buf || buf.length < 2) return;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) return;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return;
      len = Number(buf.readBigUInt64BE(2));
      offset = 10;
    }
    // RFC6455 §5.3: ALL client frames MUST be masked — protocol error.
    if (!masked) { wsClose(ws, 1002); return; }
    // Never buffer more than the message cap for a single frame.
    if (len > WS_MAX_MESSAGE) { wsClose(ws, 1009); return; }
    const maskLen = masked ? 4 : 0;
    if (buf.length < offset + maskLen + len) return;
    let payload = buf.slice(offset + maskLen, offset + maskLen + len);
    if (masked) {
      const key = buf.slice(offset, offset + 4);
      const un = Buffer.alloc(len);
      for (let i = 0; i < len; i++) un[i] = payload[i] ^ key[i & 3];
      payload = un;
    }
    ws.buf = buf.slice(offset + maskLen + len);

    if (opcode === 0x8) { wsClose(ws, 1000); return; }          // close
    if (opcode === 0x9) {                                        // ping -> pong
      if (!ws.dead) { try { ws.socket.write(wsFrame(payload, 0xA)); } catch {} }
      continue;
    }
    if (opcode === 0xA) continue;                                // pong
    if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {    // text/bin/continuation
      if (opcode !== 0x0) { ws.fragOp = opcode; ws.frags = []; ws.fragSize = 0; }
      if (ws.frags) {
        ws.fragSize = (ws.fragSize || 0) + payload.length;
        if (ws.fragSize > WS_MAX_MESSAGE) { wsClose(ws, 1009); return; }  // message too big
        ws.frags.push(payload);
      }
      if (fin && ws.frags) {
        const full = Buffer.concat(ws.frags);
        const op = ws.fragOp;
        ws.frags = null;
        if (op === 0x1) handleWsMessage(ws, full.toString('utf8'));
      }
    }
  }
}

function handleWsMessage(ws, text) {
  let msg;
  try { msg = JSON.parse(text); } catch {
    return wsSendJson(ws, { type: 'error', id: null, error: 'bad_json' });
  }
  if (!msg || msg.type !== 'chat') {
    return wsSendJson(ws, { type: 'error', id: (msg && msg.id) || null, error: 'bad_message' });
  }
  const id = typeof msg.id === 'string' ? msg.id : null;
  const messages = Array.isArray(msg.messages) ? msg.messages : null;
  if (!id || !messages || !messages.length) {
    return wsSendJson(ws, { type: 'error', id, error: 'bad_message' });
  }
  const chat = startChat({
    backend: msg.backend,
    sessionId: typeof msg.sessionId === 'string' ? msg.sessionId : null,
    messages,
    onDelta: (delta) => wsSendJson(ws, { type: 'delta', id, delta }),
  });
  if (chat.error) return wsSendJson(ws, { type: 'error', id, error: chat.error });
  ws.chats.set(id, chat);
  chat.promise.then((result) => {
    ws.chats.delete(id);
    if (result.error) wsSendJson(ws, { type: 'error', id, error: result.error });
    else wsSendJson(ws, { type: 'done', id, sessionId: result.sessionId, backend: result.backend });
  });
}

function handleUpgrade(req, socket) {
  const cleanup = (code) => {
    try {
      socket.write(`HTTP/1.1 ${code} ${code === 401 ? 'Unauthorized' : 'Bad Request'}\r\n` +
        'Content-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n' +
        JSON.stringify({ error: code === 401 ? 'unauthorized' : 'bad_request' }));
      socket.destroy();
    } catch {}
  };
  let url;
  try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return cleanup(400); }
  if (url.pathname !== '/ws/chat') return cleanup(400);
  if ((req.headers.upgrade || '').toLowerCase() !== 'websocket') return cleanup(400);
  const key = req.headers['sec-websocket-key'];
  if (!key) return cleanup(400);
  const token = url.searchParams.get('token') || bearerFrom(req);
  if (!tokenOk(token)) return cleanup(401);

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`
  );
  socket.setNoDelay(true);

  const ws = { socket, buf: null, frags: null, fragOp: 0, dead: false, chats: new Map() };
  const pingTimer = setInterval(() => {                     // server ping every 25s
    if (ws.dead) return clearInterval(pingTimer);
    try { socket.write(wsFrame(Buffer.alloc(0), 0x9)); } catch { teardown(); }
  }, 25000);

  const teardown = () => {
    wsKillChats(ws);        // runs even when wsClose already set ws.dead
    if (ws.dead) return;
    ws.dead = true;
    clearInterval(pingTimer);
    try { socket.destroy(); } catch {}
  };
  ws.teardown = teardown;

  socket.on('data', (c) => { if (!ws.dead) wsOnData(ws, c); });
  socket.on('close', teardown);
  socket.on('error', teardown);
  socket.on('end', teardown);
  log('ws client connected');
}

// ------------------------------------------------------------ static -------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
function serveStatic(req, res, pathname) {
  let rel;
  if (pathname === '/' || pathname === '/index.html') rel = 'index.html';
  else if (pathname.startsWith('/assets/')) rel = pathname.slice(1);
  else { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
  let decoded;
  try { decoded = decodeURIComponent(rel); } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' }); return res.end('bad path');
  }
  const abs = path.normalize(path.join(REPO_ROOT, decoded));
  const assetsRoot = path.join(REPO_ROOT, 'assets');
  const allowed = abs === path.join(REPO_ROOT, 'index.html') || abs.startsWith(assetsRoot + path.sep);
  if (!abs.startsWith(REPO_ROOT + path.sep) || !allowed) {  // traversal guard
    res.writeHead(403, { 'Content-Type': 'text/plain' }); return res.end('forbidden');
  }
  fs.readFile(abs, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// -------------------------------------------------------------- routes -----
function handleStatus(res) {
  const kimi = detectKimi();
  buildServices((services) => {
    sendJson(res, 200, {
      ok: true,
      now: new Date().toISOString(),
      host: {
        hostname: os.hostname(),
        os: `macOS ${os.release()} (${os.arch()})`,
        uptimeSec: Math.floor(os.uptime()),
        cpuPercent: cpuPercent(),
        ...memStats(),
        battery: getBattery(),
      },
      kimiCli: { installed: kimi.installed, version: kimi.version },
      services,
      backends: {
        'kimi-cli': { available: kimi.installed },
        'groq': { available: !!GROQ_API_KEY, model: GROQ_MODEL },
      },
    });
  });
}

function handleChatPost(req, res) {
  readBody(req, 1024 * 1024, (err, raw) => {
    if (err) {
      if (err.message === 'too_large') {
        res.on('finish', () => { try { req.socket.destroy(); } catch {} }); // destroy AFTER responding
        return sendJson(res, 413, { error: 'too_large' });
      }
      return sendJson(res, 400, { error: 'bad_body' });
    }
    let body;
    try { body = JSON.parse(raw); } catch { return sendJson(res, 400, { error: 'bad_json' }); }
    const messages = Array.isArray(body.messages) ? body.messages : null;
    if (!messages || !messages.length) return sendJson(res, 400, { error: 'bad_message' });
    const chat = startChat({
      backend: body.backend,
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
      messages,
      onDelta() {},
    });
    if (chat.error) return sendJson(res, chat.error === 'busy' ? 429 : 200, { error: chat.error });
    res.on('close', () => { if (!res.writableEnded) { try { chat.kill(); } catch {} } });
    chat.promise.then((result) => {
      if (result.error) return sendJson(res, 200, { error: result.error });
      sendJson(res, 200, { text: result.text, sessionId: result.sessionId, backend: result.backend });
    });
  });
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://127.0.0.1'); } catch {
    res.writeHead(400); return res.end();
  }
  const p = url.pathname;

  if (req.method === 'OPTIONS') {                            // CORS preflight
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    });
    return res.end();
  }

  if (p === '/api/health' && req.method === 'GET') {         // no auth
    return sendJson(res, 200, { ok: true, service: 'ron-relay', version: 2, time: new Date().toISOString() });
  }

  if (p.startsWith('/api/')) {
    if (!tokenOk(bearerFrom(req))) return sendJson(res, 401, { error: 'unauthorized' });
    if (p === '/api/status' && req.method === 'GET') return handleStatus(res);
    if (p === '/api/chat' && req.method === 'POST') return handleChatPost(req, res);
    return sendJson(res, 404, { error: 'not_found' });
  }

  if (req.method === 'GET') return serveStatic(req, res, p);
  res.writeHead(405, { 'Content-Type': 'text/plain' });
  res.end('method not allowed');
});

server.on('upgrade', handleUpgrade);

server.listen(RELAY_PORT, '127.0.0.1', () => {
  log(`ron-relay v2 listening on http://127.0.0.1:${RELAY_PORT}`);
  log(`serving static from ${REPO_ROOT}`);
  if (!RELAY_TOKEN) logErr('WARNING: RELAY_TOKEN is empty — all authenticated endpoints will return 401. Set it in config.env.');
  const kimi = detectKimi();
  log(`backends: kimi-cli=${kimi.installed ? 'yes' : 'no'} groq=${GROQ_API_KEY ? 'yes' : 'no (no key)'}`);
});
server.on('error', (e) => {
  logErr(`relay fatal: ${e.message}`);
  process.exit(1);
});
