// Tests the server's cruise-line HTTP client against a local HTTPS server on 127.0.0.1:443
// (gzip/brotli bodies, redirects, header hygiene). Run as root: node test/upstream-test.js
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const https = require('https'), zlib = require('zlib'), path = require('path'), { execSync } = require('child_process'), fs = require('fs'), os = require('os');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-'));
execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${dir}/k.pem -out ${dir}/c.pem -days 1 -subj /CN=127.0.0.1 2>/dev/null`);
process.env.SITE_HOSTS = '127.0.0.1'; process.env.SITE_GAP_MS = '150'; process.env.SITE_COOLDOWN_MS = '1500';
const Core = require('../app/src/main/assets/www/core.js');
Core.ALLOWED_HOSTS.push('127.0.0.1');
const { upstream } = require('../server/server.js');
const seen = [];
const rsc = '0:["$","x",{"rooms":[{"options":{"stateroomTypes":[{"name":"Interior","stateroomSubtypes":[{"name":"Interior","pricing":{"invoice":{"total":999}}}]}]}}]}]';
const srv = https.createServer({ key: fs.readFileSync(dir + '/k.pem'), cert: fs.readFileSync(dir + '/c.pem') }, (req, res) => {
  seen.push({ url: req.url, headers: req.headers });
  if (req.url.startsWith('/room-selection/type-and-subtype')) { res.writeHead(302, { Location: '/en/room-selection/type-and-subtype?x=1' }); return res.end(); }
  if (req.url.startsWith('/en/room-selection')) { res.writeHead(200, { 'Content-Encoding': 'br', 'Content-Type': 'text/x-component' }); return res.end(zlib.brotliCompressSync(rsc)); }
  if (req.url === '/offsite') { res.writeHead(302, { Location: 'https://evil.example.com/' }); return res.end(); }
  if (req.url === '/blocked') { res.writeHead(403); return res.end('denied'); }
  if (req.url.startsWith('/n')) { res.writeHead(200); return res.end('n'); }
  if (req.url === '/gz') { res.writeHead(200, { 'Content-Encoding': 'gzip' }); return res.end(zlib.gzipSync('{"ok":true}')); }
  res.writeHead(404); res.end();
}).listen(443, '127.0.0.1', async () => {
  const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } console.log('ok -', m); };
  try {
    const cab = await Core.getCabins(upstream, { packageCode: 'WNW123', sailDate: '20270110', host: '127.0.0.1', adults: 2, children: 0 });
    ok(cab[0].price === 999, 'cabin page: follows redirect + brotli body parsed');
    const h = seen[0].headers;
    ok(h.rsc === '1' && h.accept === 'text/x-component' && /Firefox/.test(h['user-agent']), 'sends the same headers as the Python script');
    ok(!Object.keys(h).some(k => k.startsWith('sec-fetch')), 'no browser sec-fetch-* headers');
    ok((await upstream('GET', 'https://127.0.0.1/gz', {})).body === '{"ok":true}', 'gzip body decoded');
    const off = await upstream('GET', 'https://127.0.0.1/offsite', {});
    ok(off.status === 302 && /blocked/.test(off.body), 'redirect to a non cruise-line host is not followed');
    ok((await upstream('GET', 'https://evil.example.com/', {})).body === 'blocked host', 'non cruise-line host blocked');
    // booking-site bot protection: spaced out, cached, and paused after a 403
    const t0 = Date.now(), before = seen.length;
    await Promise.all([1, 2, 3, 4].map(i => upstream('GET', 'https://127.0.0.1/n' + i, {})));
    ok(Date.now() - t0 >= 300, 'website requests are spaced out (' + (Date.now() - t0) + ' ms for 4)');
    await upstream('GET', 'https://127.0.0.1/n1', {});
    ok(seen.length === before + 4, 'identical page request reused from cache');
    ok((await upstream('GET', 'https://127.0.0.1/blocked', {})).status === 403, '403 passed through');
    const paused = await upstream('GET', 'https://127.0.0.1/n9', {});
    ok(paused.status === 429 && seen.length === before + 5, 'after a 403 the site gets a rest (no request sent)');
    await new Promise(r => setTimeout(r, 1600));
    ok((await upstream('GET', 'https://127.0.0.1/n9', {})).status === 200, 'requests resume after the pause');
    console.log('UPSTREAM TESTS PASSED');
  } finally { srv.close(); process.exit(0); }
});
