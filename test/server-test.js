// End-to-end test of the Docker web server (mock cruise line + mock Textbelt).
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');

const PORT = 18080, TB_PORT = 18081, BASE = 'http://127.0.0.1:' + PORT;
const texts = [];
const assert = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('ok -', m); };

const tb = http.createServer((req, res) => {
  let b = ''; req.on('data', d => b += d); req.on('end', () => {
    texts.push(Object.fromEntries(new URLSearchParams(b)));
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ success: true, quotaRemaining: 41 }));
  });
}).listen(TB_PORT);

let jar = {};
async function call(method, p, body, who = 'a', extra = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json', 'X-Requested-With': 'CruiseDeals' }, extra);
  if (jar[who]) headers.Cookie = jar[who];
  const r = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) jar[who] = sc.split(';')[0];
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
  return { status: r.status, json: j, headers: r.headers };
}

(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-'));
  const srv = spawn(process.execPath, [path.join(__dirname, '../server/server.js')], {
    env: Object.assign({}, process.env, { PORT, DATA_DIR: data, ADMIN_USER: 'captain', ADMIN_PASSWORD: 'correct-horse-1',
      TEXTBELT_KEY: 'test-key', TEXTBELT_URL: 'http://127.0.0.1:' + TB_PORT + '/text', MOCK_UPSTREAM: path.join(__dirname, 'mock-upstream.js') }),
    stdio: ['ignore', 'pipe', 'inherit'] });
  let out = ''; srv.stdout.on('data', d => out += d);
  for (let i = 0; i < 50 && !out.includes('listening'); i++) await new Promise(r => setTimeout(r, 100));
  try {
    assert((await call('GET', '/api/me')).status === 401, 'api requires login');
    assert((await call('POST', '/api/login', { username: 'captain', password: 'correct-horse-1' }, 'a', { 'X-Requested-With': '' })).status === 403, 'POST without CSRF header rejected');
    assert((await call('POST', '/api/login', { username: 'captain', password: 'nope' })).status === 401, 'wrong password rejected');
    const li = await call('POST', '/api/login', { username: 'Captain', password: 'correct-horse-1' });
    assert(li.status === 200 && li.json.admin, 'admin login (case-insensitive username)');
    assert(/HttpOnly/.test(li.headers.get('set-cookie')) && /SameSite=Strict/.test(li.headers.get('set-cookie')), 'session cookie is HttpOnly + SameSite=Strict');
    const page = await fetch(BASE + '/');
    assert(/default-src 'self'/.test(page.headers.get('content-security-policy')), 'CSP header set');
    assert((await page.text()).includes('data-server="1"'), 'index served in server mode');
    assert((await fetch(BASE + '/../server/server.js')).status === 404, 'no path traversal / source exposure');

    const px = await call('POST', '/api/proxy', { method: 'GET', url: 'https://evil.example.com/' });
    assert(px.status === 400, 'proxy refuses non cruise-line hosts');
    const px2 = await call('POST', '/api/proxy', { method: 'GET', url: 'https://aws-prd.api.rccl.com/en/royal/web/v2/ships?sort=name', headers: { AppKey: 'x' } });
    assert(px2.status === 200 && JSON.parse(px2.json.body).payload.ships[0].shipCode === 'WN', 'proxy relays cruise-line API');
    const cab = await call('POST', '/api/cabins', { packageCode: 'WNW123', sailDate: '20270110', adults: 2, children: 0, currency: 'USD' });
    assert(cab.status === 200 && cab.json[0].connectingPrice === 1650 && cab.json[1].price === 2399, 'cabin prices parsed (connecting + sold-out subtype skipped)');

    assert((await call('POST', '/api/admin/users', { username: 'firstmate', password: 'short' })).status === 400, 'weak password refused');
    assert((await call('POST', '/api/admin/users', { username: 'firstmate', password: 'aye-aye-sir-42' })).status === 200, 'admin creates user');
    assert((await call('POST', '/api/login', { username: 'firstmate', password: 'aye-aye-sir-42' }, 'b')).status === 200, 'new user logs in');
    assert((await call('GET', '/api/admin/users', undefined, 'b')).status === 403, 'non-admin blocked from admin API');

    const alert = { id: 'product|WN|20270110|shorex|3|9002|USD', type: 'product', title: 'Mayan Ruins Tour', ship: 'WN', shipName: 'Wonder of the Seas',
      sailDate: '20270110', category: 'shorex', day: 3, productId: '9002', currency: 'USD', initialPrice: 150, target: null, evil: '<script>' };
    assert((await call('PUT', '/api/alerts', [alert], 'b')).json[0].evil === undefined, 'alerts saved and sanitised');
    assert((await call('GET', '/api/alerts')).json.length === 0, 'alerts are per user');
    assert((await call('PUT', '/api/me/settings', { phone: 'abc', smsEnabled: true }, 'b')).status === 400, 'bad phone refused');
    assert((await call('PUT', '/api/me/settings', { phone: '+1 (555) 123-4567', smsEnabled: true }, 'b')).json.settings.phone === '+15551234567', 'phone saved');
    const chk = await call('POST', '/api/alerts/check', undefined, 'b');
    assert(chk.json[0].status === 'dropped' && chk.json[0].lastPrice === 129, 'price drop detected');
    assert(texts.length === 1 && texts[0].phone === '+15551234567' && /Mayan Ruins Tour is now \$129/.test(texts[0].message) && texts[0].key === 'test-key', 'Textbelt SMS sent');
    await call('POST', '/api/alerts/check', undefined, 'b');
    assert(texts.length === 1, 'no duplicate SMS for the same price');
    assert((await call('POST', '/api/me/test-sms', undefined, 'b')).json.quotaRemaining === 41, 'test SMS works');

    let blocked = false;
    for (let i = 0; i < 12; i++) if ((await call('POST', '/api/login', { username: 'firstmate', password: 'guess' + i }, 'x')).status === 429) blocked = true;
    assert(blocked, 'login brute force rate-limited');

    // browser: login page -> explore -> excursions with server mode
    const browser = await chromium.launch();
    const pg = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errs = []; pg.on('pageerror', e => errs.push(e.message));
    await pg.goto(BASE + '/');
    await pg.waitForSelector('text=Welcome aboard');
    await pg.screenshot({ path: path.join(__dirname, 'shots', 'web-1-login.png') });
    await pg.fill('input[autocomplete=username]', 'captain');
    await pg.fill('input[type=password]', 'correct-horse-1');
    await pg.click('button[type=submit]');
    await pg.click('text=Wonder of the Seas');
    await pg.click('text=7 Night Western Caribbean');
    await pg.click('[data-tab=excursions]');
    await pg.waitForSelector('text=Mayan Ruins Tour');
    await pg.click('[data-tab=cabins]');
    await pg.waitForSelector('text=Connecting from $1,650');
    await pg.click('[data-root=settings]');
    await pg.waitForSelector('text=Text message alerts');
    await pg.waitForSelector('text=firstmate');
    await pg.screenshot({ path: path.join(__dirname, 'shots', 'web-2-settings.png'), fullPage: true });
    await browser.close();
    assert(!errs.length, 'no browser JS errors ' + errs.join(';'));
    console.log('SERVER TESTS PASSED');
  } finally { srv.kill(); tb.close(); }
})().catch(e => { console.error(e); process.exit(1); });
