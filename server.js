import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { db, save, flush } from './lib/store.js';
import * as core from './lib/core.js';
import { computeAnalytics } from './lib/analytics.js';
import { HttpError, chatBotPaused } from './lib/core.js';
import * as telegram from './lib/channels/telegram.js';
import * as meta from './lib/channels/meta.js';
import * as whatsapp from './lib/channels/whatsapp.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const SESSION_MS = 30 * 24 * 3600 * 1000;
const STATUSES = ['new', 'confirmed', 'out_for_delivery', 'delivered', 'cancelled'];

// ---------- helpers ----------
const now = () => Date.now();
const uid = () => crypto.randomBytes(5).toString('hex');
const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const list = (v, max = 40) => (Array.isArray(v) ? v.map((x) => str(x, 80)).filter(Boolean).slice(0, max) : []);

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const a = crypto.scryptSync(pw, salt, 64);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const pubUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function currentUser(req) {
  const sid = parseCookies(req).sid;
  const s = sid && db.sessions[sid];
  if (!s || s.exp < now()) return null;
  return db.users.find((u) => u.id === s.userId) || null;
}
function startSession(req, res, user) {
  const sid = crypto.randomBytes(32).toString('hex');
  db.sessions[sid] = { userId: user.id, exp: now() + SESSION_MS };
  const secure = req.headers['x-forwarded-proto'] === 'https' || process.env.COOKIE_SECURE === '1';
  res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`);
  save();
}
function clientIp(req) {
  if (TRUST_PROXY) return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
  return req.socket.remoteAddress;
}
const attempts = new Map();
function throttle(req) {
  const ip = clientIp(req);
  const rec = attempts.get(ip);
  if (rec && rec.reset > now() && rec.n >= 10) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
  return ip;
}
function failAttempt(ip) {
  const rec = attempts.get(ip);
  if (!rec || rec.reset < now()) attempts.set(ip, { n: 1, reset: now() + 10 * 60000 });
  else rec.n += 1;
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------- serializers ----------
function chatSummary(c) {
  const visible = [...c.messages].reverse().find((m) => m.dir !== 'sys');
  return {
    id: c.id, channel: c.channel, name: c.name, last: c.last, unread: c.unread,
    needsAttention: c.needsAttention, resolved: c.resolved, botPaused: chatBotPaused(c),
    preview: visible ? visible.text.slice(0, 120) : '', lastBot: !!visible?.bot
  };
}
function chatDetail(c) {
  const idDisplay = c.channel === 'whatsapp' ? '+' + c.externalId.split('@')[0] : c.externalId;
  return {
    ...chatSummary(c), externalId: idDisplay, notes: c.notes, tags: c.tags, createdAt: c.createdAt,
    pausedUntil: c.pausedUntil, inOrderFlow: !!c.orderState, messages: c.messages.slice(-200)
  };
}

function cleanSettings(input) {
  const s = db.settings;
  const out = { ...s };
  if (typeof input.brandName === 'string') out.brandName = str(input.brandName, 60) || s.brandName;
  if (/^#[0-9a-f]{6}$/i.test(input.accent || '')) out.accent = input.accent;
  if (typeof input.currency === 'string') out.currency = str(input.currency, 8) || s.currency;
  if (typeof input.paymentNote === 'string') out.paymentNote = str(input.paymentNote, 80) || s.paymentNote;
  if (typeof input.botEnabled === 'boolean') out.botEnabled = input.botEnabled;
  if (Number.isFinite(Number(input.pauseMinutes))) out.pauseMinutes = Math.min(1440, Math.max(0, Math.round(Number(input.pauseMinutes))));
  for (const k of ['greeting', 'fallback', 'handoffReply']) if (typeof input[k] === 'string') out[k] = str(input[k], 1000) || s[k];
  if (Array.isArray(input.orderKeywords)) out.orderKeywords = list(input.orderKeywords);
  if (Array.isArray(input.humanKeywords)) out.humanKeywords = list(input.humanKeywords);
  if (Array.isArray(input.rules)) {
    out.rules = input.rules.slice(0, 100).map((r) => ({ id: str(r?.id, 20) || uid(), keywords: list(r?.keywords), reply: str(r?.reply, 1000) })).filter((r) => r.keywords.length && r.reply);
  }
  if (Array.isArray(input.catalog)) {
    out.catalog = input.catalog.slice(0, 200).map((p) => ({ id: str(p?.id, 20) || uid(), name: str(p?.name, 80), price: Math.max(0, Number(p?.price) || 0) })).filter((p) => p.name);
  }
  return out;
}

// ---------- routes ----------
const routes = [];
const route = (method, pattern, handler, opts = {}) =>
  routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, opts });
const admin = { admin: true };
const open = { auth: false };

route('GET', '/api/session', ({ user }) => ({ user: user && pubUser(user), needsSetup: db.users.length === 0, brandName: db.settings.brandName }), open);

route('POST', '/api/setup', ({ req, res, body }) => {
  if (db.users.length) throw new HttpError(403, 'Setup is already done');
  const name = str(body.name, 60), email = str(body.email, 120).toLowerCase(), password = String(body.password || '');
  if (!name || !/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, 'Enter your name and a valid email');
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  const user = { id: uid(), name, email, role: 'admin', pass: hashPassword(password) };
  db.users.push(user);
  if (str(body.brandName, 60)) db.settings.brandName = str(body.brandName, 60);
  startSession(req, res, user);
  return { user: pubUser(user) };
}, open);

route('POST', '/api/login', ({ req, res, body }) => {
  const ip = throttle(req);
  const email = str(body.email, 120).toLowerCase();
  const user = db.users.find((u) => u.email === email);
  if (!user || !checkPassword(String(body.password || ''), user.pass)) { failAttempt(ip); throw new HttpError(401, 'Wrong email or password'); }
  startSession(req, res, user);
  return { user: pubUser(user) };
}, open);

route('POST', '/api/logout', ({ req, res }) => {
  const sid = parseCookies(req).sid;
  if (sid) { delete db.sessions[sid]; save(); }
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  return { ok: true };
}, open);

route('GET', '/api/events', ({ req, res }) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(': connected\n\n');
  core.sseClients.add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 25000);
  req.on('close', () => { clearInterval(ping); core.sseClients.delete(res); });
  return undefined;
}, { stream: true });

// chats
route('GET', '/api/chats', () => Object.values(db.chats).sort((a, b) => b.last - a.last).slice(0, 300).map(chatSummary));

route('GET', '/api/chats/:id', ({ params }) => {
  const c = db.chats[decodeURIComponent(params.id)];
  if (!c) throw new HttpError(404, 'Conversation not found');
  if (c.unread) { c.unread = 0; save(); core.broadcast(); }
  return chatDetail(c);
});

route('POST', '/api/chats/:id/send', async ({ params, body, user }) => {
  const text = str(body.text, 4000);
  if (!text) throw new HttpError(400, 'Message is empty');
  await core.agentSend(decodeURIComponent(params.id), text, user);
  return { ok: true };
});

route('POST', '/api/chats/:id/resolve', ({ params, body }) => {
  const c = db.chats[decodeURIComponent(params.id)];
  if (!c) throw new HttpError(404, 'Conversation not found');
  c.resolved = !!body.resolved;
  if (c.resolved) { c.needsAttention = false; c.botPaused = false; c.pausedUntil = 0; c.orderState = null; }
  save(); core.broadcast();
  return { ok: true };
});

route('POST', '/api/chats/:id/bot', ({ params, body }) => {
  const c = db.chats[decodeURIComponent(params.id)];
  if (!c) throw new HttpError(404, 'Conversation not found');
  if (body.paused) c.botPaused = true;
  else { c.botPaused = false; c.pausedUntil = 0; }
  save(); core.broadcast();
  return { ok: true };
});

route('PATCH', '/api/chats/:id', ({ params, body }) => {
  const c = db.chats[decodeURIComponent(params.id)];
  if (!c) throw new HttpError(404, 'Conversation not found');
  if (typeof body.notes === 'string') c.notes = str(body.notes, 2000);
  if (Array.isArray(body.tags)) c.tags = list(body.tags, 12);
  save();
  return { ok: true };
});

// orders
route('GET', '/api/orders', () => db.orders.slice(0, 500));

route('POST', '/api/orders', ({ body }) => {
  const items = (Array.isArray(body.items) ? body.items : []).map((i) => {
    const p = db.settings.catalog.find((c) => c.id === i?.id);
    const qty = Math.min(99, Math.max(0, parseInt(i?.qty, 10) || 0));
    return p && qty ? { id: p.id, name: p.name, price: p.price, qty } : null;
  }).filter(Boolean);
  if (!items.length) throw new HttpError(400, 'Add at least one product');
  const name = str(body.name, 80);
  if (!name) throw new HttpError(400, 'Customer name is required');
  const order = core.createOrder({ items, address: str(body.address, 300), name });
  save(); core.broadcast();
  return order;
});

route('POST', '/api/orders/:id/status', async ({ params, body }) => {
  const order = db.orders.find((o) => o.id === params.id);
  if (!order) throw new HttpError(404, 'Order not found');
  if (!STATUSES.includes(body.status)) throw new HttpError(400, 'Invalid status');
  const notified = await core.setOrderStatus(order, body.status, !!body.notify);
  return { order, notified };
});

route('GET', '/api/analytics', ({ url }) => computeAnalytics(db, {
  days: url.searchParams.get('days'), tzOffsetMin: url.searchParams.get('tz')
}), admin);

// settings / channels / team
route('GET', '/api/settings', () => db.settings);
route('PUT', '/api/settings', ({ body }) => {
  db.settings = cleanSettings(body);
  save(); core.broadcast();
  return db.settings;
}, admin);

function channelsStatus() {
  const m = db.channels.meta;
  return {
    whatsapp: whatsapp.getStatus(),
    telegram: { ...telegram.status, configured: !!db.channels.telegram.token },
    meta: { configured: !!m.pageToken, hasSecret: !!m.appSecret, verifyToken: m.verifyToken, webhookPath: '/webhook/meta' }
  };
}
route('GET', '/api/channels', channelsStatus, admin);
route('PUT', '/api/channels', async ({ body }) => {
  if (typeof body.telegramToken === 'string') {
    db.channels.telegram.token = str(body.telegramToken, 200);
    save();
    await telegram.start();
  }
  const m = body.meta;
  if (m && typeof m === 'object') {
    if (typeof m.pageToken === 'string') db.channels.meta.pageToken = str(m.pageToken, 1000);
    if (typeof m.appSecret === 'string') db.channels.meta.appSecret = str(m.appSecret, 200);
    if (typeof m.verifyToken === 'string' && str(m.verifyToken, 100)) db.channels.meta.verifyToken = str(m.verifyToken, 100);
    save();
    meta.configure();
  }
  core.broadcast();
  return channelsStatus();
}, admin);
route('POST', '/api/channels/whatsapp/connect', async () => { await whatsapp.connect(); return whatsapp.getStatus(); }, admin);
route('POST', '/api/channels/whatsapp/disconnect', async () => { await whatsapp.disconnect(); return whatsapp.getStatus(); }, admin);

route('GET', '/api/team', () => db.users.map(pubUser), admin);
route('POST', '/api/team', ({ body }) => {
  const name = str(body.name, 60), email = str(body.email, 120).toLowerCase(), password = String(body.password || '');
  if (!name || !/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, 'Enter a name and a valid email');
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  if (db.users.some((u) => u.email === email)) throw new HttpError(409, 'That email is already in use');
  const user = { id: uid(), name, email, role: body.role === 'admin' ? 'admin' : 'agent', pass: hashPassword(password) };
  db.users.push(user);
  save();
  return pubUser(user);
}, admin);
route('DELETE', '/api/team/:id', ({ params, user }) => {
  if (params.id === user.id) throw new HttpError(400, 'You cannot remove yourself');
  db.users = db.users.filter((u) => u.id !== params.id);
  for (const [sid, s] of Object.entries(db.sessions)) if (s.userId === params.id) delete db.sessions[sid];
  save();
  return { ok: true };
}, admin);
route('POST', '/api/account/password', ({ body, user }) => {
  if (!checkPassword(String(body.current || ''), user.pass)) throw new HttpError(400, 'Current password is wrong');
  if (String(body.next || '').length < 8) throw new HttpError(400, 'New password must be at least 8 characters');
  user.pass = hashPassword(String(body.next));
  save();
  return { ok: true };
});

// Meta webhooks (raw body for signature check)
route('GET', '/webhook/meta', ({ url }) => {
  const challenge = meta.verify(url.searchParams);
  if (challenge === null) throw new HttpError(403, 'Verification failed');
  return { __raw: challenge };
}, { auth: false });
route('POST', '/webhook/meta', ({ req, raw }) => {
  if (!meta.handle(raw, req.headers['x-hub-signature-256'])) throw new HttpError(403, 'Bad signature');
  return { __raw: 'EVENT_RECEIVED' };
}, { auth: false, raw: true });

// ---------- static ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json'
};
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }
  const ext = path.extname(file);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
  fs.createReadStream(file).pipe(res);
}

// ---------- server ----------
const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
};

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const pathname = url.pathname;
  for (const [k, v] of Object.entries(SECURITY)) res.setHeader(k, v);

  if (!pathname.startsWith('/api/') && !pathname.startsWith('/webhook/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    serveStatic(req, res, pathname);
    return;
  }

  const r = routes.find((x) => x.method === req.method && x.re.test(pathname));
  if (!r) { sendJson(res, 404, { error: 'Not found' }); return; }

  const user = currentUser(req);
  if (r.opts.auth !== false && !user) { sendJson(res, 401, { error: 'Please sign in' }); return; }
  if (r.opts.admin && user.role !== 'admin') { sendJson(res, 403, { error: 'Admins only' }); return; }

  const ctx = { req, res, url, user, params: r.re.exec(pathname).groups || {}, body: {} };
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const buf = await readBody(req);
    if (r.opts.raw) ctx.raw = buf;
    else {
      if (buf.length && !String(req.headers['content-type'] || '').includes('application/json')) throw new HttpError(415, 'JSON required');
      try { ctx.body = buf.length ? JSON.parse(buf.toString('utf8')) : {}; } catch { throw new HttpError(400, 'Invalid JSON'); }
      if (ctx.body === null || typeof ctx.body !== 'object') ctx.body = {};
    }
  }

  const result = await r.handler(ctx);
  if (r.opts.stream) return;
  if (result && result.__raw !== undefined) { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(result.__raw); return; }
  sendJson(res, 200, result ?? { ok: true });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Server error' : e.message });
    else res.end();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Unified Inbox running on http://localhost:${PORT}`);
  telegram.start().catch((e) => console.error('telegram:', e.message));
  meta.configure();
  whatsapp.autoStart();
});

setInterval(() => {
  for (const [sid, s] of Object.entries(db.sessions)) if (s.exp < now()) delete db.sessions[sid];
  for (const [ip, rec] of attempts) if (rec.reset < now()) attempts.delete(ip);
}, 3600 * 1000).unref();

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { flush(); process.exit(0); });
