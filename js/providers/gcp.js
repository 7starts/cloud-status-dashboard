'use strict';
window.StatusDash = window.StatusDash || {};
window.StatusDash.providers = window.StatusDash.providers || {};

/** Google Cloud Platform — incidents JSON API */
window.StatusDash.providers.gcp = (() => {
  const ID    = 'gcp';
  const NAME  = 'Google Cloud';
  const COLOR = '#4285F4';
  const URL   = 'https://status.cloud.google.com/incidents.json';

  const DASH_RULES = [
    [/compute engine|cloud run|cloud functions|gke|kubernetes|app engine|batch|hpc|vmware|bare metal/i, 'Compute'],
    [/cloud storage|persistent disk|filestore|transfer|archive|backup/i, 'Storage'],
    [/cloud sql|cloud spanner|bigtable|firestore|datastore|memorystore|alloydb|database/i, 'Database'],
    [/vpc|cloud dns|cloud cdn|load balanc|cloud nat|interconnect|vpn|network|traffic director/i, 'Networking'],
    [/iam|identity|key management|secret manager|certificate|cloud armor|access|policy|security/i, 'Security'],
    [/pub.sub|cloud tasks|eventarc|workflows|apigee|api gateway|cloud endpoints|messaging/i, 'Integration'],
    [/vertex ai|bigquery|dataflow|dataproc|cloud composer|looker|analytics|ml|ai platform|automl|dialogflow/i, 'AI & Analytics'],
    [/cloud monitoring|cloud logging|cloud trace|debugger|profiler|deployment manager|resource manager|billing|operations/i, 'Management'],
  ];

  function _dashboard(svcName) {
    for (const [re, cat] of DASH_RULES) if (re.test(svcName)) return cat;
    return 'Other';
  }

  /**
   * GCP update statuses: INVESTIGATING, IDENTIFIED, MONITORING, RESOLVED, AVAILABLE
   */
  function _slug(inc) {
    // If incident has an end date or is not currently affecting, it's resolved
    if (!inc.currently_affecting || inc.end) {
      return 'resolved';
    }
    const s = (inc.most_recent_update?.status || '').toUpperCase();
    if (s === 'RESOLVED' || s === 'AVAILABLE') return 'resolved';
    if (s === 'MONITORING')                    return 'monitoring';
    if (s === 'IDENTIFIED')                    return 'identified';
    return 'investigating';
  }

  /**
   * Try to extract a region from the incident description or affected_products.
   * GCP incidents don't always specify a region explicitly.
   */
  const GCP_REGIONS = [
    'us-central1','us-east1','us-east4','us-west1','us-west2','us-west3','us-west4',
    'northamerica-northeast1','northamerica-northeast2','southamerica-east1','southamerica-west1',
    'europe-north1','europe-west1','europe-west2','europe-west3','europe-west4',
    'europe-west6','europe-west8','europe-west9','europe-central2',
    'asia-east1','asia-east2','asia-northeast1','asia-northeast2','asia-northeast3',
    'asia-south1','asia-south2','asia-southeast1','asia-southeast2',
    'australia-southeast1','australia-southeast2',
    'me-central1','me-central2','me-west1','africa-south1',
  ];

  function _extractRegion(text) {
    const lower = (text || '').toLowerCase();
    const found = GCP_REGIONS.filter(r => lower.includes(r));
    if (!found.length) return 'Multiple Regions';
    if (found.length === 1) return found[0];
    return `${found[0]} +${found.length - 1} more`;
  }

  function _parseUpdates(updates = []) {
    return updates.map(u => ({
      time:   u.when || u.created || '',
      status: u.status || '',
      text:   u.text || '',
    })).reverse(); // GCP returns oldest-first; reverse so newest is [0]
  }

  function parse(data) {
    if (!Array.isArray(data)) throw new Error('GCP: expected JSON array');
    const { isSafeUrl } = window.StatusDash.utils;
    return data.map(inc => {
      const svcName  = inc.service_name
        || inc.affected_products?.[0]?.title
        || 'Google Cloud Service';
      const descText = inc.external_desc || '';
      const region   = _extractRegion(
        descText + ' ' + (inc.updates || []).map(u => u.text).join(' ')
      );
      const slug     = _slug(inc);
      const link     = inc.uri
        ? (isSafeUrl(`https://status.cloud.google.com/${inc.uri}`)
           ? `https://status.cloud.google.com/${inc.uri}`
           : 'https://status.cloud.google.com/')
        : 'https://status.cloud.google.com/';
      const parsedUpdates = _parseUpdates(inc.updates);
      return {
        id: `gcp:${inc.id || Math.random()}`,
        provider: ID, providerName: NAME, providerColor: COLOR,
        service:    svcName,
        region,
        reference:  inc.number ? String(inc.number) : (inc.id || '').slice(0, 12),
        dashboard:  _dashboard(svcName),
        slug,
        link,
        publishedAt: inc.begin ? new Date(inc.begin) : new Date(0),
        updates: parsedUpdates.length
          ? parsedUpdates
          : (descText ? [{ time: inc.begin || '', status: '', text: descText }] : []),
      };
    });
  }

  async function fetchIncidents(force = false) {
    const data = await window.StatusDash.fetcher.fetchJson(URL, ID, force);
    return parse(data);
  }

  return { id: ID, name: NAME, color: COLOR, fetchIncidents };
})();
