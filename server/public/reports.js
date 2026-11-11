/* Reports: a tile per report on the Reports screen; opening one swaps the tiles for it.
 *
 * Contract Ball -- a spinning 3D ball of contract time (3d-force-graph, kept in vendor/ and only loaded when the
 * ball first opens). Contracts sit in the middle with their suffixes round them; each suffix has its own ball for
 * every department that clocked time on it, and people link to the department balls they worked on. A contract's
 * rework time is a separate ball on the contract (that time also counts in its suffix and department balls).
 * Ball size = hours. Everyone sees everyone's contract time, committed or not; Non-contract time is left out.
 * Uses api() from app.js.
 */
(() => {
  const el = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
  const fmtH = (h) => (h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : `${h >= 100 ? Math.round(h).toLocaleString('en-GB') : (Math.round(h * 4) / 4).toLocaleString('en-GB')} h`);
  const bigH = (h) => fmtH(h).replace(/ (h|min)$/, '<small>$1</small>'); // the big figure: number large, unit small
  const fmtDate = (s) => new Date(`${s}T00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const LIB = 'vendor/3d-force-graph-1.80.1.min.js';
  const COMPANY = 'Clifford Machines & Technology'; // the ball in the middle that every contract hangs from

  // ---------- Reports screen: tiles <-> one report ----------
  const section = document.querySelector('[data-view-panel="reports"]');
  const openReport = (name) => {
    el('report-tiles').classList.toggle('is-hidden', Boolean(name));
    el('report-contract-ball').classList.toggle('is-hidden', name !== 'contract-ball');
    el('reports-back').classList.toggle('is-hidden', !name);
    el('reports-title').textContent = name === 'contract-ball' ? 'Contract Ball' : 'Reports';
    if (name === 'contract-ball') ball.show(); else ball.hide();
  };
  document.querySelectorAll('[data-report]').forEach((tile) => tile.addEventListener('click', () => openReport(tile.dataset.report)));
  el('reports-back').addEventListener('click', () => openReport(null));
  // Leaving Reports for another screen stops the ball drawing; coming back starts it again.
  new MutationObserver(() => { if (section.classList.contains('is-hidden')) ball.hide(); else if (!el('report-contract-ball').classList.contains('is-hidden')) ball.show(); })
    .observe(section, { attributes: true, attributeFilter: ['class'] });

  // ---------- Contract Ball ----------
  const ball = (() => {
    const state = { selected: null, span: '12m', from: '', to: '', people: true, spin: true, flow: true, labels: 'key', focus: null };
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { state.spin = false; state.flow = false; }
    const cache = new Map(); // "from|to" -> rows
    let Graph = null, loading = null, visible = false, contracts = [], rows = [], current = [];
    let nodesById = new Map(), linksAll = [], focusSet = null, needFit = true, COL = {};

    function range(span = state.span) {
      const t = today();
      switch (span) {
        case 'week': return [iso(addDays(t, -t.getDay())), iso(t)]; // weeks start on Sunday
        case 'month': return [iso(new Date(t.getFullYear(), t.getMonth(), 1)), iso(t)];
        case '3m': return [iso(addDays(t, -91)), iso(t)];
        case 'custom': return [state.from || iso(addDays(t, -30)), state.to || iso(t)];
        default: return [iso(addDays(t, -365)), iso(t)];
      }
    }
    async function fetchRows([from, to], fresh) {
      const key = `${from}|${to}`;
      if (fresh || !cache.has(key)) cache.set(key, api('GET', `/api/reports/contract-hours?from=${from}&to=${to}`).then((data) => data.rows).catch((error) => { cache.delete(key); throw error; }));
      return cache.get(key);
    }

    function loadLibrary() {
      if (window.ForceGraph3D) return Promise.resolve();
      return loading ||= new Promise((resolve, reject) => { const s = document.createElement('script'); s.src = LIB; s.onload = resolve; s.onerror = () => reject(new Error('The 3D viewer did not load. Refresh the page to try again.')); document.head.append(s); });
    }

    const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const readColours = () => { COL = { contract: css('--ball-contract'), suffix: css('--ball-suffix'), dept: css('--ball-dept'), person: css('--ball-person'), rework: css('--ball-rework'), hub: css('--ball-hub'), link: css('--ball-link'), stage: css('--ball-stage') }; };
    const rgba = (hex, a) => { const h = hex.replace('#', ''); const n = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h, 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };
    const idOf = (x) => (typeof x === 'object' ? x.id : x);
    const typeOf = (x) => ({ c: 'contract', s: 'suffix', d: 'dept', p: 'person', r: 'rework', h: 'hub' })[idOf(x)[0]];
    const sufKey = (r) => (r.suffix ? `${r.number}-${r.suffix}` : r.number);
    const sdKey = (r) => `${sufKey(r)}|${r.department}`;

    function makeGraph() {
      readColours();
      const stage = el('ball-stage');
      Graph = ForceGraph3D({ controlType: 'orbit' })(el('ball-canvas')) // its own box: the library empties whatever it draws into
        .backgroundColor(COL.stage).showNavInfo(false)
        .nodeRelSize(3).nodeResolution(18).nodeOpacity(0.95)
        .nodeVal((n) => n.val)
        .nodeLabel((n) => `${esc(n.label)} · ${fmtH(n.hours)}`)
        .nodeColor((n) => (n.type === 'hub' ? rgba(COL.hub, focusSet ? 0.15 : 0.45) : focusSet && !focusSet.has(n.id) ? rgba(COL[n.type], 0.12) : COL[n.type]))
        .linkColor((l) => (focusSet && !(focusSet.has(idOf(l.source)) && focusSet.has(idOf(l.target))) ? rgba(COL.link, 0.05) : rgba(COL.link, 0.55)))
        .linkOpacity(0.6)
        .linkWidth((l) => Math.min(4, Math.max(0.4, Math.sqrt(l.hours) / 7)))
        .linkDirectionalParticles((l) => (state.flow ? Math.min(4, Math.max(1, Math.round(l.hours / 60))) : 0))
        .linkDirectionalParticleSpeed(0.004).linkDirectionalParticleWidth(1.8)
        .linkDirectionalParticleColor((l) => COL[typeOf(l.source)])
        .onNodeClick((n) => (n.type === 'hub' ? select(null) : select(n.id, true)))
        .onBackgroundClick(() => select(null))
        .cooldownTime(5000)
        .onEngineStop(() => { if (needFit) { needFit = false; Graph.zoomToFit(700, 40); } });
      Graph.d3Force('charge').strength(-70);
      Graph.d3Force('link').distance((l) => ({ ds: 18, sc: 38, pd: 34, rc: 26, ch: 70 })[l.kind] || 30);
      Graph.controls().autoRotate = state.spin; Graph.controls().autoRotateSpeed = 0.8;
      new ResizeObserver(() => { if (stage.clientWidth) Graph.width(stage.clientWidth).height(stage.clientHeight); }).observe(stage);
      new MutationObserver(() => { readColours(); Graph.backgroundColor(COL.stage); refreshColours(); renderPanel(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      requestAnimationFrame(drawTags);
    }

    // ---------- open / close ----------
    async function show() {
      visible = true;
      if (Graph) { Graph.resumeAnimation(); if (rows.length || contracts.length) return; }
      const empty = el('ball-empty'); empty.classList.remove('is-hidden'); empty.textContent = 'Loading…';
      try {
        const [, year] = await Promise.all([loadLibrary(), fetchRows(range('12m'), true)]);
        contractList(year);
        if (!state.selected) state.selected = new Set(contracts.slice(0, 3).map((c) => c.number)); // the three most recently worked on
        if (!Graph) makeGraph();
        await reload(false);
      } catch (error) { empty.classList.remove('is-hidden'); empty.textContent = error.message || 'The Contract Ball could not load.'; }
    }
    function hide() { visible = false; Graph?.pauseAnimation(); }

    // The contract buttons: every contract with time in the last 12 months, most recently worked on first.
    function contractList(year) {
      const by = new Map();
      for (const r of year) {
        const c = by.get(r.number) || { number: r.number, customer: r.customer, machineType: r.machineType, last: '' };
        if (r.lastDate > c.last) c.last = r.lastDate;
        if (!c.customer && r.customer) c.customer = r.customer;
        by.set(r.number, c);
      }
      contracts = [...by.values()].sort((a, b) => b.last.localeCompare(a.last) || a.number.localeCompare(b.number));
      const box = el('ball-contracts'); box.innerHTML = '';
      for (const c of contracts) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'ball-chip'; b.dataset.c = c.number;
        b.title = [c.number, c.customer, c.machineType].filter(Boolean).join(' · ');
        b.innerHTML = `<b>${esc(c.number)}</b>${c.customer ? `<small>${esc(c.customer)}</small>` : ''}<small class="h"></small>`;
        b.addEventListener('click', () => { state.selected.has(c.number) ? state.selected.delete(c.number) : state.selected.add(c.number); needFit = true; build(); });
        box.append(b);
      }
    }

    async function reload(fresh) {
      const empty = el('ball-empty');
      try { rows = await fetchRows(range(), fresh); } catch (error) { empty.classList.remove('is-hidden'); empty.textContent = error.message; return; }
      needFit = true; build();
    }

    // ---------- the ball ----------
    function build() {
      current = rows.filter((r) => state.selected.has(r.number));
      const nodes = new Map(), links = new Map();
      const node = (key, type, label) => { let n = nodes.get(key); if (!n) { n = { id: key, type, label, hours: 0 }; nodes.set(key, n); } return n; };
      const link = (a, b, kind, h) => { const k = `${a}|${b}`; let l = links.get(k); if (!l) { l = { source: a, target: b, kind, hours: 0 }; links.set(k, l); } l.hours += h; };
      if (current.length) node('h:company', 'hub', COMPANY);
      for (const r of current) {
        const ck = `c:${r.number}`, sk = `s:${sufKey(r)}`, dk = `d:${sdKey(r)}`, pk = `p:${r.userId}`;
        nodes.get('h:company').hours += r.hours;
        link(ck, 'h:company', 'ch', r.hours); // every contract hangs from the company in the middle
        node(ck, 'contract', [r.number, r.customer].filter(Boolean).join(' ')).hours += r.hours;
        node(sk, 'suffix', [sufKey(r), r.suffixDescription].filter(Boolean).join(' ')).hours += r.hours;
        node(dk, 'dept', r.department).hours += r.hours;
        link(sk, ck, 'sc', r.hours); // hours flow inwards: person -> department -> suffix -> contract
        link(dk, sk, 'ds', r.hours);
        if (state.people) { node(pk, 'person', r.person).hours += r.hours; link(pk, dk, 'pd', r.hours); }
        if (r.reworkReason) { const rk = `r:${r.number}`; node(rk, 'rework', `Rework on ${r.number}`).hours += r.hours; link(rk, ck, 'rc', r.hours); }
      }
      for (const n of nodes.values()) { // keep the place of balls that stay, so the shape doesn't fly apart
        n.val = Math.max(0.5, n.hours / 15);
        const old = nodesById.get(n.id); if (old) Object.assign(n, { x: old.x, y: old.y, z: old.z, vx: old.vx, vy: old.vy, vz: old.vz });
      }
      // The company: pinned in the middle, always the same size (it is not scaled by hours), drawn as a see-through wire sphere
      const hub = nodes.get('h:company');
      if (hub) Object.assign(hub, { val: 60, fx: 0, fy: 0, fz: 0 });
      nodesById = nodes; linksAll = [...links.values()];
      if (state.focus && !nodes.has(state.focus)) state.focus = null;
      computeFocus();
      Graph.graphData({ nodes: [...nodes.values()], links: linksAll });
      if (needFit) setTimeout(() => { if (needFit && nodesById.size) Graph.zoomToFit(600, 40); }, 1200); // a first fit while it settles, then again once it stops
      const empty = el('ball-empty');
      empty.classList.toggle('is-hidden', nodes.size > 0);
      empty.textContent = state.selected.size ? 'No contract time in these dates for the contracts picked.' : 'Pick one or more contracts above to build the ball.';
      renderTotals(); renderChips(); renderPanel();
    }
    function computeFocus() {
      if (!state.focus) { focusSet = null; return; }
      focusSet = new Set([state.focus]);
      for (const l of linksAll) { const a = idOf(l.source), b = idOf(l.target); if (a === state.focus) focusSet.add(b); if (b === state.focus) focusSet.add(a); }
    }
    const refreshColours = () => Graph.nodeColor(Graph.nodeColor()).linkColor(Graph.linkColor()).linkDirectionalParticleColor(Graph.linkDirectionalParticleColor());
    function select(key, fly) {
      state.focus = key && nodesById.has(key) ? key : null;
      computeFocus(); refreshColours(); renderPanel();
      if (fly && state.focus) {
        const n = nodesById.get(state.focus); const k = 1 + 110 / (Math.hypot(n.x, n.y, n.z) || 1);
        Graph.cameraPosition({ x: n.x * k, y: n.y * k, z: n.z * k }, n, 900);
      }
    }

    function renderTotals() {
      const h = current.reduce((s, r) => s + r.hours, 0);
      const people = new Set(current.map((r) => r.userId)).size, depts = new Set(current.map((r) => r.department)).size;
      el('ball-totals').innerHTML = `<b>${state.selected.size}</b> contracts · <b>${fmtH(h)}</b> · <b>${depts}</b> departments · <b>${people}</b> people`;
    }
    function renderChips() {
      const by = {}; for (const r of rows) by[r.number] = (by[r.number] || 0) + r.hours;
      for (const b of el('ball-contracts').children) {
        const h = by[b.dataset.c] || 0;
        b.setAttribute('aria-pressed', String(state.selected.has(b.dataset.c)));
        b.classList.toggle('is-empty', !h);
        b.querySelector('.h').textContent = h ? fmtH(h) : 'no time';
      }
    }

    // ---------- details panel ----------
    const groupBy = (list, keyFn) => { const m = new Map(); for (const r of list) { const k = keyFn(r); m.set(k, (m.get(k) || 0) + r.hours); } return [...m.entries()].sort((a, b) => b[1] - a[1]); };
    const suffixLabel = (k) => { const r = current.find((x) => sufKey(x) === k); return [k, r?.suffixDescription].filter(Boolean).join(' '); };
    const personName = (id) => current.find((r) => r.userId === id)?.person || 'Someone';
    function bars(title, entries, colour, toKey, toLabel) {
      if (!entries.length) return '';
      const max = entries[0][1], more = entries.length - 8;
      return `<div class="ball-bars"><h4>${esc(title)}</h4>${entries.slice(0, 8).map(([k, v]) => {
        const key = toKey(k), live = key && nodesById.has(key), tag = live ? 'button' : 'div';
        return `<${tag} class="ball-bar"${live ? ` type="button" data-key="${esc(key)}"` : ''}><span class="n">${esc(toLabel(k))}</span><span class="v">${fmtH(v)}</span><span class="t"><i style="width:${(v / max * 100).toFixed(1)}%;background:${colour}"></i></span></${tag}>`;
      }).join('')}${more > 0 ? `<div class="ball-bar"><span class="n ball-sub">+ ${more} more</span></div>` : ''}</div>`;
    }
    function renderPanel() {
      const p = el('ball-panel');
      if (!state.focus) {
        const h = current.reduce((s, r) => s + r.hours, 0);
        p.innerHTML = `<div class="ball-panel-head"><div><h3>Where the hours went</h3><div class="ball-sub">${esc(COMPANY)}</div></div></div>
          <div class="ball-big">${bigH(h)}</div>
          <div class="ball-intro"><p>The company is the ball in the middle. Each orange ball is a contract with its suffixes round it. Each suffix has its own purple ball for every department that clocked time on it, and people link to the department balls they worked on. A red ball on a contract is its rework.</p>
          <p>Bigger balls mean more hours. The moving dots show hours flowing in from people to the contract. Click any ball for its details.</p></div>
          ${bars('Departments', groupBy(current, (r) => r.department), COL.dept, () => '', (k) => k)}
          ${bars('Suffixes', groupBy(current, sufKey), COL.suffix, (k) => `s:${k}`, suffixLabel)}`;
      } else {
        const n = nodesById.get(state.focus), t = n.type, raw = n.id.slice(2);
        const list = current.filter((r) => (t === 'contract' ? r.number === raw : t === 'suffix' ? sufKey(r) === raw : t === 'dept' ? sdKey(r) === raw : t === 'person' ? r.userId === raw : r.number === raw && r.reworkReason));
        const total = current.reduce((s, r) => s + r.hours, 0);
        const first = list.reduce((m, r) => (!m || r.firstDate < m ? r.firstDate : m), ''), last = list.reduce((m, r) => (r.lastDate > m ? r.lastDate : m), '');
        const people = new Set(list.map((r) => r.userId)).size, blocks = list.reduce((s, r) => s + r.blocks, 0);
        const byPerson = (title) => bars(title, groupBy(list, (r) => r.userId), COL.person, (k) => `p:${k}`, personName);
        const bySuffix = (title) => bars(title, groupBy(list, sufKey), COL.suffix, (k) => `s:${k}`, suffixLabel);
        let title = n.label, sub = '', lists = '', extra = '';
        if (t === 'contract') {
          const r0 = list[0] || {}; title = raw; sub = [r0.customer, r0.machineType].filter(Boolean).join(' · ');
          const rework = list.filter((r) => r.reworkReason).reduce((s, r) => s + r.hours, 0);
          if (rework) extra = `<dt>Rework</dt><dd>${fmtH(rework)}</dd>`;
          lists = bySuffix('By suffix') + bars('By department', groupBy(list, (r) => r.department), COL.dept, () => '', (k) => k);
        } else if (t === 'suffix') {
          const r0 = list[0] || {}; title = raw; sub = [r0.suffixDescription, r0.customer].filter(Boolean).join(' · ');
          lists = bars('By department', groupBy(list, (r) => r.department), COL.dept, (k) => `d:${raw}|${k}`, (k) => k) + byPerson('By person');
        } else if (t === 'dept') {
          const [suffix, dept] = [raw.slice(0, raw.lastIndexOf('|')), raw.slice(raw.lastIndexOf('|') + 1)]; title = dept; sub = `on ${suffixLabel(suffix)}`;
          lists = byPerson('People who worked on it') + bars(`${dept} on every suffix shown`, groupBy(current.filter((r) => r.department === dept), sdKey), COL.dept, (k) => `d:${k}`, (k) => suffixLabel(k.slice(0, k.lastIndexOf('|'))));
        } else if (t === 'person') {
          title = n.label; sub = 'Contract time only';
          lists = bars('Departments worked in', groupBy(list, (r) => r.department), COL.dept, () => '', (k) => k) + bySuffix('By suffix');
        } else {
          title = `Rework on ${raw}`; sub = list[0]?.customer || '';
          lists = bars('By reason', groupBy(list, (r) => r.reworkReason), COL.rework, () => '', (k) => k) + bySuffix('By suffix') + byPerson('By person');
        }
        const kind = { contract: 'Contract', suffix: 'Suffix', dept: 'Department', person: 'Person', rework: 'Rework' }[t];
        p.innerHTML = `<div class="ball-panel-head"><div><span class="ball-kind"><i style="background:${COL[t]}"></i>${kind}</span><h3>${esc(title)}</h3><div class="ball-sub">${esc(sub)}</div></div>
            <button class="ball-close" id="ball-close" type="button" aria-label="Close details">×</button></div>
          <div class="ball-big">${bigH(n.hours)}</div>
          <dl class="ball-facts"><dt>Share of what's shown</dt><dd>${total ? Math.round((n.hours / total) * 100) : 0}%</dd>${extra}
            ${t !== 'person' ? `<dt>People</dt><dd>${people}</dd>` : ''}<dt>Time blocks</dt><dd>${blocks.toLocaleString('en-GB')}</dd>
            <dt>First clocked</dt><dd>${first ? fmtDate(first) : '–'}</dd><dt>Last clocked</dt><dd>${last ? fmtDate(last) : '–'}</dd></dl>${lists}`;
        el('ball-close').addEventListener('click', () => select(null));
      }
      p.querySelectorAll('[data-key]').forEach((b) => b.addEventListener('click', () => select(b.dataset.key, true)));
    }

    // ---------- names floating beside the balls ----------
    const tags = new Map();
    function drawTags() {
      requestAnimationFrame(drawTags);
      if (!visible || !Graph) return;
      const shell = nodesById.get('h:company')?.__threeObj?.material; // the company's ball: wire, so it reads as hollow (its colour is its own, so no other ball shares this material)
      if (shell && !shell.wireframe) { shell.wireframe = true; shell.needsUpdate = true; }
      const box = el('ball-tags'), cam = Graph.camera(), dir = cam.getWorldDirection(cam.position.clone()), want = new Set();
      for (const n of nodesById.values()) {
        if (n.x === undefined) continue;
        const show = saverOn ? n.type === 'hub' || n.type === 'contract' // screen saver: company and contracts only, or the names pile up
          : n.type === 'hub' ? state.labels !== 'off' : focusSet ? focusSet.has(n.id) || state.labels === 'all' : state.labels === 'all' || (state.labels === 'key' && (n.type === 'contract' || n.type === 'suffix'));
        if (!show) continue;
        if ((n.x - cam.position.x) * dir.x + (n.y - cam.position.y) * dir.y + (n.z - cam.position.z) * dir.z <= 0) continue; // behind the camera
        want.add(n.id);
        let tag = tags.get(n.id);
        if (!tag) { tag = document.createElement('div'); tag.className = `ball-tag ${n.type}`; tags.set(n.id, tag); box.append(tag); }
        const text = n.type === 'suffix' ? n.id.slice(2) : n.label;
        if (tag.textContent !== text) tag.textContent = text;
        const at = Graph.graph2ScreenCoords(n.x, n.y + Math.cbrt(n.val) * 3, n.z);
        tag.style.left = `${at.x}px`; tag.style.top = `${at.y}px`;
      }
      for (const [k, tag] of tags) if (!want.has(k)) { tag.remove(); tags.delete(k); }
    }

    // ---------- controls ----------
    const toggle = (id, key, after) => { const b = el(id); b.setAttribute('aria-pressed', String(state[key])); b.addEventListener('click', () => { state[key] = !state[key]; b.setAttribute('aria-pressed', String(state[key])); if (Graph) after(); }); };
    toggle('ball-people', 'people', () => { needFit = true; build(); });
    toggle('ball-spin', 'spin', () => { Graph.controls().autoRotate = state.spin; });
    toggle('ball-flow', 'flow', () => Graph.linkDirectionalParticles(Graph.linkDirectionalParticles()));
    el('ball-labels').addEventListener('change', (e) => { state.labels = e.target.value; });
    el('ball-fit').addEventListener('click', () => { if (!Graph) return; select(null); Graph.zoomToFit(700, 40); });
    el('ball-all').addEventListener('click', () => { if (!Graph) return; contracts.forEach((c) => state.selected.add(c.number)); needFit = true; build(); });
    el('ball-none').addEventListener('click', () => { if (!Graph) return; state.selected.clear(); build(); });
    el('ball-span').addEventListener('change', (e) => {
      state.span = e.target.value; el('ball-custom').classList.toggle('is-hidden', state.span !== 'custom');
      if (state.span === 'custom' && !state.from) { [state.from, state.to] = range('custom'); el('ball-from').value = state.from; el('ball-to').value = state.to; }
      if (Graph) reload(false);
    });
    const customDate = (key) => (e) => { state[key] = e.target.value; if (state.from && state.to && state.from <= state.to && Graph) reload(false); };
    el('ball-from').addEventListener('change', customDate('from'));
    el('ball-to').addEventListener('change', customDate('to'));

    // ---------- screen saver ----------
    /* Per device (this browser only), off unless switched on with the Screen saver button. After the chosen minutes
     * with no mouse, touch or key, the ball fills the screen with every contract in the chosen dates, spinning.
     * The first touch, click or key only wakes it -- it never reaches the screen underneath (so it can't start or
     * stop a clock) -- and puts back what was showing before. */
    const SAVER_KEY = 'timeslide-ball-saver';
    const saverMinutes = () => { try { return Number(localStorage.getItem(SAVER_KEY)) || 0; } catch { return 0; } };
    const setSaverMinutes = (m) => { try { if (m) localStorage.setItem(SAVER_KEY, String(m)); else localStorage.removeItem(SAVER_KEY); } catch {} };
    const saverScreen = document.createElement('div');
    saverScreen.className = 'ball-saver-screen is-hidden';
    saverScreen.innerHTML = `<div class="ball-saver-caption"><strong>${esc(COMPANY)}</strong><span id="ball-saver-span"></span></div><div class="ball-saver-wake">Touch the screen or press a key to go back</div>`;
    document.body.append(saverScreen);
    let saverOn = false, startedAt = 0, home = null, before = null, lastActive = Date.now(), swallowUntil = 0, moveFrom = null;

    async function startSaver() {
      if (saverOn) return;
      saverOn = true; moveFrom = null; startedAt = Date.now();
      const stage = el('ball-stage'); home = [stage.parentNode, stage.nextSibling];
      saverScreen.prepend(stage); saverScreen.classList.remove('is-hidden');
      el('ball-saver-span').textContent = `Contract time · ${el('ball-span').selectedOptions[0].textContent.replace('…', '')}`;
      await show();
      if (!saverOn || !Graph) return;
      before = { selected: state.selected, focus: state.focus };
      state.selected = new Set(contracts.map((c) => c.number)); state.focus = null;
      Graph.controls().autoRotate = true;
      await reload(true); // fresh figures each time it starts
    }
    function endSaver() {
      if (!saverOn) return;
      saverOn = false; lastActive = Date.now();
      const stage = el('ball-stage'); home[0].insertBefore(stage, home[1]); saverScreen.classList.add('is-hidden');
      if (before) { state.selected = before.selected; state.focus = before.focus; before = null; }
      if (Graph) { Graph.controls().autoRotate = state.spin; needFit = true; build(); }
      if (section.classList.contains('is-hidden') || el('report-contract-ball').classList.contains('is-hidden')) hide();
    }
    const wake = (event) => {
      lastActive = Date.now();
      if (!saverOn) return;
      event.preventDefault(); event.stopPropagation(); swallowUntil = Date.now() + 700; endSaver();
    };
    ['pointerdown', 'mousedown', 'touchstart', 'keydown', 'wheel'].forEach((type) => window.addEventListener(type, wake, { capture: true, passive: false }));
    ['pointerup', 'mouseup', 'touchend', 'click', 'keyup', 'contextmenu'].forEach((type) => window.addEventListener(type, (event) => {
      if (Date.now() < swallowUntil) { event.preventDefault(); event.stopPropagation(); } // the rest of the waking tap goes nowhere
    }, { capture: true, passive: false }));
    window.addEventListener('pointermove', (event) => {
      lastActive = Date.now();
      if (!saverOn || event.pointerType === 'touch' || Date.now() - startedAt < 1500) return; // a moment to let go of the mouse after Preview
      if (!moveFrom) { moveFrom = [event.clientX, event.clientY]; return; }
      if (Math.hypot(event.clientX - moveFrom[0], event.clientY - moveFrom[1]) > 12) endSaver(); // the mouse really moved, not a nudge
    }, { capture: true });
    window.addEventListener('scroll', () => { lastActive = Date.now(); }, { capture: true, passive: true });
    setInterval(() => {
      const minutes = saverMinutes();
      if (minutes && !saverOn && document.visibilityState === 'visible' && Date.now() - lastActive >= minutes * 60000) startSaver();
    }, 5000);

    const saverButton = el('ball-saver'), saverMins = el('ball-saver-mins'), saverTry = el('ball-saver-try');
    const showSaverSetting = () => {
      const minutes = saverMinutes();
      saverButton.setAttribute('aria-pressed', String(Boolean(minutes)));
      saverMins.classList.toggle('is-hidden', !minutes); saverTry.classList.toggle('is-hidden', !minutes);
      if (minutes) saverMins.value = String(minutes);
    };
    saverButton.addEventListener('click', () => { setSaverMinutes(saverMinutes() ? 0 : 5); showSaverSetting(); showToast?.(saverMinutes() ? 'Screen saver on for this device: the ball shows after 5 minutes with nothing pressed' : 'Screen saver off for this device'); });
    saverMins.addEventListener('change', () => { setSaverMinutes(Number(saverMins.value)); showSaverSetting(); });
    saverTry.addEventListener('click', (event) => { event.stopPropagation(); setTimeout(startSaver, 50); });
    showSaverSetting();

    return { show, hide };
  })();
})();
