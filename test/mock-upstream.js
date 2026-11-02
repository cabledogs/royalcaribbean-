// Fake cruise-line upstream for server tests (MOCK_UPSTREAM=test/mock-upstream.js).
let price = 129;
module.exports = async function (method, url, o) {
  const json = x => ({ status: 200, body: JSON.stringify(x) });
  if (url.includes('/web/v2/ships')) return json({ payload: { ships: [{ shipCode: 'WN', name: 'WONDER OF THE SEAS' }] } });
  if (/voyages$/.test(url)) return json({ payload: { voyages: [{ sailDate: '20270110', voyageDescription: '7 Night Western Caribbean', duration: 7, voyageCode: 'W123' }] } });
  if (/sailDate\/\d+$/.test(url)) return json({ payload: { sailingInfo: [{ itinerary: { events: [{ day: 3, port: { portName: 'Cozumel', portType: 'DOCKED' } }] } }] } });
  if (url.includes('graphql')) {
    const b = JSON.parse(o.body);
    if (b.operationName === 'WebCategories') return json({ data: { categories: { categories: [{ id: 'shorex', name: 'Shore Excursions' }, { id: 'pt_beverage', name: 'Beverage' }] } } });
    const v = b.variables;
    if (v.currentPage > 0) return json({ data: { products: { commerceProducts: [] } } });
    const items = v.category === 'shorex' ? ((v.filter.dayNumber || [])[0] === 3 ? [{ id: '9002', title: 'Mayan Ruins Tour', price: [{ currency: 'USD', formattedPromotionalPrice: '$' + price, salesUnit: { name: 'Per Person' } }] }] : [])
      : [{ id: '3005', title: 'Deluxe Beverage Package', price: [{ currency: 'USD', formattedPromotionalPrice: '$84.99', salesUnit: { name: 'Per Day' } }] }];
    return json({ data: { products: { commerceProducts: items } } });
  }
  if (url.includes('/room-selection/api/v1/rooms')) {
    const b = JSON.parse(o.body);
    if (o.headers.brand !== 'R' || o.headers.country !== 'USA') return { status: 403, body: 'missing brand/country headers' };
    const room = r => ({ request: r, options: { stateroomTypes: [{ name: 'Interior', summary: 'x', connecting: true, categories: [
      { categoryCode: 'T5', image: { alt: 'Surfside Family Interior' }, connecting: b.rooms.length > 1, stateroomsAvailable: 5, pricing: { invoice: { total: 1411.69 } },
        cabins: [{ cabinNumber: '8341', connectingCabin: { cabinNumber: '8343' } }] }] }] } });
    return json({ sailing: {}, rooms: b.rooms.map(room) });
  }
  if (url.includes('/room-selection/')) {
    if (url.includes('r0l=987654321') && url.includes('r0k=FL')) return { status: 200, body: '{"rooms":[{"options":{"stateroomTypes":[{"name":"Interior","stateroomSubtypes":[{"name":"Interior","pricing":{"invoice":{"total":1299}}}]}]}}]}' };
    const conn = { name: 'Interior Connecting', roomsLeft: 4, pricing: { invoice: { total: 1650 } } };
    return { status: 200, body: '0:["$","x",{"rooms":[{"options":{"stateroomTypes":[{"name":"Interior","stateroomSubtypes":[{"name":"Interior","pricing":{"invoice":{"total":1499.5}}},' + JSON.stringify(conn) + ']},{"name":"Balcony","stateroomSubtypes":[{"name":"Balcony","roomsLeft":0,"pricing":{"invoice":{"total":2000}}},{"name":"Balcony Plus","pricing":{"invoice":{"total":2399}}}]}]}}]}]' };
  }
  return { status: 404, body: '' };
};
module.exports.setPrice = p => { price = p; };
