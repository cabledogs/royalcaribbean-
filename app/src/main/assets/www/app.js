/* app.js - Cruise Deals UI. Works on Android (WebView) and the Docker web server. */
(function () {
  'use strict';
  var Core = window.CruiseCore, P = window.Platform;
  var http = function (m, u, o) { return P.http(m, u, o); };

  /* ---------- tiny DOM helper (always textContent: API strings are never parsed as HTML) ---------- */
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'style') el.setAttribute('style', v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); return; }
    el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
  var $ = function (id) { return document.getElementById(id); };

  /* ---------- prefs (per device) ---------- */
  function pref(k, d) { try { var v = localStorage.getItem('cd.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } }
  function setPref(k, v) { try { localStorage.setItem('cd.' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } }
  function currency() { return pref('currency', 'USD'); }
  function discounts() { return pref('discounts', {}); }
  var money = function (n, c) { return Core.fmtMoney(n, c || currency()); };

  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }
  function errBox(e) { return h('div', { class: 'err', text: (e && e.message) || String(e) }); }
  function skeleton(n) { var a = []; for (var i = 0; i < (n || 4); i++) a.push(h('div', { class: 'skel' })); return a; }
  function empty(emoji, text, sub) { return h('div', { class: 'empty' }, h('span', { class: 'e', text: emoji }), h('div', { text: text }), sub ? h('div', { class: 'small', text: sub }) : null); }

  /* ---------- caching ---------- */
  var mem = {};
  function cached(key, ttlMs, fn, persist) {
    var now = Date.now();
    if (mem[key] && now - mem[key].t < ttlMs) return Promise.resolve(mem[key].v);
    if (persist) {
      var p = pref('cache.' + key, null);
      if (p && now - p.t < ttlMs) { mem[key] = p; return Promise.resolve(p.v); }
    }
    return fn().then(function (v) {
      mem[key] = { t: now, v: v };
      if (persist) setPref('cache.' + key, mem[key]);
      return v;
    });
  }
  var HOUR = 3600e3;
  var api = {
    ships: function () { return cached('ships', 24 * HOUR, function () { return Core.getShips(http); }, true); },
    sailings: function (s) { return cached('sail.' + s, 6 * HOUR, function () { return Core.getSailings(http, s); }, true); },
    itinerary: function (s, d) { return cached('itin.' + s + d, 24 * HOUR, function () { return Core.getItinerary(http, s, d); }); },
    categories: function (s, d) { return cached('cats.' + s + d, HOUR, function () { return Core.getCategories(http, s, d); }); },
    products: function (s, d, c, day) {
      var cur = currency();
      return cached(['prod', s, d, c, day, cur].join('.'), 30 * 60e3, function () { return Core.getProducts(http, s, d, c, cur, day); });
    },
    cabins: function (o) { return cached('cab.' + JSON.stringify(o), 30 * 60e3, function () { return P.cabins(o); }); }
  };

  /* ---------- alerts ---------- */
  var alerts = [];
  function loadAlerts() { return P.getAlerts().then(function (a) { alerts = Array.isArray(a) ? a : []; updateBadge(); return alerts; }).catch(function () { return alerts; }); }
  function saveAlerts() { updateBadge(); return P.saveAlerts(alerts); }
  function updateBadge() {
    var n = alerts.filter(function (a) { return a.status === 'dropped' || a.status === 'found'; }).length, b = $('alertBadge');
    b.hidden = !n; b.textContent = n;
  }
  function alertId(a) {
    if (a.type === 'cruise') return ['cruise', a.packageCode, a.sailDate, a.split, a.kind, a.connecting ? 'c' : '', a.currency, a.loyaltyNumber || '', a.state || '', a.senior ? 's' : '', a.military ? 'm' : '', a.police ? 'p' : '', a.fire ? 'f' : ''].join('|');
    return a.type === 'cabin'
      ? ['cabin', a.packageCode, a.sailDate, a.cabinName, a.adults, a.children, a.currency, a.loyaltyNumber || '', a.state || '', a.senior ? 's' : '', a.military ? 'm' : '', a.police ? 'p' : '', a.fire ? 'f' : ''].join('|')
      : ['product', a.ship, a.sailDate, a.category, a.day, a.productId, a.currency].join('|');
  }
  /* whole-cruise alert: cheapest price for a cabin type ('any') for these rooms on one sailing */
  function cruiseAlertBase(ship, sailing, rooms, kind, connecting, price) {
    var disc = Core.discountOpts(discounts(), ship.name);
    var n = rooms.length;
    var whoTxt = rooms.map(function (r) { return r.adults + (r.children ? '+' + r.children : ''); }).join(', ');
    var what = kind === 'any' ? 'any cabin' : kindName(kind);
    var title = n === 1 ? 'Cruise: cheapest ' + (kind === 'any' ? 'cabin' : kindName(kind)) + ' (' + whoText(rooms[0].adults, rooms[0].children) + ')'
      : 'Cruise: ' + n + (connecting ? ' connecting ' : ' ') + what + ' rooms (' + whoTxt + ')';
    var b = { type: 'cruise', title: title, ship: ship.code, shipName: ship.name, sailDate: sailing.date, packageCode: ship.code + sailing.voyageCode,
      host: Core.brandHost(ship.name), currency: currency(), split: Core.splitText(rooms), kind: kind, connecting: !!(connecting && n > 1),
      categoryName: (sailing.duration ? sailing.duration + ' nights' : 'Cruise') + (sailing.description ? ' · ' + sailing.description : ''), initialPrice: price };
    for (var k in disc) b[k] = disc[k];
    b.id = alertId(b);
    return b;
  }
  function cruiseBell(base, label) {
    var bell = h('button', { class: 'bell' + (findAlert(base) ? ' on' : ''), 'aria-label': label, text: '\u{1F514}' });
    bell.onclick = function (e) { e.stopPropagation(); openAlertSheet(JSON.parse(JSON.stringify(base)), bell); };
    return bell;
  }

  /* "Watch this cruise": cheapest one-cabin price per cabin type, each with a bell */
  function watchCruiseSheet(ship, sailing) {
    var party = pref('party', { adults: 2, children: 0 });
    var listEl = h('div', null, h('div', { class: 'progress' }, h('span', { class: 'spin' }), 'Getting prices…'));
    openSheet([
      h('h3', { text: '\u{1F514} Watch this cruise' }),
      h('div', { class: 'small muted', text: ship.name + ' · ' + Core.fmtSailDate(sailing.date) + ' · one cabin for ' + whoText(party.adults, party.children) + '. Tap a bell to get alerted when that price drops.' }),
      h('div', { style: 'height:10px' }), listEl,
      h('p', { class: 'small muted', text: 'Booking 2-3 rooms (or connecting rooms)? Open the Cabins tab, choose "Whole group" and tap the bell on a result.' })
    ]);
    var o = { packageCode: ship.code + sailing.voyageCode, sailDate: sailing.date, currency: currency(), host: Core.brandHost(ship.name), adults: party.adults, children: party.children };
    var disc = Core.discountOpts(discounts(), ship.name);
    for (var k in disc) o[k] = disc[k];
    api.cabins(o).then(function (rows) {
      var best = {};
      rows.forEach(function (r) {
        if (r.price === null || r.price === undefined) return;
        var kd = Core.cabinTypeOf(r.name);
        if (kd === 'other') return;
        if (!best[kd] || r.price < best[kd]) best[kd] = r.price;
        if (!best.any || r.price < best.any) best.any = r.price;
      });
      clear(listEl);
      var kinds = ['any', 'interior', 'ocean', 'balcony', 'suite'].filter(function (kd) { return best[kd]; });
      if (!kinds.length) { add(listEl, empty('\u{1F6AB}', 'No cabins for sale for ' + whoText(party.adults, party.children))); return; }
      add(listEl, h('div', { class: 'list' }, kinds.map(function (kd) {
        var base = cruiseAlertBase(ship, sailing, [party], kd, false, best[kd]);
        return h('div', { class: 'prod' },
          h('div', { class: 'grow' }, h('div', { class: 't', text: kd === 'any' ? 'Cheapest cabin of any type' : 'Cheapest ' + kindName(kd) })),
          h('div', { class: 'price' }, h('b', { text: money(best[kd], o.currency) }), h('span', { class: 'u', text: 'total' })),
          cruiseBell(base, 'Price alert for cheapest ' + (kd === 'any' ? 'cabin' : kindName(kd))));
      })));
    }).catch(function (e) { clear(listEl); add(listEl, errBox(e)); });
  }

  function findAlert(a) { var id = alertId(a); for (var i = 0; i < alerts.length; i++) if (alerts[i].id === id) return alerts[i]; return null; }

  function openAlertSheet(base, bellBtn) {
    base.id = alertId(base);
    var existing = findAlert(base);
    var mode = existing && existing.target ? 'below' : 'any';
    var nowPrice = base.initialPrice;
    var suggested = existing && existing.target && existing.target < nowPrice ? existing.target : Math.floor(nowPrice * 0.9);
    var input = h('input', { type: 'number', inputmode: 'decimal', min: '0', max: String(nowPrice), step: '1', value: suggested, 'aria-label': 'Target price' });
    var err = h('div', { class: 'small', style: 'color:var(--coral);margin-top:6px', hidden: true });
    var rAny = h('input', { type: 'radio', name: 'am', checked: mode === 'any' });
    var rBelow = h('input', { type: 'radio', name: 'am', checked: mode === 'below' });
    var lAny = h('label', { class: 'radio' + (mode === 'any' ? ' on' : '') }, rAny, h('div', null, h('b', { text: 'Any price drop' }), h('div', { class: 'small muted', text: 'Alert me when it goes below ' + money(base.initialPrice, base.currency) })));
    var lBelow = h('label', { class: 'radio' + (mode === 'below' ? ' on' : '') }, rBelow, h('div', { class: 'grow' }, h('b', { text: 'Drops to my price' }), h('div', { class: 'field', style: 'margin:6px 0 0' }, input), err));
    function sync() { lAny.classList.toggle('on', rAny.checked); lBelow.classList.toggle('on', rBelow.checked); }
    rAny.onchange = rBelow.onchange = sync;
    input.onfocus = function () { rBelow.checked = true; sync(); };
    var how = P.features.sms ? 'You\'ll get a text (if SMS is on in Settings) and see it in Alerts.'
      : P.features.background ? 'Checked in the background - you\'ll get a phone notification.'
        : 'Open Alerts and tap "Check now" to refresh.';
    openSheet([
      h('h3', { text: existing ? 'Edit price alert' : 'Set a price alert' }),
      h('div', { class: 'muted small', text: base.title + ' · now ' + money(base.initialPrice, base.currency) + (base.unit ? ' / ' + base.unit : '') }),
      h('div', { style: 'height:12px' }), lAny, lBelow,
      h('p', { class: 'small muted', text: how }),
      h('div', { class: 'btn-row' },
        existing ? h('button', { class: 'btn ghost', text: 'Remove', onclick: function () {
          alerts = alerts.filter(function (a) { return a.id !== base.id; });
          saveAlerts(); closeSheet(); if (bellBtn) bellBtn.classList.remove('on'); toast('Alert removed');
        } }) : null,
        h('button', { class: 'btn', text: existing ? 'Save' : 'Create alert', onclick: function () {
          var target = rBelow.checked ? parseFloat(input.value) : null;
          if (rBelow.checked && !(target > 0)) { input.focus(); return; }
          if (rBelow.checked && target >= nowPrice) {
            err.textContent = 'Your price has to be below today\'s price of ' + money(nowPrice, base.currency) + '.';
            err.hidden = false; input.focus(); return;
          }
          var a = existing || base;
          if (!existing) {
            a.created = new Date().toISOString(); a.lastPrice = base.initialPrice; a.lowestSeen = base.initialPrice; a.status = 'watching';
            alerts.unshift(a);
          }
          a.target = target;
          if (!existing) a.notifiedPrice = null;
          saveAlerts(); closeSheet(); if (bellBtn) bellBtn.classList.add('on');
          // Android: alerts only help if the phone checks on its own, so switch background checks on with the first alert
          if (P.features.background === true) P.getSettings().then(function (st) {
            if (!st.background) { P.saveSettings({ background: true, hours: st.hours || 12 }); toast('Alert set - your phone will check every ' + (st.hours || 12) + ' hours and notify you'); }
          });
          toast(target ? 'We\'ll alert you at ' + money(target, a.currency) + ' or less' : 'We\'ll alert you on any price drop');
        } }))
    ]);
  }

  /* ---------- sheet ---------- */
  function openSheet(children) {
    var s = clear($('sheet')); add(s, h('div', { class: 'grab' })); add(s, children);
    s.hidden = false; $('sheetBackdrop').hidden = false;
  }
  function closeSheet() { $('sheet').hidden = true; $('sheetBackdrop').hidden = true; }
  $('sheetBackdrop').onclick = closeSheet;

  /* ---------- navigation ---------- */
  var root = 'explore', stack = [];
  var views = {};
  function go(view, params, replace) {
    if (replace) stack.pop();
    stack.push({ view: view, params: params || {} });
    render();
  }
  function back() {
    if (!$('sheet').hidden) { closeSheet(); return true; }
    if (stack.length > 1) { stack.pop(); render(); return true; }
    if (root !== 'explore') { setRoot('explore'); return true; }
    return false;
  }
  function setRoot(r) {
    root = r; stack = [{ view: r, params: {} }];
    Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (b) { b.classList.toggle('active', b.dataset.root === r); });
    render();
  }
  function render() {
    var top = stack[stack.length - 1], v = clear($('view'));
    $('back').hidden = stack.length < 2;
    setTitle('Cruise Deals', '');
    window.scrollTo(0, 0);
    views[top.view](v, top.params);
  }
  function setTitle(t, s) { $('title').textContent = t; $('subtitle').textContent = s || ''; document.title = t; }
  $('back').onclick = back;
  window.onNativeBack = back; // Android hardware back
  Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (b) { b.onclick = function () { setRoot(b.dataset.root); }; });

  function steps(n) {
    var names = ['Ship', 'Sail date', 'Packages'];
    return h('div', { class: 'steps' }, names.map(function (nm, i) {
      return h('div', { class: i < n ? 'done' : i === n ? 'now' : '', text: (i + 1) + '. ' + nm });
    }));
  }
  function shipInitials(name) {
    var w = String(name).replace(/^Celebrity /, '').replace(/ of the Seas$/, '').split(/\s+/);
    return (w[0] || '?').slice(0, 1) + (w[1] ? w[1].slice(0, 1) : (w[0] || '').slice(1, 2));
  }

  /* ================= Explore: ship picker ================= */
  views.explore = function (v) {
    var brand = pref('brand', 'all'), q = '';
    var recent = pref('recent', []);
    add(v, h('button', { class: 'finder-cta', onclick: function () { go('finder'); } },
      h('span', { class: 'e', text: '\u{1F50E}' }),
      h('div', { class: 'grow' }, h('b', { text: 'Find the cheapest cruise' }),
        h('div', { class: 'small', text: 'By ship class (Icon, Oasis\u2026), group size, connecting rooms and length' })),
      h('span', { class: 'chev', text: '\u203a' })));
    add(v, h('button', { class: 'item card tap', style: 'margin-bottom:14px', onclick: function () { go('connecting'); } },
      h('span', { style: 'font-size:24px', text: '\u{1F6AA}' }),
      h('div', { class: 'grow' }, h('div', { class: 't', text: 'Connecting cabins by ship' }), h('div', { class: 's', text: 'Every connecting pair we have found, deck by deck' })),
      h('span', { class: 'chev', text: '\u203a' })));
    add(v, steps(0));
    if (recent.length) {
      add(v, h('h2', { text: 'Recently viewed' }));
      add(v, h('div', { class: 'list' }, recent.slice(0, 3).map(function (r) {
        return h('button', { class: 'item', onclick: function () { go('sailing', r); } },
          h('div', { class: 'badge' + (r.ship.brand === 'celebrity' ? ' celebrity' : ''), text: shipInitials(r.ship.name) }),
          h('div', { class: 'grow' }, h('div', { class: 't', text: r.ship.name }), h('div', { class: 's', text: Core.fmtSailDate(r.sailing.date) + ' · ' + r.sailing.duration + ' nights' })),
          h('span', { class: 'chev', text: '›' }));
      })));
    }
    add(v, h('h2', { text: 'Choose your ship' }));
    var search = h('input', { class: 'search', type: 'search', placeholder: 'Search ships (e.g. Wonder, Icon, Beyond)', 'aria-label': 'Search ships' });
    var chips = h('div', { class: 'chips' });
    var list = h('div', null, skeleton(6));
    add(v, [search, chips, list]);
    [['all', 'All ships'], ['royal', 'Royal Caribbean'], ['celebrity', 'Celebrity']].forEach(function (c) {
      add(chips, h('button', { class: 'chip' + (brand === c[0] ? ' on' : ''), text: c[1], onclick: function (e) {
        brand = c[0]; setPref('brand', brand);
        Array.prototype.forEach.call(chips.children, function (x) { x.classList.remove('on'); }); e.target.classList.add('on'); draw();
      } }));
    });
    var ships = [];
    function draw() {
      clear(list);
      var ql = q.toLowerCase();
      var shown = ships.filter(function (s) { return (brand === 'all' || s.brand === brand) && (!ql || s.name.toLowerCase().indexOf(ql) >= 0 || s.code.toLowerCase() === ql); });
      if (!shown.length) { add(list, empty('\u{1F6A2}', 'No ships match "' + q + '"')); return; }
      add(list, h('div', { class: 'list' }, shown.map(function (s) {
        return h('button', { class: 'item', onclick: function () { go('ship', { ship: s }); } },
          h('div', { class: 'badge' + (s.brand === 'celebrity' ? ' celebrity' : ''), text: shipInitials(s.name) }),
          h('div', { class: 'grow' }, h('div', { class: 't', text: s.name }), h('div', { class: 's', text: s.brand === 'royal' ? 'Royal Caribbean' : 'Celebrity Cruises' })),
          h('span', { class: 'chev', text: '›' }));
      })));
    }
    search.oninput = function () { q = search.value.trim(); draw(); };
    api.ships().then(function (s) { ships = s; draw(); }).catch(function (e) {
      clear(list); add(list, [errBox(e), h('button', { class: 'btn block', text: 'Try again', onclick: render })]);
    });
  };

  /* ---------- group pricing with Royal's rooms service (connecting-aware) ---------- */
  function whoText(a, c) { return a + ' adult' + (a > 1 ? 's' : '') + (c ? ' + ' + c + ' kid' + (c > 1 ? 's' : '') : ''); }
  function kindName(k) { return Core.CABIN_KIND_NAMES[k] || k; }

  /* connecting cabin pairs we have seen, remembered per ship (they never change) */
  function shipPairs(code) { return pref('pairs.' + code, {}); }
  function learnPairs(code, pairs) {
    if (!pairs || !pairs.length) return;
    var m = shipPairs(code), changed = false;
    pairs.forEach(function (p) {
      var key = [p[0], p[1]].sort(function (a, b) { return a - b; }).join('&');
      if (!m[key]) { m[key] = { a: key.split('&')[0], b: key.split('&')[1], cat: p[2], kind: p[3], name: p[4] }; changed = true; }
    });
    if (changed) { setPref('pairs.' + code, m); setPref('pairsUpdated.' + code, Date.now()); }
  }

  /* room types Royal said have connecting rooms on a ship (kept with the pairs) */
  function shipConnCats(code) { return pref('conncats.' + code, {}); }
  function learnConnCats(code, ro) {
    if (!ro || !ro.options || !ro.rooms || ro.rooms.length < 2) return;
    var m = shipConnCats(code), changed = false;
    ro.options.forEach(function (o) {
      if (!o.connecting || m[o.code]) return;
      m[o.code] = { code: o.categoryCode || o.code, kind: o.kind, name: o.name }; changed = true;
    });
    if (changed) { setPref('conncats.' + code, m); setPref('pairsUpdated.' + code, Date.now()); }
  }

  api.roomOptions = function (o) {
    return cached('ro.' + JSON.stringify(o), 30 * 60e3, function () { return Core.getRoomOptions(http, o); });
  };

  /*
   * Best price per cabin kind for a group on one sailing.
   * Resolves {byKind:[{kind, name, code, total, perRoom, connecting, pairs, split}], kinds:[all kinds offered], source}
   */
  function groupPrices(ship, sailing, splits, connecting) {
    var disc = Core.discountOpts(discounts(), ship.name);
    function base() {
      var o = { packageCode: ship.code + sailing.voyageCode, sailDate: sailing.date, currency: currency(), host: Core.brandHost(ship.name) };
      for (var k in disc) o[k] = disc[k];
      return o;
    }
    var best = {}, kinds = {}, ok = 0, lastErr = '';
    return Promise.all(splits.map(function (sp) {
      function ask(rooms) {
        var o = base(); o.rooms = rooms.map(function (c) { return { adults: c.adults, children: c.children }; });
        return api.roomOptions(o);
      }
      // Royal prices only the FIRST room of a request, so ask once per room size with that size first
      return ask(sp).then(function (first) {
        learnPairs(ship.code, first.pairs); learnConnCats(ship.code, first);
        var byOcc = {}, jobs = [];
        byOcc[sp[0].adults + '/' + sp[0].children] = first;
        sp.forEach(function (c, i) {
          var key = c.adults + '/' + c.children;
          if (byOcc[key] !== undefined) return;
          byOcc[key] = null;
          var order = [c].concat(sp.filter(function (x, j) { return j !== i; }));
          jobs.push(ask(order).then(function (ro) { byOcc[key] = ro; learnPairs(ship.code, ro.pairs); }, function () { delete byOcc[key]; }));
        });
        return Promise.all(jobs).then(function () {
          ok++;
          first.options.forEach(function (c) { kinds[c.kind] = 1; });
          Core.combineSplit(sp, first, byOcc, connecting).forEach(function (b) {
            if (!best[b.kind] || b.total < best[b.kind].total) { b.split = sp; best[b.kind] = b; }
          });
        });
      }, function (e) { lastErr = (e && e.message) || String(e); /* try the other splits */ });
    })).then(function () {
      if (ok) return { byKind: ['interior', 'ocean', 'balcony', 'suite', 'other'].filter(function (k) { return best[k]; }).map(function (k) { return best[k]; }), kinds: Object.keys(kinds), source: 'rooms' };
      // fallback: older per-cabin page (no connecting flags for most categories)
      var occ = Core.occupanciesFor(splits), table = {};
      return Promise.all(occ.map(function (oc) {
        var o = base(); o.adults = oc.adults; o.children = oc.children;
        return api.cabins(o).then(function (rows) { table[oc.adults + '/' + oc.children] = rows; }, function () { table[oc.adults + '/' + oc.children] = []; });
      })).then(function () {
        var out = [], seen = {};
        Core.bestCombos(table, splits, connecting).forEach(function (x) {
          var k = Core.cabinTypeOf(x.name); seen[k] = 1;
          if (!x.best || x.best.cabins.length !== splits[0].length) return;
          if (!out.some(function (y) { return y.kind === k && y.total <= x.best.total; })) {
            out = out.filter(function (y) { return y.kind !== k; });
            out.push({ kind: k, name: x.name, code: '', total: x.best.total, perRoom: x.best.cabins.map(function (c) { return c.price; }), connecting: x.best.connecting, pairs: [],
              split: x.best.cabins.map(function (c) { return { adults: c.adults, children: c.children }; }) });
          }
        });
        if (!out.length && !Object.keys(seen).length) throw new Error('Could not get prices for this sailing');
        return { byKind: out, kinds: Object.keys(seen), source: 'fallback', error: lastErr };
      });
    });
  }

  function pairText(pairs) { return pairs.slice(0, 3).map(function (p) { return p[0] + ' & ' + p[1]; }).join(', ') + (pairs.length > 3 ? ' +' + (pairs.length - 3) + ' more' : ''); }

  /* ================= Cheapest cruise finder ================= */
  var LENGTHS = [['short', '2-5 nights', 2, 5], ['week', '6-8 nights', 6, 8], ['long', '9+ nights', 9, 99]];
  var CABIN_TYPES = [['any', 'Any'], ['interior', 'Inside'], ['ocean', 'Ocean View'], ['balcony', 'Balcony'], ['suite', 'Suite']];
  function monthKey(d) { return d.getFullYear() * 100 + d.getMonth() + 1; }
  function monthOptions() {
    var out = [], d = new Date(); d.setDate(1);
    for (var i = 0; i < 24; i++) { out.push({ key: monthKey(d), label: d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) }); d.setMonth(d.getMonth() + 1); }
    return out;
  }

  views.finder = function (v) {
    setTitle('Find the cheapest cruise', 'Every matching sailing, cheapest first');
    var months = monthOptions();
    var f = pref('finder', null) || { classes: ['icon', 'oasis'], adults: 4, children: 2, rooms: 2, maxPer: 4, connecting: true, lengths: ['short', 'week'], from: months[0].key, to: months[5].key, cabin: 'any', skipShips: [] };
    if (!months.some(function (m) { return m.key === f.from; })) f.from = months[0].key;
    if (!months.some(function (m) { return m.key === f.to; })) f.to = months[Math.min(5, months.length - 1)].key;
    function save() { setPref('finder', f); }

    var form = h('div'), out = h('div');
    add(v, [form, out]);
    var allShips = [];

    function chipToggle(list, id) { var i = list.indexOf(id); if (i >= 0) list.splice(i, 1); else list.push(id); save(); }
    function stepper(label, key, min, max, after) {
      var val = h('b', { text: f[key] });
      function set(n) { f[key] = n; val.textContent = n; save(); if (after) after(); }
      return h('div', { class: 'row', style: 'justify-content:space-between;padding:6px 0' }, h('span', { text: label }),
        h('div', { class: 'stepper' },
          h('button', { 'aria-label': 'Fewer ' + label, text: '−', onclick: function () { if (f[key] > min) set(f[key] - 1); } }), val,
          h('button', { 'aria-label': 'More ' + label, text: '+', onclick: function () { if (f[key] < max) set(f[key] + 1); } })));
    }

    function drawForm() {
      clear(form);
      /* ship classes */
      var classChips = h('div', { class: 'chips wrap' });
      Core.SHIP_CLASSES.forEach(function (c) {
        add(classChips, h('button', { class: 'chip' + (f.classes.indexOf(c.id) >= 0 ? ' on' : ''), text: c.name.replace('Celebrity ', 'Celebrity '), onclick: function () { chipToggle(f.classes, c.id); drawForm(); } }));
      });
      var shipChips = h('div', { class: 'chips wrap' });
      var inClass = allShips.filter(function (sh) { return f.classes.indexOf(Core.shipClass(sh.name)) >= 0; });
      inClass.forEach(function (sh) {
        var on = f.skipShips.indexOf(sh.code) < 0;
        add(shipChips, h('button', { class: 'chip small-chip' + (on ? ' on' : ''), text: (on ? '✓ ' : '') + sh.name.replace(' of the Seas', '').replace('Celebrity ', ''), onclick: function () { chipToggle(f.skipShips, sh.code); drawForm(); } }));
      });
      add(form, h('div', { class: 'card' }, h('b', { text: '1. Ship class' }), classChips,
        allShips.length ? (inClass.length ? h('div', { class: 'small muted', style: 'margin-top:6px', text: 'Ships included (tap to leave one out):' }) : h('div', { class: 'small muted', text: 'Pick at least one class.' })) : h('div', { class: 'small muted', text: 'Loading ships…' }),
        shipChips));

      /* party + rooms */
      var conn = h('input', { type: 'checkbox', checked: f.connecting, disabled: f.rooms < 2 });
      conn.onchange = function () { f.connecting = conn.checked; save(); };
      var roomSeg = h('div', { class: 'chips', style: 'padding:4px 0' });
      [1, 2, 3].forEach(function (n) {
        add(roomSeg, h('button', { class: 'chip' + (f.rooms === n ? ' on' : ''), text: n + ' room' + (n > 1 ? 's' : ''), onclick: function () { f.rooms = n; save(); drawForm(); } }));
      });
      add(form, h('div', { class: 'card' }, h('b', { text: '2. Who\'s going' }),
        stepper('Adults', 'adults', 1, 12), stepper('Children', 'children', 0, 10),
        h('div', { class: 'small muted', style: 'margin-top:8px', text: 'Rooms' }), roomSeg,
        stepper('Max guests per room', 'maxPer', 2, 6),
        h('label', { class: 'toggle' }, h('div', null, h('span', { text: 'Connecting rooms only' }), h('div', { class: 'small muted', text: f.rooms < 2 ? 'Pick 2 or 3 rooms to use this' : 'Rooms with a door between them' })), conn)));

      /* length + dates + cabin */
      var lenChips = h('div', { class: 'chips wrap' });
      LENGTHS.forEach(function (l) {
        add(lenChips, h('button', { class: 'chip' + (f.lengths.indexOf(l[0]) >= 0 ? ' on' : ''), text: l[1], onclick: function () { chipToggle(f.lengths, l[0]); drawForm(); } }));
      });
      var from = h('select', null, months.map(function (m) { return h('option', { value: m.key, selected: m.key === f.from, text: m.label }); }));
      var to = h('select', null, months.map(function (m) { return h('option', { value: m.key, selected: m.key === f.to, text: m.label }); }));
      from.onchange = function () { f.from = +from.value; if (f.to < f.from) f.to = f.from; save(); drawForm(); };
      to.onchange = function () { f.to = +to.value; if (f.to < f.from) f.from = f.to; save(); drawForm(); };
      var cabChips = h('div', { class: 'chips wrap' });
      CABIN_TYPES.forEach(function (c) {
        add(cabChips, h('button', { class: 'chip' + (f.cabin === c[0] ? ' on' : ''), text: c[1], onclick: function () { f.cabin = c[0]; save(); drawForm(); } }));
      });
      add(form, h('div', { class: 'card' }, h('b', { text: '3. Cruise length & dates' }), lenChips,
        h('div', { class: 'row', style: 'margin-top:8px' },
          h('label', { class: 'field grow', style: 'margin:0' }, h('span', { text: 'From' }), from),
          h('label', { class: 'field grow', style: 'margin:0' }, h('span', { text: 'To' }), to)),
        h('div', { style: 'height:10px' }), h('b', { text: '4. Cabin type' }), cabChips));

      var msg = h('div');
      add(form, [msg, h('button', { class: 'btn block', text: '\u{1F50E} Find the cheapest cruises', onclick: function () { clear(msg); run(msg); } })]);
    }

    api.ships().then(function (sh) { allShips = sh; drawForm(); }).catch(function (e) { add(out, errBox(e)); });
    drawForm();

    var runSeq = 0;
    function run(msg) {
      var my = ++runSeq;
      var alive = function () { return my === runSeq && document.body.contains(out); };
      var splits = Core.planSplits(f.adults, f.children, f.maxPer, f.rooms).filter(function (sp) { return sp.length === f.rooms; });
      if (!f.classes.length) { add(msg, errBox('Pick at least one ship class.')); return; }
      if (!f.lengths.length) { add(msg, errBox('Pick at least one cruise length.')); return; }
      if (!splits.length) { add(msg, errBox('That group doesn\'t fit in ' + f.rooms + ' room' + (f.rooms > 1 ? 's' : '') + ' of up to ' + f.maxPer + ' (each room needs an adult). Change rooms or max guests per room.')); return; }
      var ships = allShips.filter(function (sh) { return f.classes.indexOf(Core.shipClass(sh.name)) >= 0 && f.skipShips.indexOf(sh.code) < 0; });
      if (!ships.length) { add(msg, errBox('No ships selected.')); return; }
      var connecting = f.connecting && f.rooms > 1;
      var occ = Core.occupanciesFor(splits);

      clear(out);
      var status = h('div', { class: 'progress' }, h('span', { class: 'spin' }), 'Finding sailings on ' + ships.length + ' ships…');
      var stopBtn = h('button', { class: 'btn ghost block', text: 'Stop searching', onclick: function () { runSeq++; stopBtn.hidden = true; clear(status); add(status, 'Stopped.'); } });
      var listEl = h('div');
      add(out, [h('h2', { text: 'Results' }), status, stopBtn, listEl]);
      out.scrollIntoView({ behavior: 'smooth' });

      Promise.all(ships.map(function (sh) {
        return api.sailings(sh.code).then(function (ss) { return ss.map(function (x) { return { ship: sh, sailing: x }; }); }, function () { return []; });
      })).then(function (lists) {
        if (!alive()) return;
        var cands = [].concat.apply([], lists).filter(function (c) {
          var mk = monthKey(Core.sailDateObj(c.sailing.date));
          var okLen = LENGTHS.some(function (l) { return f.lengths.indexOf(l[0]) >= 0 && c.sailing.duration >= l[2] && c.sailing.duration <= l[3]; });
          return okLen && mk >= f.from && mk <= f.to && Core.sailDateObj(c.sailing.date) > new Date();
        }).sort(function (a, b) { return a.sailing.date < b.sailing.date ? -1 : 1; });
        if (!cands.length) { clear(status); stopBtn.hidden = true; add(listEl, empty('\u{1F6A2}', 'No sailings match', 'Try more months, another length or more ship classes.')); return; }
        var MAX = 150;
        if (cands.length > MAX) cands = cands.slice(0, MAX);
        var total = cands.length, done = 0, results = [], soldOut = 0, idx = 0;
        function tick() {
          clear(status);
          if (done < total) add(status, [h('span', { class: 'spin' }), 'Pricing ' + done + ' of ' + total + ' sailings… (' + occ.length + ' price check' + (occ.length > 1 ? 's' : '') + ' each, cheapest shown so far)']);
          else { stopBtn.hidden = true; add(status, 'Checked ' + total + ' sailings' + (soldOut ? ' · ' + soldOut + ' had nothing that fits' : '') + '.'); }
        }
        function draw() {
          clear(listEl);
          results.sort(function (a, b) { return a.total - b.total; });
          if (!results.length && done === total) { add(listEl, empty('\u{1F6AB}', connecting ? 'No sailings with connecting rooms that fit your group' : 'No sailings with rooms that fit your group', connecting ? 'Try turning off "Connecting rooms only" or another cabin type.' : 'Try other dates or cabin type.')); return; }
          add(listEl, h('div', { class: 'list' }, results.slice(0, 40).map(function (r, i) { return resultRow(r, i); })));
          if (results.length > 40) add(listEl, h('div', { class: 'notice', text: '+ ' + (results.length - 40) + ' more sailings (more expensive).' }));
        }
        function resultRow(r, i) {
          var n = f.adults + f.children, pk = r.pick;
          var others = r.byKind.filter(function (t) { return t !== pk; });
          var bellBase = r.source === 'rooms' || r.pick.split.length === 1 ? cruiseAlertBase(r.ship, r.sailing, pk.split, pk.kind, connecting, r.total) : null;
          return h('div', { class: 'item', role: 'button', tabindex: '0', style: 'align-items:flex-start;cursor:pointer', onkeydown: function (e) { if (e.key === 'Enter') e.currentTarget.click(); }, onclick: function () {
            setPref('cabinMode', f.rooms > 1 ? 'group' : 'one');
            setPref('group', { adults: f.adults, children: f.children, maxPer: f.maxPer, connecting: connecting, rooms: Math.max(2, f.rooms) });
            if (f.rooms === 1) setPref('party', { adults: f.adults, children: f.children });
            go('sailing', { ship: r.ship, sailing: r.sailing, tab: 'cabins' });
          } },
            h('div', { class: 'rank', text: i + 1 }),
            h('div', { class: 'grow' },
              h('div', { class: 't', text: r.ship.name }),
              h('div', { class: 's', text: Core.fmtSailDate(r.sailing.date, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) + ' · ' + r.sailing.duration + ' nights' }),
              h('div', { class: 's', text: r.sailing.description }),
              h('div', { class: 's', style: 'color:var(--text);font-weight:600' },
                (pk.connecting ? '\u{1F6AA} ' + pk.split.length + ' connecting ' : pk.split.length > 1 ? pk.split.length + ' x ' : '') + kindName(pk.kind) + ' – ' + pk.name + (pk.code ? ' (' + pk.code + ')' : '')),
              h('div', { class: 's', style: 'color:var(--text)' }, pk.split.map(function (c, k) {
                return (pk.split.length > 1 ? 'Room ' + (k + 1) + ': ' : '') + whoText(c.adults, c.children) + (pk.perRoom[k] ? ' ' + money(pk.perRoom[k]) : '');
              }).join(' · ')),
              pk.pairs && pk.pairs.length ? h('div', { class: 's', text: 'Open connecting pairs: ' + pairText(pk.pairs) }) : null,
              others.length ? h('div', { class: 's', text: others.map(function (t) { return kindName(t.kind) + ' ' + money(t.total); }).join(' · ') }) : null,
              r.missing.length ? h('div', { class: 's', text: r.missing.map(kindName).join(', ') + ': ' + (connecting ? 'no connecting rooms' : 'nothing that fits') }) : null),
            h('div', { class: 'price' }, h('b', { text: money(r.total) }), h('span', { class: 'u', text: money(r.total / n) + ' pp' })),
            bellBase ? cruiseBell(bellBase, 'Price alert for ' + r.ship.name + ' ' + Core.fmtSailDate(r.sailing.date)) : null);
        }
        function worker() {
          if (idx >= cands.length || !alive()) return Promise.resolve();
          var c = cands[idx++];
          return groupPrices(c.ship, c.sailing, splits, connecting).then(function (g) {
            if (!alive()) return;
            var wanted = f.cabin === 'any' ? g.byKind.slice() : g.byKind.filter(function (x) { return x.kind === f.cabin; });
            wanted.sort(function (a, b) { return a.total - b.total; });
            var missing = g.kinds.filter(function (k) { return k !== 'other' && !g.byKind.some(function (x) { return x.kind === k; }); });
            if (wanted.length) results.push({ ship: c.ship, sailing: c.sailing, total: wanted[0].total, pick: wanted[0], byKind: g.byKind, missing: missing, source: g.source });
            else soldOut++;
          }, function () { soldOut++; }).then(function () { done++; if (alive()) { tick(); draw(); } return worker(); });
        }
        tick();
        Promise.all([worker(), worker(), worker()]);
      });
    }
  };

  /* ================= Connecting cabins by ship ================= */
  function pairCount(code) { return Object.keys(shipPairs(code)).length; }
  function catCount(code) { return Object.keys(shipConnCats(code)).length; }

  /* finds pairs for one ship: asks for 2 rooms of 2 adults on its next couple of sailings */
  function scanShip(ship) {
    return api.sailings(ship.code).then(function (ss) {
      var soon = ss.filter(function (x) { return Core.sailDateObj(x.date) > new Date(Date.now() + 14 * 864e5); }).slice(0, 2);
      return Promise.all(soon.map(function (sl) {
        var o = { packageCode: ship.code + sl.voyageCode, sailDate: sl.date, currency: 'USD', host: Core.brandHost(ship.name), rooms: [{ adults: 2, children: 0 }, { adults: 2, children: 0 }] };
        return api.roomOptions(o).then(function (ro) { learnPairs(ship.code, ro.pairs); learnConnCats(ship.code, ro); }, function () { /* skip */ });
      }));
    });
  }

  views.connecting = function (v) {
    setTitle('Connecting cabins', 'By ship and deck');
    var listEl = h('div', null, skeleton(6)), status = h('div', { class: 'progress' });
    var scanBtn = h('button', { class: 'btn block', text: '\u{1F50D} Scan all ships' });
    add(v, [h('div', { class: 'card small muted', text: 'Connecting pairs come from the cruise line\'s own room selection. Only cabins that are still for sale show up, so the list grows every time you search or scan. Pairs never change, so they are saved on this device.' }),
      scanBtn, status, listEl]);
    var ships = [];
    function draw() {
      clear(listEl);
      add(listEl, h('div', { class: 'list' }, ships.map(function (sh) {
        var n = pairCount(sh.code), nc = catCount(sh.code);
        return h('button', { class: 'item', onclick: function () { go('connShip', { ship: sh }); } },
          h('div', { class: 'badge' + (sh.brand === 'celebrity' ? ' celebrity' : ''), text: shipInitials(sh.name) }),
          h('div', { class: 'grow' }, h('div', { class: 't', text: sh.name }), h('div', { class: 's', text: (Core.SHIP_CLASSES.filter(function (c) { return c.id === Core.shipClass(sh.name); })[0] || { name: '' }).name })),
          h('span', { class: 'pill' + (n || nc ? ' ok' : ''), text: n ? n + ' pairs' : nc ? nc + ' room types' : 'not scanned' }), h('span', { class: 'chev', text: '›' }));
      })));
    }
    api.ships().then(function (s) {
      ships = s.slice().sort(function (a, b) { return pairCount(b.code) - pairCount(a.code) || catCount(b.code) - catCount(a.code) || a.name.localeCompare(b.name); });
      draw();
    }).catch(function (e) { clear(listEl); add(listEl, errBox(e)); });
    var running = false;
    scanBtn.onclick = function () {
      if (running) { running = false; return; }
      running = true; scanBtn.textContent = 'Stop scanning';
      var idx = 0, done = 0;
      function tick() { clear(status); add(status, [h('span', { class: 'spin' }), 'Scanning ' + done + ' of ' + ships.length + ' ships…']); }
      tick();
      function worker() {
        if (!running || idx >= ships.length || !document.body.contains(v)) return Promise.resolve();
        var sh = ships[idx++];
        return scanShip(sh).catch(function () {}).then(function () { done++; if (document.body.contains(v)) { tick(); draw(); } return worker(); });
      }
      Promise.all([worker(), worker()]).then(function () {
        running = false; scanBtn.textContent = '\u{1F50D} Scan all ships';
        clear(status); add(status, 'Scanned ' + done + ' ships.'); draw();
      });
    };
  };

  views.connShip = function (v, p) {
    var ship = p.ship;
    setTitle(ship.name, 'Connecting cabins');
    var box = h('div');
    var btn = h('button', { class: 'btn block', text: '\u{1F50D} Scan this ship now' });
    add(v, [btn, h('div', { style: 'height:10px' }), box]);
    function draw() {
      clear(box);
      var m = shipPairs(ship.code), keys = Object.keys(m), cats = shipConnCats(ship.code), ck = Object.keys(cats);
      if (ck.length) {
        add(box, h('div', { class: 'port-h' }, h('div', { class: 'grow' }, h('div', { class: 'port-name', text: 'Room types with connecting rooms' })), h('span', { class: 'small muted', text: ck.length + ' types' })));
        add(box, h('div', { class: 'list' }, ['interior', 'ocean', 'balcony', 'suite', 'other'].map(function (k) {
          var l = ck.map(function (x) { return cats[x]; }).filter(function (x) { return x.kind === k; });
          if (!l.length) return null;
          return h('div', { class: 'prod', style: 'align-items:flex-start' }, h('b', { style: 'width:92px;flex:none', text: kindName(k) }),
            h('div', { class: 'grow small' }, l.map(function (x) { return h('div', { text: x.name + ' (' + x.code + ')' }); })));
        }).filter(Boolean)));
        add(box, h('div', { style: 'height:10px' }));
      }
      if (!keys.length && ck.length) { add(box, h('div', { class: 'small muted', text: 'Royal does not list the exact cabin numbers until you pick a room type on its site.' })); return; }
      if (!keys.length) { add(box, empty('\u{1F6AA}', 'No connecting pairs found yet', 'Tap "Scan this ship now", or search this ship with 2+ rooms.')); return; }
      var upd = pref('pairsUpdated.' + ship.code, 0);
      add(box, h('div', { class: 'notice', text: keys.length + ' connecting pairs' + (upd ? ' · updated ' + new Date(upd).toLocaleDateString() : '') }));
      ['interior', 'ocean', 'balcony', 'suite', 'other'].forEach(function (k) {
        var list = keys.map(function (x) { return m[x]; }).filter(function (x) { return x.kind === k; });
        if (!list.length) return;
        var decks = {};
        list.forEach(function (x) { var d = String(x.a).slice(0, -3) || '?'; (decks[d] = decks[d] || []).push(x); });
        add(box, h('div', { class: 'port-h' }, h('div', { class: 'grow' }, h('div', { class: 'port-name', text: kindName(k) })), h('span', { class: 'small muted', text: list.length + ' pairs' })));
        add(box, h('div', { class: 'list' }, Object.keys(decks).sort(function (a, b) { return a - b; }).map(function (d) {
          var ps = decks[d].sort(function (a, b) { return a.a - b.a; });
          return h('div', { class: 'prod', style: 'align-items:flex-start' }, h('b', { style: 'width:62px;flex:none', text: 'Deck ' + d }),
            h('div', { class: 'grow small' }, ps.map(function (x) { return h('div', { text: x.a + ' ↔ ' + x.b + '  · ' + x.name + (x.cat ? ' (' + x.cat + ')' : '') }); })));
        })));
      });
    }
    btn.onclick = function () {
      btn.disabled = true; btn.textContent = 'Scanning…';
      scanShip(ship).catch(function () {}).then(function () { btn.disabled = false; btn.textContent = '\u{1F50D} Scan this ship now'; draw(); });
    };
    draw();
  };

  /* ================= Ship: sail date picker ================= */
  views.ship = function (v, p) {
    var ship = p.ship;
    setTitle(ship.name, 'Pick a sail date');
    add(v, steps(1));
    var search = h('input', { class: 'search', type: 'search', placeholder: 'Filter by port, month or itinerary', 'aria-label': 'Filter sailings' });
    var chips = h('div', { class: 'chips' });
    var list = h('div', null, skeleton(6));
    add(v, [search, chips, list]);
    var len = 'all', q = '', sailings = [];
    [['all', 'Any length'], ['short', '2-5 nights'], ['week', '6-8 nights'], ['long', '9+ nights']].forEach(function (c) {
      add(chips, h('button', { class: 'chip' + (c[0] === 'all' ? ' on' : ''), text: c[1], onclick: function (e) {
        len = c[0]; Array.prototype.forEach.call(chips.children, function (x) { x.classList.remove('on'); }); e.target.classList.add('on'); draw();
      } }));
    });
    function okLen(d) { return len === 'all' || (len === 'short' && d <= 5) || (len === 'week' && d >= 6 && d <= 8) || (len === 'long' && d >= 9); }
    function draw() {
      clear(list);
      var ql = q.toLowerCase();
      var shown = sailings.filter(function (s) {
        var month = Core.fmtSailDate(s.date, { month: 'long', year: 'numeric' }).toLowerCase();
        return okLen(s.duration) && (!ql || s.description.toLowerCase().indexOf(ql) >= 0 || month.indexOf(ql) >= 0);
      });
      if (!shown.length) { add(list, empty('\u{1F4C5}', sailings.length ? 'No sailings match your filters' : 'No upcoming sailings found')); return; }
      var lastMonth = null, group = null;
      shown.forEach(function (s) {
        var dt = Core.sailDateObj(s.date);
        var month = dt.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        if (month !== lastMonth) { add(list, h('div', { class: 'month', text: month })); group = h('div', { class: 'list' }); add(list, group); lastMonth = month; }
        add(group, h('button', { class: 'item', onclick: function () { go('sailing', { ship: ship, sailing: s }); } },
          h('div', { class: 'date-tile' }, h('div', { class: 'm', text: dt.toLocaleDateString('en-US', { month: 'short' }) }), h('div', { class: 'd', text: dt.getDate() }), h('div', { class: 'y', text: dt.toLocaleDateString('en-US', { weekday: 'short' }) })),
          h('div', { class: 'grow' }, h('div', { class: 't', text: s.description || 'Sailing' }), h('div', { class: 's' }, h('span', { class: 'pill', text: s.duration + ' nights' }))),
          h('span', { class: 'chev', text: '›' })));
      });
    }
    search.oninput = function () { q = search.value.trim(); draw(); };
    api.sailings(ship.code).then(function (s) { sailings = s; draw(); }).catch(function (e) {
      clear(list); add(list, [errBox(e), h('button', { class: 'btn block', text: 'Try again', onclick: render })]);
    });
  };

  /* ================= Sailing: cabins / drinks / dining / wifi / excursions ================= */
  var TABS = [
    { id: 'cabins', label: 'Cabins', e: '\u{1F6CF}️' },
    { id: 'drinks', label: 'Drinks', e: '\u{1F379}' },
    { id: 'dining', label: 'Dining', e: '\u{1F37D}️' },
    { id: 'wifi', label: 'Wi-Fi', e: '\u{1F4F6}' },
    { id: 'excursions', label: 'Excursions', e: '\u{1F3DD}️' },
    { id: 'more', label: 'More', e: '✨' }
  ];

  views.sailing = function (v, p) {
    var ship = p.ship, sailing = p.sailing;
    var recent = pref('recent', []).filter(function (r) { return !(r.ship.code === ship.code && r.sailing.date === sailing.date); });
    recent.unshift({ ship: ship, sailing: sailing }); setPref('recent', recent.slice(0, 5));

    setTitle(ship.name, Core.fmtSailDate(sailing.date) + ' · ' + sailing.duration + ' nights');
    var itinList = h('ul', { class: 'itin', hidden: true });
    var itinBtn = h('button', { class: 'btn', text: '\u{1F5FA}️ Itinerary', onclick: function () { itinList.hidden = !itinList.hidden; } });
    add(v, h('div', { class: 'hero' },
      h('h3', { text: sailing.description || ship.name }),
      h('div', { class: 's', text: Core.fmtSailDate(sailing.date, { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' }) + ' · ' + sailing.duration + ' nights' }),
      itinList,
      h('div', { class: 'btn-row' }, itinBtn,
        h('button', { class: 'btn', text: '↗ Cruise Planner', onclick: function () { P.openUrl(Core.plannerUrl(ship.name, ship.code, sailing.date)); } })),
      h('button', { class: 'btn block', style: 'margin-top:8px', text: '\u{1F514} Watch this cruise', onclick: function () { watchCruiseSheet(ship, sailing); } })));

    var ports = {};
    // excursions wait for this so every section can be labelled with its port (never rejects)
    var itinP = api.itinerary(ship.code, sailing.date).then(function (it) {
      it.forEach(function (d) {
        ports[d.day] = d.port;
        var times = d.type === 'EMBARK' ? (d.depart ? 'departs ' + d.depart : '') : d.type === 'DEBARK' ? (d.arrive ? 'arrives ' + d.arrive : '')
          : (d.arrive && d.depart && d.port !== 'Cruising' ? d.arrive + ' - ' + d.depart : '');
        add(itinList, h('li', null, h('b', { text: 'Day ' + d.day }), h('span', { class: 'grow', text: d.port + (d.type === 'TENDERED' ? ' (tender)' : '') }), h('span', { text: times })));
      });
      if (!it.length) itinBtn.hidden = true;
      return ports;
    }).catch(function () { itinBtn.hidden = true; return ports; });

    var tab = p.tab || pref('lastTab', 'drinks');
    var segs = h('div', { class: 'segs', role: 'tablist' });
    var body = h('div');
    add(v, [segs, body]);
    var catsP = api.categories(ship.code, sailing.date);
    TABS.forEach(function (t) {
      add(segs, h('button', { class: 'seg' + (t.id === tab ? ' on' : ''), role: 'tab', 'data-tab': t.id, onclick: function (e) {
        tab = t.id; p.tab = tab; setPref('lastTab', tab);
        Array.prototype.forEach.call(segs.children, function (x) { x.classList.toggle('on', x.dataset.tab === tab); });
        show();
      } }, h('span', { class: 'e', text: t.e }), h('span', { text: t.label })));
    });
    var seq = 0;
    function show() {
      var my = ++seq; clear(body);
      var alive = function () { return my === seq && document.body.contains(body); };
      if (tab === 'cabins') return cabinsTab(body, ship, sailing, alive);
      add(body, skeleton(5));
      catsP.then(function (cats) {
        if (!alive()) return;
        var mine = cats.filter(function (c) { return c.tab === tab; });
        if (tab !== 'excursions') return productsTab(body, ship, sailing, tab, mine, ports, alive, p.owned || []);
        itinP.then(function () { if (alive()) productsTab(body, ship, sailing, tab, mine, ports, alive, p.owned || []); });
      }).catch(function (e) { if (alive()) { clear(body); add(body, [errBox(e), h('button', { class: 'btn block', text: 'Try again', onclick: render })]); } });
    }
    show();
  };

  function cabinsTab(body, ship, sailing, alive) {
    var mode = pref('cabinMode', 'one');
    var party = pref('party', { adults: 2, children: 0 });
    var group = pref('group', { adults: 4, children: 2, maxPer: 4, connecting: true, rooms: 2 });
    if (!group.rooms) group.rooms = 2;
    var chips = h('div', { class: 'chips', style: 'padding-top:0' });
    var form = h('div'), out = h('div');
    add(body, [chips, form, out]);
    [['one', 'One cabin'], ['group', 'Whole group (2-3 rooms)']].forEach(function (c) {
      add(chips, h('button', { class: 'chip' + (mode === c[0] ? ' on' : ''), text: c[1], onclick: function (e) {
        mode = c[0]; setPref('cabinMode', mode);
        Array.prototype.forEach.call(chips.children, function (x) { x.classList.remove('on'); }); e.target.classList.add('on'); draw();
      } }));
    });
    function stepper(obj, store, label, key, min, max, onchange) {
      var val = h('b', { text: obj[key] });
      function set(n) { obj[key] = n; val.textContent = n; setPref(store, obj); if (onchange) onchange(); }
      return h('div', { class: 'row', style: 'justify-content:space-between;padding:6px 0' }, h('span', { text: label }),
        h('div', { class: 'stepper' },
          h('button', { 'aria-label': 'Fewer ' + label, text: '−', onclick: function () { if (obj[key] > min) set(obj[key] - 1); } }), val,
          h('button', { 'aria-label': 'More ' + label, text: '+', onclick: function () { if (obj[key] < max) set(obj[key] + 1); } })));
    }
    var disc = Core.discountOpts(discounts(), ship.name);
    var discLabels = Core.discountLabels(disc);
    function cabinOpts(adults, children, publicOnly) {
      var o = { packageCode: ship.code + sailing.voyageCode, sailDate: sailing.date, currency: currency(), adults: adults, children: children, host: Core.brandHost(ship.name) };
      if (!publicOnly) for (var k in disc) o[k] = disc[k];
      return o;
    }
    function discountBanner() {
      var loyaltyName = Core.isRoyalShip(ship.name) ? 'Crown & Anchor' : 'Captain\'s Club';
      return discLabels.length
        ? h('div', { class: 'card small', style: 'border-left:5px solid var(--sea)' }, h('b', { text: '\u{1F3F7}\uFE0F Your discounts are on' }), ' \u2014 ' + discLabels.join(', ').replace('loyalty #', loyaltyName + ' #'),
            h('div', { class: 'muted', text: 'Prices below are what you would pay; the public price is shown for comparison.' }))
        : h('div', { class: 'card small' }, h('b', { text: 'Have a ' + loyaltyName + ' number?' }), ' Add it in ',
            h('a', { href: '#', text: 'Settings \u2192 Discounts', onclick: function (e) { e.preventDefault(); setRoot('settings'); } }), ' (plus state, 55+, military\u2026) to see your own cabin prices.');
    }
    function who(a, c) { return a + ' adult' + (a > 1 ? 's' : '') + (c ? ' + ' + c + ' kid' + (c > 1 ? 's' : '') : ''); }
    function draw() {
      clear(form); clear(out);
      if (mode === 'one') {
        add(form, discountBanner());
        add(form, h('div', { class: 'card' }, h('b', { text: 'Who\'s in the cabin?' }), stepper(party, 'party', 'Adults', 'adults', 1, 6), stepper(party, 'party', 'Children', 'children', 0, 6),
          h('button', { class: 'btn block', style: 'margin-top:8px', text: 'Show cabin prices', onclick: loadOne })));
        loadOne();
      } else {
        var conn = h('input', { type: 'checkbox', checked: group.connecting });
        conn.onchange = function () { group.connecting = conn.checked; setPref('group', group); };
        add(form, discountBanner());
        add(form, h('div', { class: 'card' },
          h('b', { text: 'Your whole travel group' }),
          h('div', { class: 'small muted', text: 'We try every way to split your group across your rooms (like 2+4 or 3+3), price each cabin for exactly who is in it, and show the cheapest total for each cabin type.' }),
          stepper(group, 'group', 'Adults', 'adults', 2, 8), stepper(group, 'group', 'Children', 'children', 0, 8),
          stepper(group, 'group', 'Rooms', 'rooms', 2, 3),
          stepper(group, 'group', 'Max guests per cabin', 'maxPer', 2, 6),
          h('label', { class: 'toggle' }, h('div', null, h('span', { text: 'Connecting cabins only' }), h('div', { class: 'small muted', text: 'Cabins with a door between them' })), conn),
          h('button', { class: 'btn block', style: 'margin-top:8px', text: 'Find the best split', onclick: loadGroup })));
      }
    }
    function loadOne() {
      clear(out); add(out, skeleton(4));
      var opts = cabinOpts(party.adults, party.children);
      var hasDisc = discLabels.length > 0;
      Promise.all([api.cabins(opts), hasDisc ? api.cabins(cabinOpts(party.adults, party.children, true)).catch(function () { return []; }) : Promise.resolve([])]).then(function (both) {
        if (!alive()) return;
        var cabins = both[0], pub = {};
        both[1].forEach(function (c) { pub[c.name] = c.price; });
        clear(out);
        if (!cabins.length) { add(out, empty('\u{1F6AB}', 'No cabins for ' + who(party.adults, party.children), 'The sailing may be sold out, or no cabin fits this many guests.')); return; }
        var n = party.adults + party.children;
        add(out, h('div', { class: 'notice', text: 'Cheapest ' + (hasDisc ? 'price with your discounts' : 'public price') + ' per cabin type for ' + who(party.adults, party.children) + ', taxes & fees included as quoted by the cruise line.' }));
        add(out, h('div', { class: 'list' }, cabins.map(function (c) {
          var base = { type: 'cabin', title: c.name + ' cabin (' + who(party.adults, party.children) + ')' + (hasDisc ? ' with discounts' : ''), cabinName: c.name, packageCode: opts.packageCode, sailDate: sailing.date, host: opts.host,
            adults: party.adults, children: party.children, currency: opts.currency, ship: ship.code, shipName: ship.name, categoryName: 'Cabins', initialPrice: c.price };
          for (var k in disc) base[k] = disc[k];
          base.id = alertId(base);
          var bell = c.price === null ? null : h('button', { class: 'bell' + (findAlert(base) ? ' on' : ''), 'aria-label': 'Price alert for ' + c.name, text: '\u{1F514}' });
          if (bell) bell.onclick = function () { openAlertSheet(JSON.parse(JSON.stringify(base)), bell); };
          var publicPrice = pub[c.name];
          var saving = hasDisc && c.price !== null && typeof publicPrice === 'number' && publicPrice > c.price ? publicPrice - c.price : 0;
          return h('div', { class: 'prod' },
            h('div', { class: 'grow' }, h('div', { class: 't', text: c.name }),
              h('div', { class: 'v', text: c.price === null ? 'Sold out' : money(c.price / n, opts.currency) + ' per person' }),
              saving ? h('div', { class: 'v' }, h('span', { class: 'pill ok', text: 'You save ' + money(saving, opts.currency) })) : (hasDisc && c.price !== null && typeof publicPrice === 'number' ? h('div', { class: 'v', text: 'Same as public price' }) : null),
              c.connectingPrice !== null && c.connectingPrice !== undefined ? h('div', { class: 'v', text: '\u{1F6AA} Connecting from ' + money(c.connectingPrice, opts.currency) }) : null),
            h('div', { class: 'price' }, c.price === null ? h('span', { class: 'pill warn', text: 'Sold out' }) : [saving ? h('s', { text: money(publicPrice, opts.currency) }) : null, h('b', { text: money(c.price, opts.currency) }), h('span', { class: 'u', text: hasDisc ? 'your price' : 'total' })]),
            bell);
        })));
        add(out, h('button', { class: 'btn ghost block', text: '\u{1F50D} See every room type', onclick: function () { roomTypesSheet(cabins, opts); } }));
      }).catch(function (e) { if (alive()) { clear(out); add(out, errBox(e)); } });
    }
    function roomTypesSheet(cabins, opts) {
      var lines = [];
      var body = cabins.map(function (c) {
        var subs = c.subtypes || [];
        lines.push(c.name + ':');
        return h('div', null,
          h('div', { class: 'cat-h' }, h('b', { text: c.name }), h('span', { class: 'small muted', text: subs.length + ' room type' + (subs.length === 1 ? '' : 's') })),
          h('div', { class: 'list', style: 'box-shadow:none;border:1px solid var(--line)' }, subs.length ? subs.map(function (st) {
            lines.push('  ' + st.name + (st.code ? ' [' + st.code + ']' : '') + ' | ' + (st.price === null ? 'n/a' : st.price) + ' | left ' + (st.roomsLeft === null ? '?' : st.roomsLeft) +
              ' | ' + (st.connecting ? 'CONNECTING ' : '') + (st.flags && st.flags.length ? 'flags: ' + st.flags.join(',') : ''));
            return h('div', { class: 'prod' },
              h('div', { class: 'grow' }, h('div', { class: 't', text: (st.connecting ? '\u{1F6AA} ' : '') + (st.name || '(no name)') }),
                h('div', { class: 'v', text: [st.code, st.roomsLeft !== null ? st.roomsLeft + ' left' : '', st.guarantee ? 'guarantee (GTY)' : '', st.connecting ? 'connecting' : ''].filter(Boolean).join(' \u00b7 ') })),
              h('div', { class: 'price' }, st.price === null ? h('span', { class: 'pill warn', text: 'n/a' }) : h('b', { text: money(st.price, opts.currency) })));
          }) : h('div', { class: 'prod small muted', text: 'No room types returned' })));
      });
      var copyBtn = h('button', { class: 'btn ghost block', text: '\u{1F4CB} Copy details (to send for help)', onclick: function () {
        var text = ship.name + ' ' + sailing.date + ' (' + who(party.adults, party.children) + ')\n' + lines.join('\n');
        var ta = h('textarea', { style: 'position:fixed;opacity:0' }); ta.value = text; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); toast('Copied - paste it into a message'); } catch (e) { toast('Could not copy'); }
        document.body.removeChild(ta);
      } });
      openSheet([h('h3', { text: 'Every room type on this sailing' }),
        h('div', { class: 'small muted', text: '\u{1F6AA} = connecting (a door to the next cabin). Prices for ' + who(party.adults, party.children) + '.' }),
        body, h('div', { style: 'height:10px' }), copyBtn]);
    }
    function loadGroup() {
      var splits = Core.planSplits(group.adults, group.children, group.maxPer, group.rooms).filter(function (sp) { return sp.length === group.rooms; });
      clear(out);
      if (!splits.length) { add(out, errBox('That group doesn\'t fit in ' + group.rooms + ' rooms of up to ' + group.maxPer + ' with at least one adult in each. Change rooms or max guests per cabin.')); return; }
      add(out, h('div', { class: 'progress' }, h('span', { class: 'spin' }), 'Asking ' + (Core.isRoyalShip(ship.name) ? 'Royal Caribbean' : 'Celebrity') + ' for ' + splits.length + ' way' + (splits.length > 1 ? 's' : '') + ' to split your group…'));
      groupPrices(ship, sailing, splits, group.connecting).then(function (g) {
        if (!alive()) return;
        clear(out);
        if (!g.byKind.length) {
          add(out, empty('\u{1F6AB}', group.connecting ? 'No connecting rooms open for this group' : 'No room combinations available',
            group.connecting ? 'Try turning off "Connecting cabins only", or another split.' : 'The sailing may be sold out for these room sizes.'));
          return;
        }
        var cur = currency(), n = group.adults + group.children;
        add(out, h('div', { class: 'notice', text: 'Cheapest way to fit ' + who(group.adults, group.children) + ' in ' + group.rooms + ' rooms, by cabin type' + (group.connecting ? ', connecting rooms only' : '') + '. ' + (discLabels.length ? 'Prices with your discounts' : 'Public prices') + ', taxes & fees included.' }));
        g.byKind.forEach(function (b) {
          add(out, h('div', { class: 'card' },
            h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', { style: 'font-size:17px', text: kindName(b.kind) }),
              h('div', { class: 'small muted', text: b.name + (b.code ? ' (' + b.code + ')' : '') }),
              b.connecting ? h('div', null, h('span', { class: 'pill ok', text: '\u{1F6AA} Connecting' })) : null),
              h('div', { class: 'price' }, h('b', { text: money(b.total, cur) }), h('span', { class: 'u', text: money(b.total / n, cur) + ' pp' })),
              g.source === 'rooms' ? cruiseBell(cruiseAlertBase(ship, sailing, b.split, b.kind, group.connecting, b.total), 'Price alert for ' + kindName(b.kind) + ' rooms') : null),
            h('div', { style: 'margin-top:8px' }, b.split.map(function (c, i) {
              return h('div', { class: 'row small', style: 'justify-content:space-between;padding:4px 0' },
                h('span', { text: 'Room ' + (i + 1) + ': ' + who(c.adults, c.children) }), h('span', { text: b.perRoom[i] ? money(b.perRoom[i], cur) : '' }));
            })),
            b.pairs && b.pairs.length ? h('div', { class: 'small', style: 'margin-top:6px' }, h('b', { text: 'Open connecting pairs: ' }), pairText(b.pairs)) : null));
        });
        var missing = g.kinds.filter(function (k) { return k !== 'other' && !g.byKind.some(function (x) { return x.kind === k; }); });
        if (missing.length) add(out, h('div', { class: 'notice', text: missing.map(kindName).join(', ') + ': ' + (group.connecting ? 'no connecting rooms open for this group.' : 'nothing that fits this group.') }));
        add(out, h('div', { class: 'notice', text: g.source === 'rooms' ? 'Live from the cruise line\'s room selection, same as their booking site. Pick the exact pair when you book.' : 'Connecting info was not available; showing per-room prices.' + (g.error ? ' (' + g.error + ')' : '') }));
      }).catch(function (e) { if (alive()) { clear(out); add(out, errBox(e)); } });
    }
    draw();
  }

  function productsTab(body, ship, sailing, tab, cats, ports, alive, owned) {
    clear(body);
    var tabInfo = TABS.filter(function (t) { return t.id === tab; })[0];
    if (!cats.length) { add(body, empty(tabInfo.e, 'No ' + tabInfo.label.toLowerCase() + ' packages are for sale on this sailing yet', 'Packages usually appear closer to sailing.')); return; }
    var sort = pref('sort', 'rank'), q = '';
    var search = h('input', { class: 'search', type: 'search', placeholder: tab === 'excursions' ? 'Search excursions or ports' : 'Search ' + tabInfo.label.toLowerCase() });
    var sel = h('select', { 'aria-label': 'Sort' },
      [['rank', 'Recommended'], ['low', 'Price: low to high'], ['high', 'Price: high to low'], ['az', 'Name A-Z']].map(function (o) { return h('option', { value: o[0], selected: o[0] === sort, text: o[1] }); }));
    var progress = h('div', { class: 'progress' });
    var listEl = h('div');
    var isEx = tab === 'excursions';
    var portChips = h('div', { class: 'chips port-chips', style: 'padding-top:0', hidden: !isEx });
    var portSel = '';
    add(body, [h('div', { class: 'toolbar' }, search, sel), portChips, progress, listEl,
      h('div', { class: 'notice', text: 'Public prices. You may see lower prices after login (loyalty, casino, or onboard specials). Tap \u{1F514} to get a price-drop alert.' })]);

    var groups = []; // {key, title, cat, day, port, items}
    function dayDate(day) {
      var dt = Core.sailDateObj(sailing.date);
      dt.setDate(dt.getDate() + day - 1);
      return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    }
    function drawPortChips() {
      if (!isEx) return;
      clear(portChips);
      var order = [], counts = {};
      groups.forEach(function (g) {
        var name = g.port || ('Day ' + g.day);
        if (!(name in counts)) { order.push(name); counts[name] = 0; }
        counts[name] += g.items.length;
      });
      if (order.length < 2) { portChips.hidden = true; return; }
      portChips.hidden = false;
      if (portSel && !(portSel in counts)) portSel = '';
      [''].concat(order).forEach(function (name) {
        var total = name ? counts[name] : order.reduce(function (n, k) { return n + counts[k]; }, 0);
        add(portChips, h('button', { class: 'chip' + (portSel === name ? ' on' : ''), text: (name || 'All ports') + ' (' + total + ')', onclick: function () {
          portSel = name; draw(); window.scrollTo(0, body.offsetTop - 60);
        } }));
      });
    }
    function draw() {
      clear(listEl);
      drawPortChips();
      var ql = q.toLowerCase(), any = false;
      groups.forEach(function (g) {
        if (isEx && portSel && (g.port || ('Day ' + g.day)) !== portSel) return;
        var items = g.items.filter(function (it) { return !ql || it.title.toLowerCase().indexOf(ql) >= 0 || g.title.toLowerCase().indexOf(ql) >= 0; });
        if (!items.length) return;
        any = true;
        items = items.slice();
        if (sort === 'low') items.sort(function (a, b) { return a.price - b.price; });
        else if (sort === 'high') items.sort(function (a, b) { return b.price - a.price; });
        else if (sort === 'az') items.sort(function (a, b) { return a.title.localeCompare(b.title); });
        if (isEx && g.day !== 'all') {
          add(listEl, h('div', { class: 'port-h' },
            h('div', { class: 'grow' }, h('div', { class: 'port-name', text: '\u{1F4CD} ' + (g.port || 'Day ' + g.day) }),
              h('div', { class: 'small muted', text: 'Day ' + g.day + ' \u00b7 ' + dayDate(g.day) })),
            h('span', { class: 'small muted', text: items.length + ' excursion' + (items.length > 1 ? 's' : '') })));
        } else {
          add(listEl, h('div', { class: 'cat-h' }, h('b', { text: g.title }), h('span', { class: 'small muted', text: items.length + ' item' + (items.length > 1 ? 's' : '') })));
        }
        add(listEl, h('div', { class: 'list' }, items.map(function (it) { return productRow(it, g); })));
      });
      if (!any && !loading) add(listEl, empty('\u{1F50D}', q ? 'Nothing matches "' + q + '"' : 'Nothing for sale here yet'));
    }
    function productRow(it, g) {
      var base = { type: 'product', title: it.title, ship: ship.code, shipName: ship.name, sailDate: sailing.date, category: g.cat.id, categoryName: g.cat.name,
        day: g.day, port: g.port || null, productId: it.id, currency: it.currency || currency(), unit: it.unit, initialPrice: it.price };
      base.id = alertId(base);
      var bell = h('button', { class: 'bell' + (findAlert(base) ? ' on' : ''), 'aria-label': 'Price alert for ' + it.title, text: '\u{1F514}' });
      bell.onclick = function () { openAlertSheet(JSON.parse(JSON.stringify(base)), bell); };
      return h('div', { class: 'prod' },
        h('div', { class: 'grow' }, h('div', { class: 't', text: it.title }), it.variants.length ? h('div', { class: 'v', text: 'Also: ' + it.variants.join(', ') }) : null,
          owned.indexOf(String(it.title).toLowerCase()) >= 0 ? h('span', { class: 'pill ok', text: '✓ You bought this' }) : null),
        h('div', { class: 'price' }, it.base ? h('s', { text: money(it.base, it.currency) }) : null, h('b', { text: money(it.price, it.currency) }), it.unit ? h('span', { class: 'u', text: 'per ' + it.unit }) : null),
        bell);
    }
    search.oninput = function () { q = search.value.trim(); draw(); };
    sel.onchange = function () { sort = sel.value; setPref('sort', sort); draw(); };

    /* build the work list: excursions are queried per itinerary day */
    var jobs = [];
    cats.forEach(function (c) {
      if (tab === 'excursions' && c.id === 'shorex') {
        for (var d = 1; d <= (sailing.duration || 7) + 1; d++) jobs.push({ cat: c, day: d });
      } else jobs.push({ cat: c, day: 'all' });
    });
    var loading = true, done = 0, failed = 0;
    function setProgress() {
      clear(progress);
      if (done < jobs.length) add(progress, [h('span', { class: 'spin' }), 'Loading prices… ' + done + ' of ' + jobs.length]);
      else if (failed) add(progress, failed + ' section(s) could not be loaded. Pull down or reopen to retry.');
    }
    setProgress();
    var idx = 0;
    function worker() {
      if (idx >= jobs.length || !alive()) return Promise.resolve();
      var j = jobs[idx++];
      return api.products(ship.code, sailing.date, j.cat.id, j.day).then(function (items) {
        if (!alive()) return;
        if (items.length) {
          var port = j.day !== 'all' ? (ports[j.day] || '') : '';
          var title = j.day !== 'all' ? 'Day ' + j.day + (port ? ' · ' + port : '') : j.cat.name;
          groups.push({ key: j.cat.id + j.day, title: title, cat: j.cat, day: j.day, port: port, items: items, order: jobs.indexOf(j) });
          groups.sort(function (a, b) { return a.order - b.order; });
        }
      }).catch(function () { failed++; }).then(function () {
        done++; if (!alive()) return; setProgress(); if (done === jobs.length) loading = false; draw(); return worker();
      });
    }
    Promise.all([worker(), worker(), worker(), worker()]).then(function () { loading = false; if (alive()) { setProgress(); draw(); } });
  }

  /* ================= Alerts ================= */
  /* ---------- Royal specials (bonus points, gift card deals, your own words on a Royal page) ---------- */
  function ensureBackground() {
    if (P.features.background === true) P.getSettings().then(function (st) {
      if (!st.background) P.saveSettings({ background: true, hours: st.hours || 12 });
    });
  }
  function specialsCard(onChange) {
    var card = h('div', { class: 'card' });
    function draw() {
      clear(card);
      var how = P.kind === 'web' ? 'Checked every 3 hours (gently, to stay clear of the cruise line\'s bot protection) and texted right away, not held for the daily text.'
        : 'Checked every 3 hours while one of these is on (gently, to stay clear of the cruise line\'s bot protection). Your phone shows a notification.';
      add(card, [h('b', { text: '\u2728 Royal specials' }), h('p', { class: 'small muted', text: 'Get alerted when Royal Caribbean posts new wording about these on its deals pages. ' + how })]);
      Object.keys(Core.SPECIALS).forEach(function (key) {
        var id = 'special|' + key;
        var on = h('input', { type: 'checkbox', checked: alerts.some(function (a) { return a.id === id; }) });
        on.onchange = function () {
          if (on.checked) {
            alerts.unshift({ id: id, type: 'special', special: key, title: Core.SPECIALS[key].title, status: 'watching', created: new Date().toISOString(), initialPrice: null });
            ensureBackground(); toast('Watching for ' + (key === 'points' ? 'bonus points' : 'gift card deals'));
          } else alerts = alerts.filter(function (a) { return a.id !== id; });
          saveAlerts(); onChange();
        };
        add(card, h('label', { class: 'toggle' }, h('span', { text: Core.SPECIALS[key].title }), on));
      });
      add(card, h('button', { class: 'btn ghost block', style: 'margin-top:8px', text: '+ Watch a Royal page for my own words', onclick: customSheet }));
    }
    function customSheet() {
      var url = h('input', { type: 'url', placeholder: 'https://www.royalcaribbean.com/cruise-deals', value: 'https://www.royalcaribbean.com/cruise-deals' });
      var words = h('input', { placeholder: 'e.g. kids sail free, 60% off, Black Friday' });
      var msg = h('div');
      openSheet([h('h3', { text: 'Watch a page for words' }),
        h('p', { class: 'small muted', text: 'Paste a royalcaribbean.com or celebritycruises.com page and the words to look for (separate phrases with commas). You get an alert when a new sentence with any of them shows up.' }),
        h('label', { class: 'field' }, h('span', { text: 'Page' }), url), h('label', { class: 'field' }, h('span', { text: 'Words or phrases' }), words), msg,
        h('button', { class: 'btn block', text: 'Start watching', onclick: function () {
          clear(msg);
          var u = url.value.trim(), w = words.value.trim();
          if (!Core.specialUrlOk(u)) { add(msg, errBox('Use an https://www.royalcaribbean.com/... or https://www.celebritycruises.com/... page.')); return; }
          if (!Core.keywordRe(w)) { add(msg, errBox('Type at least one word or phrase.')); return; }
          var id = 'special|custom|' + u + '|' + w.toLowerCase();
          if (alerts.some(function (a) { return a.id === id; })) { add(msg, errBox('You are already watching that.')); return; }
          var path = new URL(u).pathname.replace(/\/$/, '') || '/';
          alerts.unshift({ id: id, type: 'special', special: 'custom', urls: u, keywords: w, title: '"' + w + '" on ' + path, status: 'watching', created: new Date().toISOString(), initialPrice: null });
          saveAlerts(); ensureBackground(); closeSheet(); toast('Watching ' + path); onChange();
        } })]);
    }
    draw();
    return { el: card, draw: draw };
  }

  views.alerts = function (v) {
    setTitle('Price alerts', alerts.length ? alerts.length + ' watching' : '');
    var listEl = h('div'), settingsEl = h('div');
    var checkBtn = h('button', { class: 'btn block', text: '↻ Check prices now' });
    var specials = specialsCard(function () { draw(); });
    add(v, [checkBtn, h('div', { style: 'height:12px' }), listEl, specials.el, settingsEl]);
    checkBtn.onclick = function () {
      if (!alerts.length) return;
      checkBtn.disabled = true; clear(checkBtn); add(checkBtn, [h('span', { class: 'spin' }), ' Checking ' + alerts.length + ' alert(s)…']);
      P.checkAlertsNow().then(function (a) { alerts = a || alerts; updateBadge(); toast('Prices updated'); })
        .catch(function (e) { toast(e.message || 'Check failed'); })
        .then(function () { if (stack[stack.length - 1].view === 'alerts') render(); });
    };
    function specialRow(a) {
      var pill = a.status === 'found' ? h('span', { class: 'pill drop', text: '\u2728 Spotted' })
        : a.lastError ? h('span', { class: 'pill warn', text: 'Check failed' }) : h('span', { class: 'pill ok', text: 'Watching' });
      return h('div', { class: 'prod' },
        h('div', { class: 'grow' },
          h('div', { class: 't', text: '\u2728 ' + a.title }),
          a.found ? h('div', { class: 'v', text: '"' + a.found + '"' + (a.foundCount > 1 ? ' (+' + (a.foundCount - 1) + ' more)' : '') }) : null,
          a.lastError ? h('div', { class: 'v', text: a.lastError }) : null,
          h('div', { class: 'v' }, pill, a.lastChecked ? ' · checked ' + new Date(a.lastChecked).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ' · not checked yet')),
        h('button', { class: 'bell on', 'aria-label': 'Stop watching ' + a.title, text: '\u2715', onclick: function () {
          alerts = alerts.filter(function (x) { return x.id !== a.id; }); saveAlerts(); draw(); specials.draw(); toast('Stopped watching');
        } }));
    }
    function draw() {
      clear(listEl);
      if (!alerts.length) {
        checkBtn.hidden = true;
        add(listEl, empty('\u{1F514}', 'No price alerts yet', 'Open a sailing and tap the bell next to any drink package, dining package, Wi-Fi plan, excursion or cabin.'));
        add(listEl, h('button', { class: 'btn block', text: 'Browse ships', onclick: function () { setRoot('explore'); } }));
        return;
      }
      checkBtn.hidden = false;
      var sorted = alerts.slice().sort(function (a, b) { return (b.status === 'dropped' || b.status === 'found') - (a.status === 'dropped' || a.status === 'found'); });
      add(listEl, h('div', { class: 'list' }, sorted.map(function (a) {
        if (a.type === 'special') return specialRow(a);
        var pill = a.status === 'dropped' ? h('span', { class: 'pill drop', text: '↓ Price dropped' })
          : a.status === 'unavailable' ? h('span', { class: 'pill warn', text: 'Not for sale' })
            : a.lastError ? h('span', { class: 'pill warn', text: 'Check failed' }) : h('span', { class: 'pill ok', text: 'Watching' });
        var sub = [a.shipName || a.ship, Core.fmtSailDate(a.sailDate), a.port ? 'Day ' + a.day + ' ' + a.port : a.categoryName].filter(Boolean).join(' · ');
        var change = a.lastPrice !== undefined && a.initialPrice ? a.lastPrice - a.initialPrice : 0;
        return h('div', { class: 'prod' },
          h('div', { class: 'grow' },
            h('div', { class: 't', text: a.title }),
            h('div', { class: 'v', text: sub }),
            h('div', { class: 'v' }, pill, ' ', a.target ? 'Target ' + money(a.target, a.currency) : 'Any drop below ' + money(a.initialPrice, a.currency),
              a.lastChecked ? ' · checked ' + new Date(a.lastChecked).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '')),
          h('div', { class: 'price' }, h('b', { text: money(a.lastPrice, a.currency) }),
            change ? h('span', { class: 'u', style: 'color:' + (change < 0 ? 'var(--green)' : 'var(--coral)'), text: (change < 0 ? '↓ ' : '↑ ') + money(Math.abs(change), a.currency) }) : null),
          h('button', { class: 'bell on', 'aria-label': 'Edit alert', text: '✎', onclick: function () { openAlertSheet(a, null); var obs = setInterval(function () { if ($('sheet').hidden) { clearInterval(obs); draw(); } }, 300); } }));
      })));
    }
    draw();
    loadAlerts().then(draw);

    /* background / SMS settings */
    if (P.features.background === true) {
      P.getSettings().then(function (s) {
        var on = h('input', { type: 'checkbox', checked: !!s.background });
        var hrs = h('select', null, [3, 6, 12, 24].map(function (n) { return h('option', { value: n, selected: (s.hours || 12) === n, text: 'Every ' + n + ' hours' }); }));
        var save = function () { P.saveSettings({ background: on.checked, hours: hrs.value }); toast(on.checked ? 'Background checks on' : 'Background checks off'); };
        on.onchange = hrs.onchange = save;
        add(settingsEl, h('div', { class: 'card' }, h('label', { class: 'toggle' }, h('div', null, h('b', { text: 'Check automatically' }), h('div', { class: 'small muted', text: 'Your phone checks your alerts and shows a notification when a price drops. Turns on with your first alert.' })), on),
          h('label', { class: 'field', style: 'margin:8px 0 0' }, h('span', { text: 'How often' }), hrs)));
      });
    } else if (P.features.background === 'server') {
      add(settingsEl, h('div', { class: 'card small muted' }, 'The server checks your alerts automatically. Turn on text messages in ',
        h('a', { href: '#', text: 'Settings', onclick: function (e) { e.preventDefault(); setRoot('settings'); } }), '.'));
    }
  };

  /* ================= My Cruises (logged-in purchase check) ================= */
  var session = null, lastResults = null;
  /*
   * Saved cruise-line login. Phone: kept in the app's own storage on the device. Web server: kept
   * encrypted on the server (P.savedLogin) and never sent back to the browser - the server signs in.
   */
  var savedLogin = P.savedLogin || {
    get: function () { var s = pref('login', {}); return Promise.resolve({ line: s.line, user: s.user, remembered: !!(P.features.rememberPassword && s.pass) }); },
    signIn: function () { var s = pref('login', {}); return Core.login(http, s.user, s.pass, s.line); },
    remember: function (line, user, pass) { setPref('login', { line: line, user: user, pass: pass }); return Promise.resolve(); },
    forget: function () { var s = pref('login', {}); setPref('login', { line: s.line, user: s.user }); return Promise.resolve(); }
  };
  var autoTried = false;

  views.mycruises = function (v) {
    setTitle('My cruises', 'Check what you already bought');
    if (!session && !autoTried) {
      autoTried = true;
      add(v, h('div', { class: 'progress' }, h('span', { class: 'spin' }), 'Checking for a saved login…'));
      savedLogin.get().then(function (s) {
        if (!document.body.contains(v)) return;
        if (!s || !s.remembered) { clear(v); return loginForm(v); }
        clear(v); add(v, h('div', { class: 'progress' }, h('span', { class: 'spin' }), 'Signing in as ' + s.user + '…'));
        return savedLogin.signIn().then(function (sess) { session = sess; lastResults = null; profile = null; if (document.body.contains(v)) render(); },
          function (e) { if (document.body.contains(v)) { clear(v); loginForm(v, e); } });
      }).catch(function () { if (document.body.contains(v)) { clear(v); loginForm(v); } });
      return;
    }
    if (!session) return loginForm(v);
    var out = h('div');
    add(v, [h('div', { class: 'row', style: 'margin-bottom:10px' }, h('div', { class: 'grow small muted', text: 'Signed in to ' + (session.line === 'royalcaribbean' ? 'Royal Caribbean' : 'Celebrity') }),
      h('button', { class: 'btn ghost', text: 'Sign out', onclick: function () { session = null; lastResults = null; profile = null; render(); } })), out]);
    var profBox = h('div');
    out.parentNode.insertBefore(profBox, out);
    showProfile(profBox);
    if (lastResults) return drawResults(out, lastResults, false);
    add(out, h('div', { class: 'progress' }, h('span', { class: 'spin' }), 'Looking up your bookings and purchases…'));
    Core.checkPurchases(http, session, pref('currency', ''), function (ev) { if (document.body.contains(out)) drawResults(out, ev.results, true); })
      .then(function (r) { lastResults = r; if (document.body.contains(out)) drawResults(out, r, false); })
      .catch(function (e) { clear(out); add(out, errBox(e)); });
  };
  var profile = null;
  function showProfile(box) {
    var render = function (p) {
      clear(box);
      var royal = session.line === 'royalcaribbean';
      var num = royal ? p.crownAnchor : p.captainsClub;
      if (!num && !p.state) return;
      var tier = royal ? p.crownAnchorTier : p.captainsClubTier, pts = royal ? p.crownAnchorPoints : p.captainsClubPoints;
      var d = discounts();
      var already = (royal ? d.crownAnchor : d.captainsClub) === num && (!p.state || d.state === p.state);
      add(box, h('div', { class: 'card' },
        h('b', { text: (royal ? 'Crown & Anchor' : 'Captain\'s Club') + (tier ? ' · ' + Core.titleCase(String(tier).replace(/_/g, ' ')) : '') }),
        h('div', { class: 'small muted', text: [num ? '#' + num : '', pts ? pts + ' points' : '', p.state ? p.state + ' resident' : ''].filter(Boolean).join(' · ') }),
        already ? h('div', { class: 'small', style: 'margin-top:6px', text: '✓ Used for your cabin prices' })
          : h('button', { class: 'btn block', style: 'margin-top:10px', text: 'Use these for my cabin prices', onclick: function () {
            var nd = discounts();
            if (royal) nd.crownAnchor = num || nd.crownAnchor; else nd.captainsClub = num || nd.captainsClub;
            if (p.state) nd.state = p.state;
            setPref('discounts', nd); mem = {}; toast('Saved – cabin prices now use your discounts'); render(p);
          } })));
    };
    if (profile) return render(profile);
    Core.getProfile(http, session).then(function (p) { profile = p; if (document.body.contains(box)) render(p); }).catch(function () { /* optional */ });
  }

  /* open a booked cruise's sailing page: every add-on for sale, with price alerts */
  function openBooking(b) {
    var owned = b.items.map(function (i) { return String(i.title || '').toLowerCase(); });
    Promise.all([api.ships().catch(function () { return []; }), api.sailings(b.ship).catch(function () { return []; })]).then(function (r) {
      var ship = r[0].filter(function (s) { return s.code === b.ship; })[0] || { code: b.ship, name: b.shipName, brand: 'royal' };
      var sailing = r[1].filter(function (x) { return x.date === b.sailDate; })[0] || { date: b.sailDate, description: '', duration: b.nights, voyageCode: '' };
      go('sailing', { ship: ship, sailing: sailing, tab: pref('lastTab', 'drinks') === 'cabins' ? 'drinks' : pref('lastTab', 'drinks'), owned: owned });
    });
  }

  function drawResults(out, bookings, busy) {
    if (!bookings) return;
    clear(out);
    if (busy) add(out, h('div', { class: 'progress' }, h('span', { class: 'spin' }), 'Still checking…'));
    if (!bookings.length && !busy) { add(out, empty('\u{1F6A2}', 'No upcoming bookings on this account')); return; }
    var savings = 0;
    bookings.forEach(function (b) {
      b.items.forEach(function (i) { if (i.status === 'rebook') savings += i.paid - i.current; });
    });
    if (savings > 0) add(out, h('div', { class: 'card', style: 'border-left:5px solid var(--coral)' }, h('b', { text: 'You could save about ' + money(savings) }), h('div', { class: 'small muted', text: 'Cancel and rebook the items marked below (per person / per day prices).' })));
    bookings.forEach(function (b) {
      add(out, h('button', { class: 'item cruise-link', 'aria-label': 'Shop add-ons for ' + b.shipName + ' ' + Core.fmtSailDate(b.sailDate), onclick: function () { openBooking(b); } },
        h('div', { class: 'grow' },
          h('div', { class: 't', text: b.shipName + ' · ' + Core.fmtSailDate(b.sailDate) }),
          h('div', { class: 's', text: '#' + b.reservationId + ' · Room ' + b.room + ' · ' + b.nights + ' nights' }),
          h('div', { class: 's', style: 'color:var(--sea);font-weight:600', text: '\u{1F6D2} Shop drinks, dining, Wi-Fi & excursions · set alerts' })),
        h('span', { class: 'chev', text: '›' })));
      if (b.balanceDue) add(out, h('div', { class: 'notice', text: 'Remaining cruise balance: ' + money(b.balanceDue) }));
      if (!b.items.length) { add(out, h('div', { class: 'card small muted', text: busy ? 'Checking…' : 'No paid Cruise Planner purchases found.' })); return; }
      add(out, h('div', { class: 'list' }, b.items.map(function (i) {
        var pill = i.status === 'rebook' ? h('span', { class: 'pill drop', text: 'Rebook & save ' + money(i.paid - i.current, i.currency) })
          : i.status === 'best' ? h('span', { class: 'pill ok', text: 'Best price' })
            : i.status === 'not-for-sale' ? h('span', { class: 'pill warn', text: 'No longer sold' }) : h('span', { class: 'pill warn', text: 'Could not check' });
        return h('div', { class: 'prod' },
          h('div', { class: 'grow' }, h('div', { class: 't', text: i.title }), h('div', { class: 'v', text: i.guest + ' · paid ' + money(i.paid, i.currency) + (i.isOwner ? '' : ' · booked by another guest') }),
            h('div', { class: 'v' }, pill, i.promo ? ' ' + i.promo : '')),
          h('div', { class: 'price' }, i.current ? h('b', { text: money(i.current, i.currency) }) : null, i.status === 'rebook' ? h('button', { class: 'btn ghost', style: 'min-height:34px;padding:4px 10px;margin-top:4px;font-size:13px', text: 'Cancel order', onclick: function () { P.openUrl(i.cancelUrl); } }) : null));
      })));
    });
  }
  function loginForm(v, autoErr) {
    var saved = pref('login', {});
    var line = h('select', null, [['royalcaribbean', 'Royal Caribbean'], ['celebritycruises', 'Celebrity Cruises']].map(function (o) { return h('option', { value: o[0], selected: saved.line === o[0], text: o[1] }); }));
    var user = h('input', { type: 'email', autocomplete: 'username', value: saved.user || '', placeholder: 'you@example.com' });
    var pass = h('input', { type: 'password', autocomplete: 'current-password', value: P.features.rememberPassword ? (saved.pass || '') : '' });
    var remember = h('input', { type: 'checkbox', checked: !!saved.pass });
    var msg = h('div');
    if (autoErr) add(msg, errBox('Your saved login did not work: ' + (autoErr.message || autoErr)));
    var forgetBtn = h('button', { class: 'btn ghost block', hidden: true, text: 'Forget my saved login', onclick: function () {
      savedLogin.forget().then(function () { forgetBtn.hidden = true; remember.checked = false; pass.value = ''; toast('Saved login removed'); });
    } });
    savedLogin.get().then(function (s) {
      if (!s) return;
      if (s.user && !user.value) user.value = s.user;
      if (s.line) line.value = s.line;
      if (s.remembered) { remember.checked = true; forgetBtn.hidden = false; }
    }).catch(function () { /* none */ });
    var rememberLabel = P.kind === 'web' ? 'Remember my login (kept encrypted on this server)' : 'Remember on this phone';
    var btn = h('button', { class: 'btn block', text: 'Sign in & check my purchases' });
    add(v, [
      h('div', { class: 'card' },
        h('p', { class: 'small muted', style: 'margin-top:0', text: 'Sign in with your cruise line account to see every drink, dining, Wi-Fi and excursion purchase on your bookings and whether it is cheaper now. Your login goes only to the cruise line' + (P.kind === 'web' ? ' (relayed by this server; only kept, encrypted, if you tick Remember).' : '.') + ' Tap a cruise afterwards to shop its add-ons and set alerts.' }),
        h('label', { class: 'field' }, h('span', { text: 'Cruise line' }), line),
        h('label', { class: 'field' }, h('span', { text: 'Email' }), user),
        h('label', { class: 'field' }, h('span', { text: 'Password' }), pass),
        P.features.rememberPassword ? h('label', { class: 'toggle small' }, h('span', { text: rememberLabel }), remember) : null,
        msg, btn, forgetBtn)
    ]);
    btn.onclick = function () {
      clear(msg);
      if (!user.value || !pass.value) { add(msg, errBox('Enter your email and password.')); return; }
      btn.disabled = true; btn.textContent = 'Signing in…';
      var u = user.value.trim(), pw = pass.value, ln = line.value;
      setPref('login', { line: ln, user: u });
      Core.login(http, u, pw, ln).then(function (s) {
        session = s; lastResults = null; profile = null;
        // only a login that worked is remembered
        var keep = P.features.rememberPassword && remember.checked ? savedLogin.remember(ln, u, pw) : savedLogin.forget();
        return keep.catch(function (e) { toast('Signed in, but the login was not saved: ' + (e.message || e)); }).then(render);
      })
        .catch(function (e) { btn.disabled = false; btn.textContent = 'Sign in & check my purchases'; add(msg, errBox(e)); });
    };
  }

  /* ================= Settings ================= */
  views.settings = function (v) {
    setTitle('Settings', '');
    var cur = h('select', null, ['USD', 'CAD', 'AUD', 'GBP', 'EUR', 'NZD', 'MXN', 'BRL', 'SGD', 'DKK', 'NOK', 'SEK', 'CHF'].map(function (c) { return h('option', { value: c, selected: c === currency(), text: c }); }));
    cur.onchange = function () { setPref('currency', cur.value); mem = {}; toast('Prices will show in ' + cur.value); };
    add(v, h('div', { class: 'card' }, h('label', { class: 'field' }, h('span', { text: 'Currency' }), cur),
      h('button', { class: 'btn ghost block', text: 'Clear cached ships & sailings', onclick: function () {
        mem = {}; try { Object.keys(localStorage).forEach(function (k) { if (k.indexOf('cd.cache.') === 0) localStorage.removeItem(k); }); } catch (e) { /* ignore */ }
        toast('Cache cleared');
      } })));
    add(v, discountsCard());
    if (P.kind === 'web') webAccountSettings(v);
    add(v, h('div', { class: 'card small muted' },
      h('b', { text: 'About' }), h('br'),
      'Prices come from the cruise lines\' public websites. This app is not affiliated with Royal Caribbean Group. ',
      'Based on the open-source CheckRoyalCaribbeanPrice project by jdeath.'));
  };

  var STATES = ['', 'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
    'AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'ON', 'PE', 'QC', 'SK'];
  function discountsCard() {
    var d = discounts();
    var ca = h('input', { inputmode: 'numeric', autocomplete: 'off', placeholder: 'e.g. 123456789', value: d.crownAnchor || '' });
    var cc = h('input', { inputmode: 'numeric', autocomplete: 'off', placeholder: 'Celebrity only', value: d.captainsClub || '' });
    var st = h('select', null, STATES.map(function (x) { return h('option', { value: x, selected: (d.state || '') === x, text: x || 'Not set' }); }));
    var flags = [['senior', '55 or older'], ['military', 'Military / veteran'], ['police', 'Police / EMT'], ['fire', 'Firefighter']].map(function (f) {
      var cb = h('input', { type: 'checkbox', checked: !!d[f[0]] });
      cb.dataset.k = f[0];
      return { el: h('label', { class: 'toggle small' }, h('span', { text: f[1] }), cb), cb: cb };
    });
    var msg = h('div');
    function save() {
      clear(msg);
      var n = { crownAnchor: ca.value.replace(/\D/g, ''), captainsClub: cc.value.replace(/\D/g, ''), state: st.value };
      flags.forEach(function (f) { n[f.cb.dataset.k] = f.cb.checked; });
      if ((n.crownAnchor && !/^\d{4,15}$/.test(n.crownAnchor)) || (n.captainsClub && !/^\d{4,15}$/.test(n.captainsClub))) { add(msg, errBox('Loyalty numbers are digits only.')); return; }
      setPref('discounts', n); mem = {};
      toast('Discounts saved – cabin prices will use them');
    }
    return h('div', { class: 'card' },
      h('b', { text: '\u{1F3F7}️ Discounts for cabin prices' }),
      h('p', { class: 'small muted', text: 'The cruise line uses these to show loyalty, residency and other special fares. Sign in under My Cruises to fill them in automatically.' }),
      h('label', { class: 'field' }, h('span', { text: 'Crown & Anchor number (Royal Caribbean)' }), ca),
      h('label', { class: 'field' }, h('span', { text: 'Captain\'s Club number (Celebrity)' }), cc),
      h('label', { class: 'field' }, h('span', { text: 'State / province you live in' }), st),
      flags.map(function (f) { return f.el; }), msg,
      h('button', { class: 'btn block', style: 'margin-top:8px', text: 'Save discounts', onclick: save }));
  }

  function hourText(hh) { return (hh % 12 || 12) + ':00 ' + (hh < 12 ? 'AM' : 'PM'); }
  function webAccountSettings(v) {
    var box = h('div');
    add(v, box);
    P.me().then(function (me) {
      var s = me.settings || {};
      var phone = h('input', { type: 'tel', autocomplete: 'tel', placeholder: '+1 555 123 4567', value: s.phone || '' });
      var sms = h('input', { type: 'checkbox', checked: !!s.smsEnabled });
      function values() { return { phone: phone.value.trim(), smsEnabled: sms.checked }; }
      var pl = me.sendPlan || { mode: 'daily', hour: 9 };
      var when = pl.mode === 'each' ? 'Texts go out right after each price check.' : 'All your price drops come together in one text a day, around ' + hourText(pl.hour) + (pl.tz ? ' (' + pl.tz.replace(/_/g, ' ') + ' time)' : '') + '.';
      var msg = h('div');
      add(box, h('div', { class: 'card' },
        h('b', { text: 'Text message alerts' }),
        h('p', { class: 'small muted', text: me.smsConfigured ? 'Sent through ' + me.smsProvider + ' when one of your alerts drops in price.' : 'Text messages are not set up yet' + (me.admin ? ' - choose a provider below.' : ' - ask the admin.') }),
        h('label', { class: 'field' }, h('span', { text: 'Mobile number' }), phone),
        h('label', { class: 'toggle' }, h('span', { text: 'Text me price drops' }), sms),
        h('p', { class: 'small muted', text: when + ' You only get another text for the same item if its price falls below the price we last texted you.' }),
        h('p', { class: 'small muted' }, 'By turning on texts you agree to receive automated price-drop alerts at this number. Msg & data rates may apply. Reply STOP to stop, HELP for help. ',
          h('a', { href: '/sms-terms', target: '_blank', rel: 'noopener', text: 'SMS Terms' }), ' · ', h('a', { href: '/privacy', target: '_blank', rel: 'noopener', text: 'Privacy' })),
        msg,
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn', text: 'Save', onclick: function () {
            clear(msg);
            P.saveSettings(values()).then(function () { toast('Saved'); }).catch(function (e) { add(msg, errBox(e)); });
          } }),
          h('button', { class: 'btn ghost', text: 'Send test text', disabled: !me.smsConfigured, onclick: function () {
            clear(msg);
            P.saveSettings(values()).then(function () { return P.testSms(); })
              .then(function (r) { toast('Sent! ' + ((r && r.info) || '')); })
              .catch(function (e) { add(msg, errBox(e)); });
          } })),
        h('button', { class: 'btn ghost block', style: 'margin-top:10px', text: '\u{1F4AC} See what the texts look like', onclick: showSmsPreview })));

      var oldP = h('input', { type: 'password', autocomplete: 'current-password' }), newP = h('input', { type: 'password', autocomplete: 'new-password', minlength: '10' });
      var pmsg = h('div');
      add(box, h('div', { class: 'card' },
        h('b', { text: 'Account: ' + me.username + (me.admin ? ' (admin)' : '') }),
        h('label', { class: 'field', style: 'margin-top:10px' }, h('span', { text: 'Current password' }), oldP),
        h('label', { class: 'field' }, h('span', { text: 'New password (10+ characters)' }), newP), pmsg,
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn ghost', text: 'Change password', onclick: function () {
            clear(pmsg);
            P.changePassword(oldP.value, newP.value).then(function () { oldP.value = newP.value = ''; toast('Password changed'); }).catch(function (e) { add(pmsg, errBox(e)); });
          } }),
          h('button', { class: 'btn danger', text: 'Sign out', onclick: function () { P.logout().then(showLogin, showLogin); } }))));
      if (me.admin) { adminSms(box); adminSite(box); adminUsers(box); }
    }).catch(function (e) { add(box, errBox(e)); });
  }

  /* phone-style preview of the texts, built by the server's real formatter */
  function phonePreview(samples) {
    return h('div', { class: 'phone' },
      h('div', { class: 'phone-top' }, h('div', { class: 'phone-avatar', text: 'CD' }), h('div', { text: 'Cruise Deals alerts' })),
      h('div', { class: 'phone-body' }, samples.map(function (x) {
        return h('div', null,
          h('div', { class: 'bubble-label', text: x.label }),
          h('div', { class: 'bubble', text: x.text }),
          h('div', { class: 'bubble-meta', text: x.chars + ' characters · ' + x.segments + ' text' + (x.segments > 1 ? 's' : '') + ' billed' }));
      })));
  }
  function showSmsPreview() {
    P.smsPreview().then(function (samples) {
      openSheet([h('h3', { text: 'What the texts look like' }),
        h('div', { class: 'small muted', text: 'Examples with sample prices. Real texts use your alerts.' }), phonePreview(samples)]);
    }).catch(function (e) { toast(e.message); });
  }

  function adminSms(box) {
    var card = h('div', { class: 'card' });
    add(box, card);
    P.getSmsAdmin().then(function (c) {
      var provSel = h('select', null, [h('option', { value: 'off', text: 'Off (no texts)' })].concat(c.providers.map(function (p) {
        return h('option', { value: p.id, text: p.label });
      })));
      provSel.value = c.provider;
      var fieldsBox = h('div'), inputs = {};
      var link = h('input', { type: 'url', placeholder: 'https://cruise.example.com', value: c.link });
      var incLink = h('input', { type: 'checkbox', checked: c.includeLink });
      var plan = c.plan || { mode: 'daily', hour: 9, tz: '' };
      var mode = h('select', { 'aria-label': 'When texts go out' },
        h('option', { value: 'daily', text: 'Once a day - all of a user\'s drops in one text', selected: plan.mode !== 'each' }),
        h('option', { value: 'each', text: 'Right after each price check', selected: plan.mode === 'each' }));
      var hour = h('select', { 'aria-label': 'Daily text time' });
      for (var hh = 0; hh < 24; hh++) add(hour, h('option', { value: String(hh), text: hourText(hh), selected: plan.hour === hh }));
      var myTz = ''; try { myTz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { /* server time */ }
      var tzUse = plan.tz || myTz;
      var hourRow = h('label', { class: 'field' }, h('span', { text: 'Daily text time' + (tzUse ? ' (' + tzUse.replace(/_/g, ' ') + ')' : '') }), hour);
      function syncMode() { hourRow.hidden = mode.value !== 'daily'; }
      mode.onchange = syncMode; syncMode();
      var testPhone = h('input', { type: 'tel', placeholder: '+15551234567' });
      var msg = h('div'), status = h('span', { class: 'pill ' + (c.ready ? 'ok' : 'warn'), text: c.ready ? 'Working setup' : 'Not set up' });
      function drawFields() {
        clear(fieldsBox); inputs = {};
        var p = c.providers.filter(function (x) { return x.id === provSel.value; })[0];
        if (!p) return;
        add(fieldsBox, h('p', { class: 'small muted', text: p.help }));
        p.fields.forEach(function (f) {
          var cur = (c.values[p.id] || {})[f.key] || '';
          if (f.type === 'checkbox') {
            var cb = h('input', { type: 'checkbox', checked: cur === 'yes' });
            inputs[f.key] = { get value() { return cb.checked ? 'yes' : ''; } };
            add(fieldsBox, h('label', { class: 'toggle small' }, h('span', { text: f.label }), cb));
            return;
          }
          var inp = h('input', { type: f.secret ? 'password' : 'text', autocomplete: 'off', placeholder: f.secret && cur ? 'saved (' + cur.slice(-4) + ') - type to replace' : (f.placeholder || ''), value: f.secret ? '' : cur });
          inputs[f.key] = inp;
          add(fieldsBox, h('label', { class: 'field' }, h('span', { text: f.label + (f.required ? '' : '') }), inp));
        });
      }
      provSel.onchange = drawFields;
      drawFields();
      function collect() {
        var values = {}; values[provSel.value] = {};
        Object.keys(inputs).forEach(function (k) { values[provSel.value][k] = inputs[k].value; });
        return { provider: provSel.value, values: values, link: link.value.trim(), includeLink: incLink.checked, mode: mode.value, hour: parseInt(hour.value, 10), tz: tzUse };
      }
      add(card, [
        h('div', { class: 'row' }, h('b', { class: 'grow', text: '\u{1F4E8} Text message provider (admin)' }), status),
        h('label', { class: 'field', style: 'margin-top:10px' }, h('span', { text: 'Send texts with' }), provSel),
        fieldsBox,
        h('label', { class: 'field' }, h('span', { text: 'This site\'s address (for a link in texts)' }), link),
        h('label', { class: 'toggle small' }, h('span', { text: 'Add the link to the end of each text' }), incLink),
        h('label', { class: 'field', style: 'margin-top:10px' }, h('span', { text: 'When texts go out (all users)' }), mode), hourRow,
        h('p', { class: 'small muted', text: 'Users get another text for the same item only when its price falls below the price they were last texted.' }),
        msg,
        h('button', { class: 'btn block', text: 'Save provider settings', onclick: function () {
          clear(msg);
          P.saveSmsAdmin(collect()).then(function (r) {
            status.className = 'pill ' + (r.ready ? 'ok' : 'warn'); status.textContent = r.ready ? 'Working setup' : 'Not set up';
            toast('Saved'); adminRefresh();
          }).catch(function (e) { add(msg, errBox(e)); });
        } }),
        h('div', { class: 'row', style: 'margin-top:10px' }, h('label', { class: 'field grow', style: 'margin:0' }, testPhone),
          h('button', { class: 'btn ghost', text: 'Send test', onclick: function () {
            clear(msg);
            P.saveSmsAdmin(collect()).then(function () { return P.testSmsAdmin(testPhone.value); })
              .then(function (r) { toast(r.info || 'Sent!'); }).catch(function (e) { add(msg, errBox(e)); });
          } })),
        h('button', { class: 'btn ghost block', style: 'margin-top:10px', text: '\u{1F4AC} Preview the texts', onclick: showSmsPreview })
      ]);
      function adminRefresh() { P.getSmsAdmin().then(function (n) { c = n; drawFields(); }); }
    }).catch(function (e) { add(card, errBox(e)); });
  }

  /* public About / Terms / Privacy / SMS terms pages - what Textbelt reviews before allowing links */
  function adminSite(box) {
    var card = h('div', { class: 'card' });
    add(box, card);
    P.getSiteAdmin().then(function (c) {
      var name = h('input', { value: c.name || '', maxlength: '60' });
      var owner = h('input', { value: c.owner || '', maxlength: '80', placeholder: 'Your name' });
      var email = h('input', { type: 'email', value: c.email || '', maxlength: '120', placeholder: 'you@example.com' });
      var msg = h('div');
      function page(path, label) { return h('a', { href: path, target: '_blank', rel: 'noopener', text: label }); }
      add(card, [
        h('b', { text: '\u{1F4C4} Public pages (admin)' }),
        h('p', { class: 'small muted', text: 'Anyone can open these without signing in. Textbelt (and other providers) look at them before allowing links in texts. Fill in who runs the site and a contact email, then save.' }),
        h('label', { class: 'field' }, h('span', { text: 'Site name' }), name),
        h('label', { class: 'field' }, h('span', { text: 'Run by' }), owner),
        h('label', { class: 'field' }, h('span', { text: 'Contact email' }), email),
        h('p', { class: 'small' }, page('/about', 'About'), ' · ', page('/terms', 'Terms of Use'), ' · ', page('/privacy', 'Privacy Policy'), ' · ', page('/sms-terms', 'SMS Terms')),
        h('p', { class: 'small muted', text: c.url ? 'Public address: ' + c.url + (c.replyUrl ? ' · STOP/HELP replies come back to ' + c.replyUrl : '') : 'Set "This site\'s address" in the provider card above (your https:// address) so the pages and STOP replies use it.' }),
        msg,
        h('button', { class: 'btn block', text: 'Save site details', onclick: function () {
          clear(msg);
          P.saveSiteAdmin({ name: name.value.trim(), owner: owner.value.trim(), email: email.value.trim() }).then(function () { toast('Saved'); }).catch(function (e) { add(msg, errBox(e)); });
        } })
      ]);
    }).catch(function (e) { add(card, errBox(e)); });
  }

  function adminUsers(box) {
    var listEl = h('div'), msg = h('div');
    var u = h('input', { autocomplete: 'off', placeholder: 'username' }), pw = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'temporary password (10+)' });
    var adm = h('input', { type: 'checkbox' });
    add(box, h('div', { class: 'card' }, h('b', { text: 'Users' }), listEl,
      h('div', { style: 'height:10px' }),
      h('label', { class: 'field' }, h('span', { text: 'New username' }), u),
      h('label', { class: 'field' }, h('span', { text: 'Password' }), pw),
      h('label', { class: 'toggle small' }, h('span', { text: 'Admin' }), adm), msg,
      h('button', { class: 'btn block', text: 'Add user', onclick: function () {
        clear(msg);
        P.createUser({ username: u.value.trim(), password: pw.value, admin: adm.checked }).then(function () { u.value = pw.value = ''; adm.checked = false; toast('User added'); refresh(); })
          .catch(function (e) { add(msg, errBox(e)); });
      } })));
    function refresh() {
      P.listUsers().then(function (users) {
        clear(listEl);
        add(listEl, h('div', { class: 'list', style: 'margin-top:10px;box-shadow:none;border:1px solid var(--line)' }, users.map(function (x) {
          return h('div', { class: 'prod' }, h('div', { class: 'grow' }, h('div', { class: 't', text: x.username + (x.admin ? ' (admin)' : '') }), h('div', { class: 'v', text: x.alerts + ' alert(s)' + (x.smsEnabled ? ' · SMS on' : '') })),
            x.self ? null : h('button', { class: 'btn danger', text: 'Delete', onclick: function () {
              if (!confirm('Delete user ' + x.username + ' and their alerts?')) return;
              P.deleteUser(x.username).then(refresh).catch(function (e) { toast(e.message); });
            } }));
        })));
      });
    }
    refresh();
  }

  /* ================= web login screen ================= */
  function showLogin() {
    $('tabs').hidden = true; $('back').hidden = true;
    if ($('acct')) $('acct').hidden = true;
    setTitle('Cruise Deals', 'Sign in');
    var v = clear($('view'));
    var u = h('input', { autocomplete: 'username', autocapitalize: 'none' }), pw = h('input', { type: 'password', autocomplete: 'current-password' });
    var msg = h('div'), btn = h('button', { class: 'btn block', type: 'submit', text: 'Sign in' });
    var form = h('form', { class: 'card login-wrap' }, h('div', { class: 'brand-mark', text: '\u{1F6A2}' }),
      h('h2', { style: 'text-align:center;margin-top:0', text: 'Welcome aboard' }),
      h('label', { class: 'field' }, h('span', { text: 'Username' }), u), h('label', { class: 'field' }, h('span', { text: 'Password' }), pw), msg, btn);
    form.onsubmit = function (e) {
      e.preventDefault(); clear(msg); btn.disabled = true;
      P.login(u.value.trim(), pw.value).then(start).catch(function (err) { btn.disabled = false; add(msg, errBox(err)); });
    };
    add(v, form);
    add(v, h('p', { class: 'small muted', style: 'text-align:center' }, h('a', { href: '/about', text: 'About' }), ' · ', h('a', { href: '/terms', text: 'Terms' }), ' · ',
      h('a', { href: '/privacy', text: 'Privacy' }), ' · ', h('a', { href: '/sms-terms', text: 'SMS Terms' })));
    u.focus();
  }

  /* web: account button in the top bar on every page (who is signed in + Sign out) */
  function accountButton(me) {
    var btn = $('acct');
    if (!btn) {
      btn = h('button', { id: 'acct', class: 'acct-btn', 'aria-label': 'Account and sign out' });
      $('top').appendChild(btn);
    }
    btn.hidden = false;
    var name = (me && me.username) || '';
    clear(btn); add(btn, [h('span', { class: 'acct-dot', text: (name[0] || '?').toUpperCase() }), h('span', { class: 'acct-out', text: 'Sign out' })]);
    btn.onclick = function () {
      openSheet([
        h('h3', { text: 'Signed in as ' + name + (me && me.admin ? ' (admin)' : '') }),
        h('p', { class: 'small muted', text: 'Signing out ends this session on this device. Your alerts stay saved on the server.' }),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn ghost', text: 'Cancel', onclick: closeSheet }),
          h('button', { class: 'btn danger', text: 'Sign out', onclick: function () { closeSheet(); P.logout().then(showLogin, showLogin); } }))
      ]);
    };
  }

  function start(me) {
    $('tabs').hidden = false;
    if (P.kind === 'web') {
      if (me && me.username) accountButton(me);
      else P.me().then(accountButton).catch(function () { /* stays hidden */ });
    }
    loadAlerts().then(updateBadge);
    setRoot('explore');
  }

  window.addEventListener('cd-logged-out', showLogin);
  if (P.kind === 'web') P.me().then(start).catch(showLogin);
  else start();

  window.CruiseApp = { go: go, setRoot: setRoot, back: back, alerts: function () { return alerts; } };
})();
