'use strict';
window.StatusDash = window.StatusDash || {};
window.StatusDash.providers = window.StatusDash.providers || {};

/** Oracle Cloud Infrastructure — incident RSS feed */
window.StatusDash.providers.oci = (() => {
  const ID    = 'oci';
  const NAME  = 'Oracle Cloud';
  const COLOR = '#C74634';
  const URL   = 'https://ocistatus.oraclecloud.com/api/v2/incident-summary.rss';

  const DASH_RULES = [
    [/vcn|virtual cloud network|fastconnect|load balanc|dns|network firewall|site-to-site|vpn|ipv6|drg|dynamic routing|service gateway|nat gateway/i, 'Networking'],
    [/compute|container engine|kubernetes|oke|functions|\bfn\b|hpc|bare metal|virtual machine|\bvm\b|gpu|autoscal|instance pool|capacity reserv/i, 'Compute'],
    [/object storage|block volume|file storage|data transfer|storage gateway|archive storage/i, 'Storage'],
    [/database|autonomous|mysql|heatwave|nosql|oracle db|oci db|data safe|goldengate|data catalog|migration/i, 'Database'],
    [/identity|iam|vault|secret|kms|key management|security|waf|cloud guard|bastion|certificate|threat intel|vulnerab/i, 'Security'],
    [/api gateway|events|streaming|queue|service connector|integration|messaging|notifications|email delivery/i, 'Integration'],
    [/ai |generative ai|language|vision|speech|anomaly|forecast|machine learning|data science|big data|analytics|dataflow|opensearch|search/i, 'AI & Analytics'],
    [/monitor|logging|log analytics|console|resource manager|tagging|governance|budgets|cost|usage|support|quota|limits/i, 'Management'],
  ];

  function _dashboard(svc) {
    for (const [re, cat] of DASH_RULES) if (re.test(svc)) return cat;
    return 'Other';
  }

  function _slug(raw) {
    const s = (raw || '').toLowerCase();
    if (s.includes('resolv')) return 'resolved';
    if (s.includes('monitor')) return 'monitoring';
    if (s.includes('identif')) return 'identified';
    if (s.includes('investig')) return 'investigating';
    return 'resolved';
  }

  function _parseSmall(el) {
    if (!el) return '';
    let m = '', d = '', t = '';
    el.childNodes.forEach(n => {
      if (n.nodeType === Node.TEXT_NODE) { const v = n.textContent.trim(); if (v && v !== 'UTC') m += v; }
      else if (n.nodeType === Node.ELEMENT_NODE) {
        const vname = n.getAttribute('data-var');
        if (vname === 'date') d = n.textContent.trim();
        else if (vname === 'time') t = n.textContent.trim();
        else m += n.textContent.trim();
      }
    });
    return (m && d && t) ? `${m} ${d}, ${t} UTC` : el.textContent.trim();
  }

  function _parseUpdates(htmlStr) {
    const div = document.createElement('div');
    div.innerHTML = htmlStr;
    const updates = [];
    div.querySelectorAll('p').forEach(p => {
      const time   = _parseSmall(p.querySelector('small'));
      const status = p.querySelector('strong')?.textContent.trim() || '';
      const clone  = p.cloneNode(true);
      clone.querySelectorAll('small,strong,br').forEach(e => e.remove());
      const text   = clone.textContent.trim().replace(/^[-–—]\s*/, '');
      if (status || text) updates.push({ time, status, text });
    });
    return updates;
  }

  function parse(xml) {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    if (doc.querySelector('parsererror')) throw new Error('OCI: malformed RSS');
    return [...doc.querySelectorAll('item')].map(item => {
      const title   = item.querySelector('title')?.textContent.trim() || '';
      const descRaw = item.querySelector('description')?.textContent || '';
      const link    = item.querySelector('link')?.textContent.trim() || '';
      const pubDate = item.querySelector('pubDate')?.textContent || '';
      const guid    = item.querySelector('guid')?.textContent || `oci-${Math.random()}`;
      const parts   = title.split('|').map(s => s.trim());
      const updates = _parseUpdates(descRaw);
      const { isSafeUrl } = window.StatusDash.utils;
      return {
        id: `oci:${guid}`,
        provider: ID, providerName: NAME, providerColor: COLOR,
        service:   parts[0] || title,
        region:    parts[1] || 'Unknown',
        reference: parts[2] || '',
        dashboard: _dashboard(parts[0] || title),
        slug:      _slug(updates[0]?.status),
        link:      isSafeUrl(link) ? link : '',
        publishedAt: pubDate ? new Date(pubDate) : new Date(0),
        updates,
      };
    });
  }

  async function fetchIncidents(force = false) {
    const xml = await window.StatusDash.fetcher.fetchXml(URL, ID, force);
    return parse(xml);
  }

  return { id: ID, name: NAME, color: COLOR, fetchIncidents };
})();
