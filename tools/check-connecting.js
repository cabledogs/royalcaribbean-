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
    const ro = await Core.getRoomOptions(upstream, { packageCode: pkg, sailDate: date, currency: 'USD', host: 'www.royalcaribbean.com', rooms: roomList });
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
