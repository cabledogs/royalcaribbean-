/*
 * core.js - shared Royal Caribbean / Celebrity public-API logic.
 *
 * Ported from BrowseRoyalCaribbeanPrice.py and PhonePriceCheck.py
 * (https://github.com/jdeath/CheckRoyalCaribbeanPrice).
 *
 * Runs in the browser/WebView (window.CruiseCore) and in Node (require).
 * Every network call goes through an injected `http(method, url, {headers, body})`
 * function that resolves to {status, body} where body is the response text.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CruiseCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var API = 'https://aws-prd.api.rccl.com';
  var APPKEY_WEB = 'hyNNqIPHHzaLzVpcICPdAdbFV8yvTsAm';
  var UA_WEB = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:159.0) Gecko/20100101 Firefox/159.0';
  var UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
  var LOGIN_BASIC = 'Basic ZzlTMDIzdDc0NDczWlVrOTA5Rk42OEYwYjRONjdQU09oOTJvMDR2TDBCUjY1MzdwSTJ5Mmg5NE02QmJVN0Q2SjpXNjY4NDZrUFF2MTc1MDk3NW9vZEg1TTh6QzZUYTdtMzBrSDJRNzhsMldtVTUwRkNncXBQMTN3NzczNzdrN0lC';
  var SHIPS_APPKEY = 'cdCNc04srNq4rBvKofw1aC50dsdSaPuc';

  /* Hosts the app is allowed to talk to (the Docker server enforces this too). */
  var ALLOWED_HOSTS = ['aws-prd.api.rccl.com', 'api.rccl.com', 'www.royalcaribbean.com', 'www.celebritycruises.com'];

  var CATEGORIES_QUERY =
    'query WebCategories($shipCode: ShipCodeScalar!, $sailDate: LocalDateScalar!, $regionCode: String) {\n' +
    '  categories(shipCode: $shipCode, sailDate: $sailDate, regionCode: $regionCode, filter: {limitCategoriesWithProducts: true}) {\n' +
    '    ... on CategoryResultSuccess { categories { id name } }\n' +
    '  }\n' +
    '}';

  var PRODUCTS_QUERY =
    'query WebProductsByCategory($category: String!, $passengerId: String, $shipCode: ShipCodeScalar!, $sailDate: LocalDateScalar!, ' +
    '$reservationId: String, $pageSize: Long, $currentPage: Long, $sorting: Sorting, $filter: FilterInput, $currencyCode: String!) {\n' +
    '  products(category: $category, guestTypes: [ADULT], passengerId: $passengerId, shipCode: $shipCode, sailDate: $sailDate, ' +
    'reservationId: $reservationId, pageSize: $pageSize, currentPage: $currentPage, sorting: $sorting, filter: $filter, currencyIso: $currencyCode) {\n' +
    '    ... on CommerceProductResultSuccess {\n' +
    '      commerceProducts {\n' +
    '        id title\n' +
    '        variantOptions { code name }\n' +
    '        price { currency promotionalPrice shipboardPrice formattedPromotionalPrice formattedBasePrice formattedDailyPrice formattedPromoDailyPrice salesUnit { code name label } }\n' +
    '      }\n' +
    '    }\n' +
    '  }\n' +
    '}';

  function webHeaders(extra) {
    var h = { 'User-Agent': UA_WEB, 'Accept': 'application/json', 'AppKey': APPKEY_WEB };
    for (var k in (extra || {})) h[k] = extra[k];
    return h;
  }

  function qs(params) {
    return Object.keys(params).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    }).join('&');
  }

  function parseJson(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  async function getJson(http, method, url, opts) {
    var r = await http(method, url, opts || {});
    if (!r || r.status < 200 || r.status >= 300) {
      var err = new Error('Cruise line server returned ' + (r ? r.status : 'no response'));
      err.status = r ? r.status : 0;
      throw err;
    }
    var j = parseJson(r.body);
    if (j === null) throw new Error('Unexpected (non-JSON) reply from cruise line');
    return j;
  }

  /* ---------- helpers ---------- */

  function titleCase(name) {
    return String(name || '').toLowerCase()
      .replace(/(^|[^a-z])([a-z])/g, function (m, a, b) { return a + b.toUpperCase(); })
      .replace(/ Of The /g, ' of the ');
  }

  /* Ship classes by ship name (first word of the name, lower case). New ships: add them here. */
  var SHIP_CLASSES = [
    { id: 'icon', name: 'Icon Class', brand: 'royal', ships: ['icon', 'star', 'legend', 'hero'] },
    { id: 'oasis', name: 'Oasis Class', brand: 'royal', ships: ['oasis', 'allure', 'harmony', 'symphony', 'wonder', 'utopia'] },
    { id: 'quantum', name: 'Quantum Class', brand: 'royal', ships: ['quantum', 'anthem', 'ovation', 'spectrum', 'odyssey'] },
    { id: 'freedom', name: 'Freedom Class', brand: 'royal', ships: ['freedom', 'liberty', 'independence'] },
    { id: 'voyager', name: 'Voyager Class', brand: 'royal', ships: ['voyager', 'explorer', 'adventure', 'navigator', 'mariner'] },
    { id: 'radiance', name: 'Radiance Class', brand: 'royal', ships: ['radiance', 'brilliance', 'serenade', 'jewel'] },
    { id: 'vision', name: 'Vision Class', brand: 'royal', ships: ['grandeur', 'enchantment', 'rhapsody', 'vision'] },
    { id: 'edge', name: 'Celebrity Edge Class', brand: 'celebrity', ships: ['edge', 'apex', 'beyond', 'ascent', 'xcel'] },
    { id: 'solstice', name: 'Celebrity Solstice Class', brand: 'celebrity', ships: ['solstice', 'equinox', 'eclipse', 'silhouette', 'reflection'] },
    { id: 'millennium', name: 'Celebrity Millennium Class', brand: 'celebrity', ships: ['millennium', 'infinity', 'summit', 'constellation'] }
  ];

  function shipClass(shipName) {
    var royal = isRoyalShip(shipName);
    var key = String(shipName || '').replace(/^Celebrity\s+/i, '').replace(/\s+of the Seas$/i, '').trim().split(/\s+/)[0].toLowerCase();
    for (var i = 0; i < SHIP_CLASSES.length; i++) {
      var c = SHIP_CLASSES[i];
      if ((c.brand === 'royal') === royal && c.ships.indexOf(key) >= 0) return c.id;
    }
    return 'other';
  }

  function isRoyalShip(shipName) { return /of the Seas/i.test(shipName || ''); }

  function brandHost(shipName) { return isRoyalShip(shipName) ? 'www.royalcaribbean.com' : 'www.celebritycruises.com'; }

  /* "$1,234.56" / "1.234,56 €" / 85 -> number (or null). */
  function parsePrice(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    var s = String(v).replace(/[^0-9.,]/g, '');
    if (!s) return null;
    var lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
    if (lastComma > lastDot) {
      // comma is the decimal separator when followed by exactly 2 digits
      if (s.length - lastComma - 1 === 2) s = s.replace(/\./g, '').replace(',', '.');
      else s = s.replace(/,/g, '');
    } else {
      s = s.replace(/,/g, '');
    }
    var n = parseFloat(s);
    return isFinite(n) ? n : null;
  }

  /* Same field priority as BrowseRoyalCaribbeanPrice.print_and_sort_products */
  function productPrice(product) {
    var list = product && product.price;
    if (!Array.isArray(list) || !list.length || !list[0]) return null;
    var p = list[0];
    var price = parsePrice(p.formattedPromotionalPrice);
    if (price === null) price = parsePrice(p.formattedBasePrice);
    if (price === null) price = parsePrice(p.shipboardPrice);
    if (price === null || price === 0) return null;
    var base = parsePrice(p.formattedBasePrice);
    if (base === null) base = parsePrice(p.shipboardPrice);
    var unitName = (p.salesUnit && p.salesUnit.name) || '';
    var unit = unitName === 'Per Night' ? 'night' : unitName === 'Per Day' ? 'day' : '';
    return {
      price: price,
      base: base !== null && base > price ? base : null,
      currency: p.currency || null,
      unit: unit
    };
  }

  /* Bucket a store category into one of the app's tabs. */
  function classifyCategory(id, name) {
    var s = (String(id || '') + ' ' + String(name || '')).toLowerCase();
    if (id === 'shorex' || /excursion|shore ?ex|tour/.test(s)) return 'excursions';
    if (/internet|wi-?fi|voom|connect|surf|starlink/.test(s)) return 'wifi';
    if (/beverage|drink|bar\b|coffee|water|soda|wine|refresh|alcohol|bottle/.test(s)) return 'drinks';
    if (/dining|dine|restaurant|food|specialty|culinary|chef/.test(s)) return 'dining';
    return 'more';
  }

  /* ---------- fleet / sailings ---------- */

  async function getShips(http) {
    var j = await getJson(http, 'GET', API + '/en/royal/web/v2/ships?' + qs({ sort: 'name' }), { headers: webHeaders() });
    var ships = (j && j.payload && j.payload.ships) || [];
    return ships.filter(function (s) { return s && s.shipCode; }).map(function (s) {
      var name = titleCase(s.name);
      return { code: s.shipCode, name: name, brand: isRoyalShip(name) ? 'royal' : 'celebrity' };
    });
  }

  async function getSailings(http, shipCode) {
    var j = await getJson(http, 'GET', API + '/en/royal/web/v3/ships/' + encodeURIComponent(shipCode) + '/voyages', { headers: webHeaders() });
    var voyages = (j && j.payload && j.payload.voyages) || [];
    if (!Array.isArray(voyages)) voyages = [];
    return voyages.filter(function (v) { return v && v.sailDate; }).map(function (v) {
      return {
        date: v.sailDate,
        description: v.voyageDescription || '',
        duration: parseInt(v.duration, 10) || 0,
        voyageCode: v.voyageCode || ''
      };
    });
  }

  async function getItinerary(http, shipCode, sailDate) {
    var j = await getJson(http, 'GET', API + '/en/royal/web/v3/ships/' + encodeURIComponent(shipCode) + '/sailDate/' + encodeURIComponent(sailDate), { headers: webHeaders() });
    var info = j && j.payload && j.payload.sailingInfo;
    if (Array.isArray(info)) info = info[0];
    var events = (info && info.itinerary && info.itinerary.events) || [];
    var out = [];
    events.forEach(function (ev) {
      if (!ev || ev.day === null || ev.day === undefined) return;
      var port = ev.port || {};
      var arr = port.arrivalDateTime || null, dep = port.departureDateTime || null;
      out.push({
        day: parseInt(ev.day, 10),
        port: port.portName || '',
        type: port.portType || '',
        arrive: arr ? arr.slice(9, 13) : '',
        depart: dep ? dep.slice(9, 13) : ''
      });
    });
    return out;
  }

  /* ---------- store ---------- */

  async function getCategories(http, shipCode, sailDate) {
    var body = JSON.stringify({ operationName: 'WebCategories', variables: { sailDate: sailDate, shipCode: shipCode }, query: CATEGORIES_QUERY });
    var j = await getJson(http, 'POST', API + '/en/royal/web/graphql', { headers: webHeaders({ 'Content-Type': 'application/json' }), body: body });
    var list = j && j.data && j.data.categories && j.data.categories.categories;
    if (!Array.isArray(list)) return [];
    return list.filter(Boolean).map(function (c) {
      return { id: c.id, name: c.name, tab: classifyCategory(c.id, c.name) };
    });
  }

  /* All pages of one category (optionally one itinerary day, used for excursions). */
  async function getProducts(http, shipCode, sailDate, category, currency, dayNumber) {
    var vars = {
      category: category, passengerId: '', shipCode: shipCode, sailDate: sailDate, reservationId: '000000',
      pageSize: 12, // API ceiling: >20 returns empty payloads
      sorting: { sortKey: 'RANK', sortKeyOrder: 'ASCENDING' },
      filter: { includeVariantProducts: false },
      currencyCode: currency || 'USD', includeFilterInfo: false, includeIfABexperience: false
    };
    if (dayNumber !== undefined && dayNumber !== null && dayNumber !== 'all') vars.filter.dayNumber = [parseInt(dayNumber, 10)];
    var all = [], seen = {};
    for (var page = 0; page < 60; page++) {
      vars.currentPage = page;
      var body = JSON.stringify({ operationName: 'WebProductsByCategory', variables: vars, query: PRODUCTS_QUERY });
      var j;
      try {
        j = await getJson(http, 'POST', API + '/en/royal/web/graphql', { headers: webHeaders({ 'Content-Type': 'application/json' }), body: body });
      } catch (e) {
        if (page === 0) throw e;
        break;
      }
      var items = j && j.data && j.data.products && j.data.products.commerceProducts;
      if (!items || !items.length) break;
      var fresh = 0;
      items.forEach(function (p) {
        if (!p || seen[p.id]) return;
        seen[p.id] = 1; fresh++;
        var pr = productPrice(p);
        if (!pr) return;
        all.push({
          id: p.id,
          title: String(p.title || '').trim(),
          price: pr.price, base: pr.base, unit: pr.unit,
          currency: pr.currency || currency,
          variants: (p.variantOptions || []).slice(1).map(function (v) { return v && v.name; }).filter(Boolean)
        });
      });
      if (!fresh) break; // server repeating the last page
    }
    return all;
  }

  /* ---------- cabins (room-selection RSC page) ---------- */

  function extractJsonArray(text, key) {
    var re = new RegExp('"' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"\\s*:\\s*\\[');
    var m = re.exec(text);
    if (!m) return null;
    var start = m.index + m[0].length - 1;
    var depth = 0, inStr = false, esc = false;
    for (var i = start; i < text.length; i++) {
      var ch = text.charAt(i);
      if (esc) esc = false;
      else if (ch === '\\' && inStr) esc = true;
      else if (ch === '"') inStr = !inStr;
      else if (!inStr) {
        if (ch === '[') depth++;
        else if (ch === ']') {
          depth--;
          if (depth === 0) return parseJson(text.slice(start, i + 1));
        }
      }
    }
    return null;
  }

  function cabinUrl(o) {
    var d = String(o.sailDate);
    var params = {
      packageCode: o.packageCode, sailDate: d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8),
      country: 'USA', selectedCurrencyCode: o.currency || 'USD', shipCode: o.packageCode.slice(0, 2),
      cabinClassType: 'INTERIOR', roomIndex: '0', r0a: String(o.adults || 2), r0c: String(o.children || 0),
      r0b: 'n', r0r: o.police ? 'y' : 'n', r0s: o.fire ? 'y' : 'n', r0q: o.military ? 'y' : 'n', r0t: o.senior ? 'y' : 'n',
      r0d: 'INTERIOR', r0D: 'y', rgVisited: 'true', r0C: 'y'
    };
    // discount qualifiers, same URL parameters CheckRoyalCaribbeanPrice.py sends
    if (o.loyaltyNumber) params.r0l = String(o.loyaltyNumber);
    if (o.state) params.r0k = String(o.state);
    return 'https://' + (o.host || 'www.royalcaribbean.com') + '/room-selection/type-and-subtype?' + qs(params);
  }

  var CABIN_HEADERS = { 'User-Agent': UA_WEB, 'Accept': 'text/x-component', 'Accept-Language': 'en-US,en;q=0.9', 'RSC': '1' };

  /*
   * Returns one row per stateroom class (Interior, Ocean View, Balcony, Suite...) or [] when sold out:
   *   {name, price|null, connectingPrice|null, connectingName, subtypes:[{name, price, roomsLeft, guarantee, connecting}]}
   * "connecting" sub-types are the ones the cruise line names "...Connecting..." (a door to the next cabin),
   * the same rule CheckRoyalCaribbeanPrice.py uses for its [connecting] tag.
   */
  function parseCabins(text) {
    var rooms = extractJsonArray(text || '', 'rooms');
    var types = [];
    if (rooms && rooms[0] && typeof rooms[0] === 'object') types = (rooms[0].options || {}).stateroomTypes || [];
    return types.filter(Boolean).map(function (t) {
      var cheapest = null, conn = null, connName = '';
      var subtypes = [];
      (t.stateroomSubtypes || []).forEach(function (st) {
        if (!st) return;
        var total = st.pricing && st.pricing.invoice && st.pricing.invoice.total;
        var name = typeof st.name === 'string' ? st.name : '';
        var price = typeof total === 'number' && st.roomsLeft !== 0 ? total : null;
        // yes/no fields Royal sets on this room type (e.g. guarantee) - kept so "See every room type" can show them
        var flags = Object.keys(st).filter(function (k) { return st[k] === true; });
        var code = st.code || st.stateroomSubtypeCode || '';
        var connecting = /connect/i.test(name) || flags.some(function (k) { return /connect/i.test(k); });
        subtypes.push({ name: name, code: typeof code === 'string' ? code : '', price: price, roomsLeft: typeof st.roomsLeft === 'number' ? st.roomsLeft : null,
          guarantee: !!st.guarantee, connecting: connecting, flags: flags });
        if (price === null) return;
        if (cheapest === null || price < cheapest) cheapest = price;
        if (connecting && (conn === null || price < conn)) { conn = price; connName = name; }
      });
      return { name: t.name || 'Stateroom', code: typeof t.code === 'string' ? t.code : '', price: cheapest, connectingPrice: conn, connectingName: connName, subtypes: subtypes };
    });
  }

  /*
   * Ways to put a group into 1..maxCabins cabins. Every cabin needs at least one adult
   * (cruise line rule for under-21s) and at most maxPer guests.
   * Returns [[{adults, children}, ...], ...] without mirror-image duplicates.
   */
  function planSplits(adults, children, maxPer, maxCabins) {
    maxPer = maxPer || 4; maxCabins = maxCabins || 2;
    var out = [], seen = {};
    function rec(aLeft, cLeft, cabinsLeft, acc) {
      if (aLeft === 0 && cLeft === 0) {
        var key = acc.map(function (c) { return c.adults + '/' + c.children; }).sort().join(' ');
        if (!seen[key]) { seen[key] = 1; out.push(acc.slice()); }
        return;
      }
      if (cabinsLeft === 0 || aLeft === 0) return;
      for (var a = 1; a <= Math.min(aLeft, maxPer); a++) {
        for (var c = 0; c <= Math.min(cLeft, maxPer - a); c++) {
          acc.push({ adults: a, children: c });
          rec(aLeft - a, cLeft - c, cabinsLeft - 1, acc);
          acc.pop();
        }
      }
    }
    rec(adults, children, maxCabins, []);
    out.sort(function (x, y) { return x.length - y.length; });
    return out;
  }

  /* Unique cabin occupancies the splits need priced, e.g. ["2/2", "2/0"]. */
  function occupanciesFor(splits) {
    var m = {};
    splits.forEach(function (sp) { sp.forEach(function (c) { m[c.adults + '/' + c.children] = c; }); });
    return Object.keys(m).map(function (k) { return m[k]; });
  }

  /*
   * priceTable: {"2/2": parseCabins(...) result, ...}
   * Returns per class: {name, best:{total, cabins:[{adults, children, price, subtype}]}, options:[...same, sorted]}
   * connectingOnly: multi-cabin splits must use connecting sub-types (single cabin splits are always allowed).
   */
  function bestCombos(priceTable, splits, connectingOnly) {
    var classes = [];
    Object.keys(priceTable).forEach(function (k) {
      (priceTable[k] || []).forEach(function (row) { if (classes.indexOf(row.name) < 0) classes.push(row.name); });
    });
    return classes.map(function (cls) {
      var options = [];
      splits.forEach(function (sp) {
        var multi = sp.length > 1, total = 0, cabins = [];
        for (var i = 0; i < sp.length; i++) {
          var rows = priceTable[sp[i].adults + '/' + sp[i].children] || [];
          var row = null;
          rows.forEach(function (r) { if (r.name === cls) row = r; });
          if (!row) return;
          var useConn = multi && connectingOnly;
          var price = useConn ? row.connectingPrice : row.price;
          if (price === null || price === undefined) return;
          total += price;
          cabins.push({ adults: sp[i].adults, children: sp[i].children, price: price, subtype: useConn ? row.connectingName : '' });
        }
        options.push({ total: Math.round(total * 100) / 100, cabins: cabins, connecting: multi && connectingOnly });
      });
      options.sort(function (a, b) { return a.total - b.total; });
      return { name: cls, best: options[0] || null, options: options };
    });
  }

  /* Inside / Ocean View / Balcony / Suite from a cruise-line room name (Royal and Celebrity wording). */
  function cabinTypeOf(name) {
    var n = String(name || '').toLowerCase();
    if (/suite|loft|haven|retreat|villa/.test(n)) return 'suite';
    if (/balcon|veranda|aquaclass|concierge/.test(n)) return 'balcony';
    if (/ocean|outside|panoramic|porthole|window/.test(n)) return 'ocean';
    if (/interior|inside/.test(n)) return 'interior';
    return 'other';
  }
  var CABIN_KIND_NAMES = { interior: 'Inside', ocean: 'Ocean View', balcony: 'Balcony', suite: 'Suite', other: 'Other' };

  /*
   * Royal's rooms service (what the booking site itself uses). Asking for ALL of a group's rooms in
   * one request makes it mark each category "connecting": true when connecting rooms are open for
   * that group, and list cabin numbers with their "connectingCabin".
   *   o: {packageCode, sailDate (YYYYMMDD), currency, host, rooms:[{adults, children}], loyaltyNumber, state, senior, ...}
   * Returns {rooms: [[category...] per requested room], pairs: [[cabin, cabin, categoryCode, kind]...]}
   */
  /*
   * The rooms service needs a real starting category (stateroomSubtypeCode) or it answers 400.
   * Take one from the sailing's cabin page: an interior that is for sale, not a guarantee if possible.
   */
  var BLOCKED_MSG = 'The cruise line\'s website is blocking requests right now (it does this after many searches in a short time). Cabin prices should work again in 15-30 minutes; drinks, dining, Wi-Fi and excursions are not affected.';
  var startMemo = {};
  var TYPE_CODES = { interior: 'INTERIOR', ocean: 'OUTSIDE', balcony: 'BALCONY', suite: 'DELUXE' };
  async function startingCategory(http, o) {
    var key = o.packageCode + '|' + o.sailDate + '|' + (o.host || '');
    if (startMemo[key]) return startMemo[key];
    var r0 = (o.rooms && o.rooms[0]) || { adults: 2, children: 0 };
    var rows = await getCabins(http, { packageCode: o.packageCode, sailDate: o.sailDate, currency: o.currency, host: o.host, adults: r0.adults, children: r0.children });
    var order = ['interior', 'ocean', 'balcony', 'suite', 'other'];
    rows = rows.slice().sort(function (a, b) { return order.indexOf(cabinTypeOf(a.name)) - order.indexOf(cabinTypeOf(b.name)); });
    var pick = null;
    [false, true].forEach(function (allowGty) {
      rows.forEach(function (row) {
        (row.subtypes || []).forEach(function (st) {
          if (pick || !st.code || st.price === null || (st.guarantee && !allowGty)) return;
          var kind = cabinTypeOf(row.name);
          pick = { typeCode: /^[A-Z]{3,}$/.test(row.code || '') ? row.code : (TYPE_CODES[kind] || 'INTERIOR'), subtype: st.code };
        });
      });
    });
    if (!pick) throw new Error('This sailing looks sold out');
    startMemo[key] = pick;
    return pick;
  }

  async function getRoomOptions(http, o) {
    var d = String(o.sailDate);
    var royal = (o.host || 'www.royalcaribbean.com').indexOf('celebrity') < 0;
    var start = o.subtype ? { typeCode: o.typeCode || 'INTERIOR', subtype: o.subtype } : await startingCategory(http, o);
    var body = {
      countryCode: 'USA', packageId: o.packageCode, sailDate: d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8),
      currencyCode: o.currency || 'USD', language: 'en', options: true, roomNumbers: true, platform: 'web',
      rooms: (o.rooms || []).map(function (r) {
        var q = { fireFighter: !!o.fire, military: !!o.military, police: !!o.police, senior: !!o.senior };
        if (o.loyaltyNumber) q.loyaltyNumber = String(o.loyaltyNumber);
        if (o.state) q.stateCode = String(o.state);
        return { adultCount: r.adults, childCount: r.children || 0, stateroomTypeCode: start.typeCode, stateroomSubtypeCode: start.subtype, accessible: false,
          selectionFallbackStrategy: 'RECOMMENDATION', editMode: true, reset: false, taxesAndFeesBundled: true, qualifiers: q };
      })
    };
    function post(b) {
      return http('POST', 'https://' + (royal ? 'www.royalcaribbean.com' : 'www.celebritycruises.com') + '/room-selection/api/v1/rooms', {
        headers: { 'User-Agent': UA_WEB, 'Accept': '*/*', 'Content-Type': 'application/json', 'brand': royal ? 'R' : 'C', 'country': 'USA' },
        body: JSON.stringify(b)
      });
    }
    var r = await post(body);
    var discounted = !!(o.loyaltyNumber || o.state);
    if ((!r || r.status !== 200) && discounted) {
      // the loyalty number / state may not be accepted by this service: ask again without them
      body.rooms.forEach(function (x) { delete x.qualifiers.loyaltyNumber; delete x.qualifiers.stateCode; });
      r = await post(body);
      discounted = false;
    }
    if (r && (r.status === 403 || r.status === 429)) throw new Error(BLOCKED_MSG);
    if (!r || r.status !== 200) {
      var why = r && r.body ? String(r.body).replace(/\s+/g, ' ').slice(0, 200) : '';
      throw new Error('Could not get room options (' + (r ? r.status : 'no response') + (why ? ': ' + why : '') + ')');
    }
    var j = parseJson(r.body);
    if (!j || !Array.isArray(j.rooms)) throw new Error('Unexpected room options reply');
    var res = parseRoomOptions(j);
    res.rooms = (o.rooms || []).map(function (r) { return { adults: r.adults, children: r.children || 0 }; });
    res.start = start;
    res.discounted = discounted;
    if (o.keepRaw) res.raw = j;
    return res;
  }

  /*
   * Royal's multi-room reply (captured from the real site):
   *   rooms[0].options.stateroomTypes[] = {code: 'INTERIOR'|'OUTSIDE'|'BALCONY'|'DELUXE', name, connecting,
   *       stateroomSubtypes[]: {code, name, guarantee, categoryCode, connecting, pricing.invoice.total,
   *                             stateroomsAvailable, roomsLeft, image.alt}}
   *   rooms[1..] carry no options (only a placeholder "room"), so the list for the whole group comes
   *   from room 1, priced for room 1's guests. "connecting" there means a connecting pair is open.
   * Returns {options: [{code, categoryCode, name, kind, price, connecting, available, guarantee}], pairs}
   */
  var TYPE_KINDS = { INTERIOR: 'interior', OUTSIDE: 'ocean', OCEANVIEW: 'ocean', BALCONY: 'balcony', VERANDA: 'balcony',
    CONCIERGE: 'balcony', AQUA: 'balcony', DELUXE: 'suite', SUITE: 'suite' };

  function parseRoomOptions(j) {
    var pairsSeen = {}, pairs = [];
    // connecting cabin pairs can appear anywhere (room-location data)
    (function walk(node, cat, kind) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(function (x) { walk(x, cat, kind); }); return; }
      if (typeof node.categoryCode === 'string') cat = node.categoryCode;
      if (node.cabinNumber && node.connectingCabin && node.connectingCabin.cabinNumber) {
        var a = String(node.cabinNumber), b = String(node.connectingCabin.cabinNumber);
        var key = [a, b].sort().join('&');
        if (!pairsSeen[key]) { pairsSeen[key] = 1; pairs.push([a, b, cat || '', kind || '', '']); }
      }
      Object.keys(node).forEach(function (k) { if (node[k] && typeof node[k] === 'object') walk(node[k], cat, kind); });
    })(j, '', '');

    var options = [];
    var first = (j.rooms || [])[0] || {};
    var types = first.options && Array.isArray(first.options.stateroomTypes) ? first.options.stateroomTypes : [];
    types.forEach(function (t) {
      if (!t) return;
      var kind = TYPE_KINDS[String(t.code || '').toUpperCase()] || cabinTypeOf(t.name);
      (t.stateroomSubtypes || []).forEach(function (st) {
        if (!st) return;
        var inv = st.pricing && st.pricing.invoice;
        var price = inv && typeof inv.total === 'number' ? inv.total : (st.pricing && typeof st.pricing.amount === 'number' ? st.pricing.amount : null);
        var avail = typeof st.stateroomsAvailable === 'number' ? st.stateroomsAvailable : (typeof st.roomsLeft === 'number' ? st.roomsLeft : null);
        if (price === null || avail === 0) return;
        options.push({
          code: String(st.code || st.categoryCode || ''), categoryCode: String(st.categoryCode || st.code || ''),
          name: (typeof st.name === 'string' && st.name) || (st.image && st.image.alt) || st.code,
          kind: kind === 'other' ? cabinTypeOf(st.name) : kind, price: price,
          connecting: st.connecting === true, available: avail, guarantee: st.guarantee === true
        });
      });
    });
    // name the pairs' categories where we can
    pairs.forEach(function (p) {
      options.forEach(function (o) { if (o.categoryCode === p[2] || o.code === p[2]) { p[3] = o.kind; p[4] = o.name; } });
    });
    return { options: options, pairs: pairs };
  }

  /*
   * One split of the group, e.g. [{2,1},{2,1}] or [{2,0},{4,0}].
   * byOcc: {"a/c": parseRoomOptions(reply where a room of that size was listed FIRST)}
   * first: the reply for the split in its own order (its "connecting" flags apply to the whole group).
   * Same subtype for every room (that is how Royal sells a set of matching / connecting rooms).
   * Returns the cheapest option per kind: [{kind, name, code, total, perRoom, connecting, pairs}]
   */
  function combineSplit(split, first, byOcc, connectingOnly) {
    var best = {};
    var multi = split.length > 1;
    first.options.forEach(function (o) {
      if (connectingOnly && multi && !o.connecting) return;
      var per = [];
      for (var i = 0; i < split.length; i++) {
        var list = byOcc[split[i].adults + '/' + split[i].children];
        if (!list) return;
        var hit = null;
        list.options.forEach(function (x) { if (x.code === o.code) hit = x; });
        if (!hit) return;
        per.push(hit.price);
      }
      var total = Math.round(per.reduce(function (a, b) { return a + b; }, 0) * 100) / 100;
      var cur = best[o.kind];
      if (!cur || total < cur.total) {
        best[o.kind] = { kind: o.kind, name: o.name, code: o.categoryCode || o.code, total: total, perRoom: per,
          connecting: multi && o.connecting, guarantee: o.guarantee,
          pairs: first.pairs.filter(function (p) { return p[2] === o.categoryCode || p[2] === o.code; }).slice(0, 6) };
      }
    });
    return ['interior', 'ocean', 'balcony', 'suite', 'other'].filter(function (k) { return best[k]; }).map(function (k) { return best[k]; });
  }

  /* kept for older callers: options of a single reply, no per-size repricing */
  function bestByKind(ro, connectingOnly) {
    var n = ro.rooms ? ro.rooms.length : 1;
    var split = [];
    for (var i = 0; i < n; i++) split.push({ adults: 0, children: 0 });
    return combineSplit(split, ro, { '0/0': ro }, connectingOnly);
  }

  async function getCabins(http, o) {
    var r = await http('GET', cabinUrl(o), { headers: CABIN_HEADERS });
    if (r && (r.status === 403 || r.status === 429)) throw new Error(BLOCKED_MSG);
    if (!r || r.status < 200 || r.status >= 300) throw new Error('Could not retrieve cabin prices (' + (r ? r.status : 'no response') + ')');
    return parseCabins(r.body);
  }

  /* ---------- price alerts ---------- */

  /*
   * alert = {type:'product', ship, sailDate, category, day, productId, currency, target, ...}
   *       | {type:'cabin', packageCode, sailDate, host, adults, children, cabinName, currency, target, ...}
   * Returns {alert (updated copy), message|null}. `message` is set when the user should be told.
   */
  async function checkAlert(http, alert) {
    var a = JSON.parse(JSON.stringify(alert));
    var now = new Date().toISOString();
    var current = null;
    try {
      if (a.type === 'cabin') {
        var cabins = await getCabins(http, a);
        cabins.forEach(function (c) { if (c.name === a.cabinName) current = c.price; });
      } else {
        var items = await getProducts(http, a.ship, a.sailDate, a.category, a.currency, a.day);
        items.forEach(function (p) { if (String(p.id) === String(a.productId)) current = p.price; });
      }
    } catch (e) {
      a.lastError = String(e && e.message || e);
      a.lastChecked = now;
      return { alert: a, message: null };
    }
    a.lastChecked = now;
    a.lastError = null;
    if (current === null) {
      a.status = 'unavailable';
      return { alert: a, message: null };
    }
    var previous = a.lastPrice;
    a.lastPrice = current;
    if (a.lowestSeen === undefined || a.lowestSeen === null || current < a.lowestSeen) a.lowestSeen = current;
    var threshold = (a.target !== null && a.target !== undefined && a.target !== '') ? Number(a.target) : Number(a.initialPrice);
    var hit = a.target ? current <= threshold : current < threshold;
    a.status = hit ? 'dropped' : 'watching';
    var message = null;
    if (hit && (a.notifiedPrice === null || a.notifiedPrice === undefined || current < a.notifiedPrice)) {
      a.notifiedPrice = current;
      message = 'Price drop: ' + a.title + ' is now ' + fmtMoney(current, a.currency) +
        (previous !== null && previous !== undefined && previous !== current ? ' (was ' + fmtMoney(previous, a.currency) + ')' : '') +
        ' - ' + (a.shipName || a.ship || '') + ' ' + fmtSailDate(a.sailDate);
    }
    // no re-arm: after the first alert, only a price below the last alerted price alerts again
    return { alert: a, message: message };
  }

  function fmtMoney(n, currency) {
    if (n === null || n === undefined || isNaN(n)) return '-';
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD', maximumFractionDigits: n % 1 ? 2 : 0 }).format(n);
    } catch (e) { return (currency || '$') + ' ' + Number(n).toFixed(2); }
  }

  function sailDateObj(d) {
    d = String(d || '');
    return new Date(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8));
  }

  function fmtSailDate(d, opts) {
    var dt = sailDateObj(d);
    if (isNaN(dt)) return String(d || '');
    return dt.toLocaleDateString('en-US', opts || { month: 'short', day: 'numeric', year: 'numeric' });
  }

  /* ---------- My Cruises: logged-in purchase price check (PhonePriceCheck.py) ---------- */

  function b64urlDecode(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    if (typeof atob === 'function') return decodeURIComponent(escape(atob(s)));
    return Buffer.from(s, 'base64').toString('utf8');
  }

  async function login(http, username, password, line) {
    var body = 'grant_type=password&username=' + encodeURIComponent(username) + '&password=' + encodeURIComponent(password) + '&scope=openid+profile+email+vdsid';
    var r = await http('POST', 'https://www.' + line + '.com/auth/oauth2/access_token', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': LOGIN_BASIC, 'User-Agent': UA_MOBILE },
      body: body
    });
    var j = r && r.status === 200 ? parseJson(r.body) : null;
    var token = j && (j.payload ? j.payload.access_token : j.access_token);
    if (!token) throw new Error('Login failed - check your email/password (or the cruise line site may be down).');
    var claims = parseJson(b64urlDecode(token.split('.')[1] || ''));
    if (!claims || !claims.sub) throw new Error('Could not read the login token.');
    return { token: token, accountId: claims.sub, line: line };
  }

  function unwrap(j) { return j && j.payload !== undefined ? j.payload : j; }

  /* Crown & Anchor / Captain's Club numbers, tier and residency from the signed-in profile. */
  async function getProfile(http, auth) {
    var apiBrand = auth.line === 'royalcaribbean' ? 'royal' : 'celebrity';
    var j = unwrap(await getJson(http, 'GET', API + '/en/' + apiBrand + '/web/v3/guestAccounts/' + encodeURIComponent(auth.accountId), {
      headers: { 'Access-Token': auth.token, 'AppKey': APPKEY_WEB, 'vds-id': auth.accountId, 'account-id': auth.accountId, 'User-Agent': UA_WEB, 'Accept': 'application/json' }
    })) || {};
    var loy = j.loyaltyInformation || {};
    var addr = (j.contactInformation || {}).address || {};
    return {
      crownAnchor: loy.crownAndAnchorId ? String(loy.crownAndAnchorId) : '',
      crownAnchorTier: loy.crownAndAnchorSocietyLoyaltyTier || '',
      crownAnchorPoints: loy.crownAndAnchorSocietyLoyaltyIndividualPoints || 0,
      captainsClub: loy.captainsClubId ? String(loy.captainsClubId) : '',
      captainsClubTier: loy.captainsClubLoyaltyTier || '',
      captainsClubPoints: loy.captainsClubLoyaltyIndividualPoints || 0,
      clubRoyaleTier: loy.clubRoyaleLoyaltyTier || '',
      state: (addr.residencyCountryCode === 'USA' || addr.residencyCountryCode === 'CAN') ? (addr.state || '') : ''
    };
  }

  /* Discount qualifiers for one ship: Crown & Anchor for Royal, Captain's Club for Celebrity. */
  function discountOpts(d, shipName) {
    d = d || {};
    var o = {};
    var num = isRoyalShip(shipName) ? d.crownAnchor : d.captainsClub;
    if (num && /^\d{4,15}$/.test(String(num))) o.loyaltyNumber = String(num);
    if (d.state && /^[A-Z]{2}$/.test(d.state)) o.state = d.state;
    ['senior', 'military', 'police', 'fire'].forEach(function (k) { if (d[k]) o[k] = true; });
    return o;
  }

  function discountLabels(o) {
    var l = [];
    if (o.loyaltyNumber) l.push('loyalty #');
    if (o.state) l.push(o.state + ' resident');
    if (o.senior) l.push('55+');
    if (o.military) l.push('military');
    if (o.police) l.push('police');
    if (o.fire) l.push('firefighter');
    return l;
  }

  /*
   * Checks every purchased Cruise Planner item on the account.
   * onProgress({booking}) / onProgress({item}) are called as results arrive.
   */
  async function checkPurchases(http, auth, currencyOverride, onProgress) {
    var apiBrand = auth.line === 'royalcaribbean' ? 'royal' : 'celebrity';
    var brandCode = auth.line === 'royalcaribbean' ? 'R' : 'C';
    var shipNames = {};
    try {
      var sj = await getJson(http, 'GET', 'https://api.rccl.com/en/all/mobile/v2/ships?sort=name', {
        headers: { appkey: SHIPS_APPKEY, accept: 'application/json', appversion: '1.54.0', 'accept-language': 'en', 'user-agent': 'okhttp/4.10.0' }
      });
      ((unwrap(sj) || {}).ships || []).forEach(function (s) { if (s.shipCode) shipNames[s.shipCode] = titleCase(s.name); });
    } catch (e) { /* names are cosmetic */ }

    var hdr = { 'Access-Token': auth.token, 'AppKey': APPKEY_WEB, 'vds-id': auth.accountId, 'User-Agent': UA_MOBILE };
    var pj = unwrap(await getJson(http, 'GET', API + '/v1/profileBookings/enriched/' + encodeURIComponent(auth.accountId) + '?' + qs({ brand: brandCode, includeCheckin: 'false' }), { headers: hdr }));
    var bookings = (pj && pj.profileBookings) || [];
    var found = {};
    var results = [];
    for (var b = 0; b < bookings.length; b++) {
      var bk = bookings[b];
      var booking = {
        reservationId: String(bk.bookingId), passengerId: String(bk.passengerId), ship: bk.shipCode || '',
        shipName: shipNames[bk.shipCode] || bk.shipCode || '', sailDate: bk.sailDate, nights: bk.numberOfNights || 1,
        room: bk.stateroomNumber || 'GTY', balanceDue: bk.balanceDue ? bk.balanceDueAmount : null,
        guests: (bk.passengers || []).map(function (g) { return titleCase(g.firstName || ''); }).filter(Boolean),
        items: []
      };
      results.push(booking);
      if (onProgress) onProgress({ booking: booking, results: results });

      var currency = currencyOverride || 'USD';
      var oh = { 'Access-Token': auth.token, 'AppKey': APPKEY_WEB, 'Account-Id': auth.accountId, 'User-Agent': UA_MOBILE };
      var params = qs({ passengerId: booking.passengerId, reservationId: booking.reservationId, sailingId: booking.ship + booking.sailDate, currencyIso: currency, includeMedia: 'false' });
      var base = API + '/en/' + apiBrand + '/web/commerce-api/calendar/v1/' + booking.ship + '/orderHistory';
      var orders;
      try { orders = unwrap(await getJson(http, 'GET', base + '?' + params, { headers: oh })); } catch (e) { continue; }
      var list = ((orders && orders.myOrders) || []).concat((orders && orders.ordersOthersHaveBookedForMe) || []);
      for (var o = 0; o < list.length; o++) {
        var order = list[o];
        if (!((order.orderTotals || {}).total > 0)) continue;
        var detail;
        try { detail = unwrap(await getJson(http, 'GET', base + '/' + encodeURIComponent(order.orderCode) + '?' + params, { headers: oh })); } catch (e) { continue; }
        var dItems = (detail && detail.orderHistoryDetailItems) || [];
        for (var d = 0; d < dItems.length; d++) {
          var ps = dItems[d].productSummary || {};
          var product = (ps.baseOptions && ps.baseOptions[0] && ps.baseOptions[0].selected && ps.baseOptions[0].selected.code) || ps.defaultVariantId;
          var prefix = (ps.productTypeCategory || {}).id || '';
          var guests = dItems[d].guests || [];
          for (var g = 0; g < guests.length; g++) {
            var guest = guests[g];
            if (guest.orderStatus === 'CANCELLED') continue;
            var pd = guest.priceDetails || {};
            var paid = pd.subtotal || 0, qty = pd.quantity || 1;
            if (!paid) continue;
            var key = guest.id + guest.reservationId + prefix + product;
            if (found[key]) continue;
            found[key] = 1;
            if ((ps.salesUnit === 'PER_NIGHT' || ps.salesUnit === 'PER_DAY') && booking.nights > 0) paid = Math.round(paid / booking.nights * 100) / 100;
            if (qty > 0) paid = Math.round(paid / qty * 100) / 100;
            var item = {
              reservationId: guest.reservationId, passengerId: guest.id, guest: titleCase(guest.firstName || ''),
              prefix: prefix, product: product, paid: paid, currency: pd.currency || currency,
              ageType: String(guest.guestType || 'adult').toLowerCase(), orderCode: order.orderCode,
              orderDate: order.orderDate, isOwner: order.owner !== false, title: ps.title || 'Item', current: null, status: 'checking'
            };
            try {
              var cj = unwrap(await getJson(http, 'GET', API + '/en/' + apiBrand + '/web/commerce-api/catalog/v2/' + booking.ship + '/categories/' + encodeURIComponent(prefix) + '/products/' + encodeURIComponent(product) + '?' +
                qs({ reservationId: item.reservationId, startDate: booking.sailDate, currencyIso: item.currency, passengerId: item.passengerId }), { headers: hdr }));
              item.title = cj.title || item.title;
              var sp = cj.startingFromPrice;
              if (!sp) item.status = 'not-for-sale';
              else {
                item.current = sp[item.ageType + 'PromotionalPrice'] || sp[item.ageType + 'ShipboardPrice'] || null;
                item.promo = cj.promoDescription && cj.promoDescription.displayName || null;
                item.status = item.current && item.current < item.paid ? 'rebook' : 'best';
              }
            } catch (e) { item.status = 'error'; }
            item.cancelUrl = 'https://www.' + auth.line + '.com/account/cruise-planner/order-history?bookingId=' + item.reservationId + '&shipCode=' + booking.ship + '&sailDate=' + booking.sailDate;
            booking.items.push(item);
            if (onProgress) onProgress({ item: item, booking: booking, results: results });
          }
        }
      }
    }
    return results;
  }

  function plannerUrl(shipName, shipCode, sailDate) {
    return isRoyalShip(shipName)
      ? 'https://www.royalcaribbean.com/account/cruise-planner/category/beverage?bookingId=123456&shipCode=' + shipCode + '&sailDate=' + sailDate
      : 'https://www.celebritycruises.com/account/cruise-planner/category/drinks?bookingId=123456&shipCode=' + shipCode + '&sailDate=' + sailDate;
  }

  return {
    ALLOWED_HOSTS: ALLOWED_HOSTS,
    getShips: getShips, getSailings: getSailings, getItinerary: getItinerary,
    getCategories: getCategories, getProducts: getProducts, getCabins: getCabins,
    parseCabins: parseCabins, getRoomOptions: getRoomOptions, parseRoomOptions: parseRoomOptions, bestByKind: bestByKind, combineSplit: combineSplit,
    cabinTypeOf: cabinTypeOf, CABIN_KIND_NAMES: CABIN_KIND_NAMES, planSplits: planSplits, occupanciesFor: occupanciesFor, bestCombos: bestCombos, cabinUrl: cabinUrl, CABIN_HEADERS: CABIN_HEADERS, extractJsonArray: extractJsonArray,
    checkAlert: checkAlert, login: login, checkPurchases: checkPurchases, getProfile: getProfile, discountOpts: discountOpts, discountLabels: discountLabels,
    classifyCategory: classifyCategory, parsePrice: parsePrice, productPrice: productPrice,
    titleCase: titleCase, isRoyalShip: isRoyalShip, SHIP_CLASSES: SHIP_CLASSES, shipClass: shipClass, brandHost: brandHost, plannerUrl: plannerUrl,
    fmtMoney: fmtMoney, fmtSailDate: fmtSailDate, sailDateObj: sailDateObj
  };
});
