import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { exportSheets } from '../core/export.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const note = document.getElementById('note');
const panel = document.getElementById('panel');

// Control types decide the class of an account; otherwise its group (or a parent group) does
const CONTROL_CLASS = {
  bank: 'cash', fixed_assets: 'investing', accum_depreciation: 'depreciation',
  debtors: 'operating', creditors: 'operating', inventory: 'operating', grni: 'operating', wip: 'operating', tax: 'operating',
  retained_earnings: 'financing', opening_balance: 'financing',
};

let groups = [];
let accounts = [];
let fyears = [];
let base = '';
let groupById = new Map();
let accById = new Map();
let from = '';
let to = '';
let compMode = 'lastyear';
let hideZero = true;
let sets = [];

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (n) => (Math.abs(n) < 0.005 ? '–' : (n < 0 ? `(${money(-n)})` : money(n)));
const pct = (cur, prev) => (Math.abs(prev) < 0.005 ? '' : `${(((cur - prev) / Math.abs(prev)) * 100).toFixed(1)}%`);
function btn(text, cls, onClick) {
  const b = el('button', `btn ${cls}`.trim(), text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}
function option(select, value, text) {
  const o = el('option', '', text);
  o.value = value;
  select.append(o);
}

/* ---------- dates ---------- */

const D = (s) => new Date(`${s}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
const todayIso = () => iso(new Date());
const addDays = (s, n) => { const d = D(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const addYears = (s, n) => {
  const d = D(s);
  const m = d.getUTCMonth();
  d.setUTCFullYear(d.getUTCFullYear() + n);
  if (d.getUTCMonth() !== m) d.setUTCDate(0);
  return iso(d);
};
const monthStart = (s) => `${s.slice(0, 7)}-01`;
const monthEnd = (s) => { const d = D(monthStart(s)); d.setUTCMonth(d.getUTCMonth() + 1, 0); return iso(d); };
const fyFor = (s) => fyears.find((y) => s >= y.start_date && s <= y.end_date);
const fyStartFor = (s) => (fyFor(s) ? fyFor(s).start_date : `${s.slice(0, 4)}-01-01`);
const spanLen = (a, b) => Math.round((D(b) - D(a)) / 86400000) + 1;

function applyPreset(p) {
  const today = todayIso();
  if (p === 'fytd') { from = fyStartFor(today); to = today; }
  else if (p === 'month') { from = monthStart(today); to = monthEnd(today); }
  else if (p === 'lastmonth') { const e = addDays(monthStart(today), -1); from = monthStart(e); to = e; }
  else if (p === 'lastfy') { const e = addDays(fyStartFor(today), -1); from = fyStartFor(e); to = e; }
}

/* ---------- classification ---------- */

function groupClass(gid) {
  let g = groupById.get(gid);
  let n = 0;
  while (g && n++ < 10) {
    if (g.cash_flow_class) return g.cash_flow_class;
    g = groupById.get(g.parent_id);
  }
  return null;
}
const classOf = (a) => CONTROL_CLASS[a.control_type] || groupClass(a.group_id) || null;

/* ---------- data ---------- */

async function loadStatic() {
  const cid = ctx.companyId;
  const [g, a, fy, cu] = await Promise.all([
    supabase.from('account_groups').select('id, parent_id, code, name, sort_order, cash_flow_class').eq('company_id', cid),
    supabase.from('gl_accounts').select('id, code, name, group_id, control_type').eq('company_id', cid).eq('is_posting', true),
    supabase.from('fiscal_years').select('start_date, end_date').eq('company_id', cid).order('start_date'),
    supabase.from('company_currencies').select('code').eq('company_id', cid).eq('is_base', true).maybeSingle(),
  ]);
  for (const r of [g, a, fy]) if (r.error) throw r.error;
  groups = g.data;
  accounts = a.data;
  fyears = fy.data;
  base = cu.data ? cu.data.code : '';
  groupById = new Map(groups.map((x) => [x.id, x]));
  accById = new Map(accounts.map((x) => [x.id, x]));
}

function ranges() {
  const cur = { from, to };
  let c = null;
  if (compMode === 'prev') {
    const e = addDays(from, -1);
    c = { from: addDays(e, -(spanLen(from, to) - 1)), to: e };
  } else if (compMode === 'lastyear') c = { from: addYears(from, -1), to: addYears(to, -1) };
  return c ? [cur, c] : [cur];
}

async function loadSet(r) {
  const { data, error } = await supabase.rpc('trial_balance', { p_company: ctx.companyId, p_from: r.from, p_to: r.to });
  if (error) throw error;
  let profit = 0;
  let cashOpen = 0;
  let cashClose = 0;
  let cashAccounts = 0;
  const lines = new Map();
  const unclassified = new Map();
  data.forEach((x) => {
    if (!x.account_id) return;
    const dr = Number(x.debit);
    const cr = Number(x.credit);
    const op = Number(x.opening);
    const cl = Number(x.closing);
    if (x.class_type === 'income_statement') { profit -= dr - cr; return; }
    const a = accById.get(x.account_id);
    if (!a) return;
    let cls = classOf(a);
    const delta = cl - op;
    if (cls === 'cash') { cashOpen += op; cashClose += cl; cashAccounts++; return; }
    if (Math.abs(delta) < 0.005) return;
    if (!cls) { cls = 'operating'; unclassified.set(a.id, a); }
    const g = groupById.get(a.group_id);
    const key = `${cls}:${a.group_id}`;
    if (!lines.has(key)) lines.set(key, { key, section: cls, name: g ? g.name : 'Other', sort: g ? g.sort_order : 0, amount: 0, accs: [] });
    const L = lines.get(key);
    L.amount -= delta;
    L.accs.push({ a, amt: -delta });
  });
  return { profit, cashOpen, cashClose, cashAccounts, lines, unclassified, label: `${r.from} to ${r.to}` };
}

/* ---------- statement ---------- */

function buildRows() {
  const n = sets.length;
  const amtOf = (key, i) => (sets[i].lines.get(key) || { amount: 0 }).amount;
  const secTotal = (section, i) => [...sets[i].lines.values()].filter((L) => L.section === section).reduce((s, L) => s + L.amount, 0);
  const linesFor = (section) => {
    const m = new Map();
    sets.forEach((s) => s.lines.forEach((L) => { if (L.section === section) m.set(L.key, L); }));
    return [...m.values()].sort((a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name))
      .filter((L) => !hideZero || sets.some((_, i) => Math.abs(amtOf(L.key, i)) >= 0.005));
  };
  const all = (fn) => sets.map((_, i) => fn(i));
  const rows = [];
  const lineRows = (section) => linesFor(section).forEach((L) => rows.push({ kind: 'line', depth: 1, label: L.name, amts: all((i) => amtOf(L.key, i)), key: L.key }));

  rows.push({ kind: 'heading', label: 'Cash flows from operating activities' });
  rows.push({ kind: 'line', depth: 1, label: 'Net profit / (loss) for the period', amts: all((i) => sets[i].profit) });
  const dep = linesFor('depreciation');
  if (dep.length) { rows.push({ kind: 'subhead', label: 'Adjustments for non-cash items' }); lineRows('depreciation'); }
  const op = linesFor('operating');
  if (op.length) { rows.push({ kind: 'subhead', label: 'Changes in working capital' }); lineRows('operating'); }
  const operating = all((i) => sets[i].profit + secTotal('depreciation', i) + secTotal('operating', i));
  rows.push({ kind: 'total', depth: 0, label: 'Net cash from operating activities', amts: operating, style: 'subtotal' });
  rows.push({ kind: 'spacer' });

  rows.push({ kind: 'heading', label: 'Cash flows from investing activities' });
  lineRows('investing');
  const investing = all((i) => secTotal('investing', i));
  rows.push({ kind: 'total', depth: 0, label: 'Net cash from investing activities', amts: investing, style: 'subtotal' });
  rows.push({ kind: 'spacer' });

  rows.push({ kind: 'heading', label: 'Cash flows from financing activities' });
  lineRows('financing');
  const financing = all((i) => secTotal('financing', i));
  rows.push({ kind: 'total', depth: 0, label: 'Net cash from financing activities', amts: financing, style: 'subtotal' });
  rows.push({ kind: 'spacer' });

  const net = all((i) => operating[i] + investing[i] + financing[i]);
  rows.push({ kind: 'total', depth: 0, label: 'Net increase / (decrease) in cash', amts: net, style: 'total' });
  rows.push({ kind: 'line', depth: 0, label: 'Cash at beginning of period', amts: all((i) => sets[i].cashOpen) });
  rows.push({ kind: 'total', depth: 0, label: 'Cash at end of period', amts: all((i) => sets[i].cashClose), style: 'total' });
  const diff = all((i) => sets[i].cashClose - sets[i].cashOpen - net[i]);
  if (diff.some((d) => Math.abs(d) >= 0.005)) {
    rows.push({ kind: 'error', label: 'Does not reconcile to the cash and bank accounts', msg: `difference ${diff.map((d) => money(d)).join(' / ')}` });
  }
  return { rows, diff };
}

function render() {
  if (!sets.length) { panel.innerHTML = '<p class="muted">Choose the dates and click Run.</p>'; return; }
  const n = sets.length;
  const { rows, diff } = buildRows();
  const cols = n > 1 ? 5 : 2;
  const head = `<tr><th></th>${sets.map((s) => `<th>${esc(s.label)}</th>`).join('')}${n > 1 ? '<th>Variance</th><th>%</th>' : ''}</tr>`;
  const body = rows.map((r) => {
    if (r.kind === 'spacer') return `<tr class="k-spacer"><td colspan="${cols}"></td></tr>`;
    if (r.kind === 'error') return `<tr class="k-error"><td colspan="${cols}">${esc(r.label)}: ${esc(r.msg)}</td></tr>`;
    if (r.kind === 'heading') return `<tr class="k-heading"><td colspan="${cols}">${esc(r.label)}</td></tr>`;
    if (r.kind === 'subhead') return `<tr class="k-subhead"><td colspan="${cols}" style="padding-left:1.4rem">${esc(r.label)}</td></tr>`;
    const pad = 0.7 + (r.depth || 0) * 1.3;
    const cls = [`k-${r.kind}`, r.style ? `st-${r.style}` : '', r.key ? 'clickable' : ''].join(' ').trim();
    let cells = `<td class="amt">${fmt(r.amts[0])}</td>`;
    if (n > 1) cells += `<td class="amt">${fmt(r.amts[1])}</td><td class="amt">${fmt(r.amts[0] - r.amts[1])}</td><td class="amt">${pct(r.amts[0], r.amts[1])}</td>`;
    return `<tr class="${cls}"${r.key ? ` data-key="${esc(r.key)}"` : ''}><td style="padding-left:${pad}rem">${esc(r.label)}</td>${cells}</tr>`;
  }).join('');
  const ok = diff.every((d) => Math.abs(d) < 0.005);
  panel.innerHTML = `<div class="report-head"><h3>${esc(ctx.company.name)}</h3><div>Cash Flow Statement (indirect method)</div>
    <div class="muted">${esc(sets.map((s) => s.label).join(' · '))} · amounts in ${esc(base)}</div></div>
    <div class="table-wrap"><table class="report"><thead>${head}</thead><tbody>${body}</tbody></table></div>
    <p><span class="badge ${ok ? 'open' : 'st-error'}">${ok ? 'Reconciles to the cash and bank accounts' : 'Does not reconcile'}</span></p>`;
}

function updateNote() {
  const s = sets[0];
  const msgs = [];
  if (s && !s.cashAccounts) {
    msgs.push('<strong>No cash accounts found.</strong> Set the control type Bank on your bank accounts, or give their group the cash flow class Cash and bank.');
  }
  if (s && s.unclassified.size) {
    const list = [...s.unclassified.values()].slice(0, 8).map((a) => `${esc(a.code)} ${esc(a.name)}`).join(', ');
    msgs.push(`<strong>${s.unclassified.size} account(s) are not classified</strong> and are treated as operating: ${list}${s.unclassified.size > 8 ? ', ...' : ''}.
      Set the Cash flow class on their group in the <a href="/pages/chart.html">Chart of Accounts</a>.`);
  }
  note.innerHTML = msgs.length ? `<div class="card" style="border-color:var(--warning)">${msgs.join('<br>')}</div>` : '';
}

panel.addEventListener('click', async (e) => {
  const tr = e.target.closest('tr[data-key]');
  if (!tr) return;
  const L = sets[0].lines.get(tr.dataset.key);
  if (!L) return;
  const body = L.accs.slice().sort((x, y) => x.a.code.localeCompare(y.a.code, undefined, { numeric: true }))
    .map((x) => `<tr><td>${esc(x.a.code)}</td><td>${esc(x.a.name)}</td><td class="num">${fmt(x.amt)}</td></tr>`).join('');
  const node = el('div', 'table-wrap');
  node.innerHTML = `<p class="muted">The effect on cash of each account's movement in the period (an increase in an asset is a cash outflow, an increase in a liability is a cash inflow).</p>
    <table class="grid"><thead><tr><th>Code</th><th>Account</th><th style="text-align:right">Cash effect (${esc(base)})</th></tr></thead>
    <tbody>${body}<tr class="row-root"><td colspan="2">${esc(L.name)}</td><td class="num">${fmt(L.amount)}</td></tr></tbody></table>`;
  await ui.dialog({ title: L.name, node, wide: true, dismissValue: 'close', buttons: [{ label: 'Close', value: 'close', className: 'btn-ghost' }] });
});

async function doExport() {
  if (!sets.length) return ui.warn('Run the report first.');
  const n = sets.length;
  const out = [];
  buildRows().rows.forEach((r) => {
    if (r.kind === 'spacer') { out.push({ label: '', _k: 'spacer' }); return; }
    if (r.kind === 'error') { out.push({ label: `${r.label}: ${r.msg}`, _k: 'error' }); return; }
    if (r.kind === 'heading' || r.kind === 'subhead') { out.push({ label: r.label, _k: r.kind }); return; }
    const row = { label: '   '.repeat(r.depth || 0) + r.label, _k: r.kind, _s: r.style, cur: r.amts[0] };
    if (n > 1) {
      row.cmp = r.amts[1];
      row.var = r.amts[0] - r.amts[1];
      row.pct = Math.abs(r.amts[1]) < 0.005 ? '' : ((r.amts[0] - r.amts[1]) / Math.abs(r.amts[1])) * 100;
    }
    out.push(row);
  });
  const columns = [{ key: 'label', header: 'Line', width: 52 }, { key: 'cur', header: sets[0].label, width: 22 }];
  if (n > 1) columns.push({ key: 'cmp', header: sets[1].label, width: 22 }, { key: 'var', header: 'Variance', width: 16 }, { key: 'pct', header: 'Variance %', width: 12 });
  try {
    await exportSheets(`cash-flow-${to}.xlsx`, [{
      name: 'Cash flow', title: 'Cash Flow Statement (indirect method)',
      subtitle: `${sets.map((s) => s.label).join(' · ')} · amounts in ${base}`,
      totals: false, rows: out, columns,
      styleCell: (row) => (row._k === 'heading' || row._s === 'total' ? { bold: true, fill: 'E5E7EB' }
        : (row._s === 'subtotal' || row._k === 'subhead' ? { bold: true } : null)),
    }]);
  } catch (e) { ui.errorFrom(e, 'Could not export.'); }
}

/* ---------- controls ---------- */

async function run() {
  if (!from || !to || to < from) return ui.warn('Choose a valid date range.');
  try { sets = await Promise.all(ranges().map(loadSet)); } catch (e) { return ui.errorFrom(e, 'Could not run the report.'); }
  updateNote();
  render();
}

function buildToolbar() {
  toolbar.replaceChildren();
  const dateIn = (v) => { const i = el('input'); i.type = 'date'; i.value = v; i.style.width = 'auto'; return i; };
  const preset = el('select', 'compact');
  [['fytd', 'Financial year to date'], ['month', 'This month'], ['lastmonth', 'Last month'], ['lastfy', 'Last financial year'], ['custom', 'Custom dates']]
    .forEach(([v, l]) => option(preset, v, l));
  const f = dateIn(from);
  const t = dateIn(to);
  preset.addEventListener('change', () => { if (preset.value !== 'custom') { applyPreset(preset.value); f.value = from; t.value = to; run(); } });
  f.addEventListener('change', () => { from = f.value; preset.value = 'custom'; });
  t.addEventListener('change', () => { to = t.value; preset.value = 'custom'; });
  const cmpSel = el('select', 'compact');
  [['none', 'No comparative'], ['prev', 'Previous period'], ['lastyear', 'Same period last year']].forEach(([v, l]) => option(cmpSel, v, l));
  cmpSel.value = compMode;
  cmpSel.addEventListener('change', () => { compMode = cmpSel.value; run(); });
  const cb = el('input');
  cb.type = 'checkbox';
  cb.checked = hideZero;
  cb.style.width = 'auto';
  cb.addEventListener('change', () => { hideZero = cb.checked; render(); });
  const lbl = el('label');
  lbl.style.cssText = 'display:flex;align-items:center;gap:.4rem;cursor:pointer';
  lbl.append(cb, document.createTextNode('Hide zero lines'));
  toolbar.append(preset, f, el('span', 'muted', 'to'), t, cmpSel, lbl, btn('Run', 'btn-primary', run),
    el('span', 'spacer'), btn('Print', '', () => window.print()), btn('Export to Excel', '', doExport));
}

async function init() {
  document.getElementById('company-title').textContent = ctx.company.name;
  try { await loadStatic(); } catch (e) { ui.errorFrom(e, 'Could not load the report setup.'); return; }
  applyPreset('fytd');
  buildToolbar();
  hint.textContent = 'Starts from net profit and adjusts for non-cash items and changes in working capital, then shows investing and financing movements. Click a line to see the accounts behind it. Balance sheet groups are classified in the Chart of Accounts.';
  await run();
}

if (ctx) await init();