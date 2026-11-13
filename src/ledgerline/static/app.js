// Ledgerline UI: a small client-side router over the JSON API. No build step.
const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const inr = (n, cur = 'INR') => {
  try { return new Intl.NumberFormat('en-IN', { style: 'currency', currency: cur, maximumFractionDigits: 2 }).format(n); }
  catch { return `${cur} ${Number(n).toLocaleString('en-IN')}`; }
};
const compactCur = (n, cur = 'INR') => {
  try { return new Intl.NumberFormat('en-IN', { style: 'currency', currency: cur, notation: 'compact', maximumFractionDigits: 1 }).format(n); }
  catch { return `${cur} ${n}`; }
};
// amounts in different currencies are listed side by side, never added together
const multi = amounts => { const e = Object.entries(amounts ?? {}); return e.length ? e.map(([c, v]) => inr(v, c)).join(' + ') : inr(0); };
const sumBy = (rows, f = () => true) => rows.filter(f).reduce((acc, r) => { acc[r.currency] = (acc[r.currency] ?? 0) + r.total_amount; return acc; }, {});
const num = n => Number(n).toLocaleString('en-IN');
// API timestamps are UTC without an offset
const asDate = s => new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z');
const when = s => s ? asDate(s).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const whenSec = s => s ? asDate(s).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
function ago(s) {
  const d = (Date.now() - asDate(s)) / 1000;
  if (d < 60) return 'just now';
  const u = [[86400, 'day'], [3600, 'hour'], [60, 'minute']].find(([x]) => d >= x);
  const n = Math.floor(d / u[0]);
  return `${n} ${u[1]}${n === 1 ? '' : 's'} ago`;
}

const STATUS = {
  payment_initiated: { label: 'Initiated', cls: 'st-init' },
  payment_processed: { label: 'Processed', cls: 'st-proc' },
  payment_failed: { label: 'Failed', cls: 'st-fail' },
  settled: { label: 'Settled', cls: 'st-settled' },
};
const badge = s => `<span class="badge ${STATUS[s]?.cls ?? ''}">${esc(STATUS[s]?.label ?? s)}</span>`;
const FLAG = {
  failed_but_settled: ['Settled after a failure', 'flag-red'],
  stuck: ['Stuck', 'flag-amber'],
  conflicting_transitions: ['Conflicting terminal events', 'flag-blue'],
};
const statusOptions = sel => `<option value="">All statuses</option>` +
  Object.entries(STATUS).map(([v, { label }]) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${label}</option>`).join('');

class HttpError extends Error { constructor(status, body) { super(detailText(body) || `HTTP ${status}`); this.status = status; this.body = body; } }
function detailText(b) {
  if (!b) return '';
  if (typeof b.detail === 'string') return b.detail;
  if (Array.isArray(b.detail)) return b.detail.map(e => `${e.loc?.slice(1).join('.') || 'request'}: ${e.msg}`).join('; ');
  return b.detail ? JSON.stringify(b.detail) : '';
}
async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  let body = null;
  try { body = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new HttpError(res.status, body);
  return { body, res };
}

function toast(msg, tone = 'info') {
  const t = document.createElement('div');
  t.className = `toast toast-${tone}`; t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), tone === 'err' ? 7000 : 3500);
}
const loading = what => `<div class="empty"><span class="spin"></span>Loading ${what}…</div>`;
const failed = (what, e) => `<div class="note note-err">Couldn't load ${what}: ${esc(e.message)}. <button class="link" data-retry>Try again</button></div>`;

function jsonBox(status, body, open = false) {
  const ok = status >= 200 && status < 300;
  return `<details class="raw" ${open ? 'open' : ''}><summary>Raw response <span class="code ${ok ? 'ok' : 'err'}">${status}</span></summary><pre>${esc(JSON.stringify(body, null, 2))}</pre></details>`;
}
const txnLink = id => `<a class="mono" href="/ui/transaction?id=${encodeURIComponent(id)}" data-link>${esc(id)}</a>`;

/* ------------------------------------------------------------------ router */
const routes = { '/': home, '/ui/events': ingest, '/ui/transactions': transactions, '/ui/transaction': lookup, '/ui/summary': summary, '/ui/discrepancies': discrepancies };
let cleanup = null;
function navigate(url, replace = false) {
  history[replace ? 'replaceState' : 'pushState']({}, '', url);
  render();
}
function render() {
  cleanup?.(); cleanup = null;
  const path = location.pathname.replace(/\/$/, '') || '/';
  const page = routes[path] ?? notFound;
  const key = path === '/' ? 'home' : path.split('/').pop();
  document.querySelectorAll('nav a[data-page]').forEach(a => a.classList.toggle('on', a.dataset.page === key));
  document.querySelector('header.top').classList.remove('open');
  $('.menu-btn').setAttribute('aria-expanded', 'false');
  page(new URLSearchParams(location.search));
  app.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-link]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  navigate(a.getAttribute('href'));
});
addEventListener('popstate', render);
$('.menu-btn').addEventListener('click', () => {
  const h = document.querySelector('header.top');
  h.classList.toggle('open');
  $('.menu-btn').setAttribute('aria-expanded', h.classList.contains('open'));
});
function notFound() {
  document.title = 'Not found · Ledgerline';
  app.innerHTML = `<div class="page"><h1>Page not found</h1><p class="muted">There's nothing at this address. <a href="/" data-link>Go to the dashboard</a>.</p></div>`;
}

async function health() {
  const el = $('#health');
  try {
    const { body } = await api('/health');
    el.className = 'health up'; el.lastChild.textContent = `API up · ${body.database}`;
  } catch {
    el.className = 'health down'; el.lastChild.textContent = 'API unreachable';
  }
}
health(); setInterval(health, 15000);

/* ------------------------------------------------------------------ dashboard */
async function home() {
  document.title = 'Dashboard · Ledgerline';
  app.innerHTML = `<div class="page">
    <div class="page-h"><div><h1>Dashboard</h1><p class="muted">Every payment event received, the state of each transaction, and what doesn't reconcile.</p></div>
    <a class="btn btn-primary" href="/ui/events" data-link>Ingest an event</a></div>
    <div id="dash">${loading('overview')}</div>
    <section class="card"><header class="card-h"><h2>API endpoints</h2><a class="link" href="/docs" target="_blank" rel="noopener">Interactive docs ↗</a></header>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>Method</th><th>Endpoint</th><th>What it does</th><th></th></tr></thead><tbody>
      ${[['POST', '/events', 'Ingest one lifecycle event (idempotent on event_id)', '/ui/events'],
         ['POST', '/events/batch', 'Ingest up to 1,000 events at once', '/ui/events'],
         ['GET', '/transactions', 'List with filters, sorting and paging', '/ui/transactions'],
         ['GET', '/transactions/{id}', 'One transaction with its event history', '/ui/transaction'],
         ['GET', '/reconciliation/summary', 'Counts and amounts by date, merchant and status', '/ui/summary'],
         ['GET', '/reconciliation/discrepancies', 'Transactions whose history doesn\'t add up', '/ui/discrepancies']]
        .map(([m, p, d, ui]) => `<tr><td><span class="method m-${m.toLowerCase()}">${m}</span></td><td class="mono">${p}</td><td>${d}</td><td class="right"><a class="link" href="${ui}" data-link>Open →</a></td></tr>`).join('')}
      </tbody></table></div></section></div>`;
  const box = $('#dash');
  const load = async () => {
    try {
      const { body: o } = await api('/reconciliation/overview');
      const disc = Object.values(o.discrepancies).reduce((a, b) => a + b, 0);
      if (!o.transactions) {
        box.innerHTML = `<div class="card empty-state"><h2>No events yet</h2><p class="muted">Send a payment event from the <a href="/ui/events" data-link>Ingest page</a>, or load sample data:</p><pre class="cmd">uv run ledgerline-generate &amp;&amp; uv run ledgerline-seed</pre></div>`;
        return;
      }
      const statuses = Object.keys(STATUS).map(s => ({ s, ...(o.by_status[s] ?? { count: 0, amounts: {} }) }));
      const curs = Object.entries(o.currencies);
      const [pc, p] = curs[0];
      const others = curs.slice(1);
      const otherNote = k => others.length ? ` · plus ${others.map(([c, v]) => compactCur(v[k], c)).join(', ')}` : '';
      const max = Math.max(1, ...statuses.map(x => x.count));
      box.innerHTML = `
        <div class="kpis">
          <div class="kpi"><div class="kpi-l">Transactions</div><div class="kpi-v">${num(o.transactions)}</div><div class="kpi-s">${num(o.events)} events · ${o.merchants} merchant${o.merchants === 1 ? '' : 's'}</div></div>
          <div class="kpi"><div class="kpi-l">Total amount${others.length ? ` · ${pc}` : ''}</div><div class="kpi-v" title="${esc(inr(p.total, pc))}">${compactCur(p.total, pc)}</div><div class="kpi-s">across every status${otherNote('total')}</div></div>
          <div class="kpi"><div class="kpi-l">Settled${others.length ? ` · ${pc}` : ''}</div><div class="kpi-v" title="${esc(inr(p.settled, pc))}">${compactCur(p.settled, pc)}</div><div class="kpi-s">${num(o.by_status.settled?.count ?? 0)} settled transactions${otherNote('settled')}</div></div>
          <a class="kpi kpi-link ${disc ? 'kpi-warn' : 'kpi-good'}" href="/ui/discrepancies" data-link><div class="kpi-l">Discrepancies</div><div class="kpi-v">${num(disc)}</div><div class="kpi-s">${disc ? 'need a look →' : 'everything reconciles'}</div></a>
        </div>
        <div class="grid-2">
          <section class="card"><header class="card-h"><h2>Transactions by current status</h2></header>
            <div class="bars">${statuses.map(x => `<a class="bar-row" href="/ui/transactions?status=${x.s}" data-link>
              <span class="bar-l">${badge(x.s)}</span>
              <span class="bar-track"><span class="bar-fill ${STATUS[x.s].cls}" style="width:${(x.count / max) * 100}%"></span></span>
              <span class="bar-v"><b>${num(x.count)}</b><small>${multi(x.amounts)}</small></span></a>`).join('')}</div></section>
          <section class="card"><header class="card-h"><h2>Reconciliation</h2></header>
            <ul class="kv">
              <li><span><i class="dot flag-red"></i>Settled after a failure</span><b>${num(o.discrepancies.failed_but_settled)}</b></li>
              <li><span><i class="dot flag-amber"></i>Stuck in flight</span><b>${num(o.discrepancies.stuck_transactions)}</b></li>
              <li><span><i class="dot flag-blue"></i>Conflicting terminal events</span><b>${num(o.discrepancies.conflicting_transitions)}</b></li>
              <li><span>Last event received</span><b>${o.last_event_at ? `<span title="${esc(when(o.last_event_at))}">${ago(o.last_event_at)}</span>` : '—'}</b></li>
            </ul>
            <a class="btn btn-sm" href="/ui/discrepancies" data-link>Review discrepancies</a></section>
        </div>`;
    } catch (e) { box.innerHTML = failed('the overview', e); box.querySelector('[data-retry]').onclick = load; }
  };
  load();
}

/* ------------------------------------------------------------------ ingest */
const MERCHANT_SAMPLES = [['mer_kirana', 'Kirana Kart'], ['mer_chai', 'Chai Sutra'], ['mer_pages', 'PageTurner Books'], ['mer_arcade', 'Pixel Arcade'], ['mer_stride', 'Stride Sports']];
const rid = p => `${p}_${Math.random().toString(16).slice(2, 10)}${Math.random().toString(16).slice(2, 6)}`;
const localNow = () => { const d = new Date(); d.setSeconds(0, 0); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const NEXT = { payment_initiated: 'payment_processed', payment_processed: 'settled' };

function ingest() {
  document.title = 'Ingest · Ledgerline';
  app.innerHTML = `<div class="page">
    <div class="page-h"><div><h1>Ingest events</h1><p class="muted">Send payment lifecycle events the way a partner webhook would. Sending an <code>event_id</code> again is harmless: it is recognised and ignored.</p></div></div>
    <div class="grid-ingest">
      <section class="card">
        <header class="card-h"><h2>Single event</h2><span class="muted small"><span class="method m-post">POST</span> /events</span></header>
        <form id="ev" class="form" novalidate>
          <div class="row-2">
            <label class="field"><span>Event ID</span><div class="affix"><input name="event_id" placeholder="evt_abc123" required maxlength="64" autocomplete="off"><button type="button" class="btn btn-sm" data-new="event_id">New</button></div></label>
            <label class="field"><span>Event type</span><select name="event_type">${Object.entries(STATUS).map(([v, { label }]) => `<option value="${v}">${label} · ${v}</option>`).join('')}</select></label>
          </div>
          <div class="row-2">
            <label class="field"><span>Transaction ID</span><div class="affix"><input name="transaction_id" placeholder="txn_xyz789" required maxlength="64" autocomplete="off"><button type="button" class="btn btn-sm" data-new="transaction_id">New</button></div></label>
            <label class="field"><span>Timestamp <small class="muted">(your local time)</small></span><input name="timestamp" type="datetime-local" step="1" required></label>
          </div>
          <div class="row-2">
            <label class="field"><span>Merchant ID</span><input name="merchant_id" placeholder="mer_chai" required maxlength="64" list="merchant-ids" autocomplete="off"></label>
            <label class="field"><span>Merchant name</span><input name="merchant_name" placeholder="Chai Sutra" required maxlength="200"></label>
          </div>
          <div class="row-2">
            <label class="field"><span>Amount</span><input name="amount" inputmode="decimal" placeholder="1500.00" required></label>
            <label class="field"><span>Currency</span><select name="currency"><option>INR</option><option>USD</option><option>EUR</option><option>GBP</option></select></label>
          </div>
          <datalist id="merchant-ids"></datalist>
          <div class="form-actions">
            <button type="button" class="btn" id="sample">Fill sample</button>
            <button type="button" class="btn" id="next" disabled title="Continue this transaction with its next lifecycle event">Next event for this transaction</button>
            <button class="btn btn-primary" id="send">Send event</button>
          </div>
        </form>
        <div id="result"></div>
      </section>
      <div class="stack">
        <section class="card">
          <header class="card-h"><h2>Batch file</h2><span class="muted small"><span class="method m-post">POST</span> /events/batch</span></header>
          <p class="muted small">Upload a JSON array of events (for example the file written by <code>ledgerline-generate</code>). It is sent in chunks of 500; each event is checked on its own.</p>
          <label class="drop" id="drop"><input type="file" accept=".json,application/json" id="file"><span><b>Choose a JSON file</b> or drop it here</span></label>
          <div id="batch"></div>
        </section>
        <section class="card how">
          <header class="card-h"><h2>How events are applied</h2></header>
          <ol>
            <li><b>Idempotent.</b> The <code>event_id</code> is the key. A repeat returns <code>200</code> with <code>duplicate: true</code> and changes nothing.</li>
            <li><b>Order-safe.</b> The event with the latest timestamp decides a transaction's status, so a late delivery of an old event can't roll it back.</li>
            <li><b>Nothing is lost.</b> Contradictory histories (a failure then a settlement, or two settlements) are kept and flagged on the <a href="/ui/discrepancies" data-link>Discrepancies</a> page.</li>
          </ol>
        </section>
      </div>
    </div></div>`;

  const form = $('#ev'); const F = n => form.elements[n];
  F('timestamp').value = localNow();
  api('/merchants').then(({ body }) => { $('#merchant-ids').innerHTML = body.map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join(''); }).catch(() => {});
  F('merchant_id').addEventListener('change', () => {
    const opt = [...$('#merchant-ids').options].find(o => o.value === F('merchant_id').value);
    if (opt && !F('merchant_name').value) F('merchant_name').value = opt.textContent;
  });
  form.querySelectorAll('[data-new]').forEach(b => b.onclick = () => { F(b.dataset.new).value = rid(b.dataset.new === 'event_id' ? 'evt' : 'txn'); clearErr(b.dataset.new); });
  $('#sample').onclick = () => {
    const [mid, name] = MERCHANT_SAMPLES[Math.floor(Math.random() * MERCHANT_SAMPLES.length)];
    Object.entries({ event_id: rid('evt'), event_type: 'payment_initiated', transaction_id: rid('txn'), merchant_id: mid, merchant_name: name,
      amount: (Math.random() * 20000 + 49).toFixed(2), currency: 'INR', timestamp: localNow() }).forEach(([k, v]) => { F(k).value = v; });
    clearErr();
  };
  let last = null;
  $('#next').onclick = () => {
    if (!last) return;
    F('event_id').value = rid('evt');
    F('event_type').value = NEXT[last.event_type] ?? last.event_type;
    const t = new Date(asDate(last.timestamp).getTime() + 60000);
    F('timestamp').value = new Date(t - t.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
    clearErr();
  };
  const clearErr = name => form.querySelectorAll(name ? `[name=${name}]` : '[name]').forEach(i => {
    const f = i.closest('.field'); f?.classList.remove('has-err'); f?.querySelector('.err')?.remove();
  });
  form.addEventListener('input', e => e.target.name && clearErr(e.target.name));
  const setErr = (name, msg) => {
    const f = F(name)?.closest('.field'); if (!f) return false;
    f.classList.add('has-err');
    if (!f.querySelector('.err')) f.insertAdjacentHTML('beforeend', `<span class="err" role="alert">${esc(msg)}</span>`);
    return true;
  };

  form.onsubmit = async e => {
    e.preventDefault(); clearErr();
    const data = Object.fromEntries(new FormData(form));
    let bad = false;
    for (const k of ['event_id', 'transaction_id', 'merchant_id', 'merchant_name', 'amount', 'timestamp']) if (!String(data[k]).trim()) bad = setErr(k, 'Required') || bad;
    if (data.amount && !/^\d+(\.\d{1,2})?$/.test(data.amount.trim())) bad = setErr('amount', 'Use a positive number with up to 2 decimals') || bad;
    if (bad) return;
    const payload = { ...data, amount: Number(data.amount), timestamp: new Date(data.timestamp).toISOString() };
    const btn = $('#send'); btn.disabled = true; btn.textContent = 'Sending…';
    const out = $('#result');
    try {
      const { body, res } = await api('/events', { method: 'POST', body: JSON.stringify(payload) });
      last = body; $('#next').disabled = false;
      out.innerHTML = `<div class="note ${body.duplicate ? 'note-warn' : 'note-ok'}">
        ${body.duplicate ? `<b>Duplicate ignored.</b> <span class="mono">${esc(body.event_id)}</span> was already received ${esc(ago(body.received_at))}; nothing changed.`
          : `<b>Event recorded.</b> ${txnLink(body.transaction_id)} is now ${badge(body.transaction_status)}`}
        ${!body.duplicate && body.transaction_status !== body.event_type ? `<div class="small">This event is older than the transaction's latest one, so it was added to the history without changing the status.</div>` : ''}
        </div>${jsonBox(res.status, body)}`;
      toast(body.duplicate ? 'Duplicate event ignored' : 'Event recorded', body.duplicate ? 'info' : 'ok');
    } catch (err) {
      const fields = Array.isArray(err.body?.detail) ? err.body.detail : [];
      let mapped = 0;
      fields.forEach(d => { if (d.loc?.[0] === 'body' && setErr(d.loc[1], d.msg.replace(/^Value error, /, ''))) mapped++; });
      out.innerHTML = `<div class="note note-err">${mapped ? 'Fix the highlighted fields and send again.' : esc(err.message)}</div>${err.status ? jsonBox(err.status, err.body) : ''}`;
    } finally { btn.disabled = false; btn.textContent = 'Send event'; }
  };

  const fileIn = $('#file'), drop = $('#drop');
  const upload = async file => {
    const box = $('#batch');
    if (!file) return;
    let events;
    try { events = JSON.parse(await file.text()); } catch { box.innerHTML = `<div class="note note-err">${esc(file.name)} isn't valid JSON.</div>`; return; }
    if (!Array.isArray(events)) { box.innerHTML = `<div class="note note-err">The file must contain a JSON array of events.</div>`; return; }
    if (!events.length) { box.innerHTML = `<div class="note note-warn">The file is empty.</div>`; return; }
    const tally = { accepted: 0, duplicates: 0, rejected: [] };
    const t0 = performance.now();
    for (let i = 0; i < events.length; i += 500) {
      box.innerHTML = `<div class="progress"><span style="width:${(i / events.length) * 100}%"></span></div><p class="small muted">Sending ${num(Math.min(i + 500, events.length))} of ${num(events.length)}…</p>`;
      try {
        const { body } = await api('/events/batch', { method: 'POST', body: JSON.stringify(events.slice(i, i + 500)) });
        tally.accepted += body.accepted; tally.duplicates += body.duplicates;
        tally.rejected.push(...body.rejected.map(r => ({ ...r, index: r.index + i })));
      } catch (e) { box.innerHTML = `<div class="note note-err">Stopped at event ${num(i)}: ${esc(e.message)}</div>`; return; }
    }
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    box.innerHTML = `<div class="note ${tally.rejected.length ? 'note-warn' : 'note-ok'}"><b>${esc(file.name)}</b> processed in ${secs}s:
      ${num(tally.accepted)} new, ${num(tally.duplicates)} duplicates ignored, ${num(tally.rejected.length)} rejected.</div>
      ${tally.rejected.length ? `<details class="raw" open><summary>Rejected events</summary><ul class="rej">${tally.rejected.slice(0, 50).map(r => `<li><b>#${r.index}</b> ${esc(r.event_id ?? '(no id)')}: ${esc(r.errors.join('; '))}</li>`).join('')}${tally.rejected.length > 50 ? `<li class="muted">…and ${tally.rejected.length - 50} more</li>` : ''}</ul></details>` : ''}`;
    toast(`Batch done: ${num(tally.accepted)} new events`, 'ok');
    fileIn.value = '';
  };
  fileIn.onchange = () => upload(fileIn.files[0]);
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); upload(e.dataTransfer.files[0]); };
}

/* ------------------------------------------------------------------ transactions */
async function transactions(params) {
  document.title = 'Transactions · Ledgerline';
  const st = {
    merchant_id: params.get('merchant_id') || '', status: params.get('status') || '', start_date: params.get('start_date') || '', end_date: params.get('end_date') || '',
    sort_by: params.get('sort_by') || 'updated_at', sort_order: params.get('sort_order') || 'desc', page: Math.max(1, Number(params.get('page')) || 1), limit: Number(params.get('limit')) || 25,
  };
  app.innerHTML = `<div class="page">
    <div class="page-h"><div><h1>Transactions</h1><p class="muted">Current state of every transaction. Click one for its full event history.</p></div></div>
    <form class="card filters" id="f">
      <label class="field"><span>Merchant</span><select name="merchant_id"><option value="">All merchants</option></select></label>
      <label class="field"><span>Status</span><select name="status">${statusOptions(st.status)}</select></label>
      <label class="field"><span>Created from</span><input type="date" name="start_date" value="${esc(st.start_date)}"></label>
      <label class="field"><span>Created to</span><input type="date" name="end_date" value="${esc(st.end_date)}"></label>
      <label class="field"><span>Sort by</span><select name="sort"><option value="updated_at:desc">Last update, newest</option><option value="updated_at:asc">Last update, oldest</option><option value="created_at:desc">Created, newest</option><option value="created_at:asc">Created, oldest</option><option value="amount:desc">Amount, highest</option><option value="amount:asc">Amount, lowest</option></select></label>
      <div class="filter-actions"><button class="btn btn-primary">Filter</button><button type="button" class="btn" id="clear">Clear</button></div>
    </form>
    <section class="card" id="list">${loading('transactions')}</section></div>`;
  const f = $('#f');
  f.elements.sort.value = `${st.sort_by}:${st.sort_order}`;
  api('/merchants').then(({ body }) => {
    f.elements.merchant_id.insertAdjacentHTML('beforeend', body.map(m => `<option value="${esc(m.id)}">${esc(m.name)} (${esc(m.id)})</option>`).join(''));
    if (st.merchant_id && !body.some(m => m.id === st.merchant_id)) f.elements.merchant_id.insertAdjacentHTML('beforeend', `<option value="${esc(st.merchant_id)}">${esc(st.merchant_id)}</option>`);
    f.elements.merchant_id.value = st.merchant_id;
  }).catch(() => {});
  const push = () => {
    const q = new URLSearchParams();
    Object.entries(st).forEach(([k, v]) => { if (v && !(k === 'sort_by' && v === 'updated_at') && !(k === 'sort_order' && v === 'desc') && !(k === 'page' && v === 1) && !(k === 'limit' && v === 25)) q.set(k, v); });
    history.replaceState({}, '', `/ui/transactions${q.size ? '?' + q : ''}`);
  };
  f.onsubmit = e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(f));
    if (d.start_date && d.end_date && d.start_date > d.end_date) { toast('"Created from" must be on or before "Created to"', 'err'); return; }
    const [sort_by, sort_order] = d.sort.split(':');
    Object.assign(st, { merchant_id: d.merchant_id, status: d.status, start_date: d.start_date, end_date: d.end_date, sort_by, sort_order, page: 1 });
    push(); load();
  };
  f.querySelectorAll('select').forEach(s => s.addEventListener('change', () => f.requestSubmit()));
  $('#clear').onclick = () => { f.reset(); f.elements.merchant_id.value = ''; f.elements.status.value = ''; f.elements.sort.value = 'updated_at:desc'; f.requestSubmit(); };

  const box = $('#list');
  let seq = 0;
  async function load() {
    const my = ++seq;
    const q = new URLSearchParams({ skip: (st.page - 1) * st.limit, limit: st.limit, sort_by: st.sort_by, sort_order: st.sort_order });
    if (st.merchant_id) q.set('merchant_id', st.merchant_id);
    if (st.status) q.set('status', st.status);
    if (st.start_date) q.set('start_date', `${st.start_date}T00:00:00`);
    if (st.end_date) q.set('end_date', `${st.end_date}T23:59:59`);
    box.classList.add('busy');
    try {
      const { body, res } = await api(`/transactions?${q}`);
      if (my !== seq) return;
      const total = Number(res.headers.get('X-Total-Count') ?? body.length);
      const pages = Math.max(1, Math.ceil(total / st.limit));
      if (st.page > pages && total) { st.page = pages; push(); return load(); }
      const filtered = st.merchant_id || st.status || st.start_date || st.end_date;
      box.innerHTML = !body.length ? `<div class="empty">${filtered ? 'No transactions match these filters.' : 'No transactions yet. <a href="/ui/events" data-link>Ingest an event</a> to create one.'}</div>` : `
        <div class="table-wrap"><table class="tbl click"><thead><tr><th>Transaction ID</th><th>Merchant</th><th class="num">Amount</th><th>Status</th><th>Created</th><th>Updated</th></tr></thead><tbody>
        ${body.map(t => `<tr data-id="${esc(t.id)}" tabindex="0"><td class="mono">${esc(t.id)}</td><td>${esc(t.merchant_id)}</td><td class="num strong">${inr(t.amount, t.currency)}</td><td>${badge(t.status)}</td><td class="muted nowrap">${when(t.created_at)}</td><td class="muted nowrap" title="${esc(whenSec(t.updated_at))}">${ago(t.updated_at)}</td></tr>`).join('')}
        </tbody></table></div>
        <div class="pager"><span class="muted small">${num((st.page - 1) * st.limit + 1)}–${num(Math.min(st.page * st.limit, total))} of ${num(total)}</span>
          <div><button class="btn btn-sm" data-p="-1" ${st.page <= 1 ? 'disabled' : ''}>← Prev</button><span class="small">Page ${st.page} of ${num(pages)}</span><button class="btn btn-sm" data-p="1" ${st.page >= pages ? 'disabled' : ''}>Next →</button></div></div>`;
      box.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { st.page += Number(b.dataset.p); push(); load(); box.scrollIntoView({ block: 'start' }); });
      box.querySelectorAll('tr[data-id]').forEach(tr => {
        const open = () => drawer(tr.dataset.id);
        tr.onclick = open; tr.onkeydown = e => { if (e.key === 'Enter') open(); };
      });
    } catch (e) { box.innerHTML = failed('transactions', e); box.querySelector('[data-retry]').onclick = load; }
    finally { box.classList.remove('busy'); }
  }
  load();
}

async function drawer(id) {
  document.querySelector('.drawer-wrap')?.remove();
  const wrap = document.createElement('div');
  wrap.className = 'drawer-wrap';
  wrap.innerHTML = `<div class="drawer" role="dialog" aria-modal="true" aria-label="Transaction ${esc(id)}"><header><h2 class="mono">${esc(id)}</h2><button class="btn btn-sm" data-close aria-label="Close">✕</button></header><div class="drawer-b">${loading('transaction')}</div></div>`;
  document.body.append(wrap);
  const close = () => { wrap.remove(); removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  addEventListener('keydown', onKey);
  wrap.onclick = e => { if (e.target === wrap || e.target.closest('[data-close]') || e.target.closest('a[data-link]')) close(); };
  wrap.querySelector('[data-close]').focus();
  try {
    const { body } = await api(`/transactions/${encodeURIComponent(id)}`);
    wrap.querySelector('.drawer-b').innerHTML = detailHtml(body) + `<a class="btn btn-sm" href="/ui/transaction?id=${encodeURIComponent(id)}" data-link>Open full page</a>`;
  } catch (e) { wrap.querySelector('.drawer-b').innerHTML = `<div class="note note-err">${esc(e.message)}</div>`; }
}

function detailHtml(t) {
  const seen = new Set(t.events.map(e => e.event_type));
  // terminal steps in the order they actually arrived; "Settled" is the expected end until one does
  const terminals = [...new Set(t.events.map(e => e.event_type).filter(x => x === 'settled' || x === 'payment_failed'))];
  const steps = ['payment_initiated', 'payment_processed', ...(terminals.length ? terminals : ['settled'])];
  return `
    <div class="detail-head">${badge(t.status)}<span class="amount">${inr(t.amount, t.currency)}</span></div>
    ${t.flags.length ? `<div class="flags">${t.flags.map(f => `<span class="flag ${FLAG[f][1]}">${FLAG[f][0]}</span>`).join('')}</div>` : ''}
    <ol class="lifecycle" aria-label="Lifecycle">
      ${steps.map(s => `<li class="${seen.has(s) ? 'done' : ''} ${s === 'payment_failed' ? 'fail' : ''} ${t.status === s ? 'cur' : ''}"><i></i>${STATUS[s].label}</li>`).join('')}
    </ol>
    <ul class="kv">
      <li><span>Merchant</span><b>${esc(t.merchant.name)} <small class="mono muted">${esc(t.merchant.id)}</small></b></li>
      <li><span>First event</span><b>${whenSec(t.created_at)}</b></li>
      <li><span>Latest event</span><b>${whenSec(t.updated_at)}</b></li>
      <li><span>Events received</span><b>${t.events.length}</b></li>
    </ul>
    <h3>Event history</h3>
    <ol class="timeline">${t.events.map(e => `<li class="${STATUS[e.event_type]?.cls ?? ''}"><div>${badge(e.event_type)} <span class="mono small muted">${esc(e.id)}</span></div>
      <div class="small muted">Happened ${whenSec(e.timestamp)} · received ${whenSec(e.received_at)}${asDate(e.received_at) - asDate(e.timestamp) > 3600e3 ? ' <span class="late">late delivery</span>' : ''}</div></li>`).join('')}</ol>`;
}

/* ------------------------------------------------------------------ lookup */
function lookup(params) {
  document.title = 'Lookup · Ledgerline';
  const id = params.get('id') || '';
  app.innerHTML = `<div class="page page-narrow">
    <div class="page-h"><div><h1>Find a transaction</h1><p class="muted">Look up any transaction by its ID to see its status, flags and every event received for it.</p></div></div>
    <form class="card search" id="s"><label class="sr" for="tid">Transaction ID</label><input id="tid" placeholder="Enter transaction ID" value="${esc(id)}" autocomplete="off" required><button class="btn btn-primary">Look up</button></form>
    <div id="out"></div></div>`;
  const out = $('#out');
  const run = async v => {
    if (!v) { out.innerHTML = ''; return; }
    out.innerHTML = loading('transaction');
    try {
      const { body } = await api(`/transactions/${encodeURIComponent(v)}`);
      out.innerHTML = `<section class="card"><header class="card-h"><h2 class="mono">${esc(body.id)}</h2><a class="link" href="/ui/transactions?merchant_id=${encodeURIComponent(body.merchant_id)}" data-link>More from this merchant →</a></header>${detailHtml(body)}${jsonBox(200, body)}</section>`;
    } catch (e) {
      out.innerHTML = e.status === 404 ? `<div class="card empty"><b>No transaction with ID <span class="mono">${esc(v)}</span>.</b><br><span class="muted">IDs are case-sensitive. Check for typos, or browse <a href="/ui/transactions" data-link>all transactions</a>.</span></div>`
        : `<div class="note note-err">${esc(e.message)}</div>`;
    }
  };
  $('#s').onsubmit = e => {
    e.preventDefault();
    const v = $('#tid').value.trim();
    history.replaceState({}, '', v ? `/ui/transaction?id=${encodeURIComponent(v)}` : '/ui/transaction');
    run(v);
  };
  if (id) run(id); else $('#tid').focus();
}

/* ------------------------------------------------------------------ summary */
async function summary(params) {
  document.title = 'Summary · Ledgerline';
  app.innerHTML = `<div class="page">
    <div class="page-h"><div><h1>Reconciliation summary</h1><p class="muted">Transaction counts and amounts by day, merchant and status, aggregated in the database. Days are UTC.</p></div>
    <button class="btn" id="csv" disabled>Download CSV</button></div>
    <form class="card filters" id="f">
      <label class="field"><span>Merchant</span><select name="merchant_id"><option value="">All merchants</option></select></label>
      <label class="field"><span>Status</span><select name="status">${statusOptions(params.get('status') || '')}</select></label>
      <label class="field"><span>From</span><input type="date" name="start_date"></label>
      <label class="field"><span>To</span><input type="date" name="end_date"></label>
      <label class="field"><span>Group by</span><select name="group"><option value="row">Day, merchant and status</option><option value="day">Day</option><option value="merchant">Merchant</option><option value="status">Status</option></select></label>
      <div class="filter-actions"><button type="button" class="btn" id="clear">Clear</button></div>
    </form>
    <div id="sum">${loading('summary')}</div></div>`;
  const f = $('#f');
  api('/merchants').then(({ body }) => f.elements.merchant_id.insertAdjacentHTML('beforeend', body.map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join(''))).catch(() => {});
  let rows = [];
  const box = $('#sum');
  const load = async () => {
    const d = Object.fromEntries(new FormData(f));
    if (d.start_date && d.end_date && d.start_date > d.end_date) { toast('"From" must be on or before "To"', 'err'); return; }
    const q = new URLSearchParams();
    if (d.merchant_id) q.set('merchant_id', d.merchant_id);
    if (d.status) q.set('status', d.status);
    if (d.start_date) q.set('start_date', `${d.start_date}T00:00:00`);
    if (d.end_date) q.set('end_date', `${d.end_date}T23:59:59`);
    box.classList.add('busy');
    try {
      rows = (await api(`/reconciliation/summary?${q}`)).body;
      draw(d.group);
    } catch (e) { box.innerHTML = failed('the summary', e); box.querySelector('[data-retry]').onclick = load; }
    finally { box.classList.remove('busy'); }
  };
  const draw = group => {
    $('#csv').disabled = !rows.length;
    if (!rows.length) { box.innerHTML = `<div class="card empty">No transactions in this range.</div>`; return; }
    const tc = rows.reduce((a, r) => a + r.total_transactions, 0), ta = sumBy(rows);
    const byStatus = Object.keys(STATUS).map(s => ({ s, n: rows.filter(r => r.status === s).reduce((a, r) => a + r.total_transactions, 0), a: sumBy(rows, r => r.status === s) }));
    let table = rows;
    if (group !== 'row') {
      const key = { day: r => r.date, merchant: r => r.merchant_id, status: r => r.status }[group];
      const m = new Map();
      rows.forEach(r => { const k = `${key(r)}|${r.currency}`; const g = m.get(k) ?? { ...r, total_transactions: 0, total_amount: 0 }; g.total_transactions += r.total_transactions; g.total_amount += r.total_amount; m.set(k, g); });
      table = [...m.values()];
    }
    const cols = { row: ['date', 'merchant', 'status'], day: ['date'], merchant: ['merchant'], status: ['status'] }[group];
    const cell = { date: r => `<td class="nowrap">${esc(new Date(r.date + 'T00:00:00Z').toLocaleDateString([], { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }))}</td>`,
      merchant: r => `<td>${esc(r.merchant_name)} <small class="mono muted">${esc(r.merchant_id)}</small></td>`, status: r => `<td>${badge(r.status)}</td>` };
    box.innerHTML = `
      <div class="kpis kpis-5">
        <div class="kpi"><div class="kpi-l">All</div><div class="kpi-v">${num(tc)}</div><div class="kpi-s">${multi(ta)}</div></div>
        ${byStatus.map(x => `<div class="kpi"><div class="kpi-l">${badge(x.s)}</div><div class="kpi-v">${num(x.n)}</div><div class="kpi-s">${multi(x.a)}</div></div>`).join('')}
      </div>
      <section class="card"><header class="card-h"><h2>Breakdown</h2><span class="muted small">${num(table.length)} row${table.length === 1 ? '' : 's'}</span></header>
      <div class="table-wrap tall"><table class="tbl"><thead><tr>${cols.map(c => `<th>${c[0].toUpperCase() + c.slice(1)}</th>`).join('')}<th class="num">Count</th><th class="num">Amount</th></tr></thead><tbody>
      ${table.map(r => `<tr>${cols.map(c => cell[c](r)).join('')}<td class="num">${num(r.total_transactions)}</td><td class="num strong">${inr(r.total_amount, r.currency)}</td></tr>`).join('')}
      </tbody><tfoot><tr><td colspan="${cols.length}">Total</td><td class="num">${num(tc)}</td><td class="num">${multi(ta)}</td></tr></tfoot></table></div></section>`;
  };
  f.addEventListener('change', e => (e.target.name === 'group' ? draw(e.target.value) : load()));
  f.onsubmit = e => e.preventDefault();
  $('#clear').onclick = () => { f.reset(); load(); };
  $('#csv').onclick = () => {
    const lines = [['date', 'merchant_id', 'merchant_name', 'status', 'currency', 'total_transactions', 'total_amount'].join(',')]
      .concat(rows.map(r => [r.date, r.merchant_id, r.merchant_name, r.status, r.currency, r.total_transactions, r.total_amount.toFixed(2)].map(v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v).join(',')));
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })), download: 'ledgerline-summary.csv' });
    a.click(); URL.revokeObjectURL(a.href);
  };
  load();
}

/* ------------------------------------------------------------------ discrepancies */
async function discrepancies() {
  document.title = 'Discrepancies · Ledgerline';
  app.innerHTML = `<div class="page">
    <div class="page-h"><div><h1>Discrepancies</h1><p class="muted">Transactions whose event history doesn't add up. Each list is a database query; nothing is cached.</p></div>
    <button class="btn" id="re">Re-run checks</button></div>
    <div id="d">${loading('checks')}</div></div>`;
  const box = $('#d');
  const load = async () => {
    try {
      const { body, res } = await api('/reconciliation/discrepancies');
      const sec = (key, title, cls, why, act) => {
        const items = body[key];
        return `<section class="card disc ${cls}" id="${key}"><header class="card-h"><h2><i class="dot ${cls}"></i>${title} <span class="count">${num(items.length)}</span></h2></header>
          <p class="muted small">${why} <b>What to do:</b> ${act}</p>
          ${!items.length ? `<div class="empty small">None found.</div>` : `<div class="table-wrap ${items.length > 12 ? 'tall' : ''}"><table class="tbl click"><thead><tr><th>Transaction ID</th><th>Merchant</th><th class="num">Amount</th><th>Status</th><th>Created</th><th>Updated</th></tr></thead><tbody>
          ${items.map(t => `<tr data-id="${esc(t.id)}" tabindex="0"><td class="mono">${esc(t.id)}</td><td>${esc(t.merchant_id)}</td><td class="num">${inr(t.amount, t.currency)}</td><td>${badge(t.status)}</td><td class="nowrap muted">${when(t.created_at)}</td><td class="nowrap muted" title="${esc(whenSec(t.updated_at))}">${ago(t.updated_at)}</td></tr>`).join('')}
          </tbody></table></div>`}</section>`;
      };
      const total = body.failed_but_settled.length + body.stuck_transactions.length + body.conflicting_transitions.length;
      box.innerHTML = `
        <div class="kpis">
          <a class="kpi kpi-link" href="#failed_but_settled"><div class="kpi-l"><i class="dot flag-red"></i>Settled after a failure</div><div class="kpi-v">${num(body.failed_but_settled.length)}</div></a>
          <a class="kpi kpi-link" href="#stuck_transactions"><div class="kpi-l"><i class="dot flag-amber"></i>Stuck over ${body.stuck_after_hours}h</div><div class="kpi-v">${num(body.stuck_transactions.length)}</div></a>
          <a class="kpi kpi-link" href="#conflicting_transitions"><div class="kpi-l"><i class="dot flag-blue"></i>Conflicting transitions</div><div class="kpi-v">${num(body.conflicting_transitions.length)}</div></a>
          <div class="kpi ${total ? 'kpi-warn' : 'kpi-good'}"><div class="kpi-l">Overall</div><div class="kpi-v">${total ? num(total) : '✓'}</div><div class="kpi-s">${total ? 'flagged (a transaction can be in more than one list)' : 'everything reconciles'}</div></div>
        </div>
        ${sec('failed_but_settled', 'Settled with a prior failure', 'flag-red', 'Marked settled, but a <code>payment_failed</code> event was also received. Money may have moved for a payment the customer was told had failed.', 'confirm with the partner whether funds actually settled before notifying the customer.')}
        ${sec('stuck_transactions', `Stuck for more than ${body.stuck_after_hours} hours`, 'flag-amber', 'Still <em>initiated</em> or <em>processed</em> long after they started; the final event never arrived.', 'query the partner for the final status or chase the missing webhook.')}
        ${sec('conflicting_transitions', 'Conflicting state transitions', 'flag-blue', 'More than one terminal event (<code>settled</code> / <code>payment_failed</code>) for the same transaction, for example a settlement reported twice.', 'check for double settlement and reverse any duplicate payout.')}
        ${jsonBox(res.status, body)}`;
      box.querySelectorAll('tr[data-id]').forEach(tr => { tr.onclick = () => drawer(tr.dataset.id); tr.onkeydown = e => { if (e.key === 'Enter') drawer(tr.dataset.id); }; });
      box.querySelectorAll('a.kpi-link[href^="#"]').forEach(a => a.onclick = e => { e.preventDefault(); $(a.getAttribute('href')).scrollIntoView({ behavior: 'smooth' }); });
    } catch (e) { box.innerHTML = failed('discrepancies', e); box.querySelector('[data-retry]').onclick = load; }
  };
  $('#re').onclick = async () => { $('#re').disabled = true; await load(); $('#re').disabled = false; toast('Checks re-run', 'ok'); };
  load();
}

render();
