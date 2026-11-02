package com.cruisedeals.app;

import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Whole-cruise alerts for background checks: the cheapest price on one sailing for a cabin type.
 * Same rules as cruisePrice / getRoomOptions / combineSplit in core.js.
 *   split "2/0" = one cabin; "2/1,2/1" = rooms booked together in the same room type.
 */
final class CruiseAlert {
    private CruiseAlert() {}

    static String cabinTypeOf(String name) {
        String n = String.valueOf(name).toLowerCase(Locale.US);
        if (n.matches(".*(suite|loft|haven|retreat|villa).*")) return "suite";
        if (n.matches(".*(balcon|veranda|aquaclass|concierge).*")) return "balcony";
        if (n.matches(".*(ocean|outside|panoramic|porthole|window).*")) return "ocean";
        if (n.matches(".*(interior|inside).*")) return "interior";
        return "other";
    }

    static String kindOfType(String code, String name) {
        switch (String.valueOf(code).toUpperCase(Locale.US)) {
            case "INTERIOR": return "interior";
            case "OUTSIDE": case "OCEANVIEW": return "ocean";
            case "BALCONY": case "VERANDA": case "CONCIERGE": case "AQUA": return "balcony";
            case "DELUXE": case "SUITE": return "suite";
            default: return cabinTypeOf(name);
        }
    }

    static int[][] parseSplit(String s) {
        String[] parts = String.valueOf(s).split(",");
        int[][] out = new int[parts.length][];
        int n = 0;
        for (String p : parts) {
            String[] ac = p.split("/");
            try {
                int a = Integer.parseInt(ac[0].trim()), c = ac.length > 1 ? Integer.parseInt(ac[1].trim()) : 0;
                if (a > 0) out[n++] = new int[] { a, c };
            } catch (Exception ignored) { /* skip */ }
        }
        int[][] r = new int[n][];
        System.arraycopy(out, 0, r, 0, n);
        return r;
    }

    /** cheapest price (NaN when nothing fits) */
    static double price(JSONObject a) throws Exception {
        int[][] rooms = parseSplit(a.optString("split"));
        if (rooms.length == 0) throw new Exception("Alert has no guests");
        String want = a.optString("kind", "any");
        double best = Double.NaN;
        if (rooms.length == 1) {
            JSONObject o = new JSONObject(a.toString());
            o.put("adults", rooms[0][0]);
            o.put("children", rooms[0][1]);
            JSONArray rows = Cruise.cabins(o);
            for (int i = 0; i < rows.length(); i++) {
                JSONObject r = rows.getJSONObject(i);
                if (r.isNull("price")) continue;
                if (!"any".equals(want) && !want.equals(cabinTypeOf(r.optString("name")))) continue;
                double p = r.getDouble("price");
                if (Double.isNaN(best) || p < best) best = p;
            }
            return best;
        }
        String[] start = startingCategory(a, rooms[0]);
        JSONArray first = roomOptions(a, rooms, start);
        Map<String, JSONArray> byOcc = new HashMap<>();
        byOcc.put(rooms[0][0] + "/" + rooms[0][1], first);
        for (int i = 1; i < rooms.length; i++) {
            String key = rooms[i][0] + "/" + rooms[i][1];
            if (byOcc.containsKey(key)) continue;
            int[][] order = new int[rooms.length][];
            order[0] = rooms[i];
            for (int j = 0, k = 1; j < rooms.length; j++) if (j != i) order[k++] = rooms[j];
            byOcc.put(key, roomOptions(a, order, start));
        }
        return combine(rooms, first, byOcc, a.optBoolean("connecting", false), want);
    }

    /** cheapest total over room types offered for every room (same type in each room) */
    static double combine(int[][] rooms, JSONArray first, Map<String, JSONArray> byOcc, boolean connectingOnly, String want) throws Exception {
        double best = Double.NaN;
        for (int i = 0; i < first.length(); i++) {
            JSONObject o = first.getJSONObject(i);
            if (connectingOnly && !o.optBoolean("connecting")) continue;
            if (!"any".equals(want) && !want.equals(o.optString("kind"))) continue;
            double total = 0;
            boolean all = true;
            for (int[] r : rooms) {
                JSONArray list = byOcc.get(r[0] + "/" + r[1]);
                double p = Double.NaN;
                if (list != null) for (int k = 0; k < list.length(); k++) {
                    JSONObject x = list.getJSONObject(k);
                    if (x.optString("code").equals(o.optString("code"))) p = x.getDouble("price");
                }
                if (Double.isNaN(p)) { all = false; break; }
                total += p;
            }
            if (!all) continue;
            total = Math.round(total * 100) / 100.0;
            if (Double.isNaN(best) || total < best) best = total;
        }
        return best;
    }

    /** {typeCode, subtypeCode}: a for-sale category to start the rooms request from (prefer interior, non-guarantee) */
    static String[] startingCategory(JSONObject a, int[] room0) throws Exception {
        JSONObject o = new JSONObject(a.toString());
        o.put("adults", room0[0]);
        o.put("children", room0[1]);
        JSONArray rows = Cruise.cabins(o);
        String[] order = { "interior", "ocean", "balcony", "suite", "other" };
        for (int pass = 0; pass < 2; pass++) {
            for (String kind : order) {
                for (int i = 0; i < rows.length(); i++) {
                    JSONObject row = rows.getJSONObject(i);
                    if (!kind.equals(cabinTypeOf(row.optString("name")))) continue;
                    JSONArray subs = row.optJSONArray("subtypes");
                    if (subs == null) continue;
                    for (int k = 0; k < subs.length(); k++) {
                        JSONObject st = subs.getJSONObject(k);
                        if (st.optString("code").isEmpty() || st.isNull("price")) continue;
                        if (pass == 0 && st.optBoolean("guarantee")) continue;
                        String code = row.optString("code");
                        String typeCode = code.matches("[A-Z]{3,}") ? code
                            : "ocean".equals(kind) ? "OUTSIDE" : "balcony".equals(kind) ? "BALCONY" : "suite".equals(kind) ? "DELUXE" : "INTERIOR";
                        return new String[] { typeCode, st.optString("code") };
                    }
                }
            }
        }
        throw new Exception("This sailing looks sold out");
    }

    /** POST the rooms service; returns room 1's options [{code, kind, price, connecting}] */
    static JSONArray roomOptions(JSONObject a, int[][] rooms, String[] start) throws Exception {
        String d = a.optString("sailDate");
        boolean royal = !a.optString("host", "www.royalcaribbean.com").contains("celebrity");
        JSONObject body = new JSONObject();
        body.put("countryCode", "USA");
        body.put("packageId", a.optString("packageCode"));
        body.put("sailDate", d.substring(0, 4) + "-" + d.substring(4, 6) + "-" + d.substring(6, 8));
        body.put("currencyCode", a.optString("currency", "USD"));
        body.put("language", "en");
        body.put("options", true);
        body.put("roomNumbers", true);
        body.put("platform", "web");
        JSONArray rs = new JSONArray();
        for (int[] r : rooms) {
            JSONObject q = new JSONObject();
            q.put("fireFighter", a.optBoolean("fire"));
            q.put("military", a.optBoolean("military"));
            q.put("police", a.optBoolean("police"));
            q.put("senior", a.optBoolean("senior"));
            JSONObject x = new JSONObject();
            x.put("adultCount", r[0]);
            x.put("childCount", r[1]);
            x.put("stateroomTypeCode", start[0]);
            x.put("stateroomSubtypeCode", start[1]);
            x.put("accessible", false);
            x.put("selectionFallbackStrategy", "RECOMMENDATION");
            x.put("editMode", true);
            x.put("reset", false);
            x.put("taxesAndFeesBundled", true);
            x.put("qualifiers", q);
            rs.put(x);
        }
        body.put("rooms", rs);
        JSONObject h = new JSONObject();
        h.put("User-Agent", Cruise.UA_WEB);
        h.put("Accept", "*/*");
        h.put("Content-Type", "application/json");
        h.put("brand", royal ? "R" : "C");
        h.put("country", "USA");
        Net.Result res = Net.request("POST", "https://" + (royal ? "www.royalcaribbean.com" : "www.celebritycruises.com") + "/room-selection/api/v1/rooms", h, body.toString());
        if (res.status != 200) throw new Exception("Could not get room options (" + res.status + ")");
        return parseOptions(res.body);
    }

    static JSONArray parseOptions(String bodyText) throws Exception {
        JSONObject j = new JSONObject(bodyText);
        JSONArray out = new JSONArray();
        JSONArray roomsOut = j.optJSONArray("rooms");
        JSONObject r0 = roomsOut == null ? null : roomsOut.optJSONObject(0);
        JSONObject opts = r0 == null ? null : r0.optJSONObject("options");
        JSONArray types = opts == null ? null : opts.optJSONArray("stateroomTypes");
        if (types == null) return out;
        for (int i = 0; i < types.length(); i++) {
            JSONObject t = types.optJSONObject(i);
            if (t == null) continue;
            String kind = kindOfType(t.optString("code"), t.optString("name"));
            JSONArray subs = t.optJSONArray("stateroomSubtypes");
            if (subs == null) continue;
            for (int k = 0; k < subs.length(); k++) {
                JSONObject st = subs.optJSONObject(k);
                if (st == null) continue;
                JSONObject pricing = st.optJSONObject("pricing");
                JSONObject inv = pricing == null ? null : pricing.optJSONObject("invoice");
                if (inv == null || !(inv.opt("total") instanceof Number)) continue;
                Object avail = st.has("stateroomsAvailable") ? st.opt("stateroomsAvailable") : st.opt("roomsLeft");
                if (avail instanceof Number && ((Number) avail).intValue() == 0) continue;
                JSONObject o = new JSONObject();
                o.put("code", st.optString("code", st.optString("categoryCode")));
                o.put("kind", "other".equals(kind) ? cabinTypeOf(st.optString("name")) : kind);
                o.put("price", inv.optDouble("total"));
                o.put("connecting", st.optBoolean("connecting", false));
                out.put(o);
            }
        }
        return out;
    }
}
