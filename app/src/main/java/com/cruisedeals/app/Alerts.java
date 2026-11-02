package com.cruisedeals.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;

import java.text.NumberFormat;
import java.text.SimpleDateFormat;
import java.util.Currency;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

import org.json.JSONArray;
import org.json.JSONObject;

/** Alert storage, background scheduling, the price check itself and notifications. */
final class Alerts {
    static final String PREFS = "cruisedeals";
    static final String CHANNEL = "price_drops";
    static final int JOB_ID = 4711;
    private static final Object LOCK = new Object();

    private Alerts() {}

    static SharedPreferences prefs(Context c) { return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    static String load(Context c) {
        synchronized (LOCK) { return prefs(c).getString("alerts", "[]"); }
    }

    static void save(Context c, String json) {
        synchronized (LOCK) { prefs(c).edit().putString("alerts", json).apply(); }
    }

    /* ---------- scheduling ---------- */

    static void schedule(Context c, boolean enabled, int hours) {
        prefs(c).edit().putBoolean("bg", enabled).putInt("bgHours", hours).apply();
        JobScheduler js = (JobScheduler) c.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        js.cancel(JOB_ID);
        if (!enabled) return;
        JobInfo job = new JobInfo.Builder(JOB_ID, new ComponentName(c, AlertJobService.class))
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setPeriodic(Math.max(1, hours) * 3600L * 1000L)
            .setPersisted(true)
            .build();
        js.schedule(job);
    }

    static String settingsJson(Context c) {
        try {
            JSONObject o = new JSONObject();
            o.put("background", prefs(c).getBoolean("bg", false));
            o.put("hours", prefs(c).getInt("bgHours", 12));
            return o.toString();
        } catch (Exception e) { return "{}"; }
    }

    /* ---------- the check (mirrors CruiseCore.checkAlert) ---------- */

    /** Checks every alert, notifies on drops, saves and returns the updated list. */
    static JSONArray checkAll(Context c) {
        JSONArray list;
        try { list = new JSONArray(load(c)); } catch (Exception e) { list = new JSONArray(); }
        String now = iso(new Date());
        int drops = 0;
        StringBuilder msgs = new StringBuilder();
        for (int i = 0; i < list.length(); i++) {
            JSONObject a = list.optJSONObject(i);
            if (a == null) continue;
            try {
                String msg = checkOne(a, now);
                if (msg != null) {
                    drops++;
                    if (msgs.length() > 0) msgs.append('\n');
                    msgs.append(msg);
                }
            } catch (Exception ignored) { /* keep checking the rest */ }
        }
        // one notification for the whole check, not one per alert
        if (drops == 1) notify(c, 1000, "Price drop", msgs.toString());
        else if (drops > 1) notify(c, 1000, drops + " price drops", msgs.toString());
        // merge back: keep alerts the user added/removed while we were checking
        synchronized (LOCK) {
            try {
                JSONArray latest = new JSONArray(prefs(c).getString("alerts", "[]"));
                JSONArray merged = new JSONArray();
                for (int i = 0; i < latest.length(); i++) {
                    JSONObject cur = latest.optJSONObject(i);
                    if (cur == null) continue;
                    JSONObject checked = byId(list, cur.optString("id"));
                    if (checked != null) {
                        // the user may have edited the target meanwhile
                        checked.put("target", cur.opt("target") == null ? JSONObject.NULL : cur.opt("target"));
                        merged.put(checked);
                    } else merged.put(cur);
                }
                prefs(c).edit().putString("alerts", merged.toString()).apply();
                return merged;
            } catch (Exception e) {
                return list;
            }
        }
    }

    private static JSONObject byId(JSONArray list, String id) {
        for (int i = 0; i < list.length(); i++) {
            JSONObject o = list.optJSONObject(i);
            if (o != null && id.equals(o.optString("id"))) return o;
        }
        return null;
    }

    private static String checkOne(JSONObject a, String now) throws Exception {
        double current;
        try {
            if ("cabin".equals(a.optString("type"))) {
                current = Double.NaN;
                JSONArray cabins = Cruise.cabins(a);
                for (int k = 0; k < cabins.length(); k++) {
                    JSONObject cab = cabins.getJSONObject(k);
                    if (cab.optString("name").equals(a.optString("cabinName")) && !cab.isNull("price")) current = cab.getDouble("price");
                }
            } else {
                current = Cruise.findProductPrice(a.optString("ship"), a.optString("sailDate"), a.optString("category"),
                    a.has("day") ? String.valueOf(a.opt("day")) : "all", a.optString("productId"), a.optString("currency", "USD"));
            }
        } catch (Exception e) {
            a.put("lastError", String.valueOf(e.getMessage()));
            a.put("lastChecked", now);
            return null;
        }
        a.put("lastChecked", now);
        a.put("lastError", JSONObject.NULL);
        if (Double.isNaN(current)) {
            a.put("status", "unavailable");
            return null;
        }
        double previous = a.optDouble("lastPrice", Double.NaN);
        a.put("lastPrice", current);
        double lowest = a.optDouble("lowestSeen", Double.NaN);
        if (Double.isNaN(lowest) || current < lowest) a.put("lowestSeen", current);
        double target = a.optDouble("target", Double.NaN);
        boolean hasTarget = !Double.isNaN(target) && target > 0;
        double threshold = hasTarget ? target : a.optDouble("initialPrice", Double.NaN);
        boolean hit = hasTarget ? current <= threshold : current < threshold;
        a.put("status", hit ? "dropped" : "watching");
        if (!hit) return null;
        // after the first alert, only alert again when it drops below the price we last told you about
        double notified = a.optDouble("notifiedPrice", Double.NaN);
        if (!Double.isNaN(notified) && current >= notified) return null;
        a.put("notifiedPrice", current);
        String cur = a.optString("currency", "USD");
        String msg = a.optString("title") + " is now " + money(current, cur);
        if (!Double.isNaN(previous) && previous != current) msg += " (was " + money(previous, cur) + ")";
        msg += " - " + a.optString("shipName", a.optString("ship")) + " " + a.optString("sailDate");
        return msg;
    }

    static String money(double v, String currency) {
        try {
            NumberFormat f = NumberFormat.getCurrencyInstance(Locale.US);
            f.setCurrency(Currency.getInstance(currency));
            return f.format(v);
        } catch (Exception e) {
            return currency + " " + String.format(Locale.US, "%.2f", v);
        }
    }

    static String iso(Date d) {
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(d);
    }

    /* ---------- notifications ---------- */

    static void ensureChannel(Context c) {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Price drops", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("Alerts when a package, excursion or cabin gets cheaper");
        nm.createNotificationChannel(ch);
    }

    static void notify(Context c, int id, String title, String text) {
        if (Build.VERSION.SDK_INT >= 33
            && c.checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) return;
        ensureChannel(c);
        Intent open = new Intent(c, MainActivity.class);
        open.putExtra("openAlerts", true);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(c, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new Notification.Builder(c, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(new Notification.BigTextStyle().bigText(text))
            .setContentIntent(pi)
            .setAutoCancel(true)
            .build();
        ((NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE)).notify(id, n);
    }
}
