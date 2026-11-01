package com.cruisedeals.app;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Iterator;

import org.json.JSONObject;

/** Minimal HTTP client with retries (mirrors _execute_api_request in the Python scripts). */
final class Net {
    static final class Result {
        final int status;
        final String body;
        Result(int status, String body) { this.status = status; this.body = body; }
    }

    private Net() {}

    static Result request(String method, String url, JSONObject headers, String body) {
        Result last = new Result(0, "");
        for (int attempt = 1; attempt <= 3; attempt++) {
            last = once(method, url, headers, body);
            // retry only transient failures (network errors and 5xx), not 4xx
            if (last.status != 0 && last.status < 500) return last;
            try { Thread.sleep(1000L << attempt); } catch (InterruptedException e) { return last; }
        }
        return last;
    }

    private static Result once(String method, String url, JSONObject headers, String body) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setRequestMethod(method);
            c.setConnectTimeout(20000);
            c.setReadTimeout(30000);
            c.setInstanceFollowRedirects(true);
            if (headers != null) {
                Iterator<String> it = headers.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    c.setRequestProperty(k, headers.optString(k));
                }
            }
            if (body != null && body.length() > 0) {
                c.setDoOutput(true);
                byte[] b = body.getBytes("UTF-8");
                c.setFixedLengthStreamingMode(b.length);
                OutputStream os = c.getOutputStream();
                os.write(b);
                os.close();
            }
            int status = c.getResponseCode();
            InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
            return new Result(status, in == null ? "" : readAll(in));
        } catch (Exception e) {
            return new Result(0, String.valueOf(e.getMessage()));
        } finally {
            if (c != null) c.disconnect();
        }
    }

    static String readAll(InputStream in) throws java.io.IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        in.close();
        return out.toString("UTF-8");
    }
}
