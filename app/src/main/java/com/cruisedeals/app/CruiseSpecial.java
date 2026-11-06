package com.cruisedeals.app;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONObject;

/**
 * Royal specials watcher for background checks (bonus points, gift card deals, or your own words on a
 * Royal / Celebrity page). Same rules as checkSpecial in core.js: alerts only for sentences not seen before.
 */
final class CruiseSpecial {
    private CruiseSpecial() {}

    static final Pattern POINTS = Pattern.compile(
        "\\b(double|triple|2x|3x|2 x|3 x|twice the|bonus|extra)\\s+(crown\\s*(?:&|and|&amp;)\\s*anchor\\s+)?(cruise\\s+)?points\\b|\\bpoints?\\s+multiplier\\b",
        Pattern.CASE_INSENSITIVE);
    static final Pattern GIFTCARDS = Pattern.compile(
        "gift\\s*cards?\\b[^.!?]{0,120}?(\\d{1,2}\\s?%|\\$\\d+\\s+bonus|\\bbonus\\b|\\bsave\\b|\\bsale\\b|\\bdiscount|\\boff\\b)|(\\d{1,2}\\s?%\\s*off|\\bbonus\\b|\\bsale\\b|\\bsave\\b)[^.!?]{0,80}?gift\\s*cards?\\b",
        Pattern.CASE_INSENSITIVE);

    static String title(JSONObject a) {
        String s = a.optString("special");
        if ("points".equals(s)) return "Bonus Crown & Anchor points (2x, double, bonus points)";
        if ("giftcards".equals(s)) return "Royal gift card deals (bonus, % off, sale)";
        return a.optString("title", "Special");
    }

    static List<String> urls(JSONObject a) {
        String s = a.optString("special");
        if ("points".equals(s)) return Arrays.asList("https://www.royalcaribbean.com/cruise-deals", "https://www.royalcaribbean.com/crown-and-anchor-society");
        if ("giftcards".equals(s)) return Arrays.asList("https://www.royalcaribbean.com/gift-cards", "https://www.royalcaribbean.com/cruise-deals");
        List<String> out = new ArrayList<>();
        for (String u : a.optString("urls").split("\\|")) {
            if (u.matches("https://www\\.(royalcaribbean|celebritycruises)\\.com(/[^\\s@]*)?") && out.size() < 3) out.add(u);
        }
        return out;
    }

    static Pattern pattern(JSONObject a) {
        String s = a.optString("special");
        if ("points".equals(s)) return POINTS;
        if ("giftcards".equals(s)) return GIFTCARDS;
        List<String> words = new ArrayList<>();
        for (String w : a.optString("keywords").split(",")) {
            w = w.trim();
            if (w.length() > 60) w = w.substring(0, 60);
            if (!w.isEmpty() && words.size() < 10) words.add(Pattern.quote(w).replace(" ", "\\E\\s+\\Q"));
        }
        if (words.isEmpty()) return null;
        return Pattern.compile("\\b(" + String.join("|", words) + ")\\b", Pattern.CASE_INSENSITIVE);
    }

    static String pageText(String html) {
        return String.valueOf(html)
            .replace("\\u0026", "&").replace("\\u003c", "<").replace("\\u003e", ">").replace("\\n", " ").replace("\\t", " ").replace("\\\"", "\"")
            .replaceAll("(?is)<style.*?</style>", " ").replaceAll("<[^>]+>", " ")
            .replace("&amp;", "&").replace("&nbsp;", " ").replace("&#39;", "'").replace("&rsquo;", "'").replace("&quot;", "\"").replaceAll("(?i)&[a-z]+;", " ")
            .replaceAll("\\s+", " ");
    }

    static List<String> snippets(String text, Pattern re) {
        List<String> out = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        Matcher m = re.matcher(text);
        int n = 0;
        while (m.find() && n++ < 200) {
            if (m.group().isEmpty()) continue;
            int start = Math.max(Math.max(text.lastIndexOf(". ", m.start()), text.lastIndexOf('"', m.start())), Math.max(text.lastIndexOf('>', m.start()), m.start() - 120));
            int end = m.end();
            String tail = text.substring(end, Math.min(text.length(), end + 160));
            Matcher stop = Pattern.compile("[.!?\"<]").matcher(tail);
            end = stop.find() ? end + stop.start() + 1 : Math.min(text.length(), end + 120);
            String sn = text.substring(Math.max(0, start + 1), Math.min(text.length(), end))
                .replaceAll("^[^A-Za-z0-9$]+", "").replaceAll("[\\s,;:\"]+$", "").trim();
            if (sn.length() < 8 || sn.matches(".*([{}\\\\]|function\\s*\\(|=>).*")) continue;
            String key = norm(sn);
            if (!seen.add(key)) continue;
            out.add(sn.length() > 220 ? sn.substring(0, 220) : sn);
            if (out.size() >= 6) break;
        }
        return out;
    }

    static String norm(String s) { return s.toLowerCase(Locale.US).replaceAll("[^a-z0-9%$]+", " ").trim(); }

    /** same short key as snippetKey() in core.js */
    static String key(String s) {
        String k = norm(s);
        int h = 0;
        for (int i = 0; i < k.length(); i++) h = h * 31 + k.charAt(i);
        return Long.toString(h & 0xffffffffL, 36);
    }

    /** checks the pages; updates the alert; returns the notification text for NEW wording, else null */
    static String check(JSONObject a, String now) throws Exception {
        Pattern re = pattern(a);
        List<String> urls = urls(a);
        a.put("lastChecked", now);
        if (re == null || urls.isEmpty()) { a.put("lastError", "Nothing to watch"); return null; }
        JSONObject h = new JSONObject();
        h.put("User-Agent", Cruise.UA_WEB);
        h.put("Accept", "text/html,application/xhtml+xml");
        h.put("Accept-Language", "en-US,en;q=0.9");
        List<String> found = new ArrayList<>();
        int fails = 0;
        String err = "";
        for (String u : urls) {
            Net.Result r = Net.request("GET", u, h, null);
            if (r.status != 200) { fails++; err = r.status == 403 || r.status == 429 ? "The cruise line's website is blocking requests right now" : "Page answered " + r.status + " (" + u + ")"; continue; }
            for (String sn : snippets(pageText(r.body), re)) if (!found.contains(sn)) found.add(sn);
        }
        if (fails == urls.size()) { a.put("lastError", err); return null; }
        a.put("lastError", JSONObject.NULL);
        List<String> seen = new ArrayList<>(Arrays.asList(a.optString("seen").trim().split(" ")));
        seen.remove("");
        List<String> fresh = new ArrayList<>();
        for (String sn : found) if (!seen.contains(key(sn)) && !fresh.contains(sn)) fresh.add(sn);
        a.put("found", found.isEmpty() ? "" : found.get(0));
        a.put("foundCount", found.size());
        a.put("status", found.isEmpty() ? "watching" : "found");
        if (fresh.isEmpty()) return null;
        List<String> keys = new ArrayList<>();
        for (String sn : fresh) keys.add(key(sn));
        keys.addAll(seen);
        a.put("seen", String.join(" ", keys.subList(0, Math.min(60, keys.size()))));
        return title(a) + ": " + fresh.get(0) + (fresh.size() > 1 ? " (+" + (fresh.size() - 1) + " more)" : "");
    }
}
