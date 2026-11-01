# Cruise Deals (Royal Caribbean & Celebrity)

A friendlier Android app (and, on the `docker-web` branch, a self-hosted web app) for finding
**drink packages, dining packages, Wi-Fi, shore excursions and cabin prices** on any Royal Caribbean
or Celebrity sailing — with **price-drop alerts**.

Based on the open-source [CheckRoyalCaribbeanPrice](https://github.com/jdeath/CheckRoyalCaribbeanPrice)
scripts by jdeath. Not affiliated with Royal Caribbean Group.

## What it does
1. **Pick a ship → pick a sail date** (search, filter by length/port/month)
2. Inside the sailing, tabs for **Cabins · Drinks · Dining · Wi-Fi · Excursions · More**
   - search and sort by price or name; excursions grouped by day and port
   - **Cabins → Whole group**: enter total adults/kids; it tries every 2-cabin split
     (2+4, 3+3, …), prices each cabin for exactly who's in it, and shows the cheapest
     combination for Interior / Ocean View / Balcony / Suite — optionally **connecting cabins only**
3. Tap 🔔 on anything (excursions, packages, cabins) for a **price alert**: any drop, or below your price.
   Android checks in the background (every 3/6/12/24 h) and sends a notification.
4. **My Cruises**: sign in with your cruise line account to see whether anything you already
   bought is cheaper now (rebook & save).

## Install the APK
Download `CruiseDeals.apk`, open it on your phone and allow "install unknown apps".
Android 8.0+ required.

## Build
```bash
TOOLS=/path/to/toolchain bash tools/build.sh   # -> app/build/CruiseDeals.apk
```
The toolchain folder needs `android.jar` (API 34), `dx.jar`
(`com.jakewharton.android.repackaged:dalvik-dx:16.0.1`) and `apksig.jar`
(`com.android.tools.build:apksig:2.3.0`). `tools/apkbuild.py` writes the binary manifest and
resource table itself, so no Android SDK install or aapt2 is needed.
Set `KEYSTORE`/`KEYSTORE_PASS` to sign with your own key (otherwise one is generated).

## Layout
- `app/src/main/assets/www/` — the UI (shared by Android and the web version)
  - `core.js` cruise-line API logic, `platform.js` Android/web adapter, `app.js` screens
- `app/src/main/java/` — Android shell: WebView, HTTP bridge, background alert checks
- `test/` — headless UI test (`node test/ui-test.js`) with a mocked bridge
