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

const [pkg, date, ...rooms] = process.argv.slice(2);
if (!pkg || !date || !rooms.length) { console.log('Usage: node tools/check-connecting.js IC06W318 20270905 2+1 2+1'); process.exit(1); }
const roomList = rooms.map(r => { const [a, c] = r.split('+').map(Number); return { adults: a, children: c || 0 }; });
(async () => {
  try {
    const ro = await Core.getRoomOptions(upstream, { packageCode: pkg, sailDate: date, currency: 'USD', host: 'www.royalcaribbean.com', rooms: roomList, keepRaw: true });
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
    ro.rooms.forEach((list, i) => {
      console.log('Room ' + (i + 1) + ' (' + rooms[i] + '): ' + list.length + ' categories, connecting: ' + list.filter(c => c.connecting).map(c => c.code + ' ' + c.name + ' $' + c.price).join(' | '));
    });
    console.log('\nCheapest per cabin type, any rooms:');
    Core.bestByKind(ro, false).forEach(b => console.log('  ' + b.kind.padEnd(9) + b.code.padEnd(4) + ' $' + b.total + '  ' + b.name));
    console.log('Cheapest per cabin type, connecting only:');
    Core.bestByKind(ro, true).forEach(b => console.log('  ' + b.kind.padEnd(9) + b.code.padEnd(4) + ' $' + b.total + '  ' + b.name + '  pairs: ' + b.pairs.map(p => p.join('&')).join(', ')));
    console.log('\nConnecting pairs seen: ' + ro.pairs.length);
  } catch (e) { console.log('FAILED:', e.message); }
  process.exit(0);
})();
