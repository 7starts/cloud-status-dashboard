'use strict';
window.StatusDash = window.StatusDash || {};

/**
 * Shared utilities: escaping, sanitisation, formatting, debounce.
 * No external dependencies.
 */
window.StatusDash.utils = (() => {

  // ── HTML escaping ─────────────────────────────────────────────────────────
  const ESC_MAP = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' };

  /** Escape a value for safe inclusion as HTML text or attribute content. */
  function escHtml(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, c => ESC_MAP[c]);
  }

  // ── HTML sanitiser (allowlist) ────────────────────────────────────────────
  const SAFE_TAGS  = new Set(['p','br','strong','em','b','i','ul','ol','li','span','small','a','code']);
  const SAFE_ATTRS = { a: ['href'] };

  function _walkNode(src, dest) {
    src.childNodes.forEach(n => {
      if (n.nodeType === Node.TEXT_NODE) {
        dest.appendChild(document.createTextNode(n.textContent));
        return;
      }
      if (n.nodeType !== Node.ELEMENT_NODE) return;
      const tag = n.tagName.toLowerCase();
      if (!SAFE_TAGS.has(tag)) { _walkNode(n, dest); return; }   // strip tag, keep children
      const el = document.createElement(tag);
      (SAFE_ATTRS[tag] || []).forEach(attr => {
        if (!n.hasAttribute(attr)) return;
        const val = n.getAttribute(attr);
        if (attr === 'href') {
          if (!/^https?:\/\//i.test(val)) return;                 // HTTPS-only links
          el.setAttribute('href', val);
          el.setAttribute('rel', 'noopener noreferrer');
          el.setAttribute('target', '_blank');
        } else {
          el.setAttribute(attr, val);
        }
      });
      _walkNode(n, el);
      dest.appendChild(el);
    });
  }

  /**
   * Sanitise a raw HTML string using a strict tag/attribute allowlist.
   * Returns a detached <div> DOM node; call .innerHTML to read or append directly.
   */
  function sanitizeHtml(dirty) {
    const doc = new DOMParser().parseFromString(String(dirty || ''), 'text/html');
    const out = document.createElement('div');
    _walkNode(doc.body, out);
    return out;
  }

  // ── Date formatting ───────────────────────────────────────────────────────
  function fmtDate(d) {
    if (!d || !(d instanceof Date) || isNaN(d) || d.getTime() === 0) return 'Unknown date';
    return d.toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
      timeZone: 'UTC', timeZoneName: 'short',
    });
  }

  // ── URL safety ────────────────────────────────────────────────────────────
  /** Returns true only for https: URLs. */
  function isSafeUrl(url) {
    try { return new URL(String(url)).protocol === 'https:'; } catch { return false; }
  }

  // ── Debounce ──────────────────────────────────────────────────────────────
  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  // ── Input sanitisation ────────────────────────────────────────────────────
  /** Clamp and trim user-supplied filter strings. */
  function sanitizeInput(v, maxLen = 200) {
    return String(v ?? '').replace(/[<>"']/g, '').slice(0, maxLen).trim();
  }

  return { escHtml, sanitizeHtml, fmtDate, isSafeUrl, debounce, sanitizeInput };
})();
