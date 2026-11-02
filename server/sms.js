/*
 * sms.js - text message providers + the text formatter.
 *
 * Adding a provider later = add one entry to PROVIDERS:
 *   label   shown in the admin page
 *   fields  settings the admin fills in (secret: true => never sent back to the browser)
 *   send(cfg, phone, message) -> Promise<{info}>  (throw an Error with a friendly message on failure)
 * The admin page builds its form from `fields`, so no UI change is needed.
 */
'use strict';

const timeout = () => AbortSignal.timeout(20000);

/* Textbelt refuses texts with URLs unless the key is approved for them */
function stripLinks(text) {
  return String(text).replace(/\n?\s*https?:\/\/\S+/gi, '').trim();
}

const PROVIDERS = {
  textbelt: {
    label: 'Textbelt',
    help: 'Buy a key at textbelt.com. US/Canada numbers. Textbelt blocks links in texts until they approve your key, so links are left out unless you tick the box below.',
    fields: [
      { key: 'key', label: 'API key', secret: true, required: true },
      { key: 'url', label: 'API URL (leave blank for textbelt.com)', placeholder: 'https://textbelt.com/text' },
      { key: 'allowLinks', label: 'Textbelt approved my key for links', type: 'checkbox' }
    ],
    async send(cfg, phone, message, ctx) {
      if (cfg.allowLinks !== 'yes') message = stripLinks(message);
      const body = new URLSearchParams({ phone, message, key: cfg.key });
      // replies (STOP / HELP / START) come back to this server, signed with the key
      if (ctx && ctx.replyUrl) body.set('replyWebhookUrl', ctx.replyUrl);
      const res = await fetch(cfg.url || 'https://textbelt.com/text', { method: 'POST', body, signal: timeout() });
      const j = await res.json().catch(() => ({}));
      if (!j.success) throw new Error('Textbelt: ' + (j.error || 'send failed (HTTP ' + res.status + ')'));
      return { info: j.quotaRemaining !== undefined ? 'Texts left on this key: ' + j.quotaRemaining : 'Sent', quotaRemaining: j.quotaRemaining };
    }
  },

  twilio: {
    label: 'Twilio',
    help: 'Account SID and Auth Token from console.twilio.com, and a Twilio phone number to send from (+15551234567).',
    fields: [
      { key: 'accountSid', label: 'Account SID', required: true, placeholder: 'AC...' },
      { key: 'authToken', label: 'Auth token', secret: true, required: true },
      { key: 'from', label: 'From number', required: true, placeholder: '+15551234567' }
    ],
    async send(cfg, phone, message) {
      const base = process.env.TWILIO_API_BASE || 'https://api.twilio.com';
      const url = base + '/2010-04-01/Accounts/' + encodeURIComponent(cfg.accountSid) + '/Messages.json';
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: 'Basic ' + Buffer.from(cfg.accountSid + ':' + cfg.authToken).toString('base64') },
        body: new URLSearchParams({ To: phone, From: cfg.from, Body: message }),
        signal: timeout()
      });
      const j = await res.json().catch(() => ({}));
      if (res.status >= 300) throw new Error('Twilio: ' + (j.message || 'HTTP ' + res.status));
      return { info: 'Sent (Twilio id ' + (j.sid || '?') + ')' };
    }
  },

  webhook: {
    label: 'Webhook (any other service)',
    help: 'POSTs JSON {"to": "+15551234567", "message": "..."} to your URL - use it with any SMS gateway, Home Assistant, n8n, etc.',
    fields: [
      { key: 'url', label: 'Webhook URL', required: true, placeholder: 'https://example.com/send-sms' },
      { key: 'token', label: 'Bearer token (optional)', secret: true }
    ],
    async send(cfg, phone, message) {
      const headers = { 'Content-Type': 'application/json' };
      if (cfg.token) headers.Authorization = 'Bearer ' + cfg.token;
      const res = await fetch(cfg.url, { method: 'POST', headers, body: JSON.stringify({ to: phone, message }), signal: timeout() });
      if (res.status >= 300) throw new Error('Webhook returned HTTP ' + res.status);
      return { info: 'Sent (webhook HTTP ' + res.status + ')' };
    }
  }
};

/* ---------- formatting (plain GSM characters: no emoji, so each text costs as little as possible) ---------- */

function money(n, currency) {
  if (n === null || n === undefined || isNaN(n)) return '-';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD', maximumFractionDigits: n % 1 ? 2 : 0 }).format(n);
  } catch (e) { return (currency || '$') + Number(n).toFixed(2); }
}

function shortDate(d) {
  d = String(d || '');
  const dt = new Date(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8));
  return isNaN(dt) ? d : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function priceLine(d) {
  const was = typeof d.previous === 'number' && d.previous > d.current ? d.previous : d.initial;
  const unit = d.unit ? '/' + d.unit : '';
  let s = money(d.current, d.currency) + unit;
  if (typeof was === 'number' && was > d.current) s += ' (was ' + money(was, d.currency) + ', save ' + money(was - d.current, d.currency) + ')';
  return s;
}

function where(d) {
  return d.shipName + ', ' + shortDate(d.sailDate) + (d.port ? ' - Day ' + d.day + ' ' + d.port : '');
}

/** drops: [{title, current, previous, initial, target, currency, unit, shipName, sailDate, day, port}] */
function formatDrops(drops, opts) {
  opts = opts || {};
  const link = opts.link ? '\n' + opts.link.replace(/\/+$/, '') + '/' : '';
  if (!drops.length) return '';
  if (drops.length === 1) {
    const d = drops[0];
    return 'Cruise Deals: price drop!\n' +
      d.title + '\n' +
      'Now ' + priceLine(d) + '\n' +
      where(d) +
      (d.target ? '\nYour target was ' + money(d.target, d.currency) : '') +
      link;
  }
  const sameSailing = drops.every(d => d.shipName === drops[0].shipName && d.sailDate === drops[0].sailDate);
  let s = 'Cruise Deals: ' + drops.length + ' price drops' + (sameSailing ? '\n' + drops[0].shipName + ', ' + shortDate(drops[0].sailDate) : '') + '\n';
  const lines = drops.map(d => '- ' + d.title + ': ' + priceLine(d) + (sameSailing ? '' : ' [' + d.shipName + ' ' + shortDate(d.sailDate) + ']'));
  // keep long digests to a sensible length (about 4 SMS segments)
  let body = '';
  for (let i = 0; i < lines.length; i++) {
    if ((s + body + lines[i]).length > 560) { body += '+ ' + (lines.length - i) + ' more in the app\n'; break; }
    body += lines[i] + '\n';
  }
  return (s + body).trimEnd() + link;
}

function testMessage(opts) {
  opts = opts || {};
  return 'Cruise Deals: test text. Price-drop alerts for your drink packages, excursions and cabins will arrive like this.' +
    (opts.link ? '\n' + opts.link.replace(/\/+$/, '') + '/' : '');
}

const SAMPLE_DROPS = [
  { title: 'Mayan Ruins & Beach Tour', current: 109, previous: 129, initial: 129, target: null, currency: 'USD', unit: '', shipName: 'Wonder of the Seas', sailDate: '20270110', day: 3, port: 'Cozumel' },
  { title: 'Deluxe Beverage Package', current: 79.99, previous: 84.99, initial: 84.99, target: 80, currency: 'USD', unit: 'day', shipName: 'Wonder of the Seas', sailDate: '20270110' },
  { title: 'Balcony cabin (2 adults + 2 kids) with discounts', current: 3120, previous: 3398, initial: 3398, target: null, currency: 'USD', unit: '', shipName: 'Wonder of the Seas', sailDate: '20270110' }
];

/** What users will receive, for the preview in Settings. */
function samples(opts) {
  return [
    { label: 'One price drop', text: formatDrops([SAMPLE_DROPS[0]], opts) },
    { label: 'Hit your target price', text: formatDrops([SAMPLE_DROPS[1]], opts) },
    { label: 'Several drops in one check', text: formatDrops(SAMPLE_DROPS, opts) },
    { label: 'Test text', text: testMessage(opts) }
  ];
}

/** segments the carrier will bill: 160 chars (153 when split) for plain text */
function segments(text) { return text.length <= 160 ? 1 : Math.ceil(text.length / 153); }

module.exports = { SAMPLE_DROPS, stripLinks, PROVIDERS, formatDrops, testMessage, samples, segments };
