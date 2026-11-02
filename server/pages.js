/*
 * pages.js - public pages anyone can open without signing in: About, Terms, Privacy and SMS terms.
 * Text-message providers (e.g. Textbelt, before allowing links) review these. The admin fills in the
 * site name, operator and contact email on the Settings page; nothing here is hard-coded to a person.
 */
'use strict';

function esc(s) {
  return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const CSS = `
:root{--navy:#0b3a6f;--text:#15202b;--muted:#5d6b7a;--line:#dde3ea;--bg:#f2f5f9;--card:#fff}
@media (prefers-color-scheme:dark){:root{--text:#e8eef5;--muted:#9aa8b6;--line:#26323f;--bg:#0e141b;--card:#17202a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{background:linear-gradient(135deg,#0b3a6f,#0f5a8a);color:#fff;padding:18px 16px}
header a{color:#fff;text-decoration:none;font-weight:700;font-size:19px}
main{max-width:760px;margin:0 auto;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 18px 8px;margin:0 0 16px}
h1{font-size:24px;margin:4px 0 4px}h2{font-size:18px;margin:18px 0 6px}p,li{margin:6px 0}
.muted{color:var(--muted);font-size:14px}a{color:#0e7fa8}
nav.links{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:14px;margin:8px 0 24px}
.btn{display:inline-block;background:#0b3a6f;color:#fff;border-radius:10px;padding:10px 16px;text-decoration:none;font-weight:600}
@media (prefers-color-scheme:dark){.btn{background:#4d9be6}}
`;

function frame(site, title, body) {
  const name = esc(site.name);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} - ${name}</title><link rel="icon" href="/icon.png"><style>${CSS}</style></head>
<body><header><a href="/about">&#128674; ${name}</a></header>
<main>${body}
<nav class="links" aria-label="Site pages"><a href="/about">About</a><a href="/terms">Terms of Use</a><a href="/privacy">Privacy Policy</a><a href="/sms-terms">SMS Terms</a><a href="/">Sign in</a></nav>
</main></body></html>`;
}

function contactLine(site) {
  const parts = [];
  if (site.owner) parts.push(esc(site.owner));
  if (site.email) parts.push(`<a href="mailto:${esc(site.email)}">${esc(site.email)}</a>`);
  return parts.length ? parts.join(' &middot; ') : 'the site administrator';
}

function updated(site) {
  return `<p class="muted">Last updated ${esc(site.updated || new Date().toISOString().slice(0, 10))}</p>`;
}

function about(site) {
  return frame(site, 'About', `<div class="card">
<h1>${esc(site.name)}</h1>
<p>${esc(site.name)} is a private, invitation-only tool for a small group of people planning cruises. It shows public prices for cruise add-ons (drink, dining and Wi-Fi packages, shore excursions) and cabins, and lets each member set price alerts for items they are interested in.</p>
<h2>How price alerts work</h2>
<ul>
<li>Members sign in with an account created for them by the administrator. There is no public sign-up.</li>
<li>A member chooses items to watch and, if they want, turns on text messages in Settings and enters their own mobile number.</li>
<li>The server checks prices on a schedule. When a watched price drops, the member gets a short text saying what dropped and the new price, sometimes with a link back to this site to see the details.</li>
<li>Texts are only about the member's own alerts. No marketing, no promotions, nothing is sold, and numbers are never shared.</li>
</ul>
<h2>Example text</h2>
<p class="muted" style="white-space:pre-line;border-left:3px solid var(--line);padding-left:10px">${esc(site.exampleText || '')}</p>
<p>Reply STOP to any text to stop them, or HELP for help. See the <a href="/sms-terms">SMS Terms</a>.</p>
<h2>Not affiliated</h2>
<p>${esc(site.name)} is an independent personal project. It is not affiliated with, endorsed by or connected to Royal Caribbean Group, Royal Caribbean International or Celebrity Cruises. Prices come from the cruise lines' public websites and may change at any time; always confirm prices with the cruise line before buying.</p>
<h2>Contact</h2>
<p>${contactLine(site)}</p>
<p><a class="btn" href="/">Member sign-in</a></p>
</div>`);
}

function terms(site) {
  return frame(site, 'Terms of Use', `<div class="card">
<h1>Terms of Use</h1>${updated(site)}
<p>These terms apply to ${esc(site.name)} (the "Service"), run by ${contactLine(site)} (the "Operator"). By signing in or using the Service you agree to them.</p>
<h2>1. Who can use it</h2>
<p>The Service is private. Accounts are created by the Operator for invited members only. Keep your password to yourself; you are responsible for activity on your account.</p>
<h2>2. What it does</h2>
<p>The Service displays prices published by cruise lines and sends price-drop alerts that you set up. It does not sell, book or take payment for anything. Purchases are made directly with the cruise line under the cruise line's own terms.</p>
<h2>3. No guarantee of prices</h2>
<p>Prices, availability and discounts are taken from the cruise lines' public websites and may be wrong, out of date or unavailable. Alerts may be late or missed. Always check the price with the cruise line before buying. The Service is provided "as is", without warranties of any kind.</p>
<h2>4. Text messages</h2>
<p>Text alerts are optional and governed by the <a href="/sms-terms">SMS Terms</a>.</p>
<h2>5. Acceptable use</h2>
<p>Do not misuse the Service, try to access other members' accounts, overload it, or use it for anything unlawful. The Operator may suspend or delete accounts at any time.</p>
<h2>6. Your cruise-line login</h2>
<p>If you use "My Cruises", your cruise-line email and password are passed straight to the cruise line to look up your bookings. The Service does not store them.</p>
<h2>7. Limitation of liability</h2>
<p>To the fullest extent allowed by law, the Operator is not liable for any loss arising from use of the Service, including prices that were missed, wrong or changed.</p>
<h2>8. Not affiliated</h2>
<p>The Service is not affiliated with or endorsed by Royal Caribbean Group, Royal Caribbean International or Celebrity Cruises. Their names are used only to describe the prices shown.</p>
<h2>9. Changes and contact</h2>
<p>These terms may be updated; the date above shows the latest version. Questions: ${contactLine(site)}.</p>
</div>`);
}

function privacy(site) {
  return frame(site, 'Privacy Policy', `<div class="card">
<h1>Privacy Policy</h1>${updated(site)}
<p>This policy explains what ${esc(site.name)} (the "Service") keeps about its members and why.</p>
<h2>What we keep</h2>
<ul>
<li><b>Account:</b> your username and a one-way hash of your password (the password itself is never stored).</li>
<li><b>Mobile number</b>, only if you enter it to receive text alerts, and whether texts are switched on.</li>
<li><b>Your price alerts</b> (which items you watch, prices seen) and optional discount details you enter, such as a loyalty number or state of residence, used only to look up prices for you.</li>
<li><b>Sign-in sessions</b> (a random cookie) and short server logs (time, sign-ins, errors) for security.</li>
</ul>
<h2>What we do not keep</h2>
<p>Cruise-line passwords used in "My Cruises" are passed to the cruise line and not stored. There is no advertising, analytics or tracking.</p>
<h2>How your mobile number is used</h2>
<p>Only to send you the price-drop texts you asked for. It is sent to the text-message provider (for example Textbelt) solely to deliver those texts. <b>Mobile numbers and opt-in consent are never sold, rented or shared with anyone for marketing.</b></p>
<h2>Sharing</h2>
<p>Data is shared only with the services needed to run the Service: the cruise lines (to look up prices) and the text-message provider (to deliver texts). Nothing is sold.</p>
<h2>Keeping and deleting data</h2>
<p>Data is kept while your account exists. Turning texts off stops texts immediately. To delete your account and data, ask the administrator: ${contactLine(site)}.</p>
<h2>Security</h2>
<p>Passwords are hashed, sessions use secure cookies, and the site is served over HTTPS.</p>
<h2>Contact</h2>
<p>${contactLine(site)}</p>
</div>`);
}

function smsTerms(site) {
  const freq = site.smsMode === 'each'
    ? 'Texts are sent only when a price you watch drops, after each scheduled price check (a few times a day at most).'
    : 'At most one text per day, combining all of your price drops, and only on days when a price you watch drops.';
  return frame(site, 'SMS Terms', `<div class="card">
<h1>SMS Terms</h1>${updated(site)}
<h2>Program</h2>
<p><b>${esc(site.name)} price alerts</b>: automated, transactional text messages telling a member that the price of an item they chose to watch (a cruise drink, dining or Wi-Fi package, excursion or cabin) has dropped. No marketing or promotional messages are sent.</p>
<h2>How you opt in</h2>
<p>Only signed-in members can opt in. In Settings, a member enters their own mobile number and switches on "Text me price drops". Texts are never turned on for anyone without that step.</p>
<h2>Message frequency</h2>
<p>${freq} Members can send a test text to themselves from Settings.</p>
<h2>Cost</h2>
<p>Message and data rates may apply, depending on your mobile plan. ${esc(site.name)} does not charge for texts.</p>
<h2>How to stop</h2>
<p>Reply <b>STOP</b> to any message, or switch off "Text me price drops" in Settings. You will get no further alert texts. Reply <b>START</b> or switch the setting back on to resume.</p>
<h2>Help</h2>
<p>Reply <b>HELP</b> to any message, or contact ${contactLine(site)}.</p>
<h2>Links in texts</h2>
<p>Some texts end with a link to this website (${esc(site.url || 'this site')}) so members can see the details of the price drop after signing in.</p>
<h2>Carriers</h2>
<p>Carriers are not liable for delayed or undelivered messages.</p>
<h2>Privacy</h2>
<p>Mobile numbers and consent are never sold or shared for marketing. See the <a href="/privacy">Privacy Policy</a>.</p>
</div>`);
}

const PAGES = { '/about': about, '/terms': terms, '/privacy': privacy, '/sms-terms': smsTerms };

module.exports = { PAGES, esc };
