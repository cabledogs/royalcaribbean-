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
4. **Discounts** (Settings): Crown & Anchor / Captain's Club number, state of residence, 55+,
   military, police, firefighter. Cabin prices then show *your* price next to the public price
   (also used by the group planner and cabin alerts). Signing in under My Cruises can fill these in.
5. **My Cruises**: sign in with your cruise line account to see whether anything you already
   bought is cheaper now (rebook & save).

## Cheapest cruise finder
Explore → **Find the cheapest cruise**: pick ship classes (Icon, Oasis, Quantum, … or Celebrity
classes, with individual ships you can leave out), adults/kids, **1–3 rooms**, **connecting rooms only**,
cruise length (2–5 / 6–8 / 9+ nights), a month range and cabin type. Every matching sailing is
priced for your exact room split (with your discounts) and listed cheapest first; tap one to open it.
Up to 150 sailings per search, so a narrower date range is faster.

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
