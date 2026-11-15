// Token Launch Radar: a static board over the dataset main.ts writes to data.js beside this page.
// No network, no framework, no imports. Everything rendered here comes from window.RADAR.
//
// data.js contract (written by lib/model.ts):
//   { as_of, source, floor_usd, protocols_scanned, watchlist_size, board_size, early_size, live_size,
//     model_version, model, rows: [ row ], live: [ { slug, name, category, chains, tvl_usd, mcap_usd, change_7d } ] }
//   row: { rank, slug, name, category, chains, tvl_usd, change_7d, age_days, age_years, listed_at,
//          implied_value_usd, implied_low_usd, implied_high_usd, expected_airdrop_usd,
//          category_multiple, category_samples, base_value_usd, growth_multiplier, maturity_multiplier,
//          launch_unlikely, launch_reason, farm_steps }
// Where a field is absent the page derives the same figure from the row's own snapshot fields, so a
// leaner data.js still renders the whole board.
(function () {
  'use strict';

  var DATA = window.RADAR;
  var rowsEl = document.getElementById('board-rows');
  var emptyEl = document.getElementById('board-empty');
  var countEl = document.getElementById('result-count');
  var detailEl = document.getElementById('detail');
  var detailBody = document.getElementById('detail-body');
  var detailName = document.getElementById('detail-name');
  var detailSub = document.getElementById('detail-sub');
  var detailKicker = document.getElementById('detail-kicker');
  var closeBtn = document.getElementById('detail-close');
  var lastTrigger = null;

  var state = { q: '', category: 'all', chain: 'all', band: 'all', watchOnly: false, hideUnlikely: false,
    sort: 'implied', dir: -1, selected: null };

  // The filters, the sort and the open protocol live in the hash, so a filtered view or one
  // protocol's detail is a link a person can keep. Nothing leaves the page.
  function readHash() {
    var raw = String(window.location.hash || '').replace(/^#/, '');
    if (!raw) return;
    var p = new URLSearchParams(raw);
    if (p.get('q')) state.q = p.get('q');
    if (p.get('cat')) state.category = p.get('cat');
    if (p.get('chain')) state.chain = p.get('chain');
    if (p.get('band')) state.band = p.get('band');
    if (p.get('w') === '1') state.watchOnly = true;
    if (p.get('u') === '1') state.hideUnlikely = true;
    if (p.get('sort')) state.sort = p.get('sort');
    if (p.get('dir') === 'up') state.dir = 1;
    else if (p.get('dir') === 'down') state.dir = -1;
    if (p.get('p')) state.pending = p.get('p');
  }
  function writeHash() {
    var p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.category !== 'all') p.set('cat', state.category);
    if (state.chain !== 'all') p.set('chain', state.chain);
    if (state.band !== 'all') p.set('band', state.band);
    if (state.watchOnly) p.set('w', '1');
    if (state.hideUnlikely) p.set('u', '1');
    if (state.sort !== 'implied') p.set('sort', state.sort);
    if (state.dir === 1) p.set('dir', 'up');
    if (state.selected) p.set('p', state.selected);
    var next = p.toString();
    try { window.history.replaceState(null, '', next ? '#' + next : '#'); } catch (e) { /* a file page keeps no history */ }
  }

  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  function pick() {
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (v !== undefined && v !== null) return v;
    }
    return null;
  }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function truthy(v) { return v === true || v === 1 || v === 'true'; }

  if (!DATA || !Array.isArray(DATA.rows) || DATA.rows.length === 0) {
    if (countEl) countEl.textContent = 'no data';
    if (rowsEl && rowsEl.parentNode) {
      var failRow = document.createElement('tr');
      var failCell = document.createElement('td');
      failCell.colSpan = 10;
      failCell.className = 'empty';
      failCell.textContent = 'data.js did not load, so there is no board to draw. Run main.ts to write it beside this page.';
      failRow.appendChild(failCell);
      rowsEl.appendChild(failRow);
    }
    return;
  }

  var FLOOR = num(DATA.floor_usd) || 0;
  var MODEL_VERSION = DATA.model_version || 'radar';
  var LIVE = Array.isArray(DATA.live) ? DATA.live : [];
  var WATCH = {};
  (Array.isArray(DATA.watchlist) ? DATA.watchlist : []).forEach(function (s) { WATCH[s] = true; });

  // ---- formatting -------------------------------------------------------------------------
  function money(n) {
    if (n === null) return 'n/a';
    var abs = Math.abs(n);
    if (abs >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
    if (abs >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
    if (abs >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n);
  }
  function pct(n) {
    if (n === null) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(1) + '%';
  }
  function mult(n) { return n === null ? 'n/a' : n.toFixed(2) + 'x'; }
  function ageText(years, days) {
    if (years !== null && years >= 0.08) return years >= 1 ? years.toFixed(1) + 'y' : Math.max(1, Math.round(years * 12)) + 'mo';
    if (days !== null) return days >= 365 ? (days / 365).toFixed(1) + 'y' : Math.max(0, Math.round(days)) + 'd';
    return 'unknown';
  }

  // ---- row view model --------------------------------------------------------------------
  function viewOf(r) {
    var tvl = num(r.tvl_usd) || 0;
    var implied = num(r.implied_value_usd) || 0;
    var years = num(r.age_years);
    var days = num(r.age_days);
    if (years === null && days !== null) years = days / 365;
    if (years === null && typeof r.listed_at === 'string' && typeof DATA.as_of === 'string') {
      var a = Date.parse(DATA.as_of + 'T00:00:00Z');
      var b = Date.parse(r.listed_at + 'T00:00:00Z');
      if (isFinite(a) && isFinite(b)) years = Math.max(0, (a - b) / 31557600000);
    }
    var multiple = num(pick(r.category_multiple, r.multiple, r.model && r.model.category_multiple));
    var peers = num(pick(r.category_samples, r.category_peers, r.peers, r.model && r.model.category_samples));
    var growthMult = num(pick(r.growth_multiplier, r.model && r.model.growth_multiplier));
    var change = num(r.change_7d);
    if (growthMult === null) growthMult = 1 + (clamp(change === null ? 0 : change, -30, 60) / 100) * 0.5;
    var maturityMult = num(pick(r.maturity_multiplier, r.model && r.model.maturity_multiplier));
    if (maturityMult === null) {
      var y = years === null ? 1 : Math.max(0, years);
      maturityMult = 0.7 + 0.3 * (Math.min(y, 5) / 5);
    }
    var base = num(pick(r.base_value_usd, r.base_usd));
    if (base === null && multiple !== null) base = tvl * multiple;
    var low = num(pick(r.implied_low_usd, r.implied_low));
    var high = num(pick(r.implied_high_usd, r.implied_high));
    var airdrop = num(pick(r.expected_airdrop_usd, r.airdrop_usd));
    if (airdrop === null) airdrop = Math.round(implied * 0.05 * 0.1);
    var unlikely = truthy(r.launch_unlikely) || truthy(r.unlikely);
    var reason = String(pick(r.launch_reason, r.unlikely_reason, r.reason) || '');
    var onWatch = truthy(r.watchlist) || truthy(r.on_watchlist) || truthy(r.in_watchlist) || WATCH[r.slug] === true;
    return {
      rank: num(r.rank) || 0, slug: String(r.slug || ''), name: String(r.name || r.slug || ''),
      category: r.category === null || r.category === undefined || r.category === '' ? 'Other' : String(r.category),
      chains: Array.isArray(r.chains) ? r.chains.filter(function (c) { return typeof c === 'string' && c.length > 0; }) : [],
      tvl: tvl, change: change, years: years, days: days,
      implied: implied, low: low, high: high, airdrop: airdrop, multiple: multiple, peers: peers,
      base: base, growthMult: growthMult, maturityMult: maturityMult,
      unlikely: unlikely, reason: reason, watch: onWatch,
      steps: Array.isArray(r.farm_steps) ? r.farm_steps : []
    };
  }

  var ROWS = DATA.rows.map(viewOf);
  var TOTAL = ROWS.length;
  var WATCH_TOTAL = num(DATA.watchlist_size) || ROWS.filter(function (r) { return r.watch; }).length;
  var WATCH_COVERED = ROWS.filter(function (r) { return r.watch; }).length;
  var UNLIKELY = ROWS.filter(function (r) { return r.unlikely; }).length;
  // Does the model's own ranking already put every flagged protocol below every plausible one?
  var bestPlausible = Infinity;
  ROWS.forEach(function (r) { if (!r.unlikely && r.rank < bestPlausible) bestPlausible = r.rank; });
  var UNLIKELY_ABOVE = ROWS.some(function (r) { return r.unlikely && r.rank < bestPlausible; });

  // ---- header figures --------------------------------------------------------------------
  function statCell(label, value, sub, cls) {
    var d = document.createElement('div');
    d.className = 'stat' + (cls ? ' ' + cls : '');
    var dt = document.createElement('dt');
    dt.textContent = label;
    var dd = document.createElement('dd');
    dd.textContent = value;
    if (sub) {
      var small = document.createElement('small');
      small.textContent = sub;
      dd.appendChild(small);
    }
    d.appendChild(dt);
    d.appendChild(dd);
    return d;
  }

  function renderHeader() {
    document.getElementById('chip-snapshot').textContent = 'Snapshot ' + String(DATA.as_of || 'unknown');
    document.getElementById('chip-model').textContent = MODEL_VERSION + ' model';
    var scanned = num(pick(DATA.protocols_scanned, DATA.protocols_total, DATA.scanned, DATA.snapshot_size));
    var scannedSub = 'in the sealed snapshot';
    if (scanned === null) {
      scanned = TOTAL + LIVE.length;
      scannedSub = 'ranked plus reference rows';
    }
    var stats = document.getElementById('stats');
    stats.textContent = '';
    stats.appendChild(statCell('Protocols scanned', String(scanned), scannedSub));
    stats.appendChild(statCell('Pre-token ranked', String(TOTAL), (num(DATA.early_size) || 0) + ' below the floor'));
    stats.appendChild(statCell('Watchlist covered', WATCH_COVERED + ' / ' + WATCH_TOTAL, null, 'stat-accent'));
    stats.appendChild(statCell('Launch unlikely', String(UNLIKELY), 'flagged, not dropped', 'stat-warn'));

    document.getElementById('foot-snapshot').textContent = String(DATA.as_of || 'unknown') + (DATA.source ? ' from ' + DATA.source : '');
    document.getElementById('foot-floor').textContent = money(FLOOR) + ' of TVL';
    document.getElementById('foot-model').textContent = MODEL_VERSION;
  }

  // ---- filters ---------------------------------------------------------------------------
  function bandRange(band) {
    if (band === '0-100m') return [0, 1e8];
    if (band === '100m-500m') return [1e8, 5e8];
    if (band === '500m-1b') return [5e8, 1e9];
    if (band === '1b-5b') return [1e9, 5e9];
    if (band === '5b-plus') return [5e9, Infinity];
    return null;
  }

  function sortValue(r, key) {
    if (key === 'rank') return r.rank;
    if (key === 'name') return r.name.toLowerCase();
    if (key === 'category') return r.category.toLowerCase();
    if (key === 'chains') return (r.chains[0] || '').toLowerCase();
    if (key === 'tvl') return r.tvl;
    if (key === 'change') return r.change;
    if (key === 'age') return r.years;
    if (key === 'airdrop') return r.airdrop;
    if (key === 'watchlist') return r.watch ? 1 : 0;
    return r.implied;
  }

  function comparator() {
    var key = state.sort;
    var dir = state.dir;
    return function (a, b) {
      var av = sortValue(a, key);
      var bv = sortValue(b, key);
      if (av === null && bv !== null) return 1;
      if (bv === null && av !== null) return -1;
      if (av !== null && bv !== null && av !== bv) return av < bv ? -dir : dir;
      if (a.unlikely !== b.unlikely) return a.unlikely ? 1 : -1;
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    };
  }

  function filtered() {
    var q = state.q.trim().toLowerCase();
    var range = bandRange(state.band);
    var out = ROWS.filter(function (r) {
      if (state.watchOnly && !r.watch) return false;
      if (state.hideUnlikely && r.unlikely) return false;
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (state.chain !== 'all' && r.chains.indexOf(state.chain) < 0) return false;
      if (range !== null && (r.tvl < range[0] || r.tvl > range[1])) return false;
      if (q) {
        var hay = (r.name + ' ' + r.slug + ' ' + r.category + ' ' + r.chains.join(' ') + ' ' + r.reason).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
    out.sort(comparator());
    return out;
  }

  // ---- board -----------------------------------------------------------------------------
  function td(cls, text) {
    var cell = document.createElement('td');
    if (cls) cell.className = cls;
    if (text !== undefined && text !== null) cell.textContent = text;
    return cell;
  }
  function tag(cls, text) {
    var s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    return s;
  }

  function renderBoard() {
    var list = filtered();
    writeHash();
    rowsEl.textContent = '';
    var frag = document.createDocumentFragment();
    list.forEach(function (r) {
      var tr = document.createElement('tr');
      if (r.unlikely) tr.className = 'is-unlikely';
      if (r.slug === state.selected) tr.className = (tr.className ? tr.className + ' ' : '') + 'is-open';
      tr.tabIndex = 0;
      tr.setAttribute('data-slug', r.slug);

      tr.appendChild(td('cell-rank num', String(r.rank)));

      var nameCell = td('cell-name');
      var nameBtn = document.createElement('button');
      nameBtn.type = 'button';
      nameBtn.className = 'name';
      nameBtn.textContent = r.name;
      nameCell.appendChild(nameBtn);
      var metaRow = document.createElement('div');
      metaRow.className = 'meta-row';
      metaRow.appendChild(tag('slug', r.slug));
      if (r.unlikely) {
        var unlikelyTag = tag('tag', 'Unlikely: ' + (r.reason || 'off the watchlist by its own rule'));
        unlikelyTag.title = 'Unlikely launch: ' + (r.reason || 'off the watchlist by its own rule');
        metaRow.appendChild(unlikelyTag);
      }
      nameCell.appendChild(metaRow);
      tr.appendChild(nameCell);

      tr.appendChild(td('cat', r.category));
      tr.appendChild(td('chains', r.chains.length ? r.chains[0] + (r.chains.length > 1 ? ' +' + (r.chains.length - 1) : '') : 'undisclosed'));
      tr.appendChild(td('num', money(r.tvl)));
      tr.appendChild(td('num ' + (r.change === null ? '' : r.change >= 0 ? 'pos' : 'neg'), pct(r.change)));
      tr.appendChild(td('num', ageText(r.years, r.days)));

      var impliedCell = td('num');
      impliedCell.appendChild(tag('cell-value', money(r.implied)));
      if (r.low !== null && r.high !== null) impliedCell.appendChild(tag('cell-band', money(r.low) + ' - ' + money(r.high)));
      tr.appendChild(impliedCell);

      tr.appendChild(td('num cell-airdrop', money(r.airdrop)));

      var watchCell = td('cell-watch');
      if (r.watch) watchCell.appendChild(tag('badge', 'Watchlist'));
      tr.appendChild(watchCell);

      tr.addEventListener('click', function () { openDetail(r, nameBtn); });
      nameBtn.addEventListener('click', function (ev) { ev.stopPropagation(); openDetail(r, nameBtn); });
      tr.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          openDetail(r, tr);
        }
      });
      frag.appendChild(tr);
    });
    rowsEl.appendChild(frag);
    emptyEl.hidden = list.length !== 0;
    countEl.textContent = list.length + ' of ' + TOTAL + ' rows';
    document.getElementById('board-note').textContent = (state.sort === 'implied'
      ? 'Rank 1 is the highest implied value. '
      : 'Sorted by ' + state.sort + ', with ties falling back to rank. ')
      + (UNLIKELY_ABOVE
        ? 'Unlikely launches are flagged with their reason and stay on the board; this model ranks every row by implied value, so a flagged protocol can place high.'
        : 'Unlikely launches are flagged with their reason and ranked below every plausible launch.');
    var heads = document.querySelectorAll('th[data-key]');
    for (var i = 0; i < heads.length; i++) {
      if (heads[i].getAttribute('data-key') === state.sort) heads[i].setAttribute('aria-sort', state.dir === -1 ? 'descending' : 'ascending');
      else heads[i].removeAttribute('aria-sort');
    }
  }

  // ---- reference table -------------------------------------------------------------------
  function renderReference() {
    var body = document.getElementById('ref-rows');
    if (!body) return;
    body.textContent = '';
    if (LIVE.length === 0) {
      var tr = document.createElement('tr');
      var cell = td('', 'No already-trading protocol is in this dataset.');
      cell.colSpan = 5;
      tr.appendChild(cell);
      body.appendChild(tr);
      return;
    }
    LIVE.forEach(function (p) {
      var row = document.createElement('tr');
      var nameCell = td('');
      nameCell.appendChild(tag('name', String(p.name || p.slug)));
      row.appendChild(nameCell);
      row.appendChild(td('', String(p.category || 'Other')));
      row.appendChild(td('num', money(num(p.tvl_usd))));
      row.appendChild(td('num', money(num(p.mcap_usd))));
      var mcap = num(p.mcap_usd);
      var tvl = num(p.tvl_usd);
      row.appendChild(td('num', mcap !== null && tvl ? (mcap / tvl).toFixed(2) + 'x' : 'n/a'));
      body.appendChild(row);
    });
  }

  // ---- detail ----------------------------------------------------------------------------
  function heading(text) {
    var h = document.createElement('h3');
    h.textContent = text;
    return h;
  }
  function defRow(dl, label, value, cls) {
    var dt = document.createElement('dt');
    dt.textContent = label;
    var dd = document.createElement('dd');
    dd.textContent = value;
    if (cls) { dt.className = cls; dd.className = cls; }
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
  function note(text, strongText) {
    var p = document.createElement('p');
    p.className = 'note';
    if (strongText) {
      var s = document.createElement('strong');
      s.textContent = strongText;
      p.appendChild(s);
    }
    p.appendChild(document.createTextNode(text));
    return p;
  }

  function farmPlan(steps) {
    var ol = document.createElement('ol');
    ol.className = 'plan';
    steps.forEach(function (step) {
      var li = document.createElement('li');
      var wrap = document.createElement('div');
      var p = document.createElement('p');
      if (typeof step === 'string') {
        p.textContent = step;
        wrap.appendChild(p);
      } else if (step && typeof step === 'object') {
        p.textContent = String(step.text || step.step || '');
        wrap.appendChild(p);
        var meta = document.createElement('div');
        meta.className = 'meta';
        if (step.cost) meta.appendChild(tag('cost', 'Cost: ' + step.cost));
        if (step.time) meta.appendChild(tag('time', 'Time: ' + step.time));
        if (meta.childNodes.length > 0) wrap.appendChild(meta);
      } else {
        return;
      }
      li.appendChild(wrap);
      ol.appendChild(li);
    });
    return ol;
  }

  function openDetail(r, trigger) {
    lastTrigger = trigger || null;
    state.selected = r.slug;
    detailKicker.textContent = r.watch ? 'Watchlist protocol' : r.unlikely ? 'Unlikely launch' : 'Early protocol';
    detailName.textContent = r.name;
    detailSub.textContent = r.category + ' · ' + (r.chains.length ? r.chains.join(', ') : 'chain undisclosed') + ' · rank ' + r.rank + ' of ' + TOTAL;
    detailBody.textContent = '';

    var hero = document.createElement('div');
    hero.className = 'value-hero';
    var heroBig = document.createElement('b');
    heroBig.textContent = money(r.implied);
    hero.appendChild(heroBig);
    hero.appendChild(tag('', r.low !== null && r.high !== null
      ? 'implied value, 25th to 75th percentile band ' + money(r.low) + ' to ' + money(r.high)
      : 'implied value'));
    detailBody.appendChild(hero);

    detailBody.appendChild(heading('Model: TVL to implied value'));
    var dl = document.createElement('dl');
    dl.className = 'breakdown';
    defRow(dl, 'TVL', money(r.tvl));
    defRow(dl,
      'Category multiple' + (r.peers !== null ? ' (' + r.peers + (r.peers === 1 ? ' trading peer' : ' trading peers') + ')' : ''),
      r.multiple === null ? 'global median' : mult(r.multiple) + (r.peers !== null && r.peers < 3 ? ' (global fallback)' : ''));
    defRow(dl, 'Base = TVL x multiple', r.base === null ? 'n/a' : money(r.base));
    defRow(dl, 'Growth adjustment at ' + pct(r.change) + ' over 7d', mult(r.growthMult), 'adj');
    defRow(dl, 'Maturity adjustment at ' + ageText(r.years, r.days) + ' tokenless', mult(r.maturityMult), 'adj');
    defRow(dl, 'Implied value', money(r.implied), 'total');
    detailBody.appendChild(dl);

    if (r.low !== null && r.high !== null) {
      detailBody.appendChild(note('Band: the 25th to 75th percentile multiples of the same peers put this protocol at '
        + money(r.low) + ' to ' + money(r.high) + '. A wide band means the peer set disagrees about what a protocol like this is worth.'));
    }
    if (r.unlikely) {
      detailBody.appendChild(note((r.reason || 'A watchlist rule excludes it')
        + '. It stays on the board so nothing is dropped silently, but it ranks below every plausible launch.', 'Ranked as an unlikely launch. '));
    }

    detailBody.appendChild(heading('Farm plan'));
    if (r.steps.length === 0) {
      detailBody.appendChild(note('No farm plan is in this dataset for this protocol.'));
    } else {
      detailBody.appendChild(farmPlan(r.steps));
    }

    var share = TOTAL > 0 ? Math.max(1, Math.round((r.rank / TOTAL) * 100)) : 100;
    detailBody.appendChild(heading('Standing'));
    var standing = document.createElement('div');
    standing.className = 'standing';
    standing.appendChild(tag('', 'Rank ' + r.rank + ' of ' + TOTAL + ' · top ' + share + '% of the board'));
    var bar = document.createElement('div');
    bar.className = 'bar';
    var fill = document.createElement('i');
    fill.style.width = Math.max(2, 100 - share + 2) + '%';
    bar.appendChild(fill);
    standing.appendChild(bar);
    detailBody.appendChild(standing);

    detailBody.appendChild(note('Expected airdrop ' + money(r.airdrop)
      + ' = implied value x 5% community allocation x 10% assumed eligibility. A stated assumption, not a promise: nothing here says a token will be issued.'));

    detailEl.hidden = false;
    requestAnimationFrame(function () { detailEl.classList.add('is-open'); });
    closeBtn.focus();
    renderBoard();
  }

  function closeDetail() {
    detailEl.classList.remove('is-open');
    state.selected = null;
    window.setTimeout(function () { if (!state.selected) detailEl.hidden = true; }, 180);
    if (lastTrigger && lastTrigger.focus) lastTrigger.focus();
    lastTrigger = null;
    renderBoard();
  }

  // ---- wiring ----------------------------------------------------------------------------
  function fillSelect(id, values) {
    var sel = document.getElementById(id);
    values.forEach(function (v) {
      var o = document.createElement('option');
      o.value = v;
      o.textContent = v;
      sel.appendChild(o);
    });
    return sel;
  }

  function init() {
    renderHeader();
    renderReference();
    var orderClaim = document.getElementById('order-claim');
    if (orderClaim && UNLIKELY_ABOVE) {
      orderClaim.textContent = 'In this snapshot the model still ranks every row by implied value, so a flagged protocol can place above a plausible one: read the badge before you read a high rank as a launch signal.';
    }

    var cats = {};
    var chains = {};
    ROWS.forEach(function (r) {
      cats[r.category] = (cats[r.category] || 0) + 1;
      r.chains.forEach(function (c) { chains[c] = (chains[c] || 0) + 1; });
    });
    var catList = Object.keys(cats).sort(function (a, b) { return cats[b] - cats[a] || (a < b ? -1 : 1); });
    var chainList = Object.keys(chains).sort(function (a, b) { return chains[b] - chains[a] || (a < b ? -1 : 1); }).slice(0, 40);
    fillSelect('filter-category', catList);
    fillSelect('filter-chain', chainList);
    readHash();

    var q = document.getElementById('filter-q');
    q.addEventListener('input', function () { state.q = q.value; renderBoard(); });
    var cat = document.getElementById('filter-category');
    cat.addEventListener('change', function () { state.category = cat.value; renderBoard(); });
    var chain = document.getElementById('filter-chain');
    chain.addEventListener('change', function () { state.chain = chain.value; renderBoard(); });
    var band = document.getElementById('filter-band');
    band.addEventListener('change', function () { state.band = band.value; renderBoard(); });

    var watchToggle = document.getElementById('toggle-watchlist');
    watchToggle.addEventListener('click', function () {
      state.watchOnly = !state.watchOnly;
      watchToggle.setAttribute('aria-pressed', state.watchOnly ? 'true' : 'false');
      renderBoard();
    });
    var unlikelyToggle = document.getElementById('toggle-unlikely');
    unlikelyToggle.addEventListener('click', function () {
      state.hideUnlikely = !state.hideUnlikely;
      unlikelyToggle.setAttribute('aria-pressed', state.hideUnlikely ? 'true' : 'false');
      renderBoard();
    });
    document.getElementById('reset-filters').addEventListener('click', function () {
      state.q = ''; state.category = 'all'; state.chain = 'all'; state.band = 'all';
      state.watchOnly = false; state.hideUnlikely = false; state.sort = 'implied'; state.dir = -1;
      q.value = ''; cat.value = 'all'; chain.value = 'all'; band.value = 'all';
      watchToggle.setAttribute('aria-pressed', 'false');
      unlikelyToggle.setAttribute('aria-pressed', 'false');
      renderBoard();
    });

    var buttons = document.querySelectorAll('button[data-sort]');
    for (var i = 0; i < buttons.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var key = btn.getAttribute('data-sort');
          if (state.sort === key) state.dir = -state.dir;
          else {
            state.sort = key;
            state.dir = key === 'name' || key === 'category' || key === 'chains' ? 1 : -1;
          }
          renderBoard();
        });
      })(buttons[i]);
    }

    closeBtn.addEventListener('click', closeDetail);
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && !detailEl.hidden) closeDetail();
    });

    q.value = state.q;
    cat.value = state.category;
    chain.value = state.chain;
    band.value = state.band;
    watchToggle.setAttribute('aria-pressed', state.watchOnly ? 'true' : 'false');
    unlikelyToggle.setAttribute('aria-pressed', state.hideUnlikely ? 'true' : 'false');
    renderBoard();
    if (state.pending) {
      for (var k = 0; k < ROWS.length; k++) {
        if (ROWS[k].slug === state.pending) { openDetail(ROWS[k], null); break; }
      }
    }
  }

  init();
})();
