'use strict';
window.StatusDash = window.StatusDash || {};

/**
 * Smart fetcher — proxy rotation, per-proxy back-off, jitter, response cache.
 *
 * Browser support: Chrome 80+, Firefox 75+, Safari 13+, Edge 80+
 */
window.StatusDash.fetcher = (function () {

  var TIMEOUT_MS  = 12000;      // 12 s per attempt
  var CACHE_TTL   = 5 * 60 * 1000; // 5-minute cache
  var BACKOFF_MS  = 90 * 1000;  // 90-second proxy back-off
  var CACHE_PFX   = 'sdc_v2:';

  // ── Proxy definitions ─────────────────────────────────────────────────────
  // Order matters: proxies tried in sequence per provider offset.
  // 'direct' is last — it only works when the target has its own CORS headers.
  var PROXIES = [
    { name: 'allorigins', type: 'json', build: function(u){ return 'https://api.allorigins.win/get?url=' + encodeURIComponent(u); } },
    { name: 'allraw',     type: 'raw',  build: function(u){ return 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u); } },
    { name: 'corsproxy',  type: 'raw',  build: function(u){ return 'https://corsproxy.io/?' + encodeURIComponent(u); } },
    { name: 'corsorg',    type: 'raw',  build: function(u){ return 'https://corsproxy.org/?' + encodeURIComponent(u); } },
    { name: 'corslol',    type: 'raw',  build: function(u){ return 'https://api.cors.lol/?url=' + encodeURIComponent(u); } },
    { name: 'direct',     type: 'raw',  build: function(u){ return u; } },
  ];

  // ── Per-proxy back-off tracking ───────────────────────────────────────────
  var _backoff = {};

  function _isBackedOff(name) {
    return _backoff[name] != null && Date.now() < _backoff[name];
  }

  function _setBackoff(name) {
    _backoff[name] = Date.now() + BACKOFF_MS;
    console.warn('[Fetcher] proxy "' + name + '" backed off for ' + (BACKOFF_MS / 1000) + 's');
  }

  // ── Proxy rotation per provider ───────────────────────────────────────────
  // Stagger starting proxy per provider to spread load; all start from allorigins now
  var PROVIDER_OFFSETS = { oci: 0, azure: 0, aws: 0, gcp: 0 };

  function _proxyOrder(providerId) {
    var available = PROXIES.filter(function(p){ return !_isBackedOff(p.name); });
    if (!available.length) available = PROXIES.slice(); // all backed-off? reset
    var offset = (PROVIDER_OFFSETS[providerId] || 0) % available.length;
    return available.slice(offset).concat(available.slice(0, offset));
  }

  // ── Jitter delay ──────────────────────────────────────────────────────────
  function _jitter(min, max) {
    return new Promise(function(r){ setTimeout(r, min + Math.random() * (max - min)); });
  }

  // ── sessionStorage cache ──────────────────────────────────────────────────
  function _cacheGet(url) {
    try {
      var raw = sessionStorage.getItem(CACHE_PFX + url);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (Date.now() - obj.ts > CACHE_TTL) { sessionStorage.removeItem(CACHE_PFX + url); return null; }
      return obj.data;
    } catch (e) { return null; }
  }

  function _cacheSet(url, data) {
    try { sessionStorage.setItem(CACHE_PFX + url, JSON.stringify({ ts: Date.now(), data: data })); }
    catch (e) { /* quota exceeded / private browsing – ignore */ }
  }

  // ── In-flight de-duplication ──────────────────────────────────────────────
  var _inFlight = {};

  // ── Content validators ────────────────────────────────────────────────────
  function _isXml(t) {
    var s = String(t || '').replace(/^\s+/, '');
    // Accept any response that starts with '<' (HTML/XML) or contains common
    // HTML structural tags anywhere in the document (handles partial responses
    // and React-rendered pages where DOCTYPE may be preceded by a BOM/comment).
    return s.length > 50 && (
      s.charAt(0) === '<' ||
      s.indexOf('<channel') >= 0 || s.indexOf('<div')     >= 0 ||
      s.indexOf('<ul')      >= 0 || s.indexOf('<li')      >= 0 ||
      s.indexOf('<article') >= 0 || s.indexOf('<section') >= 0
    );
  }

  function _isJson(t) {
    var s = String(t || '').replace(/^\s+/, '');
    return s.length > 2 && (s.charAt(0) === '[' || s.charAt(0) === '{');
  }

  // ── Core fetch ────────────────────────────────────────────────────────────
  function _doFetch(url, dataType, providerId) {
    var validate = dataType === 'json' ? _isJson : _isXml;
    var proxies  = _proxyOrder(providerId);
    var errors   = [];
    var i        = 0;

    function tryNext() {
      if (i >= proxies.length) {
        return Promise.reject(new Error('All strategies exhausted:\n' + errors.join('\n')));
      }
      var p      = proxies[i++];
      var ctrl   = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var signal = ctrl ? ctrl.signal : undefined;
      var tid    = ctrl ? setTimeout(function(){ ctrl.abort(); }, TIMEOUT_MS) : null;
      var delay  = i > 1 ? _jitter(80, 500) : Promise.resolve();

      return delay.then(function() {
        var proxyUrl = p.build(url);
        if (!/^https?:\/\//i.test(proxyUrl)) { errors.push(p.name + ': unsafe url'); return tryNext(); }

        return fetch(proxyUrl, { signal: signal, credentials: 'omit', mode: 'cors' })
          .then(function(res) {
            if (tid) clearTimeout(tid);
            if (res.status === 429 || res.status === 503) {
              _setBackoff(p.name);
              errors.push(p.name + ': ' + res.status);
              return tryNext();
            }
            if (!res.ok) { errors.push(p.name + ': HTTP ' + res.status); return tryNext(); }

            var extract = p.type === 'json'
              ? res.json().then(function(j) {
                  var c = j.contents;
                  if (c == null) return JSON.stringify(j);
                  return typeof c === 'string' ? c : JSON.stringify(c);
                })
              : res.text();

            return extract.then(function(payload) {
              if (payload.length > 5 * 1024 * 1024) { errors.push(p.name + ': response too large'); return tryNext(); }
              if (!validate(payload)) { errors.push(p.name + ': unexpected content'); return tryNext(); }
              return payload;
            });
          })
          .catch(function(err) {
            if (tid) clearTimeout(tid);
            var msg = (err && err.name === 'AbortError') ? 'timeout' : (err && err.message) || 'error';
            errors.push(p.name + ': ' + msg);
            if (!ctrl || err.name !== 'AbortError') _setBackoff(p.name);
            return tryNext();
          });
      });
    }
    return tryNext();
  }

  // ── Public helpers ────────────────────────────────────────────────────────
  function _fetch(url, dataType, providerId, force) {
    if (!/^https:\/\//i.test(url)) return Promise.reject(new Error('HTTPS required: ' + url));
    if (!force) {
      var cached = _cacheGet(url);
      if (cached != null) {
        console.info('[StatusDash] cache hit: ' + url.split('/').pop());
        return dataType === 'json' ? Promise.resolve(JSON.parse(cached)) : Promise.resolve(cached);
      }
    }
    if (_inFlight[url]) {
      return dataType === 'json'
        ? _inFlight[url].then(function(t){ return JSON.parse(t); })
        : _inFlight[url];
    }
    var p = _doFetch(url, dataType, providerId)
      .then(function(data) { _cacheSet(url, data); return data; })
      .then(function(data) { delete _inFlight[url]; return data; })
      ['catch'](function(err) { delete _inFlight[url]; throw err; });
    _inFlight[url] = p;
    return dataType === 'json' ? p.then(function(t){ return JSON.parse(t); }) : p;
  }

  function fetchXml(url, providerId, force) {
    return _fetch(url, 'xml', providerId || '', !!force);
  }

  function fetchJson(url, providerId, force) {
    return _fetch(url, 'json', providerId || '', !!force);
  }

  function clearCache() {
    try {
      Object.keys(sessionStorage)
        .filter(function(k){ return k.indexOf(CACHE_PFX) === 0; })
        .forEach(function(k){ sessionStorage.removeItem(k); });
    } catch (e) { /* ignore */ }
  }

  return { fetchXml: fetchXml, fetchJson: fetchJson, clearCache: clearCache };

}());
