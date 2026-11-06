package com.cruisedeals.app;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import org.json.JSONArray;
import org.json.JSONObject;

public class MainActivity extends Activity {
    private static final ExecutorService POOL = Executors.newFixedThreadPool(4);
    private WebView web;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.rgb(11, 58, 111));
        // re-apply the background schedule so an update's new timing takes effect
        if (Alerts.prefs(this).getBoolean("bg", false)) Alerts.schedule(this, true, Alerts.prefs(this).getInt("bgHours", 12));
        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if ("file".equals(u.getScheme())) return false;
                openExternal(u.toString());
                return true;
            }
        });
        web.addJavascriptInterface(new Bridge(), "Native");
        web.loadUrl("file:///android_asset/www/index.html");

        Alerts.ensureChannel(this);
        if (Build.VERSION.SDK_INT >= 33
            && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] {"android.permission.POST_NOTIFICATIONS"}, 1);
        }
        handleIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIntent(intent);
    }

    private void handleIntent(Intent i) {
        if (i != null && i.getBooleanExtra("openAlerts", false)) {
            web.postDelayed(new Runnable() {
                @Override public void run() { js("window.CruiseApp && CruiseApp.setRoot('alerts')"); }
            }, 600);
        }
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("window.onNativeBack ? window.onNativeBack() : false", new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String handled) {
                if (!"true".equals(handled)) MainActivity.super.onBackPressed();
            }
        });
    }

    private void js(final String code) {
        runOnUiThread(new Runnable() {
            @Override public void run() { web.evaluateJavascript(code, null); }
        });
    }

    private void callback(String id, int status, String body) {
        js("window.__nativeCb(" + JSONObject.quote(id) + "," + status + "," + JSONObject.quote(body == null ? "" : body) + ")");
    }

    private void openExternal(String url) {
        try {
            Uri u = Uri.parse(url);
            if (!"https".equals(u.getScheme())) return;
            startActivity(new Intent(Intent.ACTION_VIEW, u));
        } catch (Exception ignored) { /* no browser */ }
    }

    private static boolean allowed(String url) {
        try {
            Uri u = Uri.parse(url);
            if (!"https".equals(u.getScheme())) return false;
            String h = u.getHost();
            return "aws-prd.api.rccl.com".equals(h) || "api.rccl.com".equals(h)
                || "www.royalcaribbean.com".equals(h) || "www.celebritycruises.com".equals(h);
        } catch (Exception e) { return false; }
    }

    private static String err(String msg) {
        try { return new JSONObject().put("error", msg).toString(); } catch (Exception e) { return "{}"; }
    }

    /** Methods callable from JavaScript as window.Native.* */
    final class Bridge {
        @JavascriptInterface
        public void http(final String id, final String method, final String url, final String headers, final String body) {
            POOL.execute(new Runnable() {
                @Override public void run() {
                    if (!allowed(url)) { callback(id, 0, "blocked host"); return; }
                    try {
                        Net.Result r = Net.request(method, url, new JSONObject(headers), body);
                        callback(id, r.status, r.body);
                    } catch (Exception e) { callback(id, 0, String.valueOf(e.getMessage())); }
                }
            });
        }

        @JavascriptInterface
        public void cabinPrices(final String id, final String opts) {
            POOL.execute(new Runnable() {
                @Override public void run() {
                    try { callback(id, 200, Cruise.cabins(new JSONObject(opts)).toString()); }
                    catch (Exception e) { callback(id, 500, err(String.valueOf(e.getMessage()))); }
                }
            });
        }

        @JavascriptInterface
        public String getAlerts() { return Alerts.load(MainActivity.this); }

        @JavascriptInterface
        public void saveAlerts(String json) {
            try { new JSONArray(json); Alerts.save(MainActivity.this, json); } catch (Exception ignored) { /* reject garbage */ }
        }

        @JavascriptInterface
        public void checkAlertsNow(final String id) {
            POOL.execute(new Runnable() {
                @Override public void run() {
                    try { callback(id, 200, Alerts.checkAll(getApplicationContext()).toString()); }
                    catch (Exception e) { callback(id, 500, err(String.valueOf(e.getMessage()))); }
                }
            });
        }

        @JavascriptInterface
        public String getBackgroundSettings() { return Alerts.settingsJson(MainActivity.this); }

        @JavascriptInterface
        public void setBackgroundChecks(boolean enabled, int hours) { Alerts.schedule(MainActivity.this, enabled, hours); }

        @JavascriptInterface
        public void openUrl(String url) { openExternal(url); }
    }
}
