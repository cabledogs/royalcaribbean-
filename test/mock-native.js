// Fake window.Native for UI tests: answers like the real cruise line APIs.
(function () {
  var alerts = '[]';
  function product(id, title, price, unit) {
    return { id: id, title: title, variantOptions: [], price: [{ currency: 'USD', formattedPromotionalPrice: '$' + price.toFixed(2), formattedBasePrice: '$' + (price * 1.2).toFixed(2), shipboardPrice: price * 1.3, salesUnit: { name: unit || 'Per Person' } }] };
  }
  var catalog = {
    pt_beverage: [product('3005', 'Deluxe Beverage Package', 84.99, 'Per Day'), product('3006', 'Refreshment Package', 39.99, 'Per Day'), product('3010', 'Evian Water 12 Bottles', 28)],
    pt_internet: [product('5001', 'VOOM Surf + Stream - 1 Device', 21.99, 'Per Day')],
    dining: [product('7001', 'Unlimited Dining Package', 299), product('7002', 'Chops Grille Dinner', 64.99)],
    shorex: [product('9001', 'Cozumel Beach Break', 79), product('9002', 'Mayan Ruins Tour', 129)]
  };
  // rooms service, shaped like the real reply captured by tools/probe-connecting.js
  function roomsReply(body) {
    var b = JSON.parse(body);
    function cat(code, alt, base, conn, n, pairs, avail) {
      var f = 1 + 0.35 * (n - 2), amt = Math.round(base * f * 100) / 100;
      var cabins = conn && b.rooms.length > 1 ? pairs.map(function (p) { return { cabinNumber: p[0], positionCode: 'AF', connectingCabin: { cabinNumber: p[1], positionCode: 'AF' } }; }) : [];
      return { pricing: { invoice: { total: amt }, amount: amt }, categoryCode: code, fareCode: 'CG1', connecting: conn && b.rooms.length > 1, image: { alt: alt }, stateroomsAvailable: avail === undefined ? 10 : avail, cabins: cabins };
    }
    return { sailing: { sailDate: b.sailDate }, rooms: b.rooms.map(function (r) {
      var n = r.adultCount + r.childCount;
      return { request: r, room: { stateroomType: { name: 'Interior' }, categoryCode: 'ZQ', pricing: { invoice: { total: 1 } } },
        options: { stateroomTypes: [
          { name: 'Interior', summary: 'Our Interior rooms', connecting: true, categories: [cat('ZQ', 'Interior Quad Guarantee', 1300, false, n), cat('T5', 'Surfside Family Interior', 1490, true, n, [['8341', '8343'], ['8343', '8341'], ['8721', '8723']])] },
          { name: 'Ocean View', summary: 'Soak in', connecting: true, categories: [cat('YQ', 'Ocean View Quad Guarantee', 1600, false, n), cat('N5', 'Ocean View', 1750, true, n, [['9101', '9103']])] },
          { name: 'Balcony', summary: 'Fresh air', connecting: false, categories: [cat('XQ', 'Balcony Guarantee', 2100, false, n), cat('XB', 'Balcony', 2300, false, n, [], 0)] },
          { name: 'Suite', summary: 'Suites', connecting: false, categories: n > 4 ? [] : [cat('J4', 'Junior Suite', 4100, false, n)] }
        ] } };
    }) };
  }
  function respond(method, url, body) {
    if (url.indexOf('/room-selection/api/v1/rooms') > 0) { (window.__roomCalls = window.__roomCalls || []).push(JSON.parse(body)); return roomsReply(body); }
    if (url.indexOf('/auth/oauth2/access_token') > 0) return { access_token: 'x.' + btoa(JSON.stringify({ sub: 'acct42' })) + '.y' };
    if (url.indexOf('/guestAccounts/acct42') > 0) return { payload: { loyaltyInformation: { crownAndAnchorId: '987654321', crownAndAnchorSocietyLoyaltyTier: 'DIAMOND', crownAndAnchorSocietyLoyaltyIndividualPoints: 93 }, contactInformation: { address: { residencyCountryCode: 'USA', state: 'FL' } } } };
    if (url.indexOf('/profileBookings/enriched/acct42') > 0) return { payload: { profileBookings: [] } };
    if (url.indexOf('/mobile/v2/ships') > 0) return { payload: { ships: [] } };
    if (url.indexOf('/web/v2/ships') > 0) return { payload: { ships: [{ shipCode: 'WN', name: 'WONDER OF THE SEAS' }, { shipCode: 'IC', name: 'ICON OF THE SEAS' }, { shipCode: 'BY', name: 'CELEBRITY BEYOND' }] } };
    if (/voyages$/.test(url)) return { payload: { voyages: [{ sailDate: '20270110', voyageDescription: '7 Night Western Caribbean', duration: 7, voyageCode: 'W123' }, { sailDate: '20270215', voyageDescription: '4 Night Bahamas & Perfect Day', duration: 4, voyageCode: 'W456' }] } };
    if (/sailDate\/\d+$/.test(url)) return { payload: { sailingInfo: [{ itinerary: { events: [{ day: 1, port: { portName: 'Port Canaveral', portType: 'EMBARK', departureDateTime: '20270110T1600' } }, { day: 2, port: { portName: 'Cruising', portType: 'CRUISING' } }, { day: 3, port: { portName: 'Cozumel', portType: 'DOCKED', arrivalDateTime: '20270112T0800', departureDateTime: '20270112T1700' } }, { day: 5, port: { portName: 'Roatan', portType: 'DOCKED', arrivalDateTime: '20270114T0800', departureDateTime: '20270114T1700' } }] } }] } };
    if (url.indexOf('graphql') > 0) {
      var b = JSON.parse(body);
      if (b.operationName === 'WebCategories') return { data: { categories: { categories: [{ id: 'pt_beverage', name: 'Beverage' }, { id: 'pt_internet', name: 'Internet' }, { id: 'dining', name: 'Dining' }, { id: 'shorex', name: 'Shore Excursions' }, { id: 'pt_spa', name: 'Spa' }] } } };
      var v = b.variables, items = catalog[v.category] || [];
      if (v.category === 'shorex') { var dn = (v.filter.dayNumber || [0])[0]; items = dn === 3 ? items : dn === 5 ? [product('9101', 'Roatan Zipline Canopy Adventure', 99), product('9102', 'Little French Key Beach Day', 119)] : []; }
      return { data: { products: { commerceProducts: v.currentPage === 0 ? items : [] } } };
    }
    return null;
  }
  window.Native = {
    http: function (id, method, url, headers, body) {
      setTimeout(function () { var r = respond(method, url, body); window.__nativeCb(id, r ? 200 : 404, r ? JSON.stringify(r) : 'nope'); }, 20);
    },
    cabinPrices: function (id, opts) {
      var o = JSON.parse(opts), n = o.adults + o.children, f = (1 + 0.35 * (n - 2)) * (o.loyaltyNumber ? 0.9 : 1) * (o.state === 'FL' ? 0.95 : 1);
      (window.__cabinOpts = window.__cabinOpts || []).push(o);
      function row(name, p, cp) {
        var subs = [{ name: name, code: name.slice(0, 1), price: p === null ? null : Math.round(p * f), roomsLeft: 9, guarantee: false, connecting: false, flags: [] }];
        if (cp) subs.push({ name: name + ' Connecting', code: 'C' + name.slice(0, 1), price: Math.round(cp * f), roomsLeft: 2, guarantee: false, connecting: true, flags: [] });
        return { name: name, price: p === null ? null : Math.round(p * f), connectingPrice: cp ? Math.round(cp * f) : null, connectingName: cp ? name + ' Connecting' : '', subtypes: subs };
      }
      var rows = n > 4 ? [row('Suite', 5200, null)] : [row('Interior', 1499.5, 1650), row('Ocean View', 1899, null), row('Balcony', 2399, 2550), row('Suite', null, null)];
      setTimeout(function () { window.__nativeCb(id, 200, JSON.stringify(rows)); }, 20);
    },
    getAlerts: function () { return alerts; },
    saveAlerts: function (j) { alerts = j; },
    checkAlertsNow: function (id) {
      var a = JSON.parse(alerts); a.forEach(function (x) { x.lastPrice = x.initialPrice - 10; x.status = 'dropped'; x.lastChecked = new Date().toISOString(); });
      alerts = JSON.stringify(a); setTimeout(function () { window.__nativeCb(id, 200, alerts); }, 20);
    },
    getBackgroundSettings: function () { return JSON.stringify(window.__bg || { background: false, hours: 12 }); },
    setBackgroundChecks: function (on, hours) { window.__bg = { background: on, hours: hours }; },
    openUrl: function (u) { window.__opened = u; }
  };
})();
