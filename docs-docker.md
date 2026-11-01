# Cruise Deals – Docker web version

The same mobile-friendly app as the Android APK, served from your own machine so your family/friends
can use it from any phone browser — each with their own login, alerts and text messages.

## What you get
- **Accounts**: the admin adds users in *Settings → Users*. No public sign-up.
- **Price alerts per user**, checked on a schedule (default every 6 h) and on demand.
- **Text alerts**: the admin picks the provider in *Settings → Text message provider* —
  **Textbelt**, **Twilio**, or a **Webhook** (JSON `{"to","message"}` to any other SMS service, Home Assistant, n8n…).
  Keys can be changed any time without a restart and are never shown back in the browser.
  Each user adds their mobile number in Settings. One combined text per check, no repeat text for the same price.
  *See what the texts look like* shows a phone preview built by the real formatter
  (examples: [text-alert-examples.png](text-alert-examples.png)).
- **Adding another provider later** = one entry in `server/sms.js` (label, settings fields, `send()`);
  the admin form builds itself from it.
- **Add to Home Screen** works (installable web app).

## Run it at home, reachable from the internet
1. Point a domain at your home IP (DuckDNS, Cloudflare, etc.) and forward ports **80 and 443**
   on your router to the machine running Docker.
2. Configure:
   ```bash
   cp .env.example .env
   nano .env        # DOMAIN, ADMIN_PASSWORD (10+ chars); TEXTBELT_KEY optional (can be set in the app)
   ```
3. Start:
   ```bash
   docker compose up -d --build
   ```
4. Open `https://YOUR-DOMAIN`, sign in as the admin, then add the other users in Settings.

Caddy fetches and renews the HTTPS certificate automatically. Data (users, alerts) lives in `./data/db.json`.

## LAN only / behind your own reverse proxy
```bash
docker build -t cruise-deals .
docker run -d -p 8080:8080 -v $PWD/data:/data -e ADMIN_PASSWORD=change-me-please cruise-deals
```
If you put it behind another proxy that terminates HTTPS, also set `TRUST_PROXY=1` and `COOKIE_SECURE=true`.

## Security notes
- Passwords are stored as scrypt hashes; sessions are random tokens in `HttpOnly`, `SameSite=Strict` cookies.
- Sign-in is rate limited (per IP and per username); API writes need a custom header (CSRF protection).
- The server only relays requests to the cruise lines' own hosts, and only for signed-in users.
- Cruise-line passwords used in *My Cruises* are passed through to the cruise line and never stored.
- Strict Content-Security-Policy, HSTS over HTTPS, no directory listing (only the app's files are served).
- Always expose it with HTTPS (the included Caddy setup does this). Keep the admin password long.

## Settings (environment variables)
| Variable | Default | Meaning |
|---|---|---|
| `ADMIN_USER` / `ADMIN_PASSWORD` | admin / random (printed in log) | first admin, created on first start only |
| `TEXTBELT_KEY` | – | optional: pre-fills Textbelt on first start (then manage it in Settings) |
| `CHECK_INTERVAL_HOURS` | 6 | scheduled alert checks |
| `SESSION_DAYS` | 30 | how long a sign-in lasts |
| `MAX_ALERTS_PER_USER` | 200 | |
| `TRUST_PROXY` | off | trust `X-Forwarded-For/Proto` (set when behind Caddy/nginx) |
| `COOKIE_SECURE` | auto | `true` forces Secure cookies |
| `PORT`, `DATA_DIR` | 8080, /data | |

## Tests
```bash
node test/server-test.js   # end-to-end: logins, security, alerts, SMS (mocked cruise line + Textbelt)
```
