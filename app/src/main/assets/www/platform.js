/*
 * platform.js - one interface, two back ends:
 *   - Android app: window.Native (Java bridge in MainActivity)
 *   - Docker web server: same-origin /api/* endpoints (per-user, logged in)
 */
(function () {
  'use strict';
  var Core = window.CruiseCore;

  /* ---------- Android ---------- */
  function androidPlatform() {
    var N = window.Native, seq = 0, pending = {};
    window.__nativeCb = function (id, status, body) {
      var cb = pending[id];
      if (cb) { delete pending[id]; cb(status, body); }
    };
    function call(fn, args) {
      return new Promise(function (resolve) {
        var id = 'cb' + (++seq);
        pending[id] = function (status, body) { resolve({ status: status, body: body }); };
        N[fn].apply(N, [id].concat(args));
      });
    }
    function parsed(r) {
      var j = null;
      try { j = JSON.parse(r.body); } catch (e) { /* ignore */ }
      if (r.status !== 200) throw new Error((j && j.error) || 'Request failed');
      return j;
    }
    return {
      kind: 'android',
      features: { background: true, sms: false, accounts: false, rememberPassword: true },
      http: function (method, url, o) {
        o = o || {};
        return call('http', [method, url, JSON.stringify(o.headers || {}), o.body == null ? '' : String(o.body)]);
      },
      cabins: function (opts) { return call('cabinPrices', [JSON.stringify(opts)]).then(parsed); },
      getAlerts: function () { return Promise.resolve(JSON.parse(N.getAlerts() || '[]')); },
      saveAlerts: function (list) { N.saveAlerts(JSON.stringify(list)); return Promise.resolve(); },
      checkAlertsNow: function () { return call('checkAlertsNow', []).then(parsed); },
      getSettings: function () { return Promise.resolve(JSON.parse(N.getBackgroundSettings() || '{}')); },
      saveSettings: function (s) { N.setBackgroundChecks(!!s.background, parseInt(s.hours, 10) || 12); return Promise.resolve(); },
      openUrl: function (url) { N.openUrl(url); },
      me: function () { return Promise.resolve(null); }
    };
  }

  /* ---------- Docker web server ---------- */
  function serverPlatform() {
    function api(method, path, body) {
      return fetch(path, {
        method: method,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'CruiseDeals' },
        body: body === undefined ? undefined : JSON.stringify(body)
      }).then(function (r) {
        return r.text().then(function (t) {
          var j = null;
          try { j = t ? JSON.parse(t) : null; } catch (e) { /* ignore */ }
          if (r.status === 401 && path !== '/api/login') { window.dispatchEvent(new Event('cd-logged-out')); }
          if (!r.ok) { var err = new Error((j && j.error) || ('Server error ' + r.status)); err.status = r.status; throw err; }
          return j;
        });
      });
    }
    return {
      kind: 'web',
      features: { background: 'server', sms: true, accounts: true, rememberPassword: false },
      api: api,
      http: function (method, url, o) {
        o = o || {};
        return api('POST', '/api/proxy', { method: method, url: url, headers: o.headers || {}, body: o.body == null ? null : String(o.body) });
      },
      cabins: function (opts) { return api('POST', '/api/cabins', opts); },
      getAlerts: function () { return api('GET', '/api/alerts'); },
      saveAlerts: function (list) { return api('PUT', '/api/alerts', list); },
      checkAlertsNow: function () { return api('POST', '/api/alerts/check'); },
      getSettings: function () { return api('GET', '/api/me').then(function (m) { return m.settings || {}; }); },
      saveSettings: function (s) { return api('PUT', '/api/me/settings', s); },
      openUrl: function (url) { window.open(url, '_blank', 'noopener'); },
      me: function () { return api('GET', '/api/me'); },
      login: function (u, p) { return api('POST', '/api/login', { username: u, password: p }); },
      logout: function () { return api('POST', '/api/logout'); },
      testSms: function () { return api('POST', '/api/me/test-sms'); },
      changePassword: function (oldP, newP) { return api('POST', '/api/me/password', { oldPassword: oldP, newPassword: newP }); },
      listUsers: function () { return api('GET', '/api/admin/users'); },
      createUser: function (u) { return api('POST', '/api/admin/users', u); },
      deleteUser: function (name) { return api('DELETE', '/api/admin/users/' + encodeURIComponent(name)); }
    };
  }

  /* ---------- plain browser (development / tests): direct fetch ---------- */
  function browserPlatform() {
    var alerts = [];
    try { alerts = JSON.parse(localStorage.getItem('cd.alerts') || '[]'); } catch (e) { alerts = []; }
    var http = window.__devHttp || function (method, url, o) {
      o = o || {};
      return fetch(url, { method: method, headers: o.headers, body: o.body || undefined })
        .then(function (r) { return r.text().then(function (t) { return { status: r.status, body: t }; }); })
        .catch(function () { return { status: 0, body: '' }; });
    };
    function save() { try { localStorage.setItem('cd.alerts', JSON.stringify(alerts)); } catch (e) { /* ignore */ } }
    return {
      kind: 'browser',
      features: { background: false, sms: false, accounts: false, rememberPassword: false },
      http: http,
      cabins: function (opts) { return Core.getCabins(http, opts); },
      getAlerts: function () { return Promise.resolve(alerts.slice()); },
      saveAlerts: function (list) { alerts = list.slice(); save(); return Promise.resolve(); },
      checkAlertsNow: async function () {
        for (var i = 0; i < alerts.length; i++) alerts[i] = (await Core.checkAlert(http, alerts[i])).alert;
        save();
        return alerts.slice();
      },
      getSettings: function () { return Promise.resolve({}); },
      saveSettings: function () { return Promise.resolve(); },
      openUrl: function (url) { window.open(url, '_blank', 'noopener'); },
      me: function () { return Promise.resolve(null); }
    };
  }

  var mode = window.Native ? 'android' : (window.CD_SERVER || location.protocol.indexOf('http') === 0 && document.documentElement.dataset.server === '1') ? 'web' : 'browser';
  window.Platform = mode === 'android' ? androidPlatform() : mode === 'web' ? serverPlatform() : browserPlatform();
})();
