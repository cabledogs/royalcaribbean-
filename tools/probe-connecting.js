#!/usr/bin/env node
/*
 * Diagnostic: shows how Royal Caribbean / Celebrity mark connecting cabins for one sailing.
 *
 *   node tools/probe-connecting.js "<royalcaribbean.com checkout or room-selection URL>"
 *
 * It reads the sailing, guests and (optionally) cabin numbers from the link, asks the cruise
 * line's public room-selection endpoints - the same ones the app uses - and prints only the
 * parts that mention "connect" or the cabin numbers in the link. Nothing is sent anywhere else.
 */
'use strict';
const https = require('https');
const zlib = require('zlib');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:159.0) Gecko/20100101 Firefox/159.0';
const link = process.argv[2];
if (!link) { console.log('Usage: node probe-connecting.js "<cruise line URL>"'); process.exit(1); }

const u = new URL(link);
const q = u.searchParams;
const host = u.hostname.includes('celebrity') ? 'www.celebritycruises.com' : 'www.royalcaribbean.com';
const pkg = q.get('packageCode'), sail = q.get('sailDate');
const rooms = [];
for (let i = 0; i < 4; i++) if (q.get('r' + i + 'a')) rooms.push({ i, a: +q.get('r' + i + 'a'), c: +(q.get('r' + i + 'c') || 0), d: q.get('r' + i + 'd') || 'INTERIOR', e: q.get('r' + i + 'e'), f: q.get('r' + i + 'f'), j: q.get('r' + i + 'j') });
const cabins = rooms.map(r => r.j).filter(Boolean);
(q.get('r0F') || '').split('|').forEach(n => { if (n && !cabins.includes(n)) cabins.push(n); });
console.log('Sailing', pkg, sail, '| rooms:', rooms.map(r => r.a + 'A+' + r.c + 'C ' + r.d + (r.e ? ' ' + r.e : '') + (r.j ? ' #' + r.j : '')).join(', '), '| cabins to look for:', cabins.join(', ') || '-');

function request(method, url, headers, body) {
  return new Promise((resolve) => {
    const x = new URL(url);
    const h = Object.assign({ 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate, br' }, headers);
    if (body) h['Content-Length'] = Buffer.byteLength(body);
    const req = https.request({ method, hostname: x.hostname, path: x.pathname + x.search, headers: h, timeout: 40000 }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume(); return resolve(request('GET', new URL(res.headers.location, url).toString(), headers));
      }
      const enc = res.headers['content-encoding'];
      const s = enc === 'gzip' ? res.pipe(zlib.createGunzip()) : enc === 'br' ? res.pipe(zlib.createBrotliDecompress()) : enc === 'deflate' ? res.pipe(zlib.createInflate()) : res;
      const chunks = []; s.on('data', c => chunks.push(c)); s.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      s.on('error', e => resolve({ status: 0, body: String(e) }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', e => resolve({ status: 0, body: String(e.message) }));
    if (body) req.write(body);
    req.end();
  });
}

function contexts(label, text, needle, max, width) {
  const re = new RegExp(needle, 'gi');
  let m, n = 0;
  const seen = new Set();
  while ((m = re.exec(text)) && n < max) {
    const s = text.slice(Math.max(0, m.index - width), m.index + width).replace(/\s+/g, ' ');
    const key = s.slice(width - 30, width + 30);
    if (seen.has(key)) continue;
    seen.add(key); n++;
    console.log('  [' + label + ' "' + needle + '" #' + n + '] ...' + s + '...');
  }
  if (!n) console.log('  [' + label + '] no "' + needle + '" found');
}

function rscParams(extra) {
  const p = new URLSearchParams({ packageCode: pkg, sailDate: sail, country: q.get('country') || 'USA', selectedCurrencyCode: q.get('selectedCurrencyCode') || 'USD', shipCode: pkg.slice(0, 2), cabinClassType: rooms[0] ? rooms[0].d : 'INTERIOR', roomIndex: '0' });
  rooms.forEach(r => {
    p.set('r' + r.i + 'a', r.a); p.set('r' + r.i + 'c', r.c); p.set('r' + r.i + 'b', 'n'); p.set('r' + r.i + 'r', 'n'); p.set('r' + r.i + 's', 'n');
    p.set('r' + r.i + 'q', 'n'); p.set('r' + r.i + 't', 'n'); p.set('r' + r.i + 'd', r.d); p.set('r' + r.i + 'D', 'y');
    if (extra && r.e) { p.set('r' + r.i + 'e', r.e); p.set('r' + r.i + 'f', r.f || r.e); }
  });
  p.set('rgVisited', 'true'); p.set('r0C', 'y');
  return p.toString();
}

(async () => {
  const rsc = { 'Accept': 'text/x-component', 'Accept-Language': 'en-US,en;q=0.9', 'RSC': '1' };

  console.log('\n== 1. type-and-subtype page (what the app uses today), all rooms in the link');
  let r = await request('GET', 'https://' + host + '/room-selection/type-and-subtype?' + rscParams(false), rsc);
  console.log('  HTTP', r.status, '|', r.body.length, 'chars');
  contexts('types', r.body, 'connect', 8, 160);
  const m = r.body.match(/"stateroomSubtypes"\s*:\s*\[\s*\{([^{}]{0,600})/);
  if (m) console.log('  first room-type fields:', m[1].replace(/\s+/g, ' ').slice(0, 600));

  console.log('\n== 2. room-location page (cabin numbers) for the category in the link');
  r = await request('GET', 'https://' + host + '/room-selection/room-location?' + rscParams(true), rsc);
  console.log('  HTTP', r.status, '|', r.body.length, 'chars');
  contexts('location', r.body, 'connect', 10, 200);
  cabins.forEach(c => contexts('location', r.body, '"' + c + '"', 3, 260));

  console.log('\n== 3. rooms API with roomNumbers=true');
  const body = JSON.stringify({
    countryCode: q.get('country') || 'USA', packageId: pkg, sailDate: sail, currencyCode: q.get('selectedCurrencyCode') || 'USD',
    language: 'en', options: true, roomNumbers: true, platform: 'web',
    rooms: rooms.map(x => ({ adultCount: x.a, childCount: x.c, stateroomTypeCode: x.d, stateroomSubtypeCode: x.e || undefined, accessible: false,
      selectionFallbackStrategy: 'RECOMMENDATION', editMode: true, reset: false, taxesAndFeesBundled: true,
      qualifiers: { fireFighter: false, military: false, police: false, senior: false } }))
  });
  r = await request('POST', 'https://' + host + '/room-selection/api/v1/rooms', { 'Accept': '*/*', 'Content-Type': 'application/json', 'brand': host.includes('celebrity') ? 'C' : 'R', 'country': 'USA' }, body);
  console.log('  HTTP', r.status, '|', r.body.length, 'chars');
  contexts('api', r.body, 'connect', 10, 200);
  cabins.forEach(c => contexts('api', r.body, '"?' + c + '"?', 3, 260));
  try {
    const j = JSON.parse(r.body);
    const paths = new Set();
    (function walk(o, p, d) {
      if (d > 7 || o === null || typeof o !== 'object') return;
      if (Array.isArray(o)) { if (o.length) walk(o[0], p + '[]', d + 1); return; }
      for (const k of Object.keys(o)) { paths.add(p + '.' + k); walk(o[k], p + '.' + k, d + 1); }
    })(j, '', 0);
    console.log('  JSON structure:\n    ' + [...paths].slice(0, 120).join('\n    '));
  } catch (e) { console.log('  (not JSON) starts with:', r.body.slice(0, 200)); }
  console.log('\nDone - please copy everything above and send it.');
})();
