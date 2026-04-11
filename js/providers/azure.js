'use strict';
window.StatusDash = window.StatusDash || {};
window.StatusDash.providers = window.StatusDash.providers || {};

/**
 * Microsoft Azure provider.
 *
 * Data sources (both fetched, results merged):
 *   1. RSS feed  — active/ongoing incidents only (empty when all systems green)
 *   2. statushistoryapi — POST INCIDENT REVIEWS (resolved historical incidents)
 *
 * Azure's public RSS feed deliberately shows only live incidents; historical
 * data lives in a separate HTML partial endpoint.
 */
window.StatusDash.providers.azure = (() => {
  const ID    = 'azure';
  const NAME  = 'Microsoft Azure';
  const COLOR = '#0078D4';

  const RSS_URL     = 'https://azure.status.microsoft/en-us/status/feed/';
  const HISTORY_URL = 'https://azure.status.microsoft/en-us/statushistoryapi/';
  const BASE_URL    = 'https://azure.status.microsoft';

  // ── Dashboard categorisation ──────────────────────────────────────────────
  const DASH_RULES = [
    [/virtual machine|vm scale|vmss|aks|kubernetes|container|functions|app service|service fabric|batch|\bhpc\b|cloud services/i, 'Compute'],
    [/storage|blob|files|disks|data lake|backup|archive|import.export/i, 'Storage'],
    [/sql database|cosmos|mysql|postgresql|mariadb|redis|synapse|table storage|azure database/i, 'Database'],
    [/virtual network|vnet|load balancer|application gateway|traffic manager|\bcdn\b|expressroute|vpn gateway|firewall|dns|front door|bastion/i, 'Networking'],
    [/active directory|aad|\biam\b|key vault|security center|defender|sentinel|information protection|privileged identity|managed identit/i, 'Security'],
    [/api management|service bus|event hub|event grid|logic apps|integration|notification hub|service connector/i, 'Integration'],
    [/machine learning|cognitive|openai|bot service|search|databricks|hdinsight|data factory|stream analytics|ai /i, 'AI & Analytics'],
    [/monitor|log analytics|advisor|policy|cost management|resource|blueprints|lighthouse|\barc\b|devops|github actions/i, 'Management'],
  ];

  function _dashboard(text) {
    for (const [re, cat] of DASH_RULES) if (re.test(text)) return cat;
    return 'Other';
  }

  // ── Status helpers ────────────────────────────────────────────────────────
  const STATUS_WORDS = {
    investigating: 'investigating', active: 'investigating', degraded: 'identified',
    identified: 'identified', mitigated: 'monitoring', monitoring: 'monitoring',
    resolved: 'resolved', rca: 'resolved', 'post-incident': 'resolved', completed: 'resolved',
  };

  function _slugFromWord(word, fallbackText) {
    const mapped = STATUS_WORDS[(word || '').toLowerCase()];
    if (mapped) return mapped;
    const t = (fallbackText || '').toLowerCase();
    if (t.includes('resolv') || t.includes('mitigat')) return 'resolved';
    if (t.includes('monitor'))                          return 'monitoring';
    if (t.includes('identif'))                          return 'identified';
    return 'investigating';
  }

  // ── Safe date parser ─────────────────────────────────────────────────────
  /**
   * Returns a valid Date in range 2000-2040, or null.
   * Handles:
   *  - Standard date strings ("Mon, 06 Apr 2026 …", "2026-03-09", "Mar 9, 2026")
   *  - Unix timestamps in milliseconds (13-digit, e.g. 1745694000000)
   *  - Unix timestamps in microseconds (15-digit, e.g. 1745694000000000) → ÷1000
   *  - Unix timestamps in seconds (10-digit) → ×1000
   *
   * Why >=14 for the µs threshold:
   *   Valid ms timestamps for years 2000-2040 are 12-13 digits.
   *   Any 14+ digit "ms" value represents year >5000, so it must be a sub-ms unit.
   *   As µs (÷1000) a 15-digit value resolves to a 12-digit ms → year ~2001-2286.
   */
  function _safeDate(str) {
    if (!str) return null;
    var s = String(str).trim();

    // Pure numeric string → treat as Unix timestamp, pick unit by digit count
    if (/^\d+$/.test(s)) {
      var n = parseInt(s, 10);
      var ms;
      if      (s.length <= 10) ms = n * 1000;              // seconds → ms
      else if (s.length <= 13) ms = n;                     // already ms
      else                     ms = Math.floor(n / 1000);  // µs (or ns) → ms
      var dn = new Date(ms);
      if (!isNaN(dn.getTime()) && dn.getFullYear() >= 2000 && dn.getFullYear() <= 2040) return dn;
      return null;
    }

    var d = new Date(s);

    // Fallback: "M/D/YYYY" or "MM/DD/YYYY" — valid in Chrome but Invalid in Firefox/Safari
    if (isNaN(d.getTime())) {
      var slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (slash) d = new Date(Date.UTC(+slash[3], +slash[1] - 1, +slash[2]));
    }
    // Fallback: "D Month YYYY" — day-first formats (e.g. "09 Apr 2026")
    if (isNaN(d.getTime())) {
      var df = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})$/);
      if (df) d = new Date(df[1] + ' ' + df[2] + ' ' + df[3]);
    }

    if (isNaN(d.getTime()) || d.getTime() <= 0) return null;
    if (d.getFullYear() < 2000 || d.getFullYear() > 2040) return null;
    return d;
  }

  // ── RSS feed parser (active incidents) ───────────────────────────────────
  /**
   * Title formats seen in the Azure RSS:
   *   "Investigating - Azure SQL Database - West Europe"
   *   "Mitigated - Azure Kubernetes Service - Multiple Regions"
   *   "Azure Active Directory - East US"       (no status prefix)
   */
  function _splitTitle(raw) {
    const parts    = raw.split(/\s*[–\-]\s*/);
    const firstLow = parts[0].trim().toLowerCase();
    if (STATUS_WORDS[firstLow] !== undefined) {
      return { statusWord: parts[0].trim(), service: (parts[1] || raw).trim(), region: parts.slice(2).join(' – ').trim() || 'Unknown' };
    }
    return { statusWord: '', service: parts[0].trim(), region: parts.slice(1).join(' – ').trim() || 'Unknown' };
  }

  function _descText(raw) {
    const d = document.createElement('div');
    d.innerHTML = raw;
    return d.textContent.trim();
  }

  function _parseRSS(xml) {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    if (doc.querySelector('parsererror')) throw new Error('Azure RSS: parse error');
    const { isSafeUrl } = window.StatusDash.utils;
    return [...doc.querySelectorAll('item')].map(item => {
      const titleRaw = item.querySelector('title')?.textContent.trim() || '';
      const descRaw  = item.querySelector('description')?.textContent || '';
      const link     = item.querySelector('link')?.textContent.trim() || '';
      const pubDate  = item.querySelector('pubDate')?.textContent || '';
      const guid     = item.querySelector('guid')?.textContent || `azure-rss-${Math.random()}`;
      const { statusWord, service, region } = _splitTitle(titleRaw);
      const descPlain = _descText(descRaw);
      return {
        id: `azure:rss:${guid}`,
        provider: ID, providerName: NAME, providerColor: COLOR,
        service, region,
        reference: guid.replace(/^urn:uuid:/, '').slice(0, 12),
        dashboard: _dashboard(service),
        slug:      _slugFromWord(statusWord, descPlain),
        link:      isSafeUrl(link) ? link : `${BASE_URL}/en-us/status/`,
        publishedAt: pubDate ? _safeDate(pubDate) : null,
        updates:   descPlain ? [{ time: '', status: statusWord || 'Update', text: descPlain }] : [],
      };
    });
  }

  // ── History HTML parser (resolved Post Incident Reviews) ──────────────────
  /**
   * The /statushistoryapi/ endpoint returns a server-rendered HTML partial.
   * We use a multi-strategy parser because the exact class names may change.
   *
   * Strategies (tried in order, first to yield items wins):
   *  A) Links whose href contains a tracking-ID-like path segment
   *  B) Common incident-card selectors
   *  C) Headings inside list items / articles
   */
  function _parseHistoryHtml(html) {
    // Strip inline styles before parsing to prevent CSP violations.
    // Chrome reports a violation for every style="" in a DOMParser-parsed document.
    var clean = String(html).replace(/\s*style\s*=\s*(?:"[^"]*"|'[^']*')/gi, '');
    const doc = new DOMParser().parseFromString(clean, 'text/html');
    if (!doc.body) return [];

    const { isSafeUrl } = window.StatusDash.utils;
    const seen = new Set();

    // Tracking-ID regex:  2-4 uppercase alphanum  +  hyphen  +  3-4 uppercase alphanum
    const TRID_RE = /\b([A-Z0-9]{2,6}-[A-Z0-9]{3,6})\b/;

    function _extractRef(el) {
      // 1. data attribute
      const da = el.getAttribute('data-tracking-id') || el.getAttribute('data-event-id') ||
                 el.querySelector('[data-tracking-id]')?.getAttribute('data-tracking-id') || '';
      if (da) return da.toUpperCase();
      // 2. link href  (e.g. ?pirid=8GCS-858  or  /history/8GCS-858)
      const href = el.querySelector('a')?.getAttribute('href') || '';
      const hm = href.match(/(?:pirid|trackingid|tracking.id)=([^&]+)/i);
      if (hm) return hm[1].toUpperCase();
      // 3. scan visible text for the pattern
      const tm = el.textContent.match(TRID_RE);
      return tm ? tm[1] : '';
    }

    // Return str only if _safeDate can parse it into a real year 2000-2040 date.
    function _okDate(str) {
      return str && _safeDate(str) !== null ? str : null;
    }

    function _extractDate(el) {
      // 1. <time datetime="...">
      //    Azure sometimes puts a wrong-epoch ISO string in datetime (e.g. "40612-12-31T...")
      //    while the visible text holds the correct human-readable date.
      //    Always validate the attribute before trusting it.
      const timeEl = el.querySelector('time');
      if (timeEl) {
        const dt  = _okDate(timeEl.getAttribute('datetime'));
        if (dt) return dt;
        // datetime was bad or absent — try visible text content
        const txt = _okDate(timeEl.textContent.trim());
        if (txt) return txt;
      }

      // 2. data-date / data-time / data-timestamp attributes
      const da = _okDate(el.getAttribute('data-date'))      ||
                 _okDate(el.getAttribute('data-time'))       ||
                 _okDate(el.getAttribute('data-timestamp'))  ||
                 _okDate(el.getAttribute('data-event-date'));
      if (da) return da;

      // 3. Dedicated date element
      const dateEl = el.querySelector(
        '.date,.event-date,.incident-date,.start-date,.posted-date,.time,.timestamp'
      );
      if (dateEl) {
        const dt2 = _okDate(dateEl.getAttribute('datetime')) ||
                    _okDate(dateEl.getAttribute('data-date'));
        if (dt2) return dt2;
        const txt2 = _okDate(dateEl.textContent.trim());
        if (txt2) return txt2;
      }

      // 4. Scan text for recognisable date patterns
      const text = el.textContent || '';
      const m1 = text.match(/\b(\d{4}[-/]\d{2}[-/]\d{2})\b/);
      if (m1 && _okDate(m1[1])) return m1[1];
      const m2 = text.match(/\b([A-Za-z]{3,9}\.?\s+\d{1,2},?\s*\d{4})\b/);
      if (m2 && _okDate(m2[1])) return m2[1];
      const m3 = text.match(/\b(\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4})\b/);
      if (m3 && _okDate(m3[1])) return m3[1];
      const m4 = text.match(/\b(\d{1,2}\/\d{1,2}\/\d{4})\b/);
      if (m4 && _okDate(m4[1])) return m4[1];

      // 5. Widen to parent element
      const parent = el.parentElement;
      if (parent) {
        const pt = parent.querySelector('time');
        if (pt) {
          const pdt = _okDate(pt.getAttribute('datetime')) || _okDate(pt.textContent.trim());
          if (pdt) return pdt;
        }
        const pText = parent.textContent || '';
        const p1 = pText.match(/\b(\d{4}[-/]\d{2}[-/]\d{2})\b/);
        if (p1 && _okDate(p1[1])) return p1[1];
        const p2 = pText.match(/\b([A-Za-z]{3,9}\.?\s+\d{1,2},?\s*\d{4})\b/);
        if (p2 && _okDate(p2[1])) return p2[1];
      }

      return '';
    }

    function _extractService(el, title) {
      // Try dedicated service element
      const s = el.querySelector('.service,.service-name,.affected-service,.event-service');
      if (s) return s.textContent.trim();
      // Fall back: first non-title line of text
      const lines = el.innerText?.split('\n').map(l => l.trim()).filter(Boolean) || [];
      if (lines.length > 1) return lines[1];
      // Last resort: guess from title keywords
      const match = title.match(/Azure\s[\w\s]+?(?=\s[-|–]|$)/);
      return match ? match[0].trim() : 'Azure Service';
    }

    function _buildIncident(el) {
      const ref     = _extractRef(el);
      const titleEl = el.querySelector('h1,h2,h3,h4,a') || el;
      const title   = titleEl.textContent.trim().replace(/\s+/g, ' ');
      if (!title || title.length < 6) return null;
      const key = ref || title;
      if (seen.has(key)) return null;
      seen.add(key);

      const dateStr = _extractDate(el);
      const service = _extractService(el, title);
      const linkEl  = el.querySelector('a[href]');
      const rawHref = linkEl?.getAttribute('href') || '';
      let link = rawHref.startsWith('http') ? rawHref : (rawHref ? `${BASE_URL}${rawHref}` : `${BASE_URL}/en-us/status/history/`);
      if (!isSafeUrl(link)) link = `${BASE_URL}/en-us/status/history/`;

      return {
        id: `azure:history:${ref || title.slice(0, 20).replace(/\s/g, '-')}`,
        provider: ID, providerName: NAME, providerColor: COLOR,
        service:  service || title,
        region:   'Multiple Regions',
        reference: ref,
        dashboard: _dashboard(service || title),
        slug:      'resolved',
        link,
        publishedAt: dateStr ? _safeDate(dateStr) : null,
        updates:   [{ time: dateStr, status: 'Post Incident Review', text: title }],
      };
    }

    // Strategy A — links containing tracking-ID-style query params
    let anchors = [...doc.querySelectorAll('a[href*="pirid"], a[href*="trackingid"], a[href*="tracking"]')];
    let containers = anchors.map(a => a.closest('li,article,section,div.event,div.incident,[data-tracking-id]') || a.parentElement);

    // Strategy B — common semantic selectors
    if (!containers.filter(Boolean).length) {
      containers = [...doc.querySelectorAll(
        '[data-tracking-id],[data-event-id],.event-list-item,.status-event,.incident-item,' +
        '.event-card,.status-history-item,.history-item,article,li.event'
      )];
    }

    // Strategy C — headings inside block elements (most generic fallback)
    if (!containers.filter(Boolean).length) {
      containers = [...doc.querySelectorAll('h2,h3,h4')]
        .map(h => h.closest('li,article,section,div') || h.parentElement);
    }

    return containers
      .filter(Boolean)
      .map(_buildIncident)
      .filter(Boolean);
  }

  // ── Public fetchIncidents ─────────────────────────────────────────────────
  async function fetchIncidents(force = false) {
    const { fetcher } = window.StatusDash;

    // Fire RSS + both history pages concurrently instead of sequentially
    const [rssRes, h1Res, h2Res] = await Promise.allSettled([
      fetcher.fetchXml(RSS_URL,                    ID, force),
      fetcher.fetchXml(HISTORY_URL + '?page=1',    ID, force),
      fetcher.fetchXml(HISTORY_URL + '?page=2',    ID, force),
    ]);

    const results = [];

    if (rssRes.status === 'fulfilled') {
      try { results.push(..._parseRSS(rssRes.value)); }
      catch (e) { console.warn('[azure] RSS parse error:', e.message); }
    } else { console.warn('[azure] RSS fetch failed:', rssRes.reason.message); }

    [h1Res, h2Res].forEach(function(r, i) {
      if (r.status === 'fulfilled') {
        try { results.push(..._parseHistoryHtml(r.value)); }
        catch (e) { console.warn('[azure] history page ' + (i + 1) + ' parse error:', e.message); }
      } else { console.warn('[azure] history page ' + (i + 1) + ' failed:', r.reason.message); }
    });

    // De-duplicate by id
    const seen = new Set();
    return results.filter(function(inc) {
      if (seen.has(inc.id)) return false;
      seen.add(inc.id);
      return true;
    });
  }

  return { id: ID, name: NAME, color: COLOR, fetchIncidents };
})();
