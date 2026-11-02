#!/usr/bin/env node
/*
 * Cruise Deals web server - multi-user, self-hosted.
 *
 *  - Serves the same mobile UI as the Android app (app/src/main/assets/www)
 *  - Username/password login (scrypt hashes, HttpOnly session cookies, login rate limiting)
 *  - Per-user price alerts, checked on a schedule; text alerts (Textbelt, Twilio or a webhook - see sms.js)
 *  - Relays cruise-line API calls for the browser (allow-listed hosts only, login required)
 *
 * Zero npm dependencies: needs Node 20+.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const zlib = require('zlib');

const WWW = process.env.WWW_DIR || path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'www');
const Core = require(path.join(WWW, 'core.js'));
const SMS = require('./sms');

/* ---------------- configuration ---------------- */
const env = process.env;
const CFG = {
  port: parseInt(env.PORT || '8080', 10),
  dataDir: env.DATA_DIR || path.join(__dirname, 'data'),
  wwwDir: WWW,
  adminUser: env.ADMIN_USER || 'admin',
  adminPassword: env.ADMIN_PASSWORD || '',
  // only used to pre-fill the SMS settings on first start; afterwards the admin page is the source of truth
  textbeltKey: env.TEXTBELT_KEY || '',
  checkHours: Math.max(1, parseFloat(env.CHECK_INTERVAL_HOURS || '6')),
  trustProxy: /^(1|true|yes)$/i.test(env.TRUST_PROXY || ''),
  cookieSecure: (env.COOKIE_SECURE || 'auto').toLowerCase(), // auto | true | false
  sessionDays: parseFloat(env.SESSION_DAYS || '30'),
  maxAlertsPerUser: parseInt(env.MAX_ALERTS_PER_USER || '200', 10),
  publicSignup: false
};
const DB_FILE = path.join(CFG.dataDir, 'db.json');

function log(...a) { console.log(new Date().toISOString(), ...a); }

/* ---------------- storage (single JSON file, atomic writes) ---------------- */
let db = { users: {}, sessions: {} };
let writing = Promise.resolve();

function loadDb() {
  fs.mkdirSync(CFG.dataDir, { recursive: true });
  if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  db.users = db.users || {};
  db.sessions = db.sessions || {};
}

function saveDb() {
  const snapshot = JSON.stringify(db);
  writing = writing.then(async () => {
    const tmp = DB_FILE + '.' + process.pid + '.tmp';
    await fsp.writeFile(tmp, snapshot, { mode: 0o600 });
    await fsp.rename(tmp, DB_FILE);
  }).catch(e => log('db write failed', e.message));
  return writing;
}

/* ---------------- passwords & sessions ---------------- */
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, SCRYPT);
  return 'scrypt$' + salt.toString('base64') + '$' + hash.toString('base64');
}

function verifyPassword(pw, stored) {
  try {
    const [kind, salt, hash] = String(stored).split('$');
    if (kind !== 'scrypt') return false;
    const want = Buffer.from(hash, 'base64');
    const got = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), want.length, SCRYPT);
    return crypto.timingSafeEqual(want, got);
  } catch (e) { return false; }
}
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString('hex'));

function validUsername(u) { return typeof u === 'string' && /^[a-zA-Z0-9._-]{3,32}$/.test(u); }
function validPassword(p) { return typeof p === 'string' && p.length >= 10 && p.length <= 200; }

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

function createSession(username) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.sessions[sha256(token)] = { user: username, expires: Date.now() + CFG.sessionDays * 864e5 };
  saveDb();
  return token;
}

function pruneSessions() {
  const now = Date.now();
  let changed = false;
  for (const [k, s] of Object.entries(db.sessions)) {
    if (s.expires < now || !db.users[s.user]) { delete db.sessions[k]; changed = true; }
  }
  if (changed) saveDb();
}

function getCookie(req, name) {
  const m = (req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}

function isHttps(req) {
  if (req.socket.encrypted) return true;
  return CFG.trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function sessionCookie(req, token, maxAgeSec) {
  const secure = CFG.cookieSecure === 'true' || (CFG.cookieSecure === 'auto' && isHttps(req));
  return 'cd_session=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAgeSec + (secure ? '; Secure' : '');
}

function currentUser(req) {
  const token = getCookie(req, 'cd_session');
  if (!token) return null;
  const s = db.sessions[sha256(token)];
  if (!s || s.expires < Date.now() || !db.users[s.user]) return null;
  return { name: s.user, rec: db.users[s.user], key: sha256(token) };
}

/* ---------------- rate limiting ---------------- */
const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.n++;
  return b.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 60e3).unref();

function clientIp(req) {
  if (CFG.trustProxy && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return req.socket.remoteAddress || '?';
}

/* ---------------- upstream (cruise line) HTTP ---------------- */
const ALLOWED_HEADERS = new Set(['user-agent', 'accept', 'accept-language', 'appkey', 'content-type', 'rsc',
  'access-token', 'vds-id', 'account-id', 'authorization', 'appversion',
  'brand', 'country']); // brand/country: the room-selection rooms service (connecting rooms)
const BOOT_STAMP = Date.now().toString(36);
const MAX_UPSTREAM_BYTES = 12 * 1024 * 1024;

function allowedUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && Core.ALLOWED_HOSTS.includes(url.hostname) && !url.username && !url.password && (url.port === '' || url.port === '443');
  } catch (e) { return false; }
}

/*
 * One request with node:https, sending only the headers we choose - the same shape as
 * Python requests in the original scripts (fetch() adds browser sec-fetch-* headers that
 * bot protection on the cruise sites can reject). Redirects are followed like requests
 * does, but only to the allow-listed cruise-line hosts.
 */
function upstreamOnce(method, url, headers, body, hops) {
  hops = hops || 0;
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const h = Object.assign({ 'Accept-Encoding': 'gzip, deflate, br', 'Connection': 'keep-alive' }, headers);
    if (body) h['Content-Length'] = Buffer.byteLength(body);
    const req = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers: h, timeout: 30000 }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 5) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, url).toString(); } catch (e) { return reject(new Error('bad redirect')); }
        if (!allowedUrl(next)) return resolve({ status: res.statusCode, body: 'redirect to a non cruise-line host blocked' });
        const m = res.statusCode === 303 || ((res.statusCode === 301 || res.statusCode === 302) && method === 'POST') ? 'GET' : method;
        return resolve(upstreamOnce(m, next, headers, m === 'GET' ? undefined : body, hops + 1));
      }
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      const chunks = [];
      let size = 0;
      stream.on('data', c => {
        size += c.length;
        if (size > MAX_UPSTREAM_BYTES) { req.destroy(); reject(new Error('upstream response too large')); return; }
        chunks.push(c);
      });
      stream.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      stream.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timed out after 30s')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/* same retry policy as the Python scripts: retry network errors and 5xx, not 4xx */
/*
 * The cruise lines' booking WEBSITES (not their APIs) have bot protection that answers 403 to
 * bursts. Requests to them go out a couple at a time with a gap, identical GETs are reused for
 * 10 minutes, and after a 403 the host gets a few minutes' rest instead of more requests.
 */
const SITE_HOSTS = new Set(['www.royalcaribbean.com', 'www.celebritycruises.com'].concat(env.SITE_HOSTS ? env.SITE_HOSTS.split(',') : []));
const SITE_GAP_MS = parseInt(env.SITE_GAP_MS || '700', 10);
const SITE_COOLDOWN_MS = parseInt(env.SITE_COOLDOWN_MS || String(3 * 60e3), 10);
const siteState = new Map(); // host -> {active, queue, nextAt, coolUntil}
const siteCache = new Map(); // key -> {t, res}

function siteGate(host) {
  let st = siteState.get(host);
  if (!st) siteState.set(host, st = { active: 0, queue: [], nextAt: 0, coolUntil: 0 });
  return new Promise(resolve => { st.queue.push(resolve); pump(st); });
}
function pump(st) {
  if (st.active >= 2 || !st.queue.length) return;
  const wait = Math.max(0, st.nextAt - Date.now());
  if (wait) { if (!st.timer) st.timer = setTimeout(() => { st.timer = null; pump(st); }, wait); return; }
  st.active++;
  st.nextAt = Date.now() + SITE_GAP_MS;
  const go = st.queue.shift();
  go(() => { st.active--; pump(st); });
  pump(st);
}

async function upstream(method, url, opts) {
  opts = opts || {};
  if (!allowedUrl(url)) return { status: 0, body: 'blocked host' };
  if (method !== 'GET' && method !== 'POST') return { status: 0, body: 'bad method' };
  const headers = {};
  for (const [k, v] of Object.entries(opts.headers || {})) {
    if (ALLOWED_HEADERS.has(k.toLowerCase()) && typeof v === 'string' && !/[\r\n]/.test(v)) headers[k] = v;
  }
  const host = new URL(url).hostname;
  if (!SITE_HOSTS.has(host)) return upstreamRetry(method, url, headers, opts);
  const key = method === 'GET' ? url + ' ' + JSON.stringify(headers) : '';
  const hit = key && siteCache.get(key);
  if (hit && Date.now() - hit.t < 10 * 60e3) return hit.res;
  const st = siteState.get(host);
  if (st && st.coolUntil > Date.now()) return { status: 429, body: 'The cruise line is limiting requests from this server - try again in a few minutes' };
  const done = await siteGate(host);
  try {
    const st2 = siteState.get(host);
    if (st2.coolUntil > Date.now()) return { status: 429, body: 'The cruise line is limiting requests from this server - try again in a few minutes' };
    const res = await upstreamRetry(method, url, headers, opts);
    if (res.status === 403 || res.status === 429) {
      if (st2.coolUntil < Date.now()) log('cruise line is blocking requests from this server; pausing', host, 'for', Math.round(SITE_COOLDOWN_MS / 60e3), 'min');
      st2.coolUntil = Date.now() + SITE_COOLDOWN_MS;
    } else if (key && res.status === 200) {
      siteCache.set(key, { t: Date.now(), res });
      if (siteCache.size > 300) siteCache.delete(siteCache.keys().next().value);
    }
    return res;
  } finally { done(); }
}

async function upstreamRetry(method, url, headers, opts) {
  let last = { status: 0, body: '' };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      last = await upstreamOnce(method, url, headers, method === 'POST' ? opts.body : undefined);
      if (last.status < 500) break;
    } catch (e) { last = { status: 0, body: String(e.message || e) }; }
    if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
  }
  if (last.status < 200 || last.status >= 300) {
    const u = new URL(url);
    log('cruise line answered', last.status || ('error: ' + last.body.slice(0, 120)), 'for', method, u.hostname + u.pathname);
  }
  return last;
}

let upstreamHttp = upstream;
if (env.MOCK_UPSTREAM) upstreamHttp = require(path.resolve(env.MOCK_UPSTREAM)); // tests only

/* ---------------- text messages (provider chosen on the admin page) ---------------- */
function normalizePhone(p) {
  const s = String(p || '').trim();
  if (!s) return '';
  const digits = s.replace(/[^\d+]/g, '');
  return /^\+?\d{7,15}$/.test(digits) ? digits : null;
}

function smsConf() {
  db.config = db.config || {};
  if (!db.config.sms) {
    db.config.sms = { provider: CFG.textbeltKey ? 'textbelt' : 'off', settings: { textbelt: { key: CFG.textbeltKey } }, link: '', includeLink: false };
  }
  db.config.sms.settings = db.config.sms.settings || {};
  return db.config.sms;
}

function smsReady() {
  const c = smsConf(), p = SMS.PROVIDERS[c.provider];
  if (!p) return false;
  const vals = c.settings[c.provider] || {};
  return p.fields.every(f => !f.required || vals[f.key]);
}

function smsFormatOpts() {
  const c = smsConf();
  const tbNoLinks = c.provider === 'textbelt' && ((c.settings.textbelt || {}).allowLinks !== 'yes');
  return { link: c.includeLink && c.link && !tbNoLinks ? c.link : '' };
}

async function sendSms(phone, message) {
  if (!smsReady()) throw new Error('Text messages are not set up yet - an admin can do it in Settings.');
  const c = smsConf();
  return SMS.PROVIDERS[c.provider].send(c.settings[c.provider] || {}, phone, message.slice(0, 1000));
}

/* ---------------- alert checking ---------------- */
function cachedHttp() {
  // one run shares responses, so many alerts on the same sailing/category cost one request
  const cache = new Map();
  return (method, url, o) => {
    const key = method + ' ' + url + ' ' + ((o && o.body) || '');
    if (!cache.has(key)) cache.set(key, upstreamHttp(method, url, o));
    return cache.get(key);
  };
}

async function checkUserAlerts(name, httpFn) {
  const rec = db.users[name];
  if (!rec || !rec.alerts || !rec.alerts.length) return { messages: [], drops: [] };
  const messages = [], drops = [];
  const results = [];
  for (const a of rec.alerts) {
    try {
      const r = await Core.checkAlert(httpFn, a);
      results.push(r.alert);
      if (r.message) messages.push(r.message);
      if (r.drop) drops.push(Object.assign({ alertId: r.alert.id }, r.drop));
    } catch (e) { results.push(a); }
  }
  // merge: keep edits made while we were checking
  const latest = db.users[name] ? db.users[name].alerts : [];
  db.users[name].alerts = latest.map(cur => {
    const done = results.find(x => x.id === cur.id);
    return done ? Object.assign(done, { target: cur.target }) : cur;
  });
  await saveDb();
  return { messages, drops };
}

function validTz(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; }
}

/* the user's local date and hour (their browser's time zone, else the server's) */
/* when texts go out is one setting for everyone, chosen by the admin */
function sendPlan() {
  const c = smsConf();
  return { mode: c.mode === 'each' ? 'each' : 'daily', hour: Number.isInteger(c.hour) ? c.hour : 9, tz: validTz(c.tz) ? c.tz : '' };
}

function localNow(tz, now) {
  tz = validTz(tz) ? tz : undefined;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(now || new Date());
  const get = t => (parts.find(p => p.type === t) || {}).value;
  return { date: get('year') + '-' + get('month') + '-' + get('day'), hour: parseInt(get('hour'), 10) };
}

async function textUser(name, drops) {
  const rec = db.users[name];
  const text = SMS.formatDrops(drops, smsFormatOpts());
  await sendSms(rec.settings.phone, text);
  log('sms sent to', name, '(' + drops.length + ' drop' + (drops.length === 1 ? '' : 's') + ')');
}

/*
 * New drops are queued per user, one entry per alert (the newest price wins, the "was" price stays).
 * "each": texted right after the check. "daily" (default): one text a day at the user's chosen hour.
 */
async function notifyUser(name, drops) {
  const rec = db.users[name];
  if (!rec || !rec.settings || !rec.settings.smsEnabled || !rec.settings.phone) return;
  if (drops.length) {
    const pending = rec.pendingDrops || [];
    for (const d of drops) {
      const i = pending.findIndex(x => x.alertId === d.alertId);
      if (i < 0) pending.push(d);
      else pending[i] = Object.assign({}, d, { previous: pending[i].previous !== null && pending[i].previous !== undefined ? pending[i].previous : d.previous });
    }
    rec.pendingDrops = pending.slice(-100);
    await saveDb();
  }
  if (sendPlan().mode === 'each') await flushTexts(name);
}

async function flushTexts(name) {
  const rec = db.users[name];
  if (!rec || !rec.pendingDrops || !rec.pendingDrops.length) return false;
  if (!rec.settings || !rec.settings.smsEnabled || !rec.settings.phone) { rec.pendingDrops = []; await saveDb(); return false; }
  // skip alerts deleted since
  const ids = new Set((rec.alerts || []).map(a => a.id));
  const drops = rec.pendingDrops.filter(d => !d.alertId || ids.has(d.alertId));
  if (!drops.length) { rec.pendingDrops = []; await saveDb(); return false; }
  try {
    await textUser(name, drops);
    rec.pendingDrops = [];
    await saveDb();
    return true;
  } catch (e) { log('sms failed for', name, e.message); return false; }
}

/* runs every few minutes: sends each "daily" user's queued drops once a day at their hour */
let digesting = false;
async function digestTick(now) {
  if (digesting) return;
  digesting = true;
  try {
    const plan = sendPlan();
    const t = localNow(plan.tz, now), hour = plan.hour;
    for (const name of Object.keys(db.users)) {
      const rec = db.users[name];
      if (!rec.pendingDrops || !rec.pendingDrops.length || !rec.settings) continue;
      if (plan.mode === 'each') { await flushTexts(name); continue; }
      if (t.hour < hour || rec.lastDigest === t.date) continue;
      // a failed send is retried at most once an hour
      if (rec.lastDigestTry && Date.now() - rec.lastDigestTry < 3600e3) continue;
      rec.lastDigestTry = Date.now();
      if (await flushTexts(name)) { rec.lastDigest = t.date; rec.lastDigestTry = 0; await saveDb(); }
    }
  } catch (e) { log('digest error', e.message); }
  finally { digesting = false; }
}

let checking = false;
async function scheduledCheck() {
  if (checking) return;
  checking = true;
  try {
    const httpFn = cachedHttp();
    for (const name of Object.keys(db.users)) {
      const { drops } = await checkUserAlerts(name, httpFn);
      await notifyUser(name, drops);
    }
    log('scheduled check finished');
  } catch (e) { log('scheduled check error', e.message); }
  finally { checking = false; }
}

/* ---------------- HTTP plumbing ---------------- */
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/core.js': ['core.js', 'text/javascript; charset=utf-8'],
  '/platform.js': ['platform.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon.png': ['icon.png', 'image/png']
};
const staticCache = {};

function securityHeaders(req, res) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

function send(res, status, obj, extraHeaders) {
  const body = obj === undefined ? '' : JSON.stringify(obj);
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extraHeaders || {}));
  res.end(body);
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve(null);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(Object.assign(new Error('Bad JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function publicUser(name, rec) {
  return {
    username: name, admin: !!rec.admin, smsConfigured: smsReady(),
    smsProvider: smsReady() ? SMS.PROVIDERS[smsConf().provider].label : '',
    settings: { phone: (rec.settings && rec.settings.phone) || '', smsEnabled: !!(rec.settings && rec.settings.smsEnabled) },
    sendPlan: sendPlan(),
    pendingTexts: (rec.pendingDrops || []).length
  };
}

function cleanAlerts(list, old) {
  if (!Array.isArray(list)) throw Object.assign(new Error('Alerts must be a list'), { status: 400 });
  if (list.length > CFG.maxAlertsPerUser) throw Object.assign(new Error('Too many alerts (max ' + CFG.maxAlertsPerUser + ')'), { status: 400 });
  return list.filter(a => a && typeof a === 'object' && typeof a.id === 'string' && (a.type === 'product' || a.type === 'cabin')).map(a => {
    const out = {};
    for (const k of ['id', 'type', 'title', 'ship', 'shipName', 'sailDate', 'category', 'categoryName', 'day', 'port', 'productId', 'currency', 'unit',
      'initialPrice', 'target', 'lastPrice', 'lowestSeen', 'status', 'lastChecked', 'lastError', 'notifiedPrice', 'created',
      'cabinName', 'packageCode', 'host', 'adults', 'children', 'loyaltyNumber', 'state', 'senior', 'military', 'police', 'fire']) {
      if (a[k] !== undefined && (a[k] === null || ['string', 'number', 'boolean'].includes(typeof a[k]))) out[k] = typeof a[k] === 'string' ? a[k].slice(0, 300) : a[k];
    }
    if (out.host && !['www.royalcaribbean.com', 'www.celebritycruises.com'].includes(out.host)) out.host = 'www.royalcaribbean.com';
    if (out.loyaltyNumber !== undefined && !/^\d{4,15}$/.test(String(out.loyaltyNumber))) delete out.loyaltyNumber;
    if (out.state !== undefined && !/^[A-Z]{2}$/.test(String(out.state))) delete out.state;
    // a target has to be below today's price (an unchanged older target is left alone)
    if (out.target !== undefined && out.target !== null && out.target !== '') {
      const t = Number(out.target);
      const nowPrice = typeof out.lastPrice === 'number' ? out.lastPrice : Number(out.initialPrice);
      const before = (old || []).find(x => x.id === out.id);
      if (!(t > 0)) out.target = null;
      else if (isFinite(nowPrice) && t >= nowPrice && !(before && Number(before.target) === t)) {
        throw Object.assign(new Error('Your target for "' + String(out.title || 'this item').slice(0, 60) + '" has to be below today\'s price'), { status: 400 });
      }
    }
    return out;
  });
}

/* ---------------- routes ---------------- */
async function api(req, res, url) {
  const method = req.method;
  const p = url.pathname;

  // CSRF: browsers can't add this header cross-site without CORS preflight (which we never grant)
  if (method !== 'GET' && req.headers['x-requested-with'] !== 'CruiseDeals') return send(res, 403, { error: 'Forbidden' });

  if (p === '/api/login' && method === 'POST') {
    const ip = clientIp(req);
    const body = (await readJson(req, 4096)) || {};
    const username = String(body.username || '').trim();
    if (limited('login-ip:' + ip, 20, 15 * 60e3) || limited('login-user:' + username.toLowerCase(), 10, 15 * 60e3)) {
      return send(res, 429, { error: 'Too many sign-in attempts. Try again in 15 minutes.' });
    }
    const name = Object.keys(db.users).find(n => n.toLowerCase() === username.toLowerCase());
    const ok = verifyPassword(String(body.password || ''), name ? db.users[name].hash : DUMMY_HASH);
    if (!name || !ok) { log('failed login for', JSON.stringify(username.slice(0, 40)), 'from', ip); return send(res, 401, { error: 'Wrong username or password' }); }
    const token = createSession(name);
    log('login', name, 'from', ip);
    return send(res, 200, publicUser(name, db.users[name]), { 'Set-Cookie': sessionCookie(req, token, Math.round(CFG.sessionDays * 86400)) });
  }

  const me = currentUser(req);
  if (!me) return send(res, 401, { error: 'Please sign in' });
  if (limited('user:' + me.name, 3000, 10 * 60e3)) return send(res, 429, { error: 'Slow down - too many requests' });

  if (p === '/api/logout' && method === 'POST') {
    delete db.sessions[me.key];
    await saveDb();
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }
  if (p === '/api/me' && method === 'GET') return send(res, 200, publicUser(me.name, me.rec));
  if (p === '/api/me/settings' && method === 'PUT') {
    const b = (await readJson(req, 4096)) || {};
    const phone = normalizePhone(b.phone);
    if (phone === null) return send(res, 400, { error: 'That phone number does not look right. Use digits, e.g. +15551234567' });
    me.rec.settings = { phone, smsEnabled: !!b.smsEnabled && !!phone };
    await saveDb();
    return send(res, 200, publicUser(me.name, me.rec));
  }
  if (p === '/api/me/test-sms' && method === 'POST') {
    if (limited('sms-test:' + me.name, 3, 60 * 60e3)) return send(res, 429, { error: 'Only 3 test texts per hour' });
    const phone = me.rec.settings && me.rec.settings.phone;
    if (!phone) return send(res, 400, { error: 'Add your mobile number first' });
    try {
      const r = await sendSms(phone, SMS.testMessage(smsFormatOpts()));
      return send(res, 200, { ok: true, info: r.info, quotaRemaining: r.quotaRemaining });
    } catch (e) { return send(res, 502, { error: e.message }); }
  }
  if (p === '/api/me/password' && method === 'POST') {
    const b = (await readJson(req, 4096)) || {};
    if (limited('pw:' + me.name, 10, 15 * 60e3)) return send(res, 429, { error: 'Too many attempts' });
    if (!verifyPassword(String(b.oldPassword || ''), me.rec.hash)) return send(res, 400, { error: 'Current password is wrong' });
    if (!validPassword(b.newPassword)) return send(res, 400, { error: 'New password must be at least 10 characters' });
    me.rec.hash = hashPassword(b.newPassword);
    for (const [k, s] of Object.entries(db.sessions)) if (s.user === me.name && k !== me.key) delete db.sessions[k];
    await saveDb();
    return send(res, 200, { ok: true });
  }

  if (p === '/api/sms/preview' && method === 'GET') {
    return send(res, 200, SMS.samples(smsFormatOpts()).map(x => Object.assign(x, { segments: SMS.segments(x.text), chars: x.text.length })));
  }
  if (p === '/api/alerts' && method === 'GET') return send(res, 200, me.rec.alerts || []);
  if (p === '/api/alerts' && method === 'PUT') {
    me.rec.alerts = cleanAlerts(await readJson(req, 512 * 1024), me.rec.alerts);
    await saveDb();
    return send(res, 200, me.rec.alerts);
  }
  if (p === '/api/alerts/check' && method === 'POST') {
    if (limited('check:' + me.name, 12, 60 * 60e3)) return send(res, 429, { error: 'You can check manually 12 times an hour' });
    const { drops } = await checkUserAlerts(me.name, cachedHttp());
    await notifyUser(me.name, drops);
    return send(res, 200, db.users[me.name].alerts);
  }

  if (p === '/api/proxy' && method === 'POST') {
    const b = (await readJson(req, 128 * 1024)) || {};
    if (!allowedUrl(b.url)) return send(res, 400, { error: 'Host not allowed' });
    const r = await upstreamHttp(String(b.method || 'GET').toUpperCase(), b.url, { headers: b.headers || {}, body: typeof b.body === 'string' ? b.body : undefined });
    return send(res, 200, { status: r.status, body: r.body });
  }
  if (p === '/api/cabins' && method === 'POST') {
    const o = (await readJson(req, 8192)) || {};
    if (!/^[A-Z0-9]{4,20}$/i.test(String(o.packageCode || '')) || !/^\d{8}$/.test(String(o.sailDate || ''))) return send(res, 400, { error: 'Bad sailing' });
    const opts = {
      packageCode: String(o.packageCode), sailDate: String(o.sailDate), currency: /^[A-Z]{3}$/.test(o.currency) ? o.currency : 'USD',
      adults: Math.min(8, Math.max(1, parseInt(o.adults, 10) || 2)), children: Math.min(8, Math.max(0, parseInt(o.children, 10) || 0)),
      host: o.host === 'www.celebritycruises.com' ? o.host : 'www.royalcaribbean.com'
    };
    // discount qualifiers (Crown & Anchor / Captain's Club number, residency, 55+, military, police, fire)
    if (/^\d{4,15}$/.test(String(o.loyaltyNumber || ''))) opts.loyaltyNumber = String(o.loyaltyNumber);
    if (/^[A-Z]{2}$/.test(String(o.state || ''))) opts.state = String(o.state);
    for (const k of ['senior', 'military', 'police', 'fire']) if (o[k] === true) opts[k] = true;
    try { return send(res, 200, await Core.getCabins(upstreamHttp, opts)); }
    catch (e) { return send(res, 502, { error: e.message }); }
  }

  /* ---- admin ---- */
  if (p.startsWith('/api/admin/')) {
    if (!me.rec.admin) return send(res, 403, { error: 'Admins only' });
    if (p === '/api/admin/users' && method === 'GET') {
      return send(res, 200, Object.keys(db.users).sort().map(n => ({
        username: n, admin: !!db.users[n].admin, alerts: (db.users[n].alerts || []).length,
        smsEnabled: !!(db.users[n].settings && db.users[n].settings.smsEnabled), self: n === me.name
      })));
    }
    if (p === '/api/admin/users' && method === 'POST') {
      const b = (await readJson(req, 4096)) || {};
      if (!validUsername(b.username)) return send(res, 400, { error: 'Username: 3-32 letters, numbers, dot, dash or underscore' });
      if (Object.keys(db.users).some(n => n.toLowerCase() === b.username.toLowerCase())) return send(res, 400, { error: 'That username is taken' });
      if (!validPassword(b.password)) return send(res, 400, { error: 'Password must be at least 10 characters' });
      db.users[b.username] = { hash: hashPassword(b.password), admin: !!b.admin, settings: {}, alerts: [], created: new Date().toISOString() };
      await saveDb();
      log('user created', b.username, 'by', me.name);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/admin/sms' && method === 'GET') {
      const c = smsConf();
      const values = {};
      for (const [id, prov] of Object.entries(SMS.PROVIDERS)) {
        const v = c.settings[id] || {};
        values[id] = {};
        for (const f of prov.fields) {
          // secrets never leave the server: only "set" plus the last 4 characters
          values[id][f.key] = f.secret ? (v[f.key] ? '********' + String(v[f.key]).slice(-4) : '') : (v[f.key] || '');
        }
      }
      return send(res, 200, {
        provider: c.provider, ready: smsReady(), link: c.link || '', includeLink: !!c.includeLink, values, plan: sendPlan(),
        providers: Object.entries(SMS.PROVIDERS).map(([id, prov]) => ({ id, label: prov.label, help: prov.help, fields: prov.fields }))
      });
    }
    if (p === '/api/admin/sms' && method === 'PUT') {
      const b = (await readJson(req, 16384)) || {};
      const c = smsConf();
      if (b.provider !== 'off' && !SMS.PROVIDERS[b.provider]) return send(res, 400, { error: 'Unknown provider' });
      const prov = SMS.PROVIDERS[b.provider];
      if (prov) {
        const cur = Object.assign({}, c.settings[b.provider] || {});
        const incoming = (b.values && b.values[b.provider]) || {};
        for (const f of prov.fields) {
          let v = incoming[f.key];
          if (typeof v !== 'string') continue;
          v = v.trim().slice(0, 500);
          if (f.secret && (v === '' || v.startsWith('********'))) continue; // keep the stored secret
          if (f.type === 'checkbox') v = v === 'yes' ? 'yes' : '';
          if (/url/i.test(f.key) && v && !/^https?:\/\/[^\s]+$/i.test(v)) return send(res, 400, { error: f.label + ' must be a http(s) URL' });
          cur[f.key] = v;
        }
        const missing = prov.fields.filter(f => f.required && !cur[f.key]).map(f => f.label);
        if (missing.length) return send(res, 400, { error: 'Please fill in: ' + missing.join(', ') });
        c.settings[b.provider] = cur;
      }
      const link = String(b.link || '').trim();
      if (link && !/^https?:\/\/[^\s]+$/i.test(link)) return send(res, 400, { error: 'Link must start with https://' });
      c.provider = b.provider;
      c.link = link;
      c.includeLink = !!b.includeLink && !!link;
      // when texts go out (for every user)
      if (b.mode === 'each' || b.mode === 'daily') c.mode = b.mode;
      if (Number.isInteger(b.hour) && b.hour >= 0 && b.hour <= 23) c.hour = b.hour;
      if (b.tz !== undefined) c.tz = validTz(b.tz) ? b.tz : '';
      await saveDb();
      log('sms settings changed to', c.provider, 'by', me.name);
      return send(res, 200, { ok: true, ready: smsReady() });
    }
    if (p === '/api/admin/sms/test' && method === 'POST') {
      if (limited('sms-admin-test:' + me.name, 10, 60 * 60e3)) return send(res, 429, { error: 'Only 10 test texts per hour' });
      const b = (await readJson(req, 4096)) || {};
      const phone = normalizePhone(b.phone);
      if (!phone) return send(res, 400, { error: 'Enter the phone number to send the test to' });
      try {
        const r = await sendSms(phone, SMS.testMessage(smsFormatOpts()));
        return send(res, 200, { ok: true, info: r.info });
      } catch (e) { return send(res, 502, { error: e.message }); }
    }
    const m = p.match(/^\/api\/admin\/users\/([^/]+)$/);
    if (m && method === 'DELETE') {
      const name = decodeURIComponent(m[1]);
      if (name === me.name) return send(res, 400, { error: 'You cannot delete yourself' });
      if (!db.users[name]) return send(res, 404, { error: 'No such user' });
      delete db.users[name];
      pruneSessions();
      await saveDb();
      log('user deleted', name, 'by', me.name);
      return send(res, 200, { ok: true });
    }
  }
  return send(res, 404, { error: 'Not found' });
}

async function serveStatic(req, res, url) {
  const entry = STATIC[url.pathname];
  if (!entry || (req.method !== 'GET' && req.method !== 'HEAD')) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
  let buf = staticCache[entry[0]];
  if (!buf) {
    try { buf = await fsp.readFile(path.join(CFG.wwwDir, entry[0])); }
    catch (e) { res.writeHead(404); return res.end(); }
    if (entry[0] === 'index.html') {
      buf = Buffer.from(buf.toString('utf8')
        .replace('<html lang="en">', '<html lang="en" data-server="1">')
        // new file names after every update so phones never keep running old app code
        .replace(/(src|href)="(core\.js|platform\.js|app\.js|app\.css)"/g, '$1="$2?v=' + BOOT_STAMP + '"')
        .replace('</title>', '</title>\n  <link rel="manifest" href="manifest.webmanifest">\n  <link rel="icon" href="icon.png">\n  <link rel="apple-touch-icon" href="icon.png">\n  <meta name="apple-mobile-web-app-capable" content="yes">'));
    }
    staticCache[entry[0]] = buf;
  }
  res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-cache' });
  res.end(req.method === 'HEAD' ? undefined : buf);
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (e) { res.writeHead(400); return res.end(); }
  securityHeaders(req, res);
  try {
    if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    return await serveStatic(req, res, url);
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Server error' });
    if (!e.status) log('error', req.method, url.pathname, e.stack || e.message);
  }
});
server.headersTimeout = 20000;
server.requestTimeout = 120000;

/* ---------------- start ---------------- */
function bootstrapAdmin() {
  if (Object.keys(db.users).length) return;
  let pw = CFG.adminPassword;
  let generated = false;
  if (!pw) { pw = crypto.randomBytes(12).toString('base64url'); generated = true; }
  if (!validUsername(CFG.adminUser)) throw new Error('ADMIN_USER is not a valid username');
  if (!validPassword(pw)) throw new Error('ADMIN_PASSWORD must be at least 10 characters');
  db.users[CFG.adminUser] = { hash: hashPassword(pw), admin: true, settings: {}, alerts: [], created: new Date().toISOString() };
  saveDb();
  log('created admin user "' + CFG.adminUser + '"' + (generated ? ' with password: ' + pw + '  (change it in Settings!)' : ''));
}

if (require.main === module) {
  loadDb();
  bootstrapAdmin();
  pruneSessions();
  setInterval(pruneSessions, 3600e3).unref();
  setInterval(scheduledCheck, CFG.checkHours * 3600e3);
  setInterval(() => digestTick(), parseInt(env.DIGEST_EVERY_MS || '', 10) || 5 * 60e3).unref();
  setTimeout(scheduledCheck, 60e3).unref();
  server.listen(CFG.port, () => log('Cruise Deals listening on :' + CFG.port + ' (alerts every ' + CFG.checkHours + 'h, texts via ' + (smsReady() ? smsConf().provider : 'nobody yet') + ')'));
  const stop = () => { server.close(); writing.then(() => process.exit(0)); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

module.exports = { server, hashPassword, verifyPassword, planCheck: scheduledCheck, upstream, digestTick };
