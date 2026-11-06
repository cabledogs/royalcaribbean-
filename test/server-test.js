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

// every local module server.js requires must be copied into the Docker image
{
  const docker = fs.readFileSync(path.join(__dirname, '../Dockerfile'), 'utf8');
  const src = fs.readFileSync(path.join(__dirname, '../server/server.js'), 'utf8');
  const mods = [...src.matchAll(/require\('\.\/([\w-]+)'\)/g)].map(m => m[1] + '.js');
  const copied = f => docker.includes('server/*.js') || docker.includes('server/' + f);
  assert(mods.length && mods.every(copied), 'Dockerfile copies every server module (' + mods.join(', ') + ')');
}

const hooks = [], twilio = [];
const tb = http.createServer((req, res) => {
  let b = ''; req.on('data', d => b += d); req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/hook') { hooks.push({ auth: req.headers.authorization, body: JSON.parse(b) }); return res.end('{}'); }
    if (req.url.startsWith('/2010-04-01/Accounts/AC123/Messages.json')) {
      twilio.push({ auth: req.headers.authorization, form: Object.fromEntries(new URLSearchParams(b)) });
      res.statusCode = 201; return res.end(JSON.stringify({ sid: 'SM1' }));
    }
    texts.push(Object.fromEntries(new URLSearchParams(b)));
    res.end(JSON.stringify({ success: true, quotaRemaining: 41 }));
  });
}).listen(TB_PORT);
const MOCK = 'http://127.0.0.1:' + TB_PORT;

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
      TEXTBELT_KEY: 'test-key-abcd', TWILIO_API_BASE: 'http://127.0.0.1:' + TB_PORT, MOCK_UPSTREAM: path.join(__dirname, 'mock-upstream.js'),
      MOCK_PRICE_FILE: path.join(data, 'mock-price'), DIGEST_EVERY_MS: '300' }),
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

    const dc = await call('POST', '/api/cabins', { packageCode: 'WNW123', sailDate: '20270110', adults: 2, loyaltyNumber: '987654321', state: 'FL', senior: true });
    assert(dc.status === 200 && dc.json[0].price === 1299, 'Crown & Anchor + state discounts passed to the cruise line');
    const bad = await call('POST', '/api/cabins', { packageCode: 'WNW123', sailDate: '20270110', loyaltyNumber: '1&r0x=evil', state: 'florida' });
    assert(bad.status === 200 && bad.json[0].price === 1499.5, 'malformed discount values ignored');
    // ---- SMS provider settings (admin page) ----
    let sc = await call('GET', '/api/admin/sms');
    assert(sc.json.provider === 'textbelt' && sc.json.ready, 'TEXTBELT_KEY pre-fills the Textbelt provider');
    assert(sc.json.values.textbelt.key === '********abcd' && !JSON.stringify(sc.json).includes('test-key-abcd'), 'secret key never sent back to the browser');
    assert(sc.json.providers.map(p => p.id).join() === 'textbelt,twilio,webhook', 'providers listed for the admin form');
    assert((await call('PUT', '/api/admin/sms', { provider: 'textbelt', values: { textbelt: { key: '********abcd', url: MOCK + '/text' } } })).json.ready, 'admin points Textbelt at a new URL, key kept');
    assert((await call('PUT', '/api/admin/sms', { provider: 'twilio', values: { twilio: { accountSid: 'AC123' } } })).status === 400, 'missing required provider fields refused');

    const rr = await call('POST', '/api/proxy', { method: 'POST', url: 'https://www.royalcaribbean.com/room-selection/api/v1/rooms',
      headers: { 'Content-Type': 'application/json', brand: 'R', country: 'USA', Accept: '*/*' }, body: JSON.stringify({ packageId: 'ICX', sailDate: '2027-09-05', rooms: [{ adultCount: 2, childCount: 1, stateroomSubtypeCode: 'T5' }, { adultCount: 2, childCount: 1, stateroomSubtypeCode: 'T5' }] }) });
    const rj = JSON.parse(rr.json.body);
    assert(rr.json.status === 200 && rj.rooms[0].options.stateroomTypes[0].stateroomSubtypes[0].connecting === true, 'rooms service relayed with brand/country headers');
    assert((await call('POST', '/api/admin/users', { username: 'firstmate', password: 'short' })).status === 400, 'weak password refused');
    assert((await call('POST', '/api/admin/users', { username: 'firstmate', password: 'aye-aye-sir-42' })).status === 200, 'admin creates user');
    assert((await call('POST', '/api/login', { username: 'firstmate', password: 'aye-aye-sir-42' }, 'b')).status === 200, 'new user logs in');
    assert((await call('GET', '/api/admin/users', undefined, 'b')).status === 403, 'non-admin blocked from admin API');
    assert((await call('GET', '/api/admin/sms', undefined, 'b')).status === 403, 'non-admin cannot see SMS settings');
    const pv = await call('GET', '/api/sms/preview', undefined, 'b');
    assert(pv.json.length === 4 && /price drop/.test(pv.json[0].text) && pv.json[0].segments >= 1, 'any user can preview the texts');

    const alert = { id: 'product|WN|20270110|shorex|3|9002|USD', type: 'product', title: 'Mayan Ruins Tour', ship: 'WN', shipName: 'Wonder of the Seas',
      sailDate: '20270110', category: 'shorex', day: 3, productId: '9002', currency: 'USD', initialPrice: 150, target: null, evil: '<script>' };
    assert((await call('PUT', '/api/alerts', [alert], 'b')).json[0].evil === undefined, 'alerts saved and sanitised');
    assert((await call('GET', '/api/alerts')).json.length === 0, 'alerts are per user');
    assert((await call('PUT', '/api/me/settings', { phone: 'abc', smsEnabled: true }, 'b')).status === 400, 'bad phone refused');
    assert((await call('PUT', '/api/me/settings', { phone: '+1 (555) 123-4567', smsEnabled: true }, 'b')).json.settings.phone === '+15551234567', 'phone saved');
    assert((await call('PUT', '/api/admin/sms', { provider: 'textbelt', values: { textbelt: {} }, mode: 'each' }, 'b')).status === 403, 'only the admin decides when texts go out');
    await call('PUT', '/api/admin/sms', { provider: 'textbelt', values: { textbelt: {} }, mode: 'each' });
    const chk = await call('POST', '/api/alerts/check', undefined, 'b');
    assert(chk.json[0].status === 'dropped' && chk.json[0].lastPrice === 129, 'price drop detected');
    assert(texts.length === 1 && texts[0].phone === '+15551234567' && texts[0].key === 'test-key-abcd', 'Textbelt SMS sent with stored key');
    assert(texts[0].message === 'Cruise Deals: price drop!\nMayan Ruins Tour\nNow $129 (was $150, save $21)\nWonder of the Seas, Jan 10, 2027', 'text format: ' + JSON.stringify(texts[0].message));
    await call('POST', '/api/alerts/check', undefined, 'b');
    assert(texts.length === 1, 'no duplicate SMS for the same price');
    // price goes back up, then down to the same price: no new text; lower than the last text: text
    fs.writeFileSync(path.join(data, 'mock-price'), '140'); await call('POST', '/api/alerts/check', undefined, 'b');
    fs.writeFileSync(path.join(data, 'mock-price'), '129'); await call('POST', '/api/alerts/check', undefined, 'b');
    assert(texts.length === 1, 'no new text when the price comes back to the already-texted price');
    fs.writeFileSync(path.join(data, 'mock-price'), '120'); await call('POST', '/api/alerts/check', undefined, 'b');
    assert(texts.length === 2 && /Now \$120/.test(texts[1].message), 'texted again only below the last texted price');
    texts.length = 1;

    // targets must be below today's price
    const tgt = await call('PUT', '/api/alerts', [Object.assign({}, alert, { lastPrice: 120, target: 125 })], 'b');
    assert(tgt.status === 400 && /below today/.test(tgt.json.error), 'target above the current price refused');
    assert((await call('PUT', '/api/alerts', [Object.assign({}, alert, { lastPrice: 120, notifiedPrice: 120, status: 'dropped', target: 110 })], 'b')).status === 200, 'target below the current price accepted');

    // daily digest: drops wait for the user's hour and go out together in one text
    const bev = d => ({ id: 'product|WN|20270110|pt_beverage|' + d + '|3005|USD', type: 'product', title: 'Deluxe Beverage Package', ship: 'WN', shipName: 'Wonder of the Seas',
      sailDate: '20270110', category: 'pt_beverage', day: d, productId: '3005', currency: 'USD', unit: 'Per Day', initialPrice: 99, target: null });
    const now = (await call('GET', '/api/alerts', undefined, 'b')).json;
    await call('PUT', '/api/alerts', now.concat([bev(1), bev(2)]), 'b');
    // pick a time zone where it is not late evening, so "2 hours from now" is still today
    const utcH = new Date().getUTCHours(), tz = utcH <= 21 ? 'UTC' : 'Etc/GMT+12', hourNow = utcH <= 21 ? utcH : utcH - 12, later = hourNow + 2;
    await call('PUT', '/api/admin/sms', { provider: 'textbelt', values: { textbelt: {} }, mode: 'daily', hour: later, tz });
    await call('POST', '/api/alerts/check', undefined, 'b');
    await new Promise(r => setTimeout(r, 900));
    assert(texts.length === 1 && (await call('GET', '/api/me', undefined, 'b')).json.pendingTexts === 2, 'daily mode: drops queued until the chosen hour');
    await call('PUT', '/api/admin/sms', { provider: 'textbelt', values: { textbelt: {} }, mode: 'daily', hour: hourNow, tz });
    await new Promise(r => setTimeout(r, 900));
    assert(texts.length === 2 && /^Cruise Deals: 2 price drops/.test(texts[1].message), 'one combined text at the chosen hour: ' + JSON.stringify(texts[1] && texts[1].message));
    fs.writeFileSync(path.join(data, 'mock-price'), '100'); await call('POST', '/api/alerts/check', undefined, 'b');
    await new Promise(r => setTimeout(r, 900));
    assert(texts.length === 2 && (await call('GET', '/api/me', undefined, 'b')).json.pendingTexts === 1, 'second drop the same day waits for tomorrow');
    texts.length = 1;
    await call('PUT', '/api/admin/sms', { provider: 'textbelt', values: { textbelt: {} }, mode: 'each' });

    assert((await call('POST', '/api/me/test-sms', undefined, 'b')).json.quotaRemaining === 41, 'test SMS works');

    // switch providers from the admin page, no restart
    await call('PUT', '/api/admin/sms', { provider: 'webhook', values: { webhook: { url: MOCK + '/hook', token: 's3cret' } }, link: 'https://cruise.example.com', includeLink: true });
    assert((await call('POST', '/api/admin/sms/test', { phone: '+15550001111' })).status === 200, 'webhook test send');
    assert(hooks[0].auth === 'Bearer s3cret' && hooks[0].body.to === '+15550001111' && hooks[0].body.message.endsWith('\nhttps://cruise.example.com/'), 'webhook got JSON + token + link');
    await call('PUT', '/api/admin/sms', { provider: 'twilio', values: { twilio: { accountSid: 'AC123', authToken: 'tok', from: '+15559998888' } } });
    assert((await call('POST', '/api/admin/sms/test', { phone: '+15550002222' })).json.info === 'Sent (Twilio id SM1)', 'twilio test send');
    assert(twilio[0].form.To === '+15550002222' && twilio[0].form.From === '+15559998888' && twilio[0].auth === 'Basic ' + Buffer.from('AC123:tok').toString('base64'), 'twilio request correct');
    await call('PUT', '/api/admin/sms', { provider: 'textbelt', values: { textbelt: {} }, link: 'https://cruise.example.com', includeLink: true });
    assert((await call('GET', '/api/me', undefined, 'b')).json.smsProvider === 'Textbelt', 'back to Textbelt; users see the provider name');
    const n0 = texts.length;
    await call('POST', '/api/admin/sms/test', { phone: '+15550003333' });
    assert(texts.length === n0 + 1 && !/https?:/.test(texts[n0].message), 'Textbelt texts leave the link out (Textbelt blocks links)');
    await call('PUT', '/api/admin/sms', { provider: 'textbelt', values: { textbelt: { allowLinks: 'yes' } }, link: 'https://cruise.example.com', includeLink: true });
    await call('POST', '/api/admin/sms/test', { phone: '+15550003333' });
    assert(texts[n0 + 1].message.endsWith('\nhttps://cruise.example.com/'), 'link included once the admin says Textbelt approved links');
    assert(texts[n0 + 1].replyWebhookUrl === 'https://cruise.example.com/api/sms/reply', 'Textbelt told where to send STOP/HELP replies');

    // public pages for the provider's review
    assert((await call('PUT', '/api/admin/site', { name: 'Hurm Cruise Deals', owner: 'Site Owner', email: 'owner@example.com' }, 'b')).status === 403, 'only the admin edits the site details');
    assert((await call('PUT', '/api/admin/site', { name: 'Hurm Cruise Deals', owner: 'Site Owner', email: 'not-an-email' })).status === 400, 'bad contact email refused');
    assert((await call('PUT', '/api/admin/site', { name: 'Hurm <b>Cruise</b> Deals', owner: 'Site Owner', email: 'owner@example.com' })).status === 200, 'site details saved');
    for (const pg of ['/about', '/terms', '/privacy', '/sms-terms']) {
      const r = await fetch(BASE + pg);
      const t = await r.text();
      assert(r.status === 200 && t.includes('Hurm &lt;b&gt;Cruise&lt;/b&gt; Deals') && t.includes('owner@example.com') && !t.includes('<b>Cruise</b>'), pg + ' is public, shows the site details, escaped');
    }
    const smsPage = await (await fetch(BASE + '/sms-terms')).text();
    assert(/Reply <b>STOP<\/b>/.test(smsPage) && /Message and data rates may apply/.test(smsPage) && /never sold/.test(smsPage), 'SMS terms cover STOP, HELP, rates and no sharing');
    assert((await (await fetch(BASE + '/about')).text()).includes('https://cruise.example.com/'), 'About shows a sample text with the link');

    // STOP / START replies from Textbelt (signed with the API key)
    const crypto = require('crypto');
    async function reply(text, sign = true) {
      const body = JSON.stringify({ textId: '1', fromNumber: '+15551234567', text });
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = crypto.createHmac('sha256', sign ? 'test-key-abcd' : 'wrong').update(ts + body).digest('hex');
      return fetch(BASE + '/api/sms/reply', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-textbelt-timestamp': ts, 'X-textbelt-signature': sig }, body });
    }
    assert((await reply('STOP', false)).status === 403, 'unsigned reply ignored');
    assert((await call('GET', '/api/me', undefined, 'b')).json.settings.smsEnabled === true, 'texts still on after a fake STOP');
    assert((await reply('Stop please')).status === 200 && (await call('GET', '/api/me', undefined, 'b')).json.settings.smsEnabled === false, 'STOP reply turns texts off');
    assert((await reply('START')).status === 200 && (await call('GET', '/api/me', undefined, 'b')).json.settings.smsEnabled === true, 'START reply turns them back on');

    // whole-cruise alerts: rooms booked together (rooms service) and one cabin (cabin page)
    const cruise = (split, kind, conn, initial) => ({ id: 'cruise|' + split + kind, type: 'cruise', title: 'Cruise test ' + split, ship: 'WN', shipName: 'Wonder of the Seas',
      sailDate: '20270110', packageCode: 'WNW123', host: 'www.royalcaribbean.com', currency: 'USD', split, kind, connecting: conn, initialPrice: initial, evil: 1 });
    const saved = await call('PUT', '/api/alerts', [cruise('2/1,2/1', 'interior', true, 3000), cruise('2/0', 'any', false, 5000), Object.assign(cruise('9/9/9', 'nonsense', false, 1), { id: 'bad' })]);
    assert(saved.status === 200 && saved.json[2].split === undefined && saved.json[2].kind === 'any', 'cruise alert fields checked (bad split/kind dropped)');
    const cc = (await call('POST', '/api/alerts/check')).json;
    assert(cc[0].lastPrice === 2823.38 && cc[0].status === 'dropped', 'group cruise alert priced from the rooms service: ' + cc[0].lastPrice + ' ' + (cc[0].lastError || ''));
    assert(typeof cc[1].lastPrice === 'number' && cc[1].lastPrice < 5000 && cc[1].status === 'dropped', 'one-cabin cruise alert priced: ' + cc[1].lastPrice + ' ' + (cc[1].lastError || ''));
    await call('PUT', '/api/alerts', []);

    // Royal specials: texted right away even in daily mode, and only once per sentence
    await call('PUT', '/api/admin/sms', { provider: 'textbelt', values: { textbelt: {} }, mode: 'daily', hour: 23, tz: 'UTC' });
    await call('PUT', '/api/me/settings', { phone: '+15551234567', smsEnabled: true }, 'b');
    const sp = await call('PUT', '/api/alerts', [{ id: 'special|giftcards', type: 'special', special: 'giftcards', title: 'Royal gift card deals', urls: 'https://evil.example.com/' },
      { id: 'special|custom|x', type: 'special', special: 'custom', title: 'kids', urls: 'https://evil.example.com/|https://www.royalcaribbean.com/cruise-deals', keywords: 'kids sail free' }], 'b');
    assert(sp.json[0].urls === undefined && sp.json[1].urls === 'https://www.royalcaribbean.com/cruise-deals', 'special alerts saved; non cruise-line pages dropped');
    const t0 = texts.length;
    await call('POST', '/api/alerts/check', undefined, 'b');
    assert(texts.length === t0, 'no text while no special is posted');
    fs.writeFileSync(path.join(data, 'mock-special'), '<p>Today only: get 10% off gift card purchases of $350 or more. Crown &amp; Anchor members save an extra 10%.</p>');
    const spc = (await call('POST', '/api/alerts/check', undefined, 'b')).json;
    assert(spc[0].status === 'found' && /10% off gift card/.test(spc[0].found), 'gift card sale spotted: ' + spc[0].found);
    assert(texts.length === t0 + 1 && /Royal special spotted/.test(texts[t0].message) && /10% off gift card purchases of \$350/.test(texts[t0].message), 'texted right away, not held for the daily text: ' + JSON.stringify(texts[t0] && texts[t0].message));
    await call('POST', '/api/alerts/check', undefined, 'b');
    assert(texts.length === t0 + 1, 'same special is not texted twice');
    await call('PUT', '/api/alerts', [], 'b');
    await call('PUT', '/api/admin/sms', { provider: 'textbelt', values: { textbelt: {} }, mode: 'each' });
    texts.length = t0;

    // remembered cruise-line login: encrypted on the server, never sent back
    assert((await call('POST', '/api/me/cruise-login/session', undefined, 'b')).status === 404, 'no saved login yet');
    const rem = await call('PUT', '/api/me/cruise-login', { line: 'royalcaribbean', user: 'me@example.com', pass: 'right-password' }, 'b');
    assert(rem.status === 200 && !JSON.stringify(rem.json).includes('right-password'), 'login saved; password not echoed');
    const got = await call('GET', '/api/me/cruise-login', undefined, 'b');
    assert(got.json.remembered === true && got.json.user === 'me@example.com' && got.json.pass === undefined, 'saved login listed without the password');
    await new Promise(r => setTimeout(r, 300));
    const dbText = fs.readFileSync(path.join(data, 'db.json'), 'utf8');
    assert(!dbText.includes('right-password') && dbText.includes('"cruiseLogin"'), 'password encrypted in the database');
    assert((fs.statSync(path.join(data, 'cruise-login.key')).mode & 0o077) === 0, 'encryption key file readable by the owner only');
    const sess = await call('POST', '/api/me/cruise-login/session', undefined, 'b');
    assert(sess.status === 200 && sess.json.accountId === 'acct42' && sess.json.token, 'server signs in with the saved login');
    assert((await call('POST', '/api/me/cruise-login/session')).status === 404, 'saved logins are per user');
    await call('DELETE', '/api/me/cruise-login', undefined, 'b');
    assert((await call('GET', '/api/me/cruise-login', undefined, 'b')).json.remembered === false, 'Forget removes the saved login');

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
    await pg.waitForSelector('text=Text message provider (admin)');
    await pg.screenshot({ path: path.join(__dirname, 'shots', 'web-3-admin-sms.png'), fullPage: true });
    await pg.click('text=Preview the texts');
    await pg.waitForSelector('.bubble');
    await pg.waitForTimeout(300);
    await pg.locator('#sheet').screenshot({ path: path.join(__dirname, 'shots', 'web-4-text-preview.png') });
    await pg.screenshot({ path: path.join(__dirname, 'shots', 'web-2-settings.png'), fullPage: true });
    // sign out from the top bar on any page
    await pg.keyboard.press('Escape').catch(() => {});
    await pg.goto(BASE + '/');
    await pg.click('[data-root=alerts]');
    await pg.click('#acct');
    await pg.waitForSelector('text=Signed in as captain (admin)');
    await pg.screenshot({ path: path.join(__dirname, 'shots', 'web-5-signout.png') });
    await pg.click('#sheet >> button.danger');
    await pg.waitForSelector('text=Welcome aboard');
    assert(await pg.locator('#acct').isHidden(), 'signed out from the top-bar account button');
    await browser.close();
    assert(!errs.length, 'no browser JS errors ' + errs.join(';'));
    console.log('SERVER TESTS PASSED');
  } finally { srv.kill(); tb.close(); }
})().catch(e => { console.error(e); process.exit(1); });
