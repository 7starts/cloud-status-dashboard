'use strict';
window.StatusDash = window.StatusDash || {};

/**
 * IP Ranges — public cloud provider IP address ranges.
 * Sources: GCP · Azure · AWS · OCI
 */
window.StatusDash.ipRanges = (function () {
  const { escHtml, debounce } = window.StatusDash.utils;

  // ── Provider definitions ──────────────────────────────────────────────────
  const PROVIDERS = [
    { id: 'gcp',   name: 'Google Cloud',       color: '#4285F4',
      url: 'https://www.gstatic.com/ipranges/cloud.json' },
    { id: 'aws',   name: 'Amazon Web Services', color: '#FF9900',
      url: 'https://ip-ranges.amazonaws.com/ip-ranges.json' },
    { id: 'oci',   name: 'Oracle Cloud',        color: '#C74634',
      url: 'https://docs.oracle.com/en-us/iaas/tools/public_ip_ranges.json' },
    { id: 'azure', name: 'Microsoft Azure',     color: '#0078D4',
      url: 'https://download.microsoft.com/download/7/1/d/71d86715-5596-4529-9b13-da13a5de5b63/ServiceTags_Public_20260406.json' },
  ];

  const PAGE_SIZE = 100;

  const state = {
    rows:     [],
    filtered: [],
    page:     1,
    sort:     { field: 'provider', dir: 'asc' },
    filters:  { provider: '', region: '', search: '' },
    status:   {},
    loaded:   false,
  };

  // ── Parsers ───────────────────────────────────────────────────────────────

  function parseGcp(json) {
    const rows = [];
    (json.prefixes || []).forEach(function (p, i) {
      if (p.ipv4Prefix) rows.push({
        id: 'gcp:' + i + ':v4', provider: 'gcp', providerName: 'Google Cloud',
        service: p.service || 'Google Cloud', region: p.scope || 'global',
        cidrs: [p.ipv4Prefix], cidr: p.ipv4Prefix, ipVersion: '4', extra: '',
      });
      if (p.ipv6Prefix) rows.push({
        id: 'gcp:' + i + ':v6', provider: 'gcp', providerName: 'Google Cloud',
        service: p.service || 'Google Cloud', region: p.scope || 'global',
        cidrs: [p.ipv6Prefix], cidr: p.ipv6Prefix, ipVersion: '6', extra: '',
      });
    });
    return rows;
  }

  function parseAws(json) {
    const rows = [];
    (json.prefixes || []).forEach(function (p, i) {
      if (!p.ip_prefix) return;
      rows.push({
        id: 'aws:v4:' + i, provider: 'aws', providerName: 'Amazon Web Services',
        service: p.service || 'AMAZON', region: p.region || 'global',
        cidrs: [p.ip_prefix], cidr: p.ip_prefix, ipVersion: '4',
        extra: p.network_border_group && p.network_border_group !== p.region
          ? 'Border: ' + p.network_border_group : '',
      });
    });
    (json.ipv6_prefixes || []).forEach(function (p, i) {
      if (!p.ipv6_prefix) return;
      rows.push({
        id: 'aws:v6:' + i, provider: 'aws', providerName: 'Amazon Web Services',
        service: p.service || 'AMAZON', region: p.region || 'global',
        cidrs: [p.ipv6_prefix], cidr: p.ipv6_prefix, ipVersion: '6',
        extra: p.network_border_group && p.network_border_group !== p.region
          ? 'Border: ' + p.network_border_group : '',
      });
    });
    return rows;
  }

  // Azure region code → friendly name
  const AZ_REGIONS = {
    australiacentral:'Australia Central', australiacentral2:'Australia Central 2',
    australiaeast:'Australia East', australiasoutheast:'Australia Southeast',
    brazilsouth:'Brazil South', brazilsoutheast:'Brazil Southeast',
    canadacentral:'Canada Central', canadaeast:'Canada East',
    centralindia:'Central India', centralus:'Central US',
    eastasia:'East Asia', eastus:'East US', eastus2:'East US 2',
    francecentral:'France Central', francesouth:'France South',
    germanynorth:'Germany North', germanywestcentral:'Germany West Central',
    israelcentral:'Israel Central', italynorth:'Italy North',
    japaneast:'Japan East', japanwest:'Japan West',
    jioindiacentral:'Jio India Central', jioindiawest:'Jio India West',
    koreacentral:'Korea Central', koreasouth:'Korea South',
    malaysiasouth:'Malaysia South', mexicocentral:'Mexico Central',
    newzealandnorth:'New Zealand North', northcentralus:'North Central US',
    northeurope:'North Europe', norwayeast:'Norway East', norwaywest:'Norway West',
    polandcentral:'Poland Central', qatarcentral:'Qatar Central',
    southafricanorth:'South Africa North', southafricawest:'South Africa West',
    southcentralus:'South Central US', southeastasia:'Southeast Asia',
    southindia:'South India', spaincentral:'Spain Central',
    swedencentral:'Sweden Central', switzerlandnorth:'Switzerland North',
    switzerlandwest:'Switzerland West', uaecentral:'UAE Central',
    uaenorth:'UAE North', uksouth:'UK South', ukwest:'UK West',
    westcentralus:'West Central US', westeurope:'West Europe',
    westindia:'West India', westus:'West US', westus2:'West US 2', westus3:'West US 3',
  };

  function parseAzure(json) {
    const rows = [];
    // Azure ServiceTags: one row per service tag (each tag may contain many prefixes)
    (json.values || []).forEach(function (v, i) {
      const props    = v.properties || {};
      const prefixes = props.addressPrefixes || [];
      if (!prefixes.length) return;
      const svcName  = props.systemService || v.name;
      const region   = props.region ? (AZ_REGIONS[props.region] || props.region) : 'global';
      const features = (props.networkFeatures || []).join(', ');
      // Show full tag name in extra if it differs from the base service name
      const tagLabel = (v.name !== svcName) ? v.name : '';
      const extra    = [tagLabel, features].filter(Boolean).join(' \u2014 ');
      const hasV4    = prefixes.some(function (p) { return !p.includes(':'); });
      const hasV6    = prefixes.some(function (p) { return  p.includes(':'); });
      const ipVer    = hasV4 && hasV6 ? '4+6' : hasV4 ? '4' : '6';
      rows.push({
        id: 'azure:' + i, provider: 'azure', providerName: 'Microsoft Azure',
        service: svcName, region: region,
        cidrs: prefixes,
        cidr:  prefixes.length === 1 ? prefixes[0] : prefixes.length + '\u202fpfx',
        ipVersion: ipVer, extra: extra,
      });
    });
    return rows;
  }

  function parseOci(json) {
    const rows = [];
    (json.regions || []).forEach(function (r) {
      (r.cidrs || []).forEach(function (c, i) {
        if (!c.cidr) return;
        const tags = (c.tags || []).join(', ');
        rows.push({
          id: 'oci:' + r.region + ':' + i, provider: 'oci', providerName: 'Oracle Cloud',
          service: tags || 'OCI', region: r.region || 'global',
          cidrs: [c.cidr], cidr: c.cidr,
          ipVersion: c.cidr.includes(':') ? '6' : '4',
          extra: c.tags && c.tags.length > 1 ? 'Tags: ' + tags : '',
        });
      });
    });
    return rows;
  }

  // ── Filter + sort ─────────────────────────────────────────────────────────

  function applyFilters() {
    const { provider, region, search } = state.filters;
    const q = search.toLowerCase().trim();

    state.filtered = state.rows.filter(function (r) {
      if (provider && r.provider !== provider) return false;
      if (region   && !r.region.toLowerCase().includes(region.toLowerCase())) return false;
      if (q) {
        const hit =
          r.service.toLowerCase().includes(q) ||
          r.region.toLowerCase().includes(q)  ||
          r.cidr.toLowerCase().includes(q)    ||
          r.extra.toLowerCase().includes(q)   ||
          r.cidrs.some(function (c) { return c.toLowerCase().includes(q); });
        if (!hit) return false;
      }
      return true;
    });

    const { field, dir } = state.sort;
    const mul = dir === 'asc' ? 1 : -1;
    state.filtered.sort(function (a, b) {
      const va = (a[field] || '').toLowerCase();
      const vb = (b[field] || '').toLowerCase();
      return va < vb ? -mul : va > vb ? mul : 0;
    });

    state.page = 1;
    _render();
  }

  // ── DOM helpers ───────────────────────────────────────────────────────────

  const $  = function (id) { return document.getElementById(id); };

  // ── Renderers ─────────────────────────────────────────────────────────────

  function _render() {
    _renderStatus();
    _renderCount();
    _renderTable();
    _renderPagination();
  }

  function _renderStatus() {
    const bar = $('irProviderBar');
    if (!bar) return;
    bar.innerHTML = PROVIDERS.map(function (p) {
      const st = state.status[p.id] || { state: 'idle' };
      let icon = '○', detail = '';
      if (st.state === 'loading') { icon = '↻'; detail = 'Loading\u2026'; }
      if (st.state === 'success') { icon = '✓'; detail = st.count.toLocaleString() + ' ranges'; }
      if (st.state === 'error')   { icon = '✕'; detail = 'Failed'; }
      return '<div class="provider-pill" data-provider="' + escHtml(p.id) + '" data-state="' + escHtml(st.state) + '"'
        + ' title="' + escHtml(st.error || p.name) + '">'
        + '<span class="pp-icon">'   + icon                + '</span>'
        + '<span class="pp-name">'   + escHtml(p.name)     + '</span>'
        + '<span class="pp-detail">' + escHtml(detail)     + '</span>'
        + '</div>';
    }).join('');
  }

  function _renderCount() {
    const el = $('irCount');
    if (!el) return;
    const total = state.filtered.length;
    if (!total) { el.textContent = 'No ranges match current filters'; return; }
    const start = (state.page - 1) * PAGE_SIZE + 1;
    const end   = Math.min(state.page * PAGE_SIZE, total);
    el.textContent = 'Showing ' + start.toLocaleString()
      + '\u2013' + end.toLocaleString()
      + ' of '   + total.toLocaleString() + ' ranges';
  }

  function _renderTable() {
    const tbody = $('irTableBody');
    if (!tbody) return;
    const start = (state.page - 1) * PAGE_SIZE;
    const slice = state.filtered.slice(start, start + PAGE_SIZE);

    if (!slice.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="ir-empty">No results \u2014 try adjusting filters.</td></tr>';
      return;
    }

    tbody.innerHTML = slice.map(function (r) {
      const multi   = r.cidrs.length > 1;
      const tipText = multi
        ? r.cidrs.slice(0, 20).join('\n') + (r.cidrs.length > 20 ? '\n\u2026 and ' + (r.cidrs.length - 20) + ' more' : '')
        : '';
      const cidrCell = multi
        ? '<span class="ir-multi-cidr" title="' + escHtml(tipText) + '">' + escHtml(r.cidr) + '</span>'
        : '<code class="ir-cidr">' + escHtml(r.cidr) + '</code>';

      const ipvClass = 'ir-ipv-' + r.ipVersion.replace('+', '_');

      return '<tr>'
        + '<td data-label="Provider"><span class="badge badge-provider" data-provider="' + escHtml(r.provider) + '">'
        +   r.provider.toUpperCase()
        + '</span></td>'
        + '<td data-label="Service"  class="ir-td-service" title="' + escHtml(r.service) + '">' + escHtml(r.service) + '</td>'
        + '<td data-label="Region"   class="ir-td-region"  title="' + escHtml(r.region)  + '">' + escHtml(r.region)  + '</td>'
        + '<td data-label="IP Range" class="ir-td-cidr">' + cidrCell + '</td>'
        + '<td data-label="Type"><span class="ir-ipv ' + ipvClass + '">IPv' + escHtml(r.ipVersion) + '</span></td>'
        + '<td data-label="Info" class="ir-td-extra" title="' + escHtml(r.extra) + '">' + escHtml(r.extra) + '</td>'
        + '</tr>';
    }).join('');
  }

  function _renderPagination() {
    const container = $('irPagination');
    if (!container) return;
    const total = state.filtered.length;
    const pages = Math.ceil(total / PAGE_SIZE);
    if (pages <= 1) { container.innerHTML = ''; return; }

    const p    = state.page;
    const show = new Set([1, pages]);
    for (let n = Math.max(1, p - 2); n <= Math.min(pages, p + 2); n++) show.add(n);

    let prev = 0;
    let html = '<div class="ir-page-nav">';
    html += '<button class="ir-page-btn" ' + (p === 1 ? 'disabled' : '') + ' data-page="' + (p - 1) + '">&#8592; Prev</button>';
    [...show].sort(function (a, b) { return a - b; }).forEach(function (n) {
      if (n - prev > 1) html += '<span class="ir-page-ellipsis">&hellip;</span>';
      html += '<button class="ir-page-btn' + (n === p ? ' active' : '') + '" data-page="' + n + '">' + n + '</button>';
      prev = n;
    });
    html += '<button class="ir-page-btn" ' + (p === pages ? 'disabled' : '') + ' data-page="' + (p + 1) + '">Next &#8594;</button>';
    html += '</div>';
    container.innerHTML = html;

    container.querySelectorAll('[data-page]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.page = parseInt(btn.dataset.page, 10);
        _renderTable();
        _renderPagination();
        _renderCount();
        const wrap = $('irTableWrap');
        if (wrap) wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  function _populateRegions() {
    const sel = $('irRegion');
    if (!sel) return;
    const regions = [...new Set(state.rows.map(function (r) { return r.region; }))]
      .filter(Boolean).sort();
    const first = sel.options[0].outerHTML;
    sel.innerHTML = first + regions.map(function (r) {
      return '<option value="' + escHtml(r) + '">' + escHtml(r) + '</option>';
    }).join('');
  }

  // ── Fetch ─────────────────────────────────────────────────────────────────

  async function _loadAll(force) {
    const fetcher = window.StatusDash.fetcher;

    PROVIDERS.forEach(function (p) { state.status[p.id] = { state: 'loading' }; });
    _renderStatus();

    // Show initial loading row
    const tbody = $('irTableBody');
    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="6" class="ir-empty">'
        + '<div class="spinner"></div><div>Fetching IP ranges&hellip;</div></td></tr>';
    }

    const results = await Promise.allSettled(PROVIDERS.map(async function (p) {
      try {
        const json = await fetcher.fetchJson(p.url, p.id, !!force);
        let rows;
        if      (p.id === 'gcp')   rows = parseGcp(json);
        else if (p.id === 'aws')   rows = parseAws(json);
        else if (p.id === 'azure') rows = parseAzure(json);
        else if (p.id === 'oci')   rows = parseOci(json);
        else rows = [];
        state.status[p.id] = { state: 'success', count: rows.length };
        _renderStatus();
        return rows;
      } catch (err) {
        console.error('[ipRanges]', p.id, err.message);
        state.status[p.id] = { state: 'error', count: 0, error: err.message };
        _renderStatus();
        return [];
      }
    }));

    state.rows   = results.flatMap(function (r) { return r.value || []; });
    state.loaded = true;
    _populateRegions();
    applyFilters();
  }

  // ── View switcher ─────────────────────────────────────────────────────────

  function _setupViewSwitcher() {
    const btnDash = $('viewBtnDashboard');
    const btnIp   = $('viewBtnIpRanges');
    const mainEl  = document.getElementById('dashboardMain');
    const ipPanel = $('ipRangesPanel');

    function _showDash() {
      if (btnDash) { btnDash.classList.add('active'); btnDash.setAttribute('aria-pressed', 'true'); }
      if (btnIp)   { btnIp.classList.remove('active'); btnIp.setAttribute('aria-pressed', 'false'); }
      if (mainEl)  mainEl.classList.remove('is-hidden');
      if (ipPanel) ipPanel.classList.add('is-hidden');
    }

    function _showIp() {
      if (btnIp)   { btnIp.classList.add('active'); btnIp.setAttribute('aria-pressed', 'true'); }
      if (btnDash) { btnDash.classList.remove('active'); btnDash.setAttribute('aria-pressed', 'false'); }
      if (mainEl)  mainEl.classList.add('is-hidden');
      if (ipPanel) ipPanel.classList.remove('is-hidden');
      if (!state.loaded) _loadAll(false);
    }

    if (btnDash) btnDash.addEventListener('click', _showDash);
    if (btnIp)   btnIp.addEventListener('click', _showIp);
  }

  // ── Wire filter controls ──────────────────────────────────────────────────

  function _wireFilters() {
    const search   = $('irSearch');
    const region   = $('irRegion');
    const provider = $('irProvider');
    const sortSel  = $('irSort');
    const sortDir  = $('irSortDir');
    const clearBtn = $('irClear');
    const reloadBtn = $('irReload');

    const onSearch = debounce(function () {
      state.filters.search = search ? search.value : '';
      applyFilters();
    }, 280);

    if (search)   search.addEventListener('input', onSearch);
    if (region)   region.addEventListener('change', function () { state.filters.region   = region.value;   applyFilters(); });
    if (provider) provider.addEventListener('change', function () { state.filters.provider = provider.value; applyFilters(); });
    if (sortSel)  sortSel.addEventListener('change', function () { state.sort.field = sortSel.value; applyFilters(); });
    if (sortDir)  sortDir.addEventListener('click', function () {
      state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
      sortDir.textContent = state.sort.dir === 'asc' ? '↑' : '↓';
      applyFilters();
    });
    if (clearBtn) clearBtn.addEventListener('click', function () {
      state.filters = { provider: '', region: '', search: '' };
      if (search)   search.value   = '';
      if (region)   region.value   = '';
      if (provider) provider.value = '';
      applyFilters();
    });
    if (reloadBtn) reloadBtn.addEventListener('click', function () { _loadAll(true); });
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  _setupViewSwitcher();
  _wireFilters();

  return { reload: function () { _loadAll(true); } };
}());
