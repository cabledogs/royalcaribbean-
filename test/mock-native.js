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
  function respond(method, url, body) {
    if (url.indexOf('/web/v2/ships') > 0) return { payload: { ships: [{ shipCode: 'WN', name: 'WONDER OF THE SEAS' }, { shipCode: 'IC', name: 'ICON OF THE SEAS' }, { shipCode: 'BY', name: 'CELEBRITY BEYOND' }] } };
    if (/voyages$/.test(url)) return { payload: { voyages: [{ sailDate: '20270110', voyageDescription: '7 Night Western Caribbean', duration: 7, voyageCode: 'W123' }, { sailDate: '20270215', voyageDescription: '4 Night Bahamas & Perfect Day', duration: 4, voyageCode: 'W456' }] } };
    if (/sailDate\/\d+$/.test(url)) return { payload: { sailingInfo: [{ itinerary: { events: [{ day: 1, port: { portName: 'Port Canaveral', portType: 'EMBARK', departureDateTime: '20270110T1600' } }, { day: 2, port: { portName: 'Cruising', portType: 'CRUISING' } }, { day: 3, port: { portName: 'Cozumel', portType: 'DOCKED', arrivalDateTime: '20270112T0800', departureDateTime: '20270112T1700' } }] } }] } };
    if (url.indexOf('graphql') > 0) {
      var b = JSON.parse(body);
      if (b.operationName === 'WebCategories') return { data: { categories: { categories: [{ id: 'pt_beverage', name: 'Beverage' }, { id: 'pt_internet', name: 'Internet' }, { id: 'dining', name: 'Dining' }, { id: 'shorex', name: 'Shore Excursions' }, { id: 'pt_spa', name: 'Spa' }] } } };
      var v = b.variables, items = catalog[v.category] || [];
      if (v.category === 'shorex') items = (v.filter.dayNumber || [0])[0] === 3 ? items : [];
      return { data: { products: { commerceProducts: v.currentPage === 0 ? items : [] } } };
    }
    return null;
  }
  window.Native = {
    http: function (id, method, url, headers, body) {
      setTimeout(function () { var r = respond(method, url, body); window.__nativeCb(id, r ? 200 : 404, r ? JSON.stringify(r) : 'nope'); }, 20);
    },
    cabinPrices: function (id, opts) {
      var o = JSON.parse(opts), n = o.adults + o.children, f = 1 + 0.35 * (n - 2);
      function row(name, p, cp) { return { name: name, price: p === null ? null : Math.round(p * f), connectingPrice: cp ? Math.round(cp * f) : null, connectingName: cp ? name + ' Connecting' : '' }; }
      var rows = n > 4 ? [row('Suite', 5200, null)] : [row('Interior', 1499.5, 1650), row('Ocean View', 1899, null), row('Balcony', 2399, 2550), row('Suite', null, null)];
      setTimeout(function () { window.__nativeCb(id, 200, JSON.stringify(rows)); }, 20);
    },
    getAlerts: function () { return alerts; },
    saveAlerts: function (j) { alerts = j; },
    checkAlertsNow: function (id) {
      var a = JSON.parse(alerts); a.forEach(function (x) { x.lastPrice = x.initialPrice - 10; x.status = 'dropped'; x.lastChecked = new Date().toISOString(); });
      alerts = JSON.stringify(a); setTimeout(function () { window.__nativeCb(id, 200, alerts); }, 20);
    },
    getBackgroundSettings: function () { return '{"background":false,"hours":12}'; },
    setBackgroundChecks: function () {},
    openUrl: function (u) { window.__opened = u; }
  };
})();
