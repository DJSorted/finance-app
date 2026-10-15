import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { exportSheets } from '../core/export.js';
import { parse, evaluate } from '../core/formula.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const panel = document.getElementById('panel');

let groups = [];
let accounts = [];
let formats = [];
let lines = [];
let fyears = [];
let base = '';
let formatId = '';
let months = [];
let sets = [];
let periodKey = 'r12';
let endKey = '';
let showAll = false;
let hideZero = true;
let showAvg = false;
let forceOpen = false;
const collapsedState = new Map();
let groupById = new Map();
let childMap = new Map();
let accByGroup = new Map();

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (n) => (Math.abs(n) < 0.005 ? '–' : (n < 0 ? `(${money(-n)})` : money(n)));
const fmt0 = (n) => (Math.abs(n) < 0.5 ? '–' : (n < 0 ? `(${Math.round(-n).toLocaleString()})` : Math.round(n).toLocaleString()));
function btn(text, cls, onClick) {
  const b = el('button', `btn ${cls}`.trim(), text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}
function option(select, value, text) { const o = el('option', '', text); o.value = value; select.append(o); }
async function rpcAll(fn, params) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.rpc(fn, params).range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

/* ---------- dates ---------- */

const D = (s) => new Date(`${s}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
const todayIso = () => iso(new Date());
const monthStart = (s) => `${s.slice(0, 7)}-01`;
const monthEnd = (s) => { const d = D(monthStart(s)); d.setUTCMonth(d.getUTCMonth() + 1, 0); return iso(d); };
const addMonths = (s, k) => { const d = D(monthStart(s)); d.setUTCMonth(d.getUTCMonth() + k); return iso(d); };
const monthLabel = (s) => D(s).toLocaleDateString(undefined, { month: 'short', year: '2-digit', timeZone: 'UTC' });

function buildMonths() {
  let list = [];
  if (periodKey.startsWith('fy:')) {
    const fy = fyears.find((y) => y.start_date === periodKey.slice(3));
    if (!fy) return [];
    let m = monthStart(fy.start_date);
    while (m <= fy.end_date && list.length < 36) { list.push(m); m = addMonths(m, 1); }
  } else {
    const n = Number(periodKey.slice(1));
    let m = addMonths(endKey || monthStart(todayIso()), -(n - 1));
    for (let i = 0; i < n; i++) { list.push(m); m = addMonths(m, 1); }
  }
  return list.map((s) => ({ key: s.slice(0, 7), from: s, to: monthEnd(s), label: monthLabel(s) }));
}

/* ---------- data ---------- */

const cmp = (a, b) => (a.sort_order - b.sort_order) || a.code.localeCompare(b.code, undefined, { numeric: true });

async function loadStatic() {
  const cid = ctx.companyId;
  const [g, a, f, fy, cu] = await Promise.all([
    supabase.from('account_groups').select('id, parent_id, code, name, level, show_subtotal, collapsed_default, sort_order').eq('company_id', cid),
    supabase.from('gl_accounts').select('id, code, name, group_id, normal_balance, control_type, sort_order').eq('company_id', cid).eq('is_posting', true),
    supabase.from('report_formats').select('id, code, name, is_default').eq('company_id', cid).eq('statement_type', 'income_statement').order('code'),
    supabase.from('fiscal_years').select('start_date, end_date').eq('company_id', cid).order('start_date'),
    supabase.from('company_currencies').select('code').eq('company_id', cid).eq('is_base', true).maybeSingle(),
  ]);
  for (const r of [g, a, f, fy]) if (r.error) throw r.error;
  groups = g.data;
  accounts = a.data;
  formats = f.data;
  fyears = fy.data;
  base = cu.data ? cu.data.code : '';
  groupById = new Map(groups.map((x) => [x.id, x]));
  childMap = new Map();
  groups.forEach((x) => { if (x.parent_id) { if (!childMap.has(x.parent_id)) childMap.set(x.parent_id, []); childMap.get(x.parent_id).push(x); } });
  childMap.forEach((l) => l.sort(cmp));
  accByGroup = new Map();
  accounts.forEach((x) => { if (x.group_id) { if (!accByGroup.has(x.group_id)) accByGroup.set(x.group_id, []); accByGroup.get(x.group_id).push(x); } });
  accByGroup.forEach((l) => l.sort(cmp));
  const def = formats.find((x) => x.is_default) || formats[0];
  formatId = def ? def.id : '';
}

async function loadLines() {
  lines = [];
  if (!formatId) return;
  const { data, error } = await supabase.from('report_lines').select('*').eq('format_id', formatId).order('sort_order');
  if (error) throw error;
  lines = data;
}

async function run() {
  months = buildMonths();
  if (!months.length) return ui.warn('Choose a period.');
  let data;
  try { data = await rpcAll('income_monthly', { p_company: ctx.companyId, p_from: months[0].from, p_to: months[months.length - 1].to }); }
  catch (e) { return ui.errorFrom(e, 'Could not run the report.'); }
  const idx = new Map(months.map((m, i) => [m.key, i]));
  sets = months.map(() => ({ map: new Map() }));
  const total = { map: new Map() };
  data.forEach((r) => {
    const i = idx.get(String(r.month).slice(0, 7));
    if (i === undefined) return;
    const row = { dr: Number(r.debit), cr: Number(r.credit) };
    sets[i].map.set(r.account_id, row);
    const t = total.map.get(r.account_id) || { dr: 0, cr: 0 };
    t.dr += row.dr; t.cr += row.cr;
    total.map.set(r.account_id, t);
  });
  sets.push(total);
  render();
}

/* ---------- report engine (the same rules as the Income Statement, one set per month plus a total) ---------- */

function buildRows() {
  const bal = (a, i) => { const r = sets[i].map.get(a.id); return r ? r.dr - r.cr : 0; };
  const memo = sets.map(() => new Map());
  const totalOf = (gid, i) => {
    if (memo[i].has(gid)) return memo[i].get(gid);
    let t = (accByGroup.get(gid) || []).reduce((s, a) => s + bal(a, i), 0);
    (childMap.get(gid) || []).forEach((c) => { t += totalOf(c.id, i); });
    memo[i].set(gid, t);
    return t;
  };
  const isZero = (a) => sets.every((_, i) => Math.abs(bal(a, i)) < 0.005);
  const rows = [];
  const values = sets.map(() => ({}));

  function addNode(line, g, depth, levelsLeft, top) {
    const key = `${line.id}:${g.id}`;
    const kids = levelsLeft > 0 ? (childMap.get(g.id) || []) : [];
    const accs = (line.show_accounts || showAll) ? (accByGroup.get(g.id) || []).filter((a) => !hideZero || !isZero(a)) : [];
    const hasDetail = kids.length > 0 || accs.length > 0;
    const label = top ? line.label : g.name;
    const amts = sets.map((_, i) => totalOf(g.id, i) * line.sign);
    const defCollapsed = top ? line.start_collapsed : g.collapsed_default;
    const collapsed = hasDetail && !forceOpen && (collapsedState.has(key) ? collapsedState.get(key) : defCollapsed);
    const style = top ? line.style : 'normal';
    if (!hasDetail || collapsed) {
      rows.push({ kind: 'group', depth, label, amts, style, key: hasDetail ? key : null, collapsed });
      return;
    }
    const showTotal = top || g.show_subtotal;
    rows.push({ kind: 'header', depth, label, amts: showTotal ? null : amts, key, collapsed: false, style: 'normal' });
    kids.forEach((k) => addNode(line, k, depth + 1, levelsLeft - 1, false));
    accs.forEach((a) => rows.push({ kind: 'account', depth: depth + 1, label: `${a.code}  ${a.name}`, amts: sets.map((_, i) => bal(a, i) * line.sign), acc: a }));
    if (showTotal) rows.push({ kind: 'total', depth, label: `Total ${label}`, amts, style });
  }

  lines.forEach((l) => {
    if (l.line_type === 'heading') { rows.push({ kind: 'heading', label: l.label }); return; }
    if (l.line_type === 'spacer') { rows.push({ kind: 'spacer' }); return; }
    if (l.line_type === 'group') {
      const g = groupById.get(l.group_id);
      if (!g) { rows.push({ kind: 'error', label: l.label, msg: 'Group not found' }); return; }
      if (l.code) sets.forEach((_, i) => { values[i][l.code.toUpperCase()] = totalOf(g.id, i) * l.sign; });
      addNode(l, g, 0, showAll ? 4 : l.detail_levels, true);
      return;
    }
    let amts = [];
    let msg = '';
    try { const ast = parse(l.formula); amts = sets.map((_, i) => evaluate(ast, values[i])); } catch (e) { msg = e.message; }
    if (!msg && l.code) sets.forEach((_, i) => { values[i][l.code.toUpperCase()] = amts[i]; });
    rows.push(msg ? { kind: 'error', label: l.label, msg } : { kind: 'formula', depth: 0, label: l.label, amts, style: l.style });
  });
  return rows;
}

/* ---------- render ---------- */

function render() {
  if (!formats.length) {
    panel.innerHTML = '<p class="muted">There is no income statement layout yet. Create one in <a href="/pages/reports.html">Report Layouts</a> (statement type: Income Statement) and it will appear here.</p>';
    return;
  }
  if (!lines.length) { panel.innerHTML = '<p class="muted">This layout has no lines yet. Add them in Report Layouts.</p>'; return; }
  if (!sets.length) { panel.innerHTML = '<p class="muted">Choose the period and click Run.</p>'; return; }

  const n = months.length;
  const rows = buildRows();
  const cols = n + 2 + (showAvg ? 1 : 0);
  const head = `<tr><th></th>${months.map((m) => `<th>${esc(m.label)}</th>`).join('')}<th>Total</th>${showAvg ? '<th>Average</th>' : ''}</tr>`;
  const body = rows.map((r) => {
    if (r.kind === 'spacer') return `<tr class="k-spacer"><td colspan="${cols}"></td></tr>`;
    if (r.kind === 'error') return `<tr class="k-error"><td colspan="${cols}">${esc(r.label)}: ${esc(r.msg)}</td></tr>`;
    if (r.kind === 'heading') return `<tr class="k-heading"><td colspan="${cols}">${esc(r.label)}</td></tr>`;
    const pad = 0.7 + (r.depth || 0) * 1.3;
    const caret = r.key ? `<span class="tree-caret">${r.collapsed ? '▸' : '▾'}</span>` : '<span class="tree-caret leaf">▾</span>';
    const clickable = r.key || r.acc;
    const cls = [`k-${r.kind}`, r.style ? `st-${r.style}` : '', clickable ? 'clickable' : ''].join(' ').trim();
    const attrs = r.key ? ` data-key="${esc(r.key)}"` : (r.acc ? ` data-acc="${r.acc.id}"` : '');
    let cells;
    if (!r.amts) cells = '<td class="amt"></td>'.repeat(n + 1 + (showAvg ? 1 : 0));
    else {
      cells = r.amts.map((a) => `<td class="amt">${fmt0(a)}</td>`).join('');
      if (showAvg) cells += `<td class="amt">${fmt0(r.amts[n] / n)}</td>`;
    }
    return `<tr class="${cls}"${attrs}><td style="padding-left:${pad}rem;white-space:nowrap">${caret}${esc(r.label)}</td>${cells}</tr>`;
  }).join('');
  const fmtName = (formats.find((x) => x.id === formatId) || {}).name || '';
  panel.innerHTML = `<div class="report-head"><h3>${esc(ctx.company.name)}</h3><div>Income Statement Trend${fmtName ? ` · ${esc(fmtName)}` : ''}</div>
    <div class="muted">${esc(months[0].label)} to ${esc(months[n - 1].label)} · amounts in ${esc(base)}, whole units</div></div>
    <div class="table-wrap"><table class="report"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

panel.addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-key], tr[data-acc]');
  if (!tr) return;
  if (tr.dataset.acc) { openAccount(accounts.find((a) => a.id === tr.dataset.acc)); return; }
  const k = tr.dataset.key;
  const cur = buildRows().find((r) => r.key === k);
  collapsedState.set(k, cur ? !cur.collapsed : true);
  render();
});

function setAll(collapse) {
  collapsedState.clear();
  forceOpen = true;
  const rows = buildRows();
  forceOpen = false;
  rows.filter((r) => r.key).forEach((r) => collapsedState.set(r.key, collapse));
  render();
}

async function openAccount(a) {
  if (!a || !months.length) return;
  const from = months[0].from;
  const to = months[months.length - 1].to;
  const { data, error } = await supabase.rpc('account_transactions', { p_company: ctx.companyId, p_account: a.id, p_from: from, p_to: to });
  if (error) return ui.errorFrom(error, 'Could not load the transactions.');
  let run2 = 0;
  let dr = 0;
  let cr = 0;
  const body = data.map((r) => {
    const d = Number(r.base_debit);
    const c = Number(r.base_credit);
    dr += d; cr += c; run2 += d - c;
    return `<tr><td>${r.journal_date}</td><td>${esc(r.journal_no || '')}</td><td>${esc(r.description || '')}</td>
      <td class="num">${d ? money(d) : ''}</td><td class="num">${c ? money(c) : ''}</td><td class="num">${fmt(run2)}</td></tr>`;
  }).join('');
  const node = el('div', 'table-wrap');
  node.innerHTML = `<p class="muted">${esc(from)} to ${esc(to)} · debit positive, credit in brackets${data.length >= 2000 ? ' · showing the first 2,000 lines' : ''}</p>
    <table class="grid"><thead><tr><th>Date</th><th>Journal</th><th>Description</th><th style="text-align:right">Debit</th>
    <th style="text-align:right">Credit</th><th style="text-align:right">Balance</th></tr></thead><tbody>
    ${body || '<tr><td colspan="6" class="muted">No postings in this period.</td></tr>'}
    <tr class="row-root"><td colspan="3">Total</td><td class="num">${money(dr)}</td><td class="num">${money(cr)}</td><td class="num">${fmt(run2)}</td></tr></tbody></table>`;
  await ui.dialog({ title: `${a.code} ${a.name}`, node, wide: true, dismissValue: 'close', buttons: [{ label: 'Close', value: 'close', className: 'btn-ghost' }] });
}

/* ---------- export ---------- */

async function doExport() {
  if (!sets.length || !lines.length) return ui.warn('Run the report first.');
  const n = months.length;
  const out = [];
  buildRows().forEach((r) => {
    if (r.kind === 'spacer') { out.push({ label: '', _k: 'spacer' }); return; }
    if (r.kind === 'error') { out.push({ label: `${r.label}: ${r.msg}`, _k: 'error' }); return; }
    if (r.kind === 'heading') { out.push({ label: r.label, _k: 'heading' }); return; }
    const row = { label: '   '.repeat(r.depth || 0) + r.label, _k: r.kind, _s: r.style };
    if (r.amts) {
      r.amts.slice(0, n).forEach((a, i) => { row[`m${i}`] = a; });
      row.total = r.amts[n];
      if (showAvg) row.avg = r.amts[n] / n;
    }
    out.push(row);
  });
  const columns = [{ key: 'label', header: 'Line', width: 48 }, ...months.map((m, i) => ({ key: `m${i}`, header: m.label, width: 14 })), { key: 'total', header: 'Total', width: 16 }];
  if (showAvg) columns.push({ key: 'avg', header: 'Average', width: 16 });
  try {
    await exportSheets(`income-trend-${months[0].key}-to-${months[n - 1].key}.xlsx`, [{
      name: 'Income trend', title: 'Income Statement Trend',
      subtitle: `${(formats.find((x) => x.id === formatId) || {}).name || ''} · ${months[0].label} to ${months[n - 1].label} · amounts in ${base}`,
      totals: false, rows: out, columns,
      styleCell: (row) => (row._k === 'heading' || row._s === 'total' ? { bold: true, fill: 'E5E7EB' }
        : (row._s === 'subtotal' || row._k === 'total' ? { bold: true } : null)),
    }]);
  } catch (e) { ui.errorFrom(e, 'Could not export.'); }
}

/* ---------- controls ---------- */

function buildToolbar() {
  toolbar.replaceChildren();
  const period = el('select', 'compact');
  [['r12', 'Last 12 months'], ['r6', 'Last 6 months'], ['r24', 'Last 24 months']].forEach(([v, l]) => option(period, v, l));
  fyears.forEach((y) => option(period, `fy:${y.start_date}`, `Financial year ${y.start_date} to ${y.end_date}`));
  period.value = periodKey;
  const ending = el('select', 'compact');
  const now = monthStart(todayIso());
  for (let i = 0; i < 36; i++) { const m = addMonths(now, -i); option(ending, m, i === 0 ? `${monthLabel(m)} (this month)` : monthLabel(m)); }
  ending.value = endKey || now;
  const endWrap = el('span', 'muted', 'ending');
  const sync = () => { const r = !periodKey.startsWith('fy:'); ending.style.display = r ? '' : 'none'; endWrap.style.display = r ? '' : 'none'; };
  period.addEventListener('change', () => { periodKey = period.value; sync(); run(); });
  ending.addEventListener('change', () => { endKey = ending.value; run(); });
  sync();

  const lay = el('select', 'compact');
  lay.style.maxWidth = '200px';
  formats.forEach((f) => option(lay, f.id, f.name + (f.is_default ? ' (default)' : '')));
  lay.value = formatId;
  lay.addEventListener('change', async () => { formatId = lay.value; collapsedState.clear(); try { await loadLines(); } catch (e) { ui.errorFrom(e); } render(); });

  const check = (label, get, set) => {
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = get();
    cb.style.width = 'auto';
    cb.addEventListener('change', () => { set(cb.checked); render(); });
    const l = el('label');
    l.style.cssText = 'display:flex;align-items:center;gap:.4rem;cursor:pointer';
    l.append(cb, document.createTextNode(label));
    return l;
  };
  toolbar.append(period, endWrap, ending);
  if (formats.length) toolbar.append(lay);
  toolbar.append(check('Show all accounts', () => showAll, (v) => { showAll = v; }),
    check('Hide zero accounts', () => hideZero, (v) => { hideZero = v; }),
    check('Average column', () => showAvg, (v) => { showAvg = v; }),
    btn('Run', 'btn-primary', run), btn('Expand all', '', () => setAll(false)), btn('Collapse all', '', () => setAll(true)),
    el('span', 'spacer'), btn('Print', '', () => window.print()), btn('Export to Excel', '', doExport));
}

async function init() {
  document.getElementById('company-title').textContent = ctx.company.name;
  try { await loadStatic(); await loadLines(); } catch (e) { ui.errorFrom(e, 'Could not load the report setup.'); return; }
  buildToolbar();
  hint.textContent = 'Your income statement layout by month, built from posted journals. The Total column is calculated on the whole period, so subtotal formulas stay correct. Click an account to see its transactions across the period, or a heading to expand or collapse it.';
  await run();
}

if (ctx) await init();