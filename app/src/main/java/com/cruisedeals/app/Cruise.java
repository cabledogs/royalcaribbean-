package com.cruisedeals.app;

import java.net.URLEncoder;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.json.JSONArray;
import org.json.JSONObject;

/** Java port of the parts of core.js the background alert checker needs. */
final class Cruise {
    static final String API = "https://aws-prd.api.rccl.com";
    static final String APPKEY_WEB = "hyNNqIPHHzaLzVpcICPdAdbFV8yvTsAm";
    static final String UA_WEB = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:159.0) Gecko/20100101 Firefox/159.0";

    static final String PRODUCTS_QUERY =
        "query WebProductsByCategory($category: String!, $passengerId: String, $shipCode: ShipCodeScalar!, $sailDate: LocalDateScalar!, "
        + "$reservationId: String, $pageSize: Long, $currentPage: Long, $sorting: Sorting, $filter: FilterInput, $currencyCode: String!) {\n"
        + "  products(category: $category, guestTypes: [ADULT], passengerId: $passengerId, shipCode: $shipCode, sailDate: $sailDate, "
        + "reservationId: $reservationId, pageSize: $pageSize, currentPage: $currentPage, sorting: $sorting, filter: $filter, currencyIso: $currencyCode) {\n"
        + "    ... on CommerceProductResultSuccess {\n"
        + "      commerceProducts {\n"
        + "        id title\n"
        + "        price { currency promotionalPrice shipboardPrice formattedPromotionalPrice formattedBasePrice salesUnit { code name label } }\n"
        + "      }\n"
        + "    }\n"
        + "  }\n"
        + "}";

    private Cruise() {}

    static JSONObject webHeaders(boolean json) throws Exception {
        JSONObject h = new JSONObject();
        h.put("User-Agent", UA_WEB);
        h.put("Accept", "application/json");
        h.put("AppKey", APPKEY_WEB);
        if (json) h.put("Content-Type", "application/json");
        return h;
    }

    /** Same rules as core.js parsePrice. Returns NaN when unparseable. */
    static double parsePrice(Object v) {
        if (v == null || v == JSONObject.NULL) return Double.NaN;
        if (v instanceof Number) return ((Number) v).doubleValue();
        String s = String.valueOf(v).replaceAll("[^0-9.,]", "");
        if (s.length() == 0) return Double.NaN;
        int lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
        if (lastComma > lastDot) {
            if (s.length() - lastComma - 1 == 2) s = s.replace(".", "").replace(',', '.');
            else s = s.replace(",", "");
        } else {
            s = s.replace(",", "");
        }
        try { return Double.parseDouble(s); } catch (NumberFormatException e) { return Double.NaN; }
    }

    static double productPrice(JSONObject product) {
        JSONArray list = product.optJSONArray("price");
        if (list == null || list.length() == 0) return Double.NaN;
        JSONObject p = list.optJSONObject(0);
        if (p == null) return Double.NaN;
        double price = parsePrice(p.opt("formattedPromotionalPrice"));
        if (Double.isNaN(price)) price = parsePrice(p.opt("formattedBasePrice"));
        if (Double.isNaN(price)) price = parsePrice(p.opt("shipboardPrice"));
        return price == 0 ? Double.NaN : price;
    }

    /** Current price of one product, NaN if not for sale. Throws on network failure. */
    static double findProductPrice(String ship, String sailDate, String category, String day, String productId, String currency) throws Exception {
        JSONObject vars = new JSONObject();
        vars.put("category", category);
        vars.put("passengerId", "");
        vars.put("shipCode", ship);
        vars.put("sailDate", sailDate);
        vars.put("reservationId", "000000");
        vars.put("pageSize", 12);
        JSONObject sorting = new JSONObject();
        sorting.put("sortKey", "RANK");
        sorting.put("sortKeyOrder", "ASCENDING");
        vars.put("sorting", sorting);
        JSONObject filter = new JSONObject();
        filter.put("includeVariantProducts", false);
        if (day != null && day.length() > 0 && !"all".equals(day)) filter.put("dayNumber", new JSONArray().put(Integer.parseInt(day)));
        vars.put("filter", filter);
        vars.put("currencyCode", currency == null || currency.length() == 0 ? "USD" : currency);
        vars.put("includeFilterInfo", false);
        vars.put("includeIfABexperience", false);
        for (int page = 0; page < 60; page++) {
            vars.put("currentPage", page);
            JSONObject body = new JSONObject();
            body.put("operationName", "WebProductsByCategory");
            body.put("variables", vars);
            body.put("query", PRODUCTS_QUERY);
            Net.Result r = Net.request("POST", API + "/en/royal/web/graphql", webHeaders(true), body.toString());
            if (r.status != 200) {
                if (page == 0) throw new Exception("Server returned " + r.status);
                break;
            }
            JSONObject j = new JSONObject(r.body);
            JSONObject data = j.optJSONObject("data");
            JSONObject products = data == null ? null : data.optJSONObject("products");
            JSONArray items = products == null ? null : products.optJSONArray("commerceProducts");
            if (items == null || items.length() == 0) break;
            for (int i = 0; i < items.length(); i++) {
                JSONObject p = items.optJSONObject(i);
                if (p != null && productId.equals(p.optString("id"))) return productPrice(p);
            }
        }
        return Double.NaN;
    }

    /* ---------- cabins ---------- */

    static String enc(String s) throws Exception { return URLEncoder.encode(s, "UTF-8"); }

    static String cabinUrl(JSONObject o) throws Exception {
        String d = o.optString("sailDate");
        String pkg = o.optString("packageCode");
        String host = o.optString("host", "www.royalcaribbean.com");
        if (!"www.royalcaribbean.com".equals(host) && !"www.celebritycruises.com".equals(host)) host = "www.royalcaribbean.com";
        String cur = o.optString("currency", "USD");
        StringBuilder sb = new StringBuilder("https://").append(host).append("/room-selection/type-and-subtype?");
        sb.append("packageCode=").append(enc(pkg));
        sb.append("&sailDate=").append(enc(d.substring(0, 4) + "-" + d.substring(4, 6) + "-" + d.substring(6, 8)));
        sb.append("&country=USA&selectedCurrencyCode=").append(enc(cur));
        sb.append("&shipCode=").append(enc(pkg.length() >= 2 ? pkg.substring(0, 2) : pkg));
        sb.append("&cabinClassType=INTERIOR&roomIndex=0");
        sb.append("&r0a=").append(o.optInt("adults", 2));
        sb.append("&r0c=").append(o.optInt("children", 0));
        sb.append("&r0b=n&r0r=n&r0s=n&r0q=n&r0t=n&r0d=INTERIOR&r0D=y&rgVisited=true&r0C=y");
        return sb.toString();
    }

    /** Bracket-counting extractor, same as _extract_json_array in the Python script. */
    static JSONArray extractJsonArray(String text, String key) {
        Matcher m = Pattern.compile("\"" + Pattern.quote(key) + "\"\\s*:\\s*\\[").matcher(text);
        if (!m.find()) return null;
        int start = m.end() - 1, depth = 0;
        boolean inStr = false, esc = false;
        for (int i = start; i < text.length(); i++) {
            char ch = text.charAt(i);
            if (esc) esc = false;
            else if (ch == '\\' && inStr) esc = true;
            else if (ch == '"') inStr = !inStr;
            else if (!inStr) {
                if (ch == '[') depth++;
                else if (ch == ']') {
                    depth--;
                    if (depth == 0) {
                        try { return new JSONArray(text.substring(start, i + 1)); } catch (Exception e) { return null; }
                    }
                }
            }
        }
        return null;
    }

    /** [{name, price|null}] - empty when sold out. Throws on network failure. */
    static JSONArray cabins(JSONObject o) throws Exception {
        JSONObject h = new JSONObject();
        h.put("User-Agent", UA_WEB);
        h.put("Accept", "text/x-component");
        h.put("Accept-Language", "en-US,en;q=0.9");
        h.put("RSC", "1");
        Net.Result r = Net.request("GET", cabinUrl(o), h, null);
        if (r.status != 200) throw new Exception("Could not retrieve cabin prices (" + r.status + ")");
        JSONArray out = new JSONArray();
        JSONArray rooms = extractJsonArray(r.body, "rooms");
        if (rooms == null || rooms.length() == 0) return out;
        JSONObject first = rooms.optJSONObject(0);
        JSONObject options = first == null ? null : first.optJSONObject("options");
        JSONArray types = options == null ? null : options.optJSONArray("stateroomTypes");
        if (types == null) return out;
        for (int i = 0; i < types.length(); i++) {
            JSONObject t = types.optJSONObject(i);
            if (t == null) continue;
            double cheapest = Double.NaN, conn = Double.NaN;
            String connName = "";
            JSONArray subtypes = new JSONArray();
            JSONArray subs = t.optJSONArray("stateroomSubtypes");
            if (subs != null) for (int k = 0; k < subs.length(); k++) {
                JSONObject st = subs.optJSONObject(k);
                if (st == null) continue;
                JSONObject pricing = st.optJSONObject("pricing");
                JSONObject invoice = pricing == null ? null : pricing.optJSONObject("invoice");
                Object left = st.opt("roomsLeft");
                boolean soldOut = left instanceof Number && ((Number) left).intValue() == 0;
                double total = invoice != null && invoice.opt("total") instanceof Number && !soldOut ? invoice.optDouble("total") : Double.NaN;
                String name = st.opt("name") instanceof String ? st.optString("name") : "";
                boolean connecting = name.toLowerCase(java.util.Locale.US).contains("connect");
                JSONObject so = new JSONObject();
                so.put("name", name);
                so.put("price", Double.isNaN(total) ? JSONObject.NULL : (Object) Double.valueOf(total));
                so.put("roomsLeft", left instanceof Number ? left : JSONObject.NULL);
                so.put("guarantee", st.optBoolean("guarantee", false));
                so.put("connecting", connecting);
                subtypes.put(so);
                if (Double.isNaN(total)) continue;
                if (Double.isNaN(cheapest) || total < cheapest) cheapest = total;
                if (connecting && (Double.isNaN(conn) || total < conn)) { conn = total; connName = name; }
            }
            JSONObject c = new JSONObject();
            c.put("name", t.optString("name", "Stateroom"));
            c.put("price", Double.isNaN(cheapest) ? JSONObject.NULL : (Object) Double.valueOf(cheapest));
            c.put("connectingPrice", Double.isNaN(conn) ? JSONObject.NULL : (Object) Double.valueOf(conn));
            c.put("connectingName", connName);
            c.put("subtypes", subtypes);
            out.put(c);
        }
        return out;
    }
}
