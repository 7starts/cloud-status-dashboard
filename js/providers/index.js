'use strict';
window.StatusDash = window.StatusDash || {};

/**
 * Provider registry — aggregates all cloud providers and loads them concurrently.
 * Each provider must implement: { id, name, color, fetchIncidents(force) }
 */
window.StatusDash.providerRegistry = (() => {
  const { providers } = window.StatusDash;

  const ALL = [
    providers.oci,
    providers.azure,
    providers.aws,
    providers.gcp,
  ];

  /**
   * Fetch all providers concurrently. Failures are isolated — one failing provider
   * does not block the others.
   *
   * @param {function} onStatus  Called with (id, state, count?, errorMsg?)
   *   state: 'loading' | 'success' | 'error'
   * @param {boolean}  force     Bypass response cache
   * @returns {Promise<Incident[]>} Flat array of all normalised incidents
   */
  async function fetchAll(onStatus, force = false) {
    ALL.forEach(p => onStatus?.(p.id, 'loading'));

    const results = await Promise.allSettled(
      ALL.map(p =>
        p.fetchIncidents(force)
          .then(list => {
            onStatus?.(p.id, 'success', list.length);
            return list;
          })
          .catch(err => {
            console.error(`[${p.id}]`, err);
            onStatus?.(p.id, 'error', 0, err.message);
            return [];
          })
      )
    );

    return results.flatMap(r => r.value ?? []);
  }

  function getById(id) { return ALL.find(p => p.id === id) ?? null; }

  return { ALL, fetchAll, getById };
})();
