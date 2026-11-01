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
    var n = alerts.filter(function (a) { return a.status === 'dropped'; }).length, b = $('alertBadge');
    b.hidden = !n; b.textContent = n;
  }
  function alertId(a) {
    return a.type === 'cabin'
      ? ['cabin', a.packageCode, a.sailDate, a.cabinName, a.adults, a.children, a.currency, a.loyaltyNumber || '', a.state || '', a.senior ? 's' : '', a.military ? 'm' : '', a.police ? 'p' : '', a.fire ? 'f' : ''].join('|')
      : ['product', a.ship, a.sailDate, a.category, a.day, a.productId, a.currency].join('|');
  }
  function findAlert(a) { var id = alertId(a); for (var i = 0; i < alerts.length; i++) if (alerts[i].id === id) return alerts[i]; return null; }

  function openAlertSheet(base, bellBtn) {
    base.id = alertId(base);
    var existing = findAlert(base);
    var mode = existing && existing.target ? 'below' : 'any';
    var suggested = existing && existing.target ? existing.target : Math.floor(base.initialPrice * 0.9);
    var input = h('input', { type: 'number', inputmode: 'decimal', min: '0', step: '1', value: suggested, 'aria-label': 'Target price' });
    var rAny = h('input', { type: 'radio', name: 'am', checked: mode === 'any' });
    var rBelow = h('input', { type: 'radio', name: 'am', checked: mode === 'below' });
    var lAny = h('label', { class: 'radio' + (mode === 'any' ? ' on' : '') }, rAny, h('div', null, h('b', { text: 'Any price drop' }), h('div', { class: 'small muted', text: 'Alert me when it goes below ' + money(base.initialPrice, base.currency) })));
    var lBelow = h('label', { class: 'radio' + (mode === 'below' ? ' on' : '') }, rBelow, h('div', { class: 'grow' }, h('b', { text: 'Drops to my price' }), h('div', { class: 'field', style: 'margin:6px 0 0' }, input)));
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
          var a = existing || base;
          if (!existing) {
            a.created = new Date().toISOString(); a.lastPrice = base.initialPrice; a.lowestSeen = base.initialPrice; a.status = 'watching';
            alerts.unshift(a);
          }
          a.target = target;
          a.notifiedPrice = null;
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
        h('button', { class: 'btn', text: '↗ Cruise Planner', onclick: function () { P.openUrl(Core.plannerUrl(ship.name, ship.code, sailing.date)); } }))));

    var ports = {};
    api.itinerary(ship.code, sailing.date).then(function (it) {
      it.forEach(function (d) {
        ports[d.day] = d.port;
        var times = d.type === 'EMBARK' ? (d.depart ? 'departs ' + d.depart : '') : d.type === 'DEBARK' ? (d.arrive ? 'arrives ' + d.arrive : '')
          : (d.arrive && d.depart && d.port !== 'Cruising' ? d.arrive + ' - ' + d.depart : '');
        add(itinList, h('li', null, h('b', { text: 'Day ' + d.day }), h('span', { class: 'grow', text: d.port + (d.type === 'TENDERED' ? ' (tender)' : '') }), h('span', { text: times })));
      });
      if (!it.length) itinBtn.hidden = true;
    }).catch(function () { itinBtn.hidden = true; });

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
        productsTab(body, ship, sailing, tab, mine, ports, alive);
      }).catch(function (e) { if (alive()) { clear(body); add(body, [errBox(e), h('button', { class: 'btn block', text: 'Try again', onclick: render })]); } });
    }
    show();
  };

  function cabinsTab(body, ship, sailing, alive) {
    var mode = pref('cabinMode', 'one');
    var party = pref('party', { adults: 2, children: 0 });
    var group = pref('group', { adults: 4, children: 2, maxPer: 4, connecting: true });
    var chips = h('div', { class: 'chips', style: 'padding-top:0' });
    var form = h('div'), out = h('div');
    add(body, [chips, form, out]);
    [['one', 'One cabin'], ['group', 'Whole group (2 cabins)']].forEach(function (c) {
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
          h('div', { class: 'small muted', text: 'We try every way to split your group (like 2+4 or 3+3), price each cabin for exactly who is in it, and show the cheapest total for each cabin type.' }),
          stepper(group, 'group', 'Adults', 'adults', 2, 8), stepper(group, 'group', 'Children', 'children', 0, 8),
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
      }).catch(function (e) { if (alive()) { clear(out); add(out, errBox(e)); } });
    }
    function loadGroup() {
      var splits = Core.planSplits(group.adults, group.children, group.maxPer, 2);
      clear(out);
      if (!splits.length) { add(out, errBox('That group doesn\'t fit in 2 cabins of ' + group.maxPer + ' with at least one adult in each. Raise "Max guests per cabin".')); return; }
      var occ = Core.occupanciesFor(splits), table = {}, done = 0, idx = 0;
      var prog = h('div', { class: 'progress' });
      add(out, prog);
      function tick() { clear(prog); add(prog, [h('span', { class: 'spin' }), 'Pricing cabin combinations… ' + done + ' of ' + occ.length]); }
      tick();
      function worker() {
        if (idx >= occ.length || !alive()) return Promise.resolve();
        var o = occ[idx++];
        return api.cabins(cabinOpts(o.adults, o.children)).then(function (rows) { table[o.adults + '/' + o.children] = rows; }, function () { table[o.adults + '/' + o.children] = []; })
          .then(function () { done++; if (alive()) tick(); return worker(); });
      }
      Promise.all([worker(), worker(), worker()]).then(function () {
        if (!alive()) return;
        clear(out);
        var res = Core.bestCombos(table, splits, group.connecting).filter(function (r) { return r.best; });
        if (!res.length) {
          add(out, empty('\u{1F6AB}', group.connecting ? 'No connecting cabins found for this group' : 'No cabin combinations available',
            group.connecting ? 'Try turning off "Connecting cabins only".' : 'The sailing may be sold out for these cabin sizes.'));
          return;
        }
        var cur = currency();
        add(out, h('div', { class: 'notice', text: 'Cheapest way to fit ' + who(group.adults, group.children) + ' on this sailing, by cabin type. Totals add up each cabin\'s ' + (discLabels.length ? 'price with your discounts' : 'public price') + ' (taxes & fees included).' }));
        res.forEach(function (r) {
          var best = r.best;
          var others = r.options.slice(1, 4);
          var more = h('div', { hidden: true }, others.map(function (o) {
            return h('div', { class: 'row small', style: 'justify-content:space-between;padding:6px 0;border-top:1px solid var(--line)' },
              h('span', { text: o.cabins.map(function (c) { return who(c.adults, c.children); }).join('  |  ') }), h('b', { text: money(o.total, cur) }));
          }));
          add(out, h('div', { class: 'card' },
            h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', { style: 'font-size:17px', text: r.name }),
              best.connecting ? h('div', null, h('span', { class: 'pill ok', text: '\u{1F6AA} Connecting' })) : null),
              h('div', { class: 'price' }, h('b', { text: money(best.total, cur) }), h('span', { class: 'u', text: money(best.total / (group.adults + group.children), cur) + ' pp' }))),
            h('div', { style: 'margin-top:8px' }, best.cabins.map(function (c, i) {
              return h('div', { class: 'row small', style: 'justify-content:space-between;padding:4px 0' },
                h('span', { text: (best.cabins.length > 1 ? 'Cabin ' + (i + 1) + ': ' : 'One cabin: ') + who(c.adults, c.children) + (c.subtype ? ' · ' + c.subtype : '') }),
                h('span', { text: money(c.price, cur) }));
            })),
            others.length ? h('button', { class: 'btn ghost block', style: 'margin-top:8px;min-height:38px;font-size:14px', text: 'Other splits (' + others.length + ')', onclick: function () { more.hidden = !more.hidden; } }) : null,
            more));
        });
        add(out, h('div', { class: 'notice', text: 'Prices are per cabin; actual connecting cabin pairs and room numbers are confirmed when you book. Every cabin needs at least one adult.' }));
      });
    }
    draw();
  }

  function productsTab(body, ship, sailing, tab, cats, ports, alive) {
    clear(body);
    var tabInfo = TABS.filter(function (t) { return t.id === tab; })[0];
    if (!cats.length) { add(body, empty(tabInfo.e, 'No ' + tabInfo.label.toLowerCase() + ' packages are for sale on this sailing yet', 'Packages usually appear closer to sailing.')); return; }
    var sort = pref('sort', 'rank'), q = '';
    var search = h('input', { class: 'search', type: 'search', placeholder: tab === 'excursions' ? 'Search excursions or ports' : 'Search ' + tabInfo.label.toLowerCase() });
    var sel = h('select', { 'aria-label': 'Sort' },
      [['rank', 'Recommended'], ['low', 'Price: low to high'], ['high', 'Price: high to low'], ['az', 'Name A-Z']].map(function (o) { return h('option', { value: o[0], selected: o[0] === sort, text: o[1] }); }));
    var progress = h('div', { class: 'progress' });
    var listEl = h('div');
    add(body, [h('div', { class: 'toolbar' }, search, sel), progress, listEl,
      h('div', { class: 'notice', text: 'Public prices. You may see lower prices after login (loyalty, casino, or onboard specials). Tap \u{1F514} to get a price-drop alert.' })]);

    var groups = []; // {key, title, cat, day, items}
    function draw() {
      clear(listEl);
      var ql = q.toLowerCase(), any = false;
      groups.forEach(function (g) {
        var items = g.items.filter(function (it) { return !ql || it.title.toLowerCase().indexOf(ql) >= 0 || g.title.toLowerCase().indexOf(ql) >= 0; });
        if (!items.length) return;
        any = true;
        items = items.slice();
        if (sort === 'low') items.sort(function (a, b) { return a.price - b.price; });
        else if (sort === 'high') items.sort(function (a, b) { return b.price - a.price; });
        else if (sort === 'az') items.sort(function (a, b) { return a.title.localeCompare(b.title); });
        add(listEl, h('div', { class: 'cat-h' }, h('b', { text: g.title }), h('span', { class: 'small muted', text: items.length + ' item' + (items.length > 1 ? 's' : '') })));
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
        h('div', { class: 'grow' }, h('div', { class: 't', text: it.title }), it.variants.length ? h('div', { class: 'v', text: 'Also: ' + it.variants.join(', ') }) : null),
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
  views.alerts = function (v) {
    setTitle('Price alerts', alerts.length ? alerts.length + ' watching' : '');
    var listEl = h('div'), settingsEl = h('div');
    var checkBtn = h('button', { class: 'btn block', text: '↻ Check prices now' });
    add(v, [checkBtn, h('div', { style: 'height:12px' }), listEl, settingsEl]);
    checkBtn.onclick = function () {
      if (!alerts.length) return;
      checkBtn.disabled = true; clear(checkBtn); add(checkBtn, [h('span', { class: 'spin' }), ' Checking ' + alerts.length + ' alert(s)…']);
      P.checkAlertsNow().then(function (a) { alerts = a || alerts; updateBadge(); toast('Prices updated'); })
        .catch(function (e) { toast(e.message || 'Check failed'); })
        .then(function () { if (stack[stack.length - 1].view === 'alerts') render(); });
    };
    function draw() {
      clear(listEl);
      if (!alerts.length) {
        checkBtn.hidden = true;
        add(listEl, empty('\u{1F514}', 'No price alerts yet', 'Open a sailing and tap the bell next to any drink package, dining package, Wi-Fi plan, excursion or cabin.'));
        add(listEl, h('button', { class: 'btn block', text: 'Browse ships', onclick: function () { setRoot('explore'); } }));
        return;
      }
      var sorted = alerts.slice().sort(function (a, b) { return (b.status === 'dropped') - (a.status === 'dropped'); });
      add(listEl, h('div', { class: 'list' }, sorted.map(function (a) {
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
  views.mycruises = function (v) {
    setTitle('My cruises', 'Check what you already bought');
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
      add(out, h('div', { class: 'cat-h' }, h('b', { text: b.shipName + ' · ' + Core.fmtSailDate(b.sailDate) }), h('span', { class: 'small muted', text: '#' + b.reservationId + ' · Room ' + b.room })));
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
  function loginForm(v) {
    var saved = pref('login', {});
    var line = h('select', null, [['royalcaribbean', 'Royal Caribbean'], ['celebritycruises', 'Celebrity Cruises']].map(function (o) { return h('option', { value: o[0], selected: saved.line === o[0], text: o[1] }); }));
    var user = h('input', { type: 'email', autocomplete: 'username', value: saved.user || '', placeholder: 'you@example.com' });
    var pass = h('input', { type: 'password', autocomplete: 'current-password', value: P.features.rememberPassword ? (saved.pass || '') : '' });
    var remember = h('input', { type: 'checkbox', checked: !!saved.pass });
    var msg = h('div');
    var btn = h('button', { class: 'btn block', text: 'Sign in & check my purchases' });
    add(v, [
      h('div', { class: 'card' },
        h('p', { class: 'small muted', style: 'margin-top:0', text: 'Sign in with your cruise line account to see every drink, dining, Wi-Fi and excursion purchase on your bookings and whether it is cheaper now. Your login goes only to the cruise line' + (P.kind === 'web' ? ' (relayed by this server, never stored).' : '.') }),
        h('label', { class: 'field' }, h('span', { text: 'Cruise line' }), line),
        h('label', { class: 'field' }, h('span', { text: 'Email' }), user),
        h('label', { class: 'field' }, h('span', { text: 'Password' }), pass),
        P.features.rememberPassword ? h('label', { class: 'toggle small' }, h('span', { text: 'Remember on this phone' }), remember) : null,
        msg, btn)
    ]);
    btn.onclick = function () {
      clear(msg);
      if (!user.value || !pass.value) { add(msg, errBox('Enter your email and password.')); return; }
      btn.disabled = true; btn.textContent = 'Signing in…';
      setPref('login', { line: line.value, user: user.value, pass: P.features.rememberPassword && remember.checked ? pass.value : undefined });
      Core.login(http, user.value.trim(), pass.value, line.value).then(function (s) { session = s; lastResults = null; profile = null; render(); })
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

  function webAccountSettings(v) {
    var box = h('div');
    add(v, box);
    P.me().then(function (me) {
      var s = me.settings || {};
      var phone = h('input', { type: 'tel', autocomplete: 'tel', placeholder: '+1 555 123 4567', value: s.phone || '' });
      var sms = h('input', { type: 'checkbox', checked: !!s.smsEnabled });
      var msg = h('div');
      add(box, h('div', { class: 'card' },
        h('b', { text: 'Text message alerts' }),
        h('p', { class: 'small muted', text: me.smsConfigured ? 'Sent through ' + me.smsProvider + ' when one of your alerts drops in price.' : 'Text messages are not set up yet' + (me.admin ? ' - choose a provider below.' : ' - ask the admin.') }),
        h('label', { class: 'field' }, h('span', { text: 'Mobile number' }), phone),
        h('label', { class: 'toggle' }, h('span', { text: 'Text me price drops' }), sms),
        msg,
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn', text: 'Save', onclick: function () {
            clear(msg);
            P.saveSettings({ phone: phone.value.trim(), smsEnabled: sms.checked }).then(function () { toast('Saved'); }).catch(function (e) { add(msg, errBox(e)); });
          } }),
          h('button', { class: 'btn ghost', text: 'Send test text', disabled: !me.smsConfigured, onclick: function () {
            clear(msg);
            P.saveSettings({ phone: phone.value.trim(), smsEnabled: sms.checked }).then(function () { return P.testSms(); })
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
      if (me.admin) { adminSms(box); adminUsers(box); }
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
      var testPhone = h('input', { type: 'tel', placeholder: '+15551234567' });
      var msg = h('div'), status = h('span', { class: 'pill ' + (c.ready ? 'ok' : 'warn'), text: c.ready ? 'Working setup' : 'Not set up' });
      function drawFields() {
        clear(fieldsBox); inputs = {};
        var p = c.providers.filter(function (x) { return x.id === provSel.value; })[0];
        if (!p) return;
        add(fieldsBox, h('p', { class: 'small muted', text: p.help }));
        p.fields.forEach(function (f) {
          var cur = (c.values[p.id] || {})[f.key] || '';
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
        return { provider: provSel.value, values: values, link: link.value.trim(), includeLink: incLink.checked };
      }
      add(card, [
        h('div', { class: 'row' }, h('b', { class: 'grow', text: '\u{1F4E8} Text message provider (admin)' }), status),
        h('label', { class: 'field', style: 'margin-top:10px' }, h('span', { text: 'Send texts with' }), provSel),
        fieldsBox,
        h('label', { class: 'field' }, h('span', { text: 'This site\'s address (for a link in texts)' }), link),
        h('label', { class: 'toggle small' }, h('span', { text: 'Add the link to the end of each text' }), incLink),
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
    u.focus();
  }

  function start() {
    $('tabs').hidden = false;
    loadAlerts().then(updateBadge);
    setRoot('explore');
  }

  window.addEventListener('cd-logged-out', showLogin);
  if (P.kind === 'web') P.me().then(start).catch(showLogin);
  else start();

  window.CruiseApp = { go: go, setRoot: setRoot, back: back, alerts: function () { return alerts; } };
})();
