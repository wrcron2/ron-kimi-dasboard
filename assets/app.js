/* ==========================================================================
   Ron — Kimi Dashboard · app.js (vanilla, zero external resources)
   Two modes (see CONTRACTS.md):
     - front-door  : *.github.io  -> status + auto-redirect to relay tunnel
     - full        : any other origin (relay) -> same-origin WS chat + status
   ========================================================================== */
'use strict';

/* ============================ CONFIG ============================
   Every endpoint/URL the dashboard talks to lives in these getters.
   Keep them EXACTLY in sync with CONTRACTS.md.                    */

const CFG = {
  repo: {
    owner: 'wrcron2',
    name: 'ron-kimi-dasboard',
    liveBranch: 'live',
  },
  // Front-door bootstrap: live/link.json (heartbeat every 60s).
  linkJsonRaw() {  // CDN-cached ~5min -> query-string bust
    return 'https://raw.githubusercontent.com/' + this.repo.owner + '/' + this.repo.name +
           '/' + this.repo.liveBranch + '/link.json?ts=' + Date.now();
  },
  linkJsonApi() {  // authoritative, 60 req/hr per IP -> used every 3rd poll
    return 'https://api.github.com/repos/' + this.repo.owner + '/' + this.repo.name +
           '/contents/link.json?ref=' + this.repo.liveBranch;
  },
  // Relay REST (full mode = same-origin).
  apiHealth()  { return '/api/health'; },
  apiStatus()  { return '/api/status'; },
  apiChat()    { return '/api/chat'; },
  // Relay WebSocket (token via ?token= per contract).
  wsChat(token) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host + '/ws/chat?token=' + encodeURIComponent(token);
  },
  // Storage keys
  store: {
    token:   'rkd_token',    // passphrase (per-origin)
    history: 'rkd_history',  // chat history (full origin only)
    session: 'rkd_session',  // current kimi sessionId
    backend: 'rkd_backend',  // backend picker choice
  },
  // Timing / thresholds (contract §live/link.json, §Dashboard)
  frontPollMs: 30000,          // link.json poll cadence (while visible)
  onlineWindowMs: 150000,      // now - updatedAt < 150s  => online
  countdownSec: 5,             // auto-redirect countdown
  statusPollMs: 10000,         // /api/status cadence in full mode
  wsServerIdleExpectMs: 35000, // relay pings every 25s
  failThreshold: 3,            // consecutive failures -> degraded bootstrap
  historyMax: 100,             // persisted messages cap
};

const MODE = (location.hostname === 'github.io' ||
  location.hostname.endsWith('.github.io')) ? 'front-door' : 'full';

/* ============================ HELPERS ============================ */

const $ = (sel) => document.querySelector(sel);

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 15) >> (c === 'x' ? 0 : 1);
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtAgo(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 48) return h + 'h ' + (m % 60) + 'm ago';
  return Math.floor(h / 24) + 'd ago';
}

function fmtUptime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d > 0) return d + 'd ' + h + 'h';
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}

let toastTimer = null;
function toast(msg, kind, ms) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms || 4200);
}

/* Render assistant text: ``` fences -> HTML-escaped <pre>, paragraphs otherwise. */
function renderRich(container, text) {
  container.innerHTML = '';
  const parts = String(text).split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      // fenced code block; strip optional language hint on first line
      let code = part.replace(/^[ \t]*[a-zA-Z0-9_+.-]*\n/, '');
      code = code.replace(/\n$/, '');
      const pre = document.createElement('pre');
      const codeEl = document.createElement('code');
      codeEl.textContent = code; // textContent = inherently escaped
      pre.appendChild(codeEl);
      container.appendChild(pre);
    } else if (part.trim() !== '') {
      part.split(/\n{2,}/).forEach((para) => {
        if (!para.trim()) return;
        const p = document.createElement('p');
        // escape everything, keep single newlines as <br>
        p.innerHTML = esc(para.replace(/^\n+|\n+$/g, '')).replace(/\n/g, '<br>');
        container.appendChild(p);
      });
    }
  });
  if (!container.childNodes.length) container.appendChild(el('p', null, ''));
}

/* ============================ TOKEN / GATE ============================ */

function getToken() {
  try { return localStorage.getItem(CFG.store.token) || ''; } catch (e) { return ''; }
}
function setToken(t) {
  try { localStorage.setItem(CFG.store.token, t); } catch (e) { /* private mode */ }
}
function clearToken() {
  try { localStorage.removeItem(CFG.store.token); } catch (e) { /* noop */ }
}

/* Full mode: consume `#k=<token>` handoff hash from the front door and strip it
   so the token never persists in the URL (contract §Security). */
function consumeHandoffHash() {
  if (!location.hash) return;
  const m = location.hash.match(/[#&]k=([^&]+)/);
  if (m && m[1]) {
    try { setToken(decodeURIComponent(m[1])); } catch (e) { setToken(m[1]); }
  }
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* noop */ }
}

function showGate(errMsg) {
  $('#frontdoor').hidden = true;
  $('#app').hidden = true;
  const gate = $('#gate');
  gate.hidden = false;
  const err = $('#gate-error');
  if (errMsg) { err.textContent = errMsg; err.hidden = false; }
  else err.hidden = true;
  setTimeout(() => $('#gate-input').focus(), 60);
}

function hideGate() { $('#gate').hidden = true; }

function initGate(onUnlocked) {
  $('#gate-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#gate-input').value.trim();
    if (!v) return;
    setToken(v);
    $('#gate-input').value = '';
    hideGate();
    onUnlocked();
  });
}

/* Any 401 anywhere -> wipe token and re-gate with an error. */
function handleUnauthorized() {
  clearToken();
  showGate('Key rejected by the relay — check it and try again.');
}

function forgetKey() {
  clearToken();
  location.reload();
}

/* ==========================================================================
   FRONT-DOOR MODE  (github.io — always up; points at the live relay tunnel)
   ========================================================================== */

const fd = {
  pollCount: 0,
  timer: null,
  countdownTimer: null,
  countdownLeft: 0,
  lastLink: null,
  cancelledUrl: null, // relay URL for which the user cancelled auto-redirect
};

function b64ToUtf8(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

/* ---- link.json v3 decryption (contract §live/link.json) ----
   v3: {"version":3,"updatedAt":…,"host":…,"enc":{"alg":"PBKDF2-SHA256-100000/AES-256-GCM",
        "nonce":"<b64 12B>","payload":"<b64 ciphertext||tag>"}}
   plaintext = JSON {"computer":…,"services":…,"backends":…}, key = dashboard token.
   updatedAt/host stay PLAINTEXT so freshness/last-seen logic works pre/post unlock. */
const linkCrypto = { token: null, key: null }; // derived key cached per token for the session

async function linkJsonKey(token) {
  if (linkCrypto.key && linkCrypto.token === token) return linkCrypto.key;
  const SALT = 'ron-kimi-dasboard-v1', ITER = 100000;
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(token), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: new TextEncoder().encode(SALT), iterations: ITER, hash: 'SHA-256' }, km, 256);
  const key = await crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['decrypt']);
  linkCrypto.token = token;
  linkCrypto.key = key;
  return key;
}

async function decryptPayload(enc, token) {
  const key = await linkJsonKey(token);
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(enc.nonce) }, key, b64(enc.payload));
  return JSON.parse(new TextDecoder().decode(plain));
}

/* Normalize any parsed link.json: v3+enc -> decrypt; v2 legacy -> use as-is.
   A decryption failure means the stored key is wrong -> wipe + re-gate. */
async function resolveLink(parsed) {
  if (parsed && parsed.version >= 3 && parsed.enc) {
    try {
      const plain = await decryptPayload(parsed.enc, getToken());
      return Object.assign({}, parsed, {
        computer: plain.computer,
        services: plain.services,
        backends: plain.backends,
      });
    } catch (e) {
      clearToken();
      linkCrypto.token = null;
      linkCrypto.key = null;
      if (fd.timer) { clearInterval(fd.timer); fd.timer = null; } // stop polling behind the gate
      showGate('Wrong dashboard key — check it and try again.');
      throw new Error('wrong dashboard key');
    }
  }
  return parsed; // v2 legacy plaintext
}

async function fetchLinkJson() {
  fd.pollCount++;
  // Every 3rd poll: authoritative Contents API (base64); else raw CDN with bust.
  if (fd.pollCount % 3 === 0) {
    const r = await fetch(CFG.linkJsonApi(), { headers: { 'Accept': 'application/vnd.github+json' } });
    if (!r.ok) throw new Error('github api ' + r.status);
    const j = await r.json();
    return resolveLink(JSON.parse(b64ToUtf8(j.content)));
  }
  const r = await fetch(CFG.linkJsonRaw(), { cache: 'no-store' });
  if (!r.ok) throw new Error('raw ' + r.status);
  return resolveLink(await r.json());
}

function linkIsOnline(link) {
  if (!link || !link.updatedAt) return false;
  const fresh = (Date.now() - Date.parse(link.updatedAt)) < CFG.onlineWindowMs;
  const relay = (link.services || []).find((s) => s.id === 'relay');
  return !!(fresh && relay && relay.ok && relay.url);
}

function relayUrlOf(link) {
  const relay = (link.services || []).find((s) => s.id === 'relay');
  return relay && relay.url ? relay.url : null;
}

/* Redirect carries the passphrase as a `#k=` hash (never sent to any server);
   the full mode stores it and strips it via history.replaceState. */
function goToRelay(url) {
  const token = getToken();
  location.href = url + (token ? '#k=' + encodeURIComponent(token) : '');
}

function fdStopCountdown() {
  clearInterval(fd.countdownTimer);
  fd.countdownTimer = null;
}

function fdRenderOnline(link) {
  const url = relayUrlOf(link);
  const hero = $('#fd-hero');
  hero.innerHTML = '';
  const row = el('div', 'hero-row');
  row.appendChild(el('span', 'pulse-dot'));
  row.appendChild(el('h2', null, 'Mac is online'));
  hero.appendChild(row);
  hero.appendChild(el('p', 'hero-sub', 'Taking you to the live dashboard…'));
  hero.appendChild(el('span', 'fd-url', url));
  const count = el('div', 'fd-count', String(CFG.countdownSec));
  hero.appendChild(count);
  const actions = el('div', 'fd-actions');
  const cancel = el('button', 'btn btn-ghost', 'Cancel');
  const enter = el('button', 'btn btn-primary', 'Enter now');
  actions.appendChild(cancel);
  actions.appendChild(enter);
  hero.appendChild(actions);

  fdStopCountdown();
  fd.countdownLeft = CFG.countdownSec;
  fd.countdownTimer = setInterval(() => {
    fd.countdownLeft--;
    if (fd.countdownLeft <= 0) { fdStopCountdown(); goToRelay(url); return; }
    count.textContent = String(fd.countdownLeft);
  }, 1000);
  cancel.addEventListener('click', () => {
    fdStopCountdown();
    fd.cancelledUrl = url; // don't restart the countdown on later polls (same tunnel)
    count.textContent = '—';
    hero.querySelector('.hero-sub').textContent = 'Auto-redirect paused. Enter whenever you like.';
  });
  enter.addEventListener('click', () => { fdStopCountdown(); goToRelay(url); });
}

function statCell(k, v) {
  const s = el('div', 'stat');
  s.appendChild(el('div', 'stat-k', k));
  s.appendChild(el('div', 'stat-v', v));
  return s;
}

function batteryStr(b) {
  if (!b) return '—';
  return (b.percent != null ? b.percent + '%' : '?') + (b.charging ? ' ⚡ charging' : '');
}

function fdRenderOffline(link) {
  fdStopCountdown();
  const hero = $('#fd-hero');
  hero.innerHTML = '';
  const row = el('div', 'hero-row');
  row.appendChild(el('span', 'pulse-dot off'));
  row.appendChild(el('h2', null, 'Mac is offline'));
  hero.appendChild(row);
  const sub = link && link.updatedAt
    ? 'Last seen ' + fmtAgo(Date.parse(link.updatedAt)) + '. This page checks again every 30s.'
    : 'No heartbeat data yet. This page checks again every 30s.';
  hero.appendChild(el('p', 'hero-sub', sub));

  const stats = $('#fd-stats');
  const svcs = $('#fd-services');
  if (link) {
    stats.hidden = false;
    stats.innerHTML = '';
    stats.appendChild(el('h3', 'card-title', 'Last known stats'));
    const grid = el('div', 'stat-grid');
    const c = link.computer || {};
    grid.appendChild(statCell('Host', c.hostname || '—'));
    grid.appendChild(statCell('OS', c.os || '—'));
    grid.appendChild(statCell('Uptime', fmtUptime(c.uptimeSec)));
    grid.appendChild(statCell('CPU', c.cpuPercent != null ? Number(c.cpuPercent).toFixed(0) + '%' : '—'));
    grid.appendChild(statCell('Memory',
      (c.memUsedGB != null && c.memTotalGB != null)
        ? Number(c.memUsedGB).toFixed(1) + ' / ' + Number(c.memTotalGB).toFixed(0) + ' GB' : '—'));
    grid.appendChild(statCell('Battery', batteryStr(c.battery)));
    stats.appendChild(grid);

    svcs.hidden = false;
    svcs.innerHTML = '';
    svcs.appendChild(el('h3', 'card-title', 'Services (last heartbeat)'));
    const list = el('div', 'svc-list');
    (link.services || []).forEach((s) => {
      const card = el('div', 'svc-card dim');
      const info = el('div', 'svc-info');
      const name = el('div', 'svc-name');
      name.appendChild(el('span', 'pulse-dot ' + (s.ok ? '' : 'off')));
      name.appendChild(el('span', null, s.name || s.id));
      info.appendChild(name);
      info.appendChild(el('div', 'svc-note', s.note || (s.ok ? 'was up' : 'was down')));
      card.appendChild(info);
      list.appendChild(card);
    });
    svcs.appendChild(list);
  } else {
    stats.hidden = true;
    svcs.hidden = true;
  }
}

async function fdPoll() {
  if (document.visibilityState !== 'visible') return;
  try {
    const link = await fetchLinkJson();
    fd.lastLink = link;
    if (linkIsOnline(link)) {
      // don't reset a running countdown or one the user cancelled for this tunnel
      if (!fd.countdownTimer && fd.cancelledUrl !== relayUrlOf(link)) fdRenderOnline(link);
    } else {
      fdRenderOffline(link);
    }
    $('#fd-meta').textContent =
      'checked ' + fmtTime(Date.now()) + ' · heartbeat ' +
      (link.updatedAt ? fmtAgo(Date.parse(link.updatedAt)) : 'never');
  } catch (e) {
    if (e && e.message === 'wrong dashboard key') return; // gate is up; stay quiet
    // Transient network/GitHub failure — keep showing last data.
    if (!fd.lastLink && !$('#fd-hero').children.length) {
      const hero = $('#fd-hero');
      const row = el('div', 'hero-row');
      row.appendChild(el('span', 'pulse-dot bad'));
      row.appendChild(el('h2', null, 'Can\'t reach GitHub'));
      hero.appendChild(row);
      hero.appendChild(el('p', 'hero-sub',
        'Heartbeat data is unavailable. Retrying every 30s — check your connection.'));
    }
    $('#fd-meta').textContent = 'check failed (' + e.message + ') · retrying…';
  }
}

function startFrontDoor() {
  $('#frontdoor').hidden = false;
  fdPoll();
  if (!fd.timer) fd.timer = setInterval(fdPoll, CFG.frontPollMs);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') fdPoll();
  });
  $('#fd-lock').addEventListener('click', forgetKey);
}

/* ==========================================================================
   FULL MODE  (served by the relay — same-origin WS + REST, token required)
   ========================================================================== */

const app = {
  tab: 'chat',
  statusTimer: null,
  statusFails: 0,
  degraded: false,
  bootstrapTimer: null,
  lastStatus: null,
  // chat
  history: [],
  sessionId: null,
  backend: 'auto',
  sending: false,
};

function authHeaders(extra) {
  const h = { 'Authorization': 'Bearer ' + getToken() };
  return Object.assign(h, extra || {});
}

/* ------------------------------ tabs ------------------------------ */

function switchTab(name) {
  app.tab = name;
  ['chat', 'mac', 'code'].forEach((t) => {
    $('#tab-' + t).hidden = (t !== name);
  });
  document.querySelectorAll('.tabbar-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  if (name === 'mac') pollStatus(true);
  if (name === 'code') renderCodeTab();
  if (name === 'chat') scrollChat();
}

function setConnDot(state) { // 'ok' | 'bad' | null
  const d = $('#conn-dot');
  d.className = 'conn-dot' + (state ? ' ' + state : '');
}

/* ------------------------------ chat ------------------------------ */

function loadChatState() {
  try { app.history = JSON.parse(localStorage.getItem(CFG.store.history) || '[]'); }
  catch (e) { app.history = []; }
  if (!Array.isArray(app.history)) app.history = [];
  try { app.sessionId = localStorage.getItem(CFG.store.session) || null; } catch (e) { app.sessionId = null; }
  try { app.backend = localStorage.getItem(CFG.store.backend) || 'auto'; } catch (e) { app.backend = 'auto'; }
  if (!['auto', 'kimi', 'groq'].includes(app.backend)) app.backend = 'auto';
}

function saveChatState() {
  try {
    localStorage.setItem(CFG.store.history, JSON.stringify(app.history.slice(-CFG.historyMax)));
    if (app.sessionId) localStorage.setItem(CFG.store.session, app.sessionId);
    else localStorage.removeItem(CFG.store.session);
    localStorage.setItem(CFG.store.backend, app.backend);
  } catch (e) { /* storage full / private mode — chat still works in-memory */ }
}

function scrollChat() {
  const list = $('#chat-list');
  list.scrollTop = list.scrollHeight;
  window.scrollTo({ top: document.body.scrollHeight });
}

function bubbleNode(role, ts) {
  const b = el('div', 'msg msg-' + role);
  const body = el('div', 'msg-body');
  b.appendChild(body);
  if (ts) {
    const meta = el('span', 'msg-meta', fmtTime(ts));
    b.appendChild(meta);
  }
  return { bubble: b, body };
}

function paintHistory() {
  const list = $('#chat-list');
  list.innerHTML = '';
  if (!app.history.length) {
    const empty = el('div', 'chat-empty');
    empty.appendChild(el('div', 'big', 'No messages yet'));
    empty.appendChild(el('div', null,
      'Ask your Mac anything. Pick a backend above — Auto prefers the local Kimi CLI.'));
    list.appendChild(empty);
    return;
  }
  app.history.forEach((m) => {
    const { bubble, body } = bubbleNode(m.role === 'user' ? 'user' : 'assistant', m.ts);
    if (m.role === 'user') body.textContent = m.content;
    else renderRich(body, m.content);
    list.appendChild(bubble);
  });
  scrollChat();
}

function addErrorBubble(text) {
  const list = $('#chat-list');
  const b = el('div', 'msg msg-error', text);
  list.appendChild(b);
  scrollChat();
}

/* -------- WebSocket transport (contract §/ws/chat) -------- */

const wsx = {
  ws: null,
  state: 'closed',       // closed | connecting | open
  failCount: 0,          // CONSECUTIVE WS failures -> POST /api/chat fallback at >=2 (contract)
  pending: null,         // in-flight { id, payload, body, bubble, text }
  queued: null,          // { payload, pending } waiting for a working socket (1st failure)
  backoff: 1000,
  retryTimer: null,
  idleTimer: null,       // server-silence watchdog (CFG.wsServerIdleExpectMs)
};

function wsSetState(s) {
  wsx.state = s;
  setConnDot(s === 'open' ? 'ok' : (s === 'connecting' ? null : 'bad'));
}

/* Server-silence watchdog: the relay frames (incl. its 25s ping cadence) should
   never leave the socket quiet for wsServerIdleExpectMs. If it does, the socket
   is dead-but-open -> close it to trigger the reconnect backoff. */
function wsArmWatchdog() {
  clearTimeout(wsx.idleTimer);
  wsx.idleTimer = setTimeout(() => {
    try { if (wsx.ws) wsx.ws.close(); } catch (e) { /* noop */ }
  }, CFG.wsServerIdleExpectMs);
}

/* One WS failure: 1st consecutive -> queue the message and reconnect;
   2nd consecutive -> POST /api/chat fallback (contract §Dashboard/Chat).
   Counter resets on any successful WS round-trip. */
function wsHandleFailure(payload, pending) {
  wsx.failCount++;
  if (wsx.failCount >= 2) {
    wsx.failCount = 0;
    wsx.queued = null;
    postChatFallback(payload, pending);
    return;
  }
  wsx.queued = { payload: payload, pending: pending };
  wsConnect(true); // kick an immediate reconnect to deliver the queued message
}

/* Try to flush a queued message over an open socket. */
function wsFlushQueue() {
  const q = wsx.queued;
  if (!q) return;
  wsx.queued = null;
  try {
    wsx.pending = q.pending;
    wsx.ws.send(JSON.stringify(q.payload));
  } catch (e) {
    wsx.pending = null;
    wsHandleFailure(q.payload, q.pending);
  }
}

function wsConnect(immediate) {
  if (wsx.state === 'open' || wsx.state === 'connecting') return;
  if (!immediate) {
    clearTimeout(wsx.retryTimer);
    wsx.retryTimer = setTimeout(() => wsConnect(true), wsx.backoff);
    wsx.backoff = Math.min(wsx.backoff * 2, 15000);
    return;
  }
  clearTimeout(wsx.retryTimer);
  let sock;
  try { sock = new WebSocket(CFG.wsChat(getToken())); }
  catch (e) {
    wsSetState('closed');
    if (wsx.queued) { const q = wsx.queued; wsx.queued = null; wsHandleFailure(q.payload, q.pending); }
    return;
  }
  wsx.ws = sock;
  wsSetState('connecting');

  sock.onopen = () => { wsSetState('open'); wsx.backoff = 1000; wsArmWatchdog(); wsFlushQueue(); };
  sock.onmessage = (ev) => {
    wsArmWatchdog(); // any server frame proves the socket is alive
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (!wsx.pending || msg.id !== wsx.pending.id) return;
    if (msg.type === 'delta') {
      wsx.pending.text += msg.delta || '';
      renderRich(wsx.pending.body, wsx.pending.text);
      const cur = el('span', 'cursor');
      wsx.pending.body.appendChild(cur);
      scrollChat();
    } else if (msg.type === 'done') {
      wsx.failCount = 0; // successful WS round-trip
      finalizeAssistant(wsx.pending, msg);
      wsx.pending = null;
    } else if (msg.type === 'error') {
      wsx.failCount = 0; // server answered -> transport works
      failAssistant(wsx.pending, msg.error || 'unknown_error');
      wsx.pending = null;
    }
  };
  sock.onclose = () => {
    clearTimeout(wsx.idleTimer);
    const wasPending = wsx.pending;
    wsx.ws = null;
    wsSetState('closed');
    wsx.pending = null;
    if (wasPending) {
      // Socket died mid-reply -> counts as a WS failure (retry once, then POST).
      wsHandleFailure(wasPending.payload, wasPending);
      return;
    }
    if (wsx.queued) {
      // Reconnect attempt itself failed while a message was queued.
      const q = wsx.queued;
      wsx.queued = null;
      wsHandleFailure(q.payload, q.pending);
      return;
    }
    wsConnect(false); // reconnect with backoff
  };
  sock.onerror = () => { /* onclose follows */ };
}

function backendLabel(b) {
  return b === 'kimi' ? 'Kimi (Mac)' : b === 'groq' ? 'Free Cloud' : 'Auto';
}

function friendlyChatError(code) {
  const map = {
    busy: '4 chats already running — wait a moment.',
    no_backend: 'No chat brain available — check kimi CLI / Groq key on your Mac.',
    kimi_not_installed: 'Kimi Code CLI isn\'t installed on your Mac — install it or use Free Cloud.',
    kimi_timeout: 'Kimi Code took too long — try again with a shorter request.',
    groq_no_key: 'Free Cloud needs a Groq key in config.env on your Mac.',
    groq_timeout: 'Free Cloud took too long — try again.',
    engine_crash: 'The chat engine on your Mac crashed — it restarts itself; try again.',
    connection_lost: 'Connection to the Mac dropped mid-reply. Reconnecting…',
  };
  if (map[code]) return map[code];
  if (code && code.indexOf('kimi_failed') === 0)
    return 'Kimi Code hit an error — try again or switch backend.';
  if (code && code.indexOf('groq_failed') === 0)
    return 'Free Cloud hit an error — try again or switch backend.';
  return 'Something went wrong (' + (code || 'unknown') + ').';
}

function finalizeAssistant(pending, done) {
  pending.bubble.querySelectorAll('.cursor').forEach((c) => c.remove());
  const text = pending.text || '(empty reply)';
  renderRich(pending.body, text);
  const meta = pending.bubble.querySelector('.msg-meta');
  if (meta) {
    meta.textContent = fmtTime(Date.now()) +
      (done && done.backend ? ' · ' + done.backend : '');
  }
  app.history.push({ role: 'assistant', content: text, ts: Date.now() });
  if (app.history.length > CFG.historyMax) app.history = app.history.slice(-CFG.historyMax);
  if (done && done.sessionId) app.sessionId = done.sessionId;
  app.sending = false;
  $('#chat-send').disabled = false;
  saveChatState();
  scrollChat();
}

function failAssistant(pending, code) {
  if (pending && pending.bubble) pending.bubble.remove();
  app.sending = false;
  $('#chat-send').disabled = false;
  addErrorBubble(friendlyChatError(code));
}

/* POST /api/chat fallback (non-streaming, contract §Relay) */
async function postChatFallback(payload, pending) {
  try {
    const r = await fetch(CFG.apiChat(), {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        messages: payload.messages,
        backend: payload.backend,
        sessionId: payload.sessionId,
      }),
    });
    if (r.status === 401) { failAssistant(pending, 'unauthorized'); handleUnauthorized(); return; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) { failAssistant(pending, j.error || ('http_' + r.status)); return; }
    pending.text = j.text || '';
    finalizeAssistant(pending, { backend: j.backend, sessionId: j.sessionId });
  } catch (e) {
    failAssistant(pending, 'network');
  }
}

function sendChat(text) {
  if (app.sending || !text) return;
  app.sending = true;
  $('#chat-send').disabled = true;

  const msg = { role: 'user', content: text, ts: Date.now() };
  app.history.push(msg);
  saveChatState();

  const list = $('#chat-list');
  const empty = list.querySelector('.chat-empty');
  if (empty) empty.remove();
  const u = bubbleNode('user', msg.ts);
  u.body.textContent = text;
  list.appendChild(u.bubble);

  const a = bubbleNode('assistant', Date.now());
  const cur = el('span', 'cursor');
  a.body.appendChild(cur);
  list.appendChild(a.bubble);
  scrollChat();

  const payload = {
    type: 'chat',
    id: uuid(),
    backend: app.backend,
    sessionId: app.sessionId,
    messages: app.history.slice(-CFG.historyMax).map((m) => ({ role: m.role, content: m.content })),
  };
  const pending = { id: payload.id, payload: payload, body: a.body, bubble: a.bubble, text: '' };

  // Contract: POST /api/chat fallback only after the WS fails TWICE in a row.
  if (wsx.state === 'open' && wsx.ws) {
    try {
      wsx.pending = pending;
      wsx.ws.send(JSON.stringify(payload));
      return;
    } catch (e) {
      wsx.pending = null;
    }
  }
  // Socket not usable (or send threw): 1st failure queues + reconnects,
  // 2nd consecutive failure falls back to POST /api/chat.
  wsHandleFailure(payload, pending);
}

function initChat() {
  loadChatState();
  paintHistory();

  document.querySelectorAll('.seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.backend === app.backend);
    b.addEventListener('click', () => {
      app.backend = b.dataset.backend;
      document.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('active', x === b));
      saveChatState();
    });
  });

  $('#chat-new').addEventListener('click', () => {
    app.history = [];
    app.sessionId = null;
    saveChatState();
    paintHistory();
    toast('New chat started', 'ok', 2200);
  });

  const input = $('#chat-input');
  const autosize = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  };
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    // Enter sends (desktop); Shift+Enter newline. On touch keyboards use the button.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer:fine)').matches) {
      e.preventDefault();
      $('#chat-form').requestSubmit();
    }
  });

  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    autosize();
    sendChat(text);
  });

  wsConnect(true); // warm the socket
}

/* ------------------------------ mac tab ------------------------------ */

function renderMacWaiting(note) {
  const msg = note || 'connecting to the relay…';
  const hero = $('#mac-hero');
  hero.innerHTML = '';
  hero.appendChild(el('span', 'pulse-dot off'));
  const txt = el('div', 'hero-txt');
  txt.appendChild(el('h2', null, 'My Mac'));
  txt.appendChild(el('p', null, msg));
  hero.appendChild(txt);
  const stats = $('#mac-stats');
  stats.innerHTML = '';
  stats.appendChild(el('p', 'meta-line',
    note || 'Waiting for the first status update — if this persists, check the agent on the Mac.'));
  const svcs = $('#mac-services');
  svcs.innerHTML = '';
  svcs.appendChild(el('p', 'meta-line', msg));
  $('#mac-meta').textContent = 'last updated —';
}

function bar(label, pct, text, isHot) {
  const row = el('div', 'bar-row');
  const lab = el('div', 'bar-label');
  lab.appendChild(el('span', null, label));
  lab.appendChild(el('span', 'mono', text));
  row.appendChild(lab);
  const track = el('div', 'bar');
  const hot = typeof isHot === 'function' ? isHot(pct) : pct >= 85;
  const fill = el('div', 'bar-fill' + (hot ? ' hot' : ''));
  fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
  track.appendChild(fill);
  row.appendChild(track);
  return row;
}

function renderMacTab(s) {
  const host = s.host || {};
  const hero = $('#mac-hero');
  hero.innerHTML = '';
  hero.appendChild(el('span', 'pulse-dot'));
  const txt = el('div', 'hero-txt');
  txt.appendChild(el('h2', null, host.hostname || 'Mac'));
  txt.appendChild(el('p', null, (host.os || '—') + ' · up ' + fmtUptime(host.uptimeSec)));
  hero.appendChild(txt);
  const badge = el('span', 'badge badge-on', 'Online');
  hero.appendChild(badge);

  const stats = $('#mac-stats');
  stats.innerHTML = '';
  const cpu = Number(host.cpuPercent || 0);
  const memUsed = Number(host.memUsedGB || 0), memTotal = Number(host.memTotalGB || 0);
  stats.appendChild(bar('CPU', cpu, cpu.toFixed(0) + '%'));
  const memPct = memTotal > 0 ? (memUsed / memTotal) * 100 : 0;
  stats.appendChild(bar('Memory', memPct, memUsed.toFixed(1) + ' / ' + memTotal.toFixed(0) + ' GB'));
  if (host.battery) {
    const b = host.battery;
    stats.appendChild(bar('Battery', b.percent != null ? b.percent : 0,
      batteryStr(b), (p) => p <= 20)); // red only when LOW, not when full
  }
  const kc = s.kimiCli || {};
  const info = el('p', 'meta-line',
    'kimi-cli ' + (kc.installed ? (kc.version || 'installed') : 'not found') +
    ' · groq ' + (s.backends && s.backends.groq && s.backends.groq.available ? 'ready' : 'no key'));
  stats.appendChild(info);

  const list = $('#mac-services');
  list.innerHTML = '';
  (s.services || []).forEach((svc) => {
    const card = el('div', 'svc-card' + (svc.ok ? '' : ' dim'));
    const infoEl = el('div', 'svc-info');
    const name = el('div', 'svc-name');
    name.appendChild(el('span', 'pulse-dot ' + (svc.ok ? '' : 'off')));
    name.appendChild(el('span', null, svc.name || svc.id));
    infoEl.appendChild(name);
    if (svc.url) infoEl.appendChild(el('div', 'svc-url', svc.url));
    if (!svc.ok) infoEl.appendChild(el('div', 'svc-note', svc.note || 'not running'));
    card.appendChild(infoEl);
    const open = el('button', 'btn btn-sm ' + (svc.ok && svc.openUrl ? 'btn-primary' : 'btn-ghost'), 'Open');
    if (!svc.ok || !svc.openUrl) open.disabled = true;
    else open.addEventListener('click', () => window.open(svc.openUrl, '_blank', 'noopener'));
    card.appendChild(open);
    list.appendChild(card);
  });

  $('#mac-meta').textContent = 'last updated ' + (s.now ? fmtTime(Date.parse(s.now)) : fmtTime(Date.now()));
}

async function pollStatus(force) {
  if (!force && document.visibilityState !== 'visible') return;
  if (app.degraded) return; // bootstrap loop owns recovery
  try {
    const r = await fetch(CFG.apiStatus(), { headers: authHeaders(), cache: 'no-store' });
    if (r.status === 401) { handleUnauthorized(); return; }
    if (!r.ok) throw new Error('http ' + r.status);
    const j = await r.json();
    app.lastStatus = j;
    app.statusFails = 0;
    renderMacTab(j);
    if (app.tab === 'code') renderCodeTab();
  } catch (e) {
    app.statusFails++;
    if (!app.lastStatus) {
      // No data yet — never leave empty card shells.
      renderMacWaiting('Relay unreachable — retrying…');
    } else {
      // Keep last-known data, but say plainly that it's stale.
      $('#mac-meta').textContent = 'Relay unreachable — retrying… · showing last-known data from ' +
        (app.lastStatus.now ? fmtTime(Date.parse(app.lastStatus.now)) : 'earlier');
    }
    if (app.statusFails >= CFG.failThreshold) enterDegraded();
  }
}

/* ------------------------------ code tab ------------------------------ */

function isTouchDevice() {
  return ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0;
}
function isDesktopUA() {
  return !/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function codeService() {
  const svcs = (app.lastStatus && app.lastStatus.services) || [];
  return svcs.find((s) => s.id === 'code') || null;
}

function renderCodeTab() {
  const svc = codeService();
  const btn = $('#code-open');
  const status = $('#code-status');
  if (svc && svc.ok && svc.openUrl) {
    btn.disabled = false;
    btn.onclick = () => window.open(svc.openUrl, '_blank', 'noopener');
    status.textContent = 'running · ' + svc.openUrl;
  } else {
    btn.disabled = true;
    btn.onclick = null;
    status.textContent = svc
      ? 'VS Code is not reachable right now' + (svc.note ? ' — ' + svc.note : '')
      : 'waiting for status…';
  }
  // iframe embed: desktop-class, non-touch only (Apple blocks iframe logins).
  $('#code-embed-wrap').hidden = !(isDesktopUA() && !isTouchDevice());
}

function initCodeTab() {
  $('#code-embed-toggle').addEventListener('click', () => {
    const wrap = $('#code-frame-wrap');
    const frame = $('#code-frame');
    const btn = $('#code-embed-toggle');
    if (wrap.hidden) {
      const svc = codeService();
      if (!svc || !svc.openUrl) { toast('VS Code tunnel is not up yet.', 'err'); return; }
      if (!frame.src) frame.src = svc.openUrl;
      wrap.hidden = false;
      btn.textContent = 'Close embed';
    } else {
      wrap.hidden = true;
      btn.textContent = 'Try embedding (experimental — if it asks for a password forever, use Open VS Code instead)';
    }
  });
}

/* -------------------- degraded / bootstrap recovery --------------------
   Relay unreachable (3 consecutive status failures) -> toast + watch
   live/link.json for a fresh tunnel URL (tunnels change on restart).     */

function enterDegraded() {
  if (app.degraded) return;
  app.degraded = true;
  clearInterval(app.statusTimer);
  toast('Lost contact with the Mac — watching for it to come back…', 'err', 6000);
  bootstrapPoll();
  app.bootstrapTimer = setInterval(bootstrapPoll, CFG.frontPollMs);
}

function exitDegraded() {
  if (!app.degraded) return;
  app.degraded = false;
  app.statusFails = 0;
  clearInterval(app.bootstrapTimer);
  toast('Mac is back online', 'ok');
  pollStatus(true);
  app.statusTimer = setInterval(pollStatus, CFG.statusPollMs);
}

async function bootstrapPoll() {
  let link = null;
  try { link = await fetchLinkJson(); } catch (e) { return; } // GitHub down too — retry next tick
  if (!linkIsOnline(link)) return;
  const url = relayUrlOf(link);
  if (!url) return;
  const mine = location.origin;
  if (url.replace(/\/$/, '') !== mine.replace(/\/$/, '')) {
    // Tunnel restarted under a new URL — hand off the key via #k= hash.
    goToRelay(url);
    return;
  }
  // Same origin: probe health, resume when it answers.
  try {
    const r = await fetch(CFG.apiHealth(), { cache: 'no-store' });
    if (r.ok) exitDegraded();
  } catch (e) { /* still down */ }
}

/* ------------------------------ boot ------------------------------ */

function startFull() {
  $('#app').hidden = false;
  document.querySelectorAll('.tabbar-btn').forEach((b) => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
  });
  $('#app-lock').addEventListener('click', forgetKey);
  initChat();
  initCodeTab();
  switchTab('chat');
  renderMacWaiting();
  pollStatus(true);
  app.statusTimer = setInterval(pollStatus, CFG.statusPollMs);
}

/* Re-gate after a 401 (or a wrong decryption key) must NOT re-run full init:
   that would stack duplicate pollers + listeners. First unlock does full init;
   later re-unlocks just resume polling. */
let started = false;

function onUnlocked() {
  hideGate();
  if (MODE === 'front-door') {
    if (started) { if (!fd.timer) fd.timer = setInterval(fdPoll, CFG.frontPollMs); fdPoll(); return; }
    started = true;
    startFrontDoor();
  } else {
    if (started) { pollStatus(true); return; }
    started = true;
    startFull();
  }
}

function boot() {
  if (MODE === 'full') consumeHandoffHash();
  initGate(onUnlocked);
  if (!getToken()) showGate();
  else onUnlocked();
}

document.addEventListener('DOMContentLoaded', boot);
