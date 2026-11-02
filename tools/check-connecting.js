#!/usr/bin/env node
/*
 * Runs the app's own connecting-room search for one sailing and prints the result.
 *   node tools/check-connecting.js <packageCode> <YYYYMMDD> <room1 adults+kids> [<room2>] [<room3>]
 *   e.g. node tools/check-connecting.js IC06W318 20270905 2+1 2+1
 */
'use strict';
const path = require('path');
process.env.WWW_DIR = process.env.WWW_DIR || path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'www');
const Core = require(path.join(process.env.WWW_DIR, 'core.js'));
const { upstream } = require(path.join(__dirname, '..', 'server', 'server.js'));

// optional: --cna 123456789 --state FL  (to test with your Crown & Anchor number / residency)
const argv = process.argv.slice(2), disc = {};
for (let i = argv.length - 2; i >= 0; i--) {
  if (argv[i] === '--cna') { disc.loyaltyNumber = argv[i + 1]; argv.splice(i, 2); }
  else if (argv[i] === '--state') { disc.state = argv[i + 1].toUpperCase(); argv.splice(i, 2); }
}
const [pkg, date, ...rooms] = argv;
if (!pkg || !date || !rooms.length) { console.log('Usage: node tools/check-connecting.js IC06W318 20270905 2+1 2+1'); process.exit(1); }
const roomList = rooms.map(r => { const [a, c] = r.split('+').map(Number); return { adults: a, children: c || 0 }; });
(async () => {
  try {
    const ro = await Core.getRoomOptions(upstream, { packageCode: pkg, sailDate: date, currency: 'USD', host: 'www.royalcaribbean.com', rooms: roomList, keepRaw: true, ...disc });
    if (disc.loyaltyNumber || disc.state) console.log('Discounts ' + (ro.discounted ? 'ACCEPTED by Royal' : 'REJECTED by Royal - asked again without them'));
    // where in Royal's reply are categories, connecting flags and cabin pairs?
    const where = {};
    (function walk(o, p) {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) { o.forEach((x, i) => walk(x, p + (p === '' || /rooms$/.test(p) ? '[' + i + ']' : '[]'))); return; }
      if (typeof o.categoryCode === 'string') {
        const w = where[p] = where[p] || { cats: 0, connectingTrue: 0, pairs: 0 };
        w.cats++; if (o.connecting === true) w.connectingTrue++;
        (o.cabins || []).forEach(c => { if (c && c.connectingCabin) w.pairs++; });
      }
      for (const k of Object.keys(o)) walk(o[k], p + '.' + k);
    })(ro.raw, '');
    console.log('Where Royal put the categories:');
    for (const [p, w] of Object.entries(where)) console.log('  ' + p + '  categories=' + w.cats + ' connecting=' + w.connectingTrue + ' cabinPairs=' + w.pairs);
    console.log('Started from category ' + ro.start.subtype + ' (' + ro.start.typeCode + ')');
    console.log('Room 1 (' + rooms[0] + ') lists ' + ro.options.length + ' room types for sale.');
    console.log('Connecting: ' + (ro.options.filter(c => c.connecting).map(c => c.kind + ' ' + c.code + ' ' + c.name + ' $' + c.price).join(' | ') || 'none'));
    // reprice every other room size by asking with that size first, like the app does
    const byOcc = {}; byOcc[roomList[0].adults + '/' + roomList[0].children] = ro;
    for (let i = 1; i < roomList.length; i++) {
      const key = roomList[i].adults + '/' + roomList[i].children;
      if (byOcc[key]) continue;
      const order = [roomList[i]].concat(roomList.filter((x, k) => k !== i));
      byOcc[key] = await Core.getRoomOptions(upstream, { packageCode: pkg, sailDate: date, currency: 'USD', host: 'www.royalcaribbean.com', rooms: order, ...disc });
    }
    console.log('\nCheapest per cabin type, all rooms same type:');
    Core.combineSplit(roomList, ro, byOcc, false).forEach(b => console.log('  ' + b.kind.padEnd(9) + b.code.padEnd(4) + ' $' + b.total + '  ' + b.name + (b.connecting ? '  (connecting)' : '')));
    console.log('Cheapest per cabin type, connecting only:');
    Core.combineSplit(roomList, ro, byOcc, true).forEach(b => console.log('  ' + b.kind.padEnd(9) + b.code.padEnd(4) + ' $' + b.total + '  ' + b.name + '  pairs: ' + (b.pairs.map(p => p[0] + '&' + p[1]).join(', ') || '-')));
    console.log('\nConnecting pairs seen: ' + ro.pairs.length);
  } catch (e) { console.log('FAILED:', e.message); }
  process.exit(0);
})();
