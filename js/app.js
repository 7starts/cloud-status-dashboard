'use strict';
window.StatusDash = window.StatusDash || {};

(function () {
  const { utils, fetcher, providerRegistry } = window.StatusDash;
  const { escHtml, fmtDate, isSafeUrl, debounce, sanitizeInput } = utils;

  const STATUS_LABELS = {
    resolved: 'Resolved', monitoring: 'Monitoring',
    identified: 'Identified', investigating: 'Investigating',
  };

  const PROVIDER_SHORT = { oci: 'OCI', azure: 'Azure', aws: 'AWS', gcp: 'GCP' };

  const PROVIDER_STATUS_URLS = {
    oci:   'https://ocistatus.oraclecloud.com/',
    azure: 'https://azure.status.microsoft/en-us/status/',
    aws:   'https://health.aws.amazon.com/health/status',
    gcp:   'https://status.cloud.google.com/',
  };

  // Shared timestamp helper used by applyFilters and renderProviderStatus
  const ts = d => (d && d.getTime && d.getTime() > 0) ? d.getTime() : 0;

  // ── Application state ─────────────────────────────────────────────────────
  const state = {
    all:            [],
    filtered:       [],
    providerStatus: {},   // { [id]: { state, count, msg } }
    isLoading:      false,
    currentTab:     'status',
  };

  // ── DOM refs ──────────────────────────────────────────────────────────────
  const $  = id => document.getElementById(id);
  const $$ = sel => document.querySelectorAll(sel);

  // ── Provider status bar ───────────────────────────────────────────────────
  function renderProviderBar() {
    const bar = $('providerBar');
    if (!bar) return;
    bar.innerHTML = providerRegistry.ALL.map(p => {
      const ps = state.providerStatus[p.id] || { state: 'idle' };
      let icon = '○', detail = 'Waiting…';
      if (ps.state === 'loading') { icon = '↻'; detail = 'Loading…'; }
      if (ps.state === 'success') { icon = '✓'; detail = ps.count > 0 ? `${ps.count} incidents` : 'No active incidents'; }
      if (ps.state === 'error')   { icon = '✕'; detail = 'Failed'; }
      return `<div class="provider-pill" data-provider="${escHtml(p.id)}" data-state="${escHtml(ps.state)}"
                   title="${ps.state === 'error' ? escHtml(ps.msg || 'Fetch failed') : escHtml(p.name)}">
                <span class="pp-icon">${icon}</span>
                <span class="pp-name">${escHtml(p.name)}</span>
                <span class="pp-detail">${escHtml(detail)}</span>
              </div>`;
    }).join('');
  }

  // ── Summary stats ─────────────────────────────────────────────────────────
  function renderStats() {
    const d = state.all;
    const activeCount = d.filter(i => ['investigating','identified'].includes(i.slug)).length;
    $('sTotal').textContent    = d.length;
    $('sActive').textContent   = activeCount;
    $('sMonitor').textContent  = d.filter(i => i.slug === 'monitoring').length;
    $('sResolved').textContent = d.filter(i => i.slug === 'resolved').length;

    // Update tab badges
    const ongoing = d.filter(i => i.slug !== 'resolved');
    const badge = $('tabBadgeHistory');
    if (badge) badge.textContent = String(d.length);
    const obadge = $('tabBadgeOngoing');
    if (obadge) obadge.textContent = String(ongoing.length);
  }

  // ── Populate filter dropdowns ─────────────────────────────────────────────
  function populateSelects() {
    const fill = (id, values) => {
      const sel  = $(id);
      const first = sel.options[0].outerHTML;
      sel.innerHTML = first + [...new Set(values)].filter(Boolean).sort()
        .map(v => `<option value="${escHtml(v)}">${escHtml(v)}</option>`).join('');
    };
    fill('fRegion',  state.all.map(i => i.region));
    fill('fService', state.all.map(i => i.service));
  }

  // ── Filter + sort ─────────────────────────────────────────────────────────
  function applyFilters() {
    const search   = sanitizeInput($('fSearch').value).toLowerCase();
    const provider = $('fProvider').value;
    const status   = $('fStatus').value;
    const region   = $('fRegion').value;
    const service  = $('fService').value;
    const dash     = $('fDashboard').value;
    const fromStr  = $('fFrom').value;
    const toStr    = $('fTo').value;
    const sort     = $('sortSel').value;

    const from = fromStr ? new Date(`${fromStr}T00:00:00Z`) : null;
    const to   = toStr   ? new Date(`${toStr}T23:59:59Z`)   : null;

    const activeFilters = [search, provider, status, region, service, dash, fromStr, toStr].filter(Boolean).length;
    const badge = $('filterActiveCount');
    badge.textContent = activeFilters;
    badge.classList.toggle('is-hidden-badge', !activeFilters);
    $('filterHint').textContent = activeFilters
      ? `${activeFilters} filter${activeFilters !== 1 ? 's' : ''} active`
      : 'Use filters to narrow results';

    state.filtered = state.all.filter(i => {
      if (provider && i.provider  !== provider) return false;
      if (status   && i.slug      !== status)   return false;
      if (region   && i.region    !== region)   return false;
      if (service  && i.service   !== service)  return false;
      if (dash     && i.dashboard !== dash)     return false;
      if (from     && i.publishedAt < from)     return false;
      if (to       && i.publishedAt > to)       return false;
      if (search) {
        const hay = [i.service, i.region, i.reference, i.providerName,
          i.updates.map(u => u.text).join(' ')].join(' ').toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });

    state.filtered.sort((a, b) => {
      if (sort === 'oldest')  return ts(a.publishedAt) - ts(b.publishedAt);
      if (sort === 'service') return a.service.localeCompare(b.service);
      if (sort === 'region')  return a.region.localeCompare(b.region);
      return ts(b.publishedAt) - ts(a.publishedAt);   // newest first; nulls go last
    });

    renderList();
  }

  // ── Render incident list (History tab) ───────────────────────────────────
  function renderList() {
    const list = $('incidentsList');
    const cnt  = $('resultsCount');
    cnt.innerHTML = `Showing <strong>${escHtml(String(state.filtered.length))}</strong> of <strong>${escHtml(String(state.all.length))}</strong> incidents`;

    if (!state.filtered.length) {
      list.innerHTML = `
        <div class="state-box" role="status">
          <div class="state-icon">&#128269;</div>
          <div class="state-title">No matching incidents</div>
          <div class="state-sub">Try adjusting your filters or search terms.</div>
        </div>`;
      return;
    }

    list.innerHTML = state.filtered.map((inc, idx) => {
      const tlHtml = inc.updates.length
        ? inc.updates.map(u => `
            <div class="tl-entry">
              <div class="tl-dot"></div>
              <div class="tl-body">
                ${u.time   ? `<div class="tl-time">${escHtml(u.time)}</div>` : ''}
                ${u.status ? `<div class="tl-status">${escHtml(u.status)}</div>` : ''}
                ${u.text   ? `<div class="tl-text">${escHtml(u.text)}</div>` : ''}
              </div>
            </div>`).join('')
        : '<p class="no-updates">No update details in feed.</p>';

      const safeLink = isSafeUrl(inc.link) ? inc.link : '';
      const provSlug = inc.providerName.split(' ')[0] === 'Amazon' ? 'AWS'
                     : inc.providerName.split(' ')[0];

      return `
        <div class="incident-card" data-idx="${idx}" role="listitem">
          <div class="card-header" role="button" tabindex="0" aria-expanded="false">
            <div class="status-dot dot-${escHtml(inc.slug)}"></div>
            <div class="card-body">
              <div class="card-top-row">
                <div class="card-service">${escHtml(inc.service)}</div>
                <div class="card-date">${escHtml(fmtDate(inc.publishedAt))}</div>
              </div>
              <div class="badge-row">
                <span class="badge badge-provider" data-provider="${escHtml(inc.provider)}">${escHtml(provSlug)}</span>
                <span class="badge badge-status badge-${escHtml(inc.slug)}">${escHtml(STATUS_LABELS[inc.slug] || inc.slug)}</span>
                <span class="badge badge-region">${escHtml(inc.region)}</span>
                <span class="badge badge-dash">${escHtml(inc.dashboard)}</span>
                ${inc.reference ? `<span class="badge badge-ref">${escHtml(inc.reference)}</span>` : ''}
              </div>
            </div>
            <span class="expand-icon" aria-hidden="true">&#9662;</span>
          </div>
          <div class="card-detail" aria-hidden="true">
            <div class="timeline">${tlHtml}</div>
            <div class="detail-footer">
              ${safeLink
                ? `<a href="${escHtml(safeLink)}" target="_blank" rel="noopener noreferrer" class="link-out">
                     View on ${escHtml(inc.providerName)} &#8599;
                   </a>`
                : '<span></span>'}
              ${inc.reference ? `<span class="detail-ref">Ref: ${escHtml(inc.reference)}</span>` : ''}
            </div>
          </div>
        </div>`;
    }).join('');
  }

  // ── Ongoing tab renderer ─────────────────────────────────────────────────
  function renderOngoing() {
    const container = $('ongoingContent');
    if (!container) return;

    const ACTIVE_SLUGS = ['investigating', 'identified', 'monitoring'];
    const active = state.all.filter(i => ACTIVE_SLUGS.includes(i.slug));

    if (!active.length) {
      container.innerHTML = `
        <div class="all-ok-banner">
          <div class="all-ok-icon">&#9989;</div>
          <div>
            <div class="all-ok-title">All systems operational</div>
            <div class="all-ok-sub">No active incidents detected across OCI, Azure, AWS, and GCP.</div>
          </div>
        </div>`;
      return;
    }

    // Group by provider
    const byProvider = {};
    providerRegistry.ALL.forEach(p => { byProvider[p.id] = []; });
    active.forEach(i => {
      if (byProvider[i.provider]) byProvider[i.provider].push(i);
      else byProvider[i.provider] = [i];
    });

    let html = '';

    providerRegistry.ALL.forEach(p => {
      const items = byProvider[p.id];
      if (!items || !items.length) return;

      // Sort by severity: investigating > identified > monitoring
      const ORDER = { investigating: 0, identified: 1, monitoring: 2 };
      items.sort((a, b) => (ORDER[a.slug] || 3) - (ORDER[b.slug] || 3));

      html += `<div class="ongoing-section">
        <div class="ongoing-section-title">${escHtml(p.name)} (${items.length})</div>`;

      items.forEach(inc => {
        const latestUpdate = inc.updates.length ? inc.updates[inc.updates.length - 1] : null;
        const safeLink = isSafeUrl(inc.link) ? inc.link : '';
        const provSlug = PROVIDER_SHORT[inc.provider] || escHtml(inc.provider);
        html += `
          <div class="ongoing-card" data-slug="${escHtml(inc.slug)}">
            <div class="status-dot dot-${escHtml(inc.slug)} ongoing-card-dot"></div>
            <div class="ongoing-card-body">
              <div class="ongoing-service">${escHtml(inc.service)}</div>
              <div class="ongoing-meta">
                <span class="badge badge-provider" data-provider="${escHtml(inc.provider)}">${escHtml(provSlug)}</span>
                <span class="badge badge-status badge-${escHtml(inc.slug)}">${escHtml(STATUS_LABELS[inc.slug] || inc.slug)}</span>
                <span class="badge badge-region">${escHtml(inc.region)}</span>
              </div>
              ${latestUpdate && latestUpdate.text
                ? `<div class="ongoing-update">${escHtml(latestUpdate.text.slice(0, 200))}</div>`
                : ''}
              <div class="ongoing-time">
                ${escHtml(fmtDate(inc.publishedAt))}
                ${safeLink ? ` &mdash; <a href="${escHtml(safeLink)}" target="_blank" rel="noopener noreferrer" class="link-out ongoing-details-link">Details &#8599;</a>` : ''}
              </div>
            </div>
          </div>`;
      });

      html += '</div>';
    });

    container.innerHTML = html;
  }

  // ── Provider status tab renderer ─────────────────────────────────────────
  function _timeSince(date) {
    if (!date || isNaN(date.getTime()) || date.getTime() === 0) return '';
    const diff = Date.now() - date.getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1)  return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  function renderProviderStatus() {
    const container = $('statusContent');
    if (!container) return;

    const ACTIVE_SLUGS = ['investigating', 'identified', 'monitoring'];

    // Build provider cards
    let cardsHtml = '<div class="status-grid">';
    providerRegistry.ALL.forEach(p => {
      const ps = state.providerStatus[p.id] || { state: 'idle' };
      const provIncidents = state.all.filter(i => i.provider === p.id);
      const activeInc = provIncidents.filter(i => ACTIVE_SLUGS.includes(i.slug));
      const investigatingCount = activeInc.filter(i => i.slug === 'investigating' || i.slug === 'identified').length;
      const monitoringCount    = activeInc.filter(i => i.slug === 'monitoring').length;

      let healthClass = 'ok', healthLabel = 'Operational';
      if (ps.state === 'loading') { healthClass = 'warning'; healthLabel = 'Loading…'; }
      else if (ps.state === 'error') { healthClass = 'warning'; healthLabel = 'Data unavailable'; }
      else if (investigatingCount > 0) { healthClass = 'alert'; healthLabel = 'Incident'; }
      else if (monitoringCount > 0)    { healthClass = 'warning'; healthLabel = 'Monitoring'; }

      // Affected services summary
      const affectedServices = [...new Set(activeInc.map(i => i.service))].slice(0, 3);
      const affectedHtml = affectedServices.length
        ? `<strong>${affectedServices.length} affected:</strong> ${affectedServices.map(s => escHtml(s)).join(', ')}${activeInc.length > 3 ? ` +${activeInc.length - 3} more` : ''}`
        : ps.state === 'loading' ? 'Loading data…'
        : ps.state === 'error'   ? 'Could not load data'
        : 'No active incidents';

      const statusUrl = PROVIDER_STATUS_URLS[p.id] || '';
      cardsHtml += `
        <div class="status-card">
          <div class="status-card-stripe" data-provider="${escHtml(p.id)}"></div>
          <div class="status-card-inner">
            <div class="status-card-header">
              <div class="status-provider-name">
                ${statusUrl
                  ? `<a href="${escHtml(statusUrl)}" target="_blank" rel="noopener noreferrer" class="provider-name-link">${escHtml(p.name)} &#8599;</a>`
                  : escHtml(p.name)}
              </div>
              <div class="status-health ${escHtml(healthClass)}">
                <div class="status-health-dot"></div>
                ${escHtml(healthLabel)}
              </div>
            </div>
            <div class="status-metrics">
              <div class="metric-item">
                <div class="metric-val ${investigatingCount > 0 ? 'some' : 'zero'}">${investigatingCount}</div>
                <div class="metric-lbl">Active</div>
              </div>
              <div class="metric-item">
                <div class="metric-val ${monitoringCount > 0 ? 'some-mon' : 'zero'}">${monitoringCount}</div>
                <div class="metric-lbl">Monitoring</div>
              </div>
            </div>
            <div class="status-affected">${affectedHtml}</div>
            ${p.id === 'aws' ? '<div class="status-feed-note">Feed: legacy RSS &mdash; verify active incidents on official page</div>' : ''}
          </div>
        </div>`;
    });
    cardsHtml += '</div>';

    // Recent incidents across all providers (last 10)
    const recent = state.all
      .slice()
      .sort((a, b) => ts(b.publishedAt) - ts(a.publishedAt))
      .slice(0, 10);

    let recentHtml = '';
    if (recent.length) {
      recentHtml = `
        <div class="recent-section-title">Recent Incidents</div>
        <div class="recent-list">
          ${recent.map(inc => {
            const safeLink = isSafeUrl(inc.link) ? inc.link : '';
            const provSlug = PROVIDER_SHORT[inc.provider] || inc.provider;
            const inner = `
              <div class="recent-dot dot-${escHtml(inc.slug)}"></div>
              <div class="recent-body">
                <div class="recent-service">${escHtml(inc.service)}</div>
                <div class="recent-meta">
                  <span class="badge badge-provider" data-provider="${escHtml(inc.provider)}">${escHtml(provSlug)}</span>
                  <span class="badge badge-status badge-${escHtml(inc.slug)} recent-badge">${escHtml(STATUS_LABELS[inc.slug] || inc.slug)}</span>
                  <span class="badge badge-region">${escHtml(inc.region)}</span>
                </div>
                <div class="recent-time">${escHtml(_timeSince(inc.publishedAt))} &mdash; ${escHtml(fmtDate(inc.publishedAt))}</div>
              </div>`;
            return safeLink
              ? `<a href="${escHtml(safeLink)}" target="_blank" rel="noopener noreferrer" class="recent-item recent-item-link">${inner}</a>`
              : `<div class="recent-item">${inner}</div>`;
          }).join('')}
        </div>`;
    }

    container.innerHTML = cardsHtml + recentHtml;
  }

  // ── Tab switching ─────────────────────────────────────────────────────────
  function switchTab(tabId) {
    state.currentTab = tabId;
    $$('.tab-btn').forEach(btn => {
      const isActive = btn.id === `tabBtn${tabId.charAt(0).toUpperCase() + tabId.slice(1)}`;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', String(isActive));
    });
    $$('.tab-panel').forEach(panel => {
      panel.classList.toggle('is-hidden', panel.id !== `tab-${tabId}`);
    });
    if (tabId === 'ongoing') renderOngoing();
    if (tabId === 'status')  renderProviderStatus();
  }

  $('tabBtnHistory').addEventListener('click', () => switchTab('history'));
  $('tabBtnOngoing').addEventListener('click',  () => switchTab('ongoing'));
  $('tabBtnStatus').addEventListener('click',   () => switchTab('status'));

  // ── Card toggle (event delegation) ────────────────────────────────────────
  function _toggle(card) {
    const isOpen = card.classList.toggle('is-open');
    card.querySelector('.card-header').setAttribute('aria-expanded', String(isOpen));
    card.querySelector('.card-detail').setAttribute('aria-hidden',   String(!isOpen));
  }

  $('incidentsList').addEventListener('click', e => {
    const hdr = e.target.closest('.card-header');
    if (hdr) _toggle(hdr.closest('.incident-card'));
  });

  $('incidentsList').addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const hdr = e.target.closest('.card-header');
    if (!hdr) return;
    e.preventDefault();
    _toggle(hdr.closest('.incident-card'));
  });

  // ── Load / refresh ────────────────────────────────────────────────────────
  async function load(force = false) {
    if (state.isLoading) return;
    state.isLoading = true;
    if (force) fetcher.clearCache();

    // Reset UI — mark all providers as loading before any fetch starts
    providerRegistry.ALL.forEach(p => { state.providerStatus[p.id] = { state: 'loading' }; });
    renderProviderBar();
    renderProviderStatus();   // show loading cards immediately on status tab

    const btn = $('btnRefresh');
    btn.disabled = true;
    btn.querySelector('.spin').style.animation = 'spin 0.7s linear infinite';
    $('lastUpdated').textContent = 'Loading…';
    $('liveDot').dataset.state   = 'loading';

    $('incidentsList').innerHTML = `
      <div class="state-box" role="status" aria-live="polite">
        <div class="spinner"></div>
        <div class="state-title">Fetching incident data&hellip;</div>
        <div class="state-sub">Connecting to OCI &middot; Azure &middot; AWS &middot; GCP concurrently.</div>
      </div>`;

    state.all = await providerRegistry.fetchAll((id, st, count, msg) => {
      state.providerStatus[id] = { state: st, count: count != null ? count : 0, msg };
      renderProviderBar();
      // Update status tab live as each provider finishes — no need to wait for all
      renderProviderStatus();
      if (state.currentTab === 'ongoing') renderOngoing();
    }, force);

    populateSelects();
    renderStats();
    applyFilters();

    // Final re-render after all providers complete (catches any tab that wasn't live-updated)
    if (state.currentTab === 'status')  renderProviderStatus();
    if (state.currentTab === 'ongoing') renderOngoing();

    const anyOk  = providerRegistry.ALL.some(p => state.providerStatus[p.id] && state.providerStatus[p.id].state === 'success');
    const now    = new Date();
    $('lastUpdated').textContent = anyOk
      ? `Updated ${now.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',timeZone:'UTC'})} UTC`
      : 'All providers failed';
    $('liveDot').dataset.state = anyOk ? 'ok' : 'error';

    btn.disabled = false;
    btn.querySelector('.spin').style.animation = '';
    state.isLoading = false;
  }

  // ── Filter event wiring ───────────────────────────────────────────────────
  const debounced = debounce(applyFilters, 280);

  ['fSearch'].forEach(id => $(id).addEventListener('input', debounced));
  ['fProvider','fStatus','fRegion','fService','fDashboard','fFrom','fTo','sortSel'].forEach(id => {
    $(id).addEventListener('change', applyFilters);
  });

  $('btnClearFilters').addEventListener('click', () => {
    ['fSearch','fProvider','fStatus','fRegion','fService','fDashboard','fFrom','fTo'].forEach(id => {
      $(id).value = '';
    });
    applyFilters();
  });

  $('btnRefresh').addEventListener('click', () => load(true));

  $('filterToggle').addEventListener('click', () => {
    const panel  = $('filterPanel');
    const isOpen = panel.classList.toggle('open');
    $('filterToggle').setAttribute('aria-expanded', String(isOpen));
    $('filterBody').hidden = !isOpen;
  });

  // ── Boot ──────────────────────────────────────────────────────────────────
  load();
})();
