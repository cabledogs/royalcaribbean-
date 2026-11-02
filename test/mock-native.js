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
  // rooms service, shaped like the real reply (from royalcaribbean.com's room-selection page):
  // only rooms[0] carries options, priced for rooms[0]'s guests; connecting flags apply to the group
  function roomsReply(body) {
    var b = JSON.parse(body), multi = b.rooms.length > 1, r0 = b.rooms[0], n = r0.adultCount + r0.childCount;
    function sub(code, name, base, conn, pairs, avail, guarantee) {
      var amt = Math.round(base * (1 + 0.35 * (n - 2)) * 100) / 100;
      var o = { code: code, name: name, guarantee: !!guarantee, categoryCode: code, connecting: !!(conn && multi), pricing: { invoice: { total: amt } },
        image: { alt: name }, stateroomsAvailable: avail === undefined ? 10 : avail };
      if (conn && multi && pairs) o.cabins = pairs.map(function (p) { return { cabinNumber: p[0], connectingCabin: { cabinNumber: p[1] } }; });
      return o;
    }
    return { sailing: { sailDate: b.sailDate }, rooms: b.rooms.map(function (r, i) {
      if (i > 0) return { request: { adultCount: r.adultCount, childCount: r.childCount, editMode: false, reset: true }, room: {} };
      return { request: r, room: { code: 'ZQ' },
        options: { stateroomTypes: [
          { code: 'INTERIOR', name: 'Interior', summary: 'Our Interior rooms', connecting: multi, stateroomSubtypes: [sub('ZQ', 'Interior Quad Guarantee', 1300, false, null, 10, true), sub('T5', 'Surfside Family Interior', 1490, true, [['8341', '8343'], ['8721', '8723']])] },
          { code: 'OUTSIDE', name: 'Ocean View', summary: 'Soak in', connecting: multi, stateroomSubtypes: [sub('YQ', 'Ocean View Quad Guarantee', 1600, false, null, 10, true), sub('N5', 'Ocean View', 1750, true, [['9101', '9103']])] },
          { code: 'BALCONY', name: 'Balcony', summary: 'Fresh air', connecting: false, stateroomSubtypes: [sub('XQ', 'Balcony Guarantee', 2100, false, null, 10, true), sub('XB', 'Balcony', 2300, false, null, 0)] },
          { code: 'DELUXE', name: 'Suite', summary: 'Suites', connecting: false, stateroomSubtypes: n > 4 ? [] : [sub('J4', 'Junior Suite', 4100, false)] }
        ] } };
    }) };
  }
  function respond(method, url, body) {
    if (url.indexOf('/room-selection/api/v1/rooms') > 0) {
      var rb = JSON.parse(body);
      (window.__roomCalls = window.__roomCalls || []).push(rb);
      // like the real service: 400 without a starting category
      if (!rb.rooms.every(function (r) { return r.stateroomSubtypeCode && r.stateroomTypeCode; })) return { __status: 400, error: 'stateroomSubtypeCode is required' };
      return roomsReply(body);
    }
    if (url.indexOf('/room-selection/type-and-subtype') > 0) {
      return { __raw: '0:["$","x",{"rooms":[{"options":{"stateroomTypes":[{"code":"INTERIOR","name":"Interior","stateroomSubtypes":[{"code":"ZQ","name":"Interior","guarantee":true,"pricing":{"invoice":{"total":1300}}},{"code":"T5","name":"Surfside Family Interior","pricing":{"invoice":{"total":1490}}}]}]}}]}]' };
    }
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
      setTimeout(function () {
        var r = respond(method, url, body);
        if (r && r.__raw) return window.__nativeCb(id, 200, r.__raw);
        if (r && r.__status) return window.__nativeCb(id, r.__status, JSON.stringify(r));
        window.__nativeCb(id, r ? 200 : 404, r ? JSON.stringify(r) : 'nope');
      }, 20);
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
