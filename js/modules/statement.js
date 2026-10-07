import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { exportSheets } from '../core/export.js';
import { parse, evaluate } from '../core/formula.js';

const ctx = await startPage();

const TYPE = document.body.dataset.statement === 'balance_sheet' ? 'balance_sheet' : 'income_statement';
const IS = TYPE === 'income_statement';
const TITLE = IS ? 'Income Statement' : 'Balance Sheet';

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const note = document.getElementById('note');
const panel = document.getElementById('panel');

let groups = [];
let accounts = [];
let formats = [];
let lines = [];
let fyears = [];
let base = '';
let reId = null;
let formatId = '';
let from = '';
let to = '';
let asAt = '';
let compMode = IS ? 'lastyear' : 'none';
let sets = [];
let showAll = false;
let hideZero = true;
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

/* ---------- data ---------- */

const cmp = (a, b) => (a.sort_order - b.sort_order) || a.code.localeCompare(b.code, undefined, { numeric: true });

async function loadStatic() {
  const cid = ctx.companyId;
  const [g, a, f, fy, cu] = await Promise.all([
    supabase.from('account_groups').select('id, parent_id, code, name, level, show_subtotal, collapsed_default, sort_order').eq('company_id', cid),
    supabase.from('gl_accounts').select('id, code, name, group_id, normal_balance, control_type, sort_order').eq('company_id', cid).eq('is_posting', true),
    supabase.from('report_formats').select('id, code, name, is_default').eq('company_id', cid).eq('statement_type', TYPE).order('code'),
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
  const re = accounts.find((x) => x.control_type === 'retained_earnings');
  reId = re ? re.id : null;
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

function ranges() {
  if (IS) {
    const cur = { from, to };
    let c = null;
    if (compMode === 'prev') {
      const e = addDays(from, -1);
      c = { from: addDays(e, -(spanLen(from, to) - 1)), to: e };
    } else if (compMode === 'lastyear') c = { from: addYears(from, -1), to: addYears(to, -1) };
    return c ? [cur, c] : [cur];
  }
  const cur = { asAt };
  let c = null;
  if (compMode === 'prevmonth') c = { asAt: addDays(monthStart(asAt), -1) };
  else if (compMode === 'lastyear') c = { asAt: addYears(asAt, -1) };
  else if (compMode === 'lastfyend') c = { asAt: addDays(fyStartFor(asAt), -1) };
  return c ? [cur, c] : [cur];
}

async function loadSet(r) {
  const f = IS ? r.from : fyStartFor(r.asAt);
  const t = IS ? r.to : r.asAt;
  const { data, error } = await supabase.rpc('trial_balance', { p_company: ctx.companyId, p_from: f, p_to: t });
  if (error) throw error;
  const hasFy = !!fyFor(t);
  const map = new Map();
  let isNet = 0;
  let prior = 0;
  data.forEach((x) => {
    if (!x.account_id) { prior += Number(x.closing); return; }
    const row = { open: Number(x.opening), dr: Number(x.debit), cr: Number(x.credit), close: Number(x.closing) };
    map.set(x.account_id, row);
    if (x.class_type === 'income_statement') isNet += row.dr - row.cr + (hasFy ? 0 : row.open);
  });
  return { map, adj: IS ? 0 : isNet + prior, from: f, to: t, label: IS ? `${r.from} to ${r.to}` : `As at ${r.asAt}` };
}

/* ---------- report engine (same rules as the layout preview, with real balances) ---------- */

function buildRows() {
  const bal = (a, i) => {
    const r = sets[i].map.get(a.id);
    return (r ? (IS ? r.dr - r.cr : r.close) : 0) + (!IS && a.id === reId ? sets[i].adj : 0);
  };
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
    accs.forEach((a) => rows.push({
      kind: 'account', depth: depth + 1,
      label: `${a.code}  ${a.name}${!IS && a.id === reId && Math.abs(sets[0].adj) > 0.004 ? '  (includes unclosed profit)' : ''}`,
      amts: sets.map((_, i) => bal(a, i) * line.sign), acc: a,
    }));
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

function periodText() { return sets.map((s) => s.label).join(' · '); }

function render() {
  const fmtName = (formats.find((x) => x.id === formatId) || {}).name || '';
  if (!formats.length) {
    panel.innerHTML = `<p class="muted">There is no ${TITLE.toLowerCase()} layout yet. Create one in <a href="/pages/reports.html">Report Layouts</a> (statement type: ${TITLE}) and it will appear here.</p>`;
    return;
  }
  if (!lines.length) { panel.innerHTML = '<p class="muted">This layout has no lines yet. Add them in Report Layouts.</p>'; return; }
  if (!sets.length) { panel.innerHTML = '<p class="muted">Choose the dates and click Run.</p>'; return; }

  const n = sets.length;
  const rows = buildRows();
  const cols = n > 1 ? 5 : 2;
  const head = `<tr><th></th>${sets.map((s) => `<th>${esc(s.label)}</th>`).join('')}${n > 1 ? '<th>Variance</th><th>%</th>' : ''}</tr>`;
  const body = rows.map((r) => {
    if (r.kind === 'spacer') return `<tr class="k-spacer"><td colspan="${cols}"></td></tr>`;
    if (r.kind === 'error') return `<tr class="k-error"><td colspan="${cols}">${esc(r.label)}: ${esc(r.msg)}</td></tr>`;
    if (r.kind === 'heading') return `<tr class="k-heading"><td colspan="${cols}">${esc(r.label)}</td></tr>`;
    const pad = 0.7 + (r.depth || 0) * 1.3;
    const caret = r.key ? `<span class="tree-caret">${r.collapsed ? '▸' : '▾'}</span>` : '<span class="tree-caret leaf">▾</span>';
    const clickable = r.key || r.acc;
    const cls = [`k-${r.kind}`, r.style ? `st-${r.style}` : '', clickable ? 'clickable' : ''].join(' ').trim();
    const attrs = r.key ? ` data-key="${esc(r.key)}"` : (r.acc ? ` data-acc="${r.acc.id}"` : '');
    let cells = '';
    if (!r.amts) cells = '<td class="amt"></td>'.repeat(n > 1 ? 4 : 1);
    else {
      cells = `<td class="amt">${fmt(r.amts[0])}</td>`;
      if (n > 1) cells += `<td class="amt">${fmt(r.amts[1])}</td><td class="amt">${fmt(r.amts[0] - r.amts[1])}</td><td class="amt">${pct(r.amts[0], r.amts[1])}</td>`;
    }
    return `<tr class="${cls}"${attrs}><td style="padding-left:${pad}rem">${caret}${esc(r.label)}</td>${cells}</tr>`;
  }).join('');
  panel.innerHTML = `<div class="report-head"><h3>${esc(ctx.company.name)}</h3><div>${TITLE}${fmtName ? ` · ${esc(fmtName)}` : ''}</div>
    <div class="muted">${esc(periodText())} · amounts in ${esc(base)}</div></div>
    <div class="table-wrap"><table class="report"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

function updateNote() {
  note.innerHTML = '';
  if (!IS && sets.length && !reId && Math.abs(sets[0].adj) > 0.004) {
    note.innerHTML = `<div class="card" style="border-color:var(--warning)"><strong>Profit is not in equity.</strong>
      Unclosed profit of ${money(-sets[0].adj)} ${esc(base)} cannot be shown because no account has the control type Retained earnings.
      Set it on an equity account in the Chart of Accounts and the balance sheet will include it.</div>`;
  }
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

/* ---------- drill into an account ---------- */

async function openAccount(a) {
  if (!a) return;
  const s = sets[0];
  const { data, error } = await supabase.rpc('account_transactions', {
    p_company: ctx.companyId, p_account: a.id, p_from: s.from, p_to: s.to,
  });
  if (error) return ui.errorFrom(error, 'Could not load the transactions.');
  const open = IS ? 0 : ((s.map.get(a.id) || {}).open || 0);
  let run = open;
  let dr = 0;
  let cr = 0;
  const body = data.map((r) => {
    const d = Number(r.base_debit);
    const c = Number(r.base_credit);
    dr += d;
    cr += c;
    run += d - c;
    return `<tr><td>${r.journal_date}</td><td>${esc(r.journal_no || '')}</td><td>${esc(r.description || '')}</td>
      <td class="num">${d ? money(d) : ''}</td><td class="num">${c ? money(c) : ''}</td><td class="num">${fmt(run)}</td></tr>`;
  }).join('');
  const node = el('div', 'table-wrap');
  node.innerHTML = `<p class="muted">${esc(s.from)} to ${esc(s.to)} · ledger signs: debit positive, credit in brackets${data.length >= 2000 ? ' · showing the first 2,000 lines' : ''}</p>
    <table class="grid"><thead><tr><th>Date</th><th>Journal</th><th>Description</th><th style="text-align:right">Debit</th>
    <th style="text-align:right">Credit</th><th style="text-align:right">Balance</th></tr></thead><tbody>
    ${IS ? '' : `<tr class="row-parent"><td colspan="5">Opening balance</td><td class="num">${fmt(open)}</td></tr>`}
    ${body || '<tr><td colspan="6" class="muted">No postings in this period.</td></tr>'}
    <tr class="row-root"><td colspan="3">Total</td><td class="num">${money(dr)}</td><td class="num">${money(cr)}</td><td class="num">${fmt(run)}</td></tr></tbody></table>`;
  await ui.dialog({ title: `${a.code} ${a.name}`, node, wide: true, dismissValue: 'close',
    buttons: [{ label: 'Close', value: 'close', className: 'btn-ghost' }] });
}

/* ---------- export ---------- */

async function doExport() {
  if (!sets.length || !lines.length) return ui.warn('Run the report first.');
  const n = sets.length;
  const out = [];
  buildRows().forEach((r) => {
    if (r.kind === 'spacer') { out.push({ label: '', _k: 'spacer' }); return; }
    if (r.kind === 'error') { out.push({ label: `${r.label}: ${r.msg}`, _k: 'error' }); return; }
    if (r.kind === 'heading') { out.push({ label: r.label, _k: 'heading' }); return; }
    const row = { label: '   '.repeat(r.depth || 0) + r.label, _k: r.kind, _s: r.style };
    if (r.amts) {
      row.cur = r.amts[0];
      if (n > 1) {
        row.cmp = r.amts[1];
        row.var = r.amts[0] - r.amts[1];
        row.pct = Math.abs(r.amts[1]) < 0.005 ? '' : ((r.amts[0] - r.amts[1]) / Math.abs(r.amts[1])) * 100;
      }
    }
    out.push(row);
  });
  const columns = [{ key: 'label', header: 'Line', width: 52 }, { key: 'cur', header: sets[0].label, width: 20 }];
  if (n > 1) columns.push({ key: 'cmp', header: sets[1].label, width: 20 }, { key: 'var', header: 'Variance', width: 16 }, { key: 'pct', header: 'Variance %', width: 12 });
  try {
    await exportSheets(`${TITLE.toLowerCase().replace(' ', '-')}-${IS ? to : asAt}.xlsx`, [{
      name: TITLE, title: TITLE, subtitle: `${(formats.find((x) => x.id === formatId) || {}).name || ''} · ${periodText()} · amounts in ${base}`,
      totals: false, rows: out, columns,
      styleCell: (row) => (row._k === 'heading' || row._s === 'total' ? { bold: true, fill: 'E5E7EB' }
        : (row._s === 'subtotal' || row._k === 'total' ? { bold: true } : null)),
    }]);
  } catch (e) { ui.errorFrom(e, 'Could not export.'); }
}

/* ---------- controls ---------- */

async function run() {
  if (IS && (!from || !to || to < from)) return ui.warn('Choose a valid date range.');
  if (!IS && !asAt) return ui.warn('Choose the date.');
  try { sets = await Promise.all(ranges().map(loadSet)); } catch (e) { return ui.errorFrom(e, 'Could not run the report.'); }
  updateNote();
  render();
}

function buildToolbar() {
  toolbar.replaceChildren();
  const dateIn = (v) => { const i = el('input'); i.type = 'date'; i.value = v; i.style.width = 'auto'; return i; };
  const cmpSel = el('select', 'compact');
  const opts = IS ? [['none', 'No comparative'], ['prev', 'Previous period'], ['lastyear', 'Same period last year']]
    : [['none', 'No comparative'], ['prevmonth', 'Previous month end'], ['lastyear', 'Same date last year'], ['lastfyend', 'Last financial year end']];
  opts.forEach(([v, l]) => option(cmpSel, v, l));
  cmpSel.value = compMode;
  cmpSel.addEventListener('change', () => { compMode = cmpSel.value; run(); });

  if (IS) {
    const preset = el('select', 'compact');
    [['fytd', 'Financial year to date'], ['month', 'This month'], ['lastmonth', 'Last month'], ['lastfy', 'Last financial year'], ['custom', 'Custom dates']]
      .forEach(([v, l]) => option(preset, v, l));
    const f = dateIn(from);
    const t = dateIn(to);
    preset.addEventListener('change', () => { if (preset.value !== 'custom') { applyPreset(preset.value); f.value = from; t.value = to; run(); } });
    f.addEventListener('change', () => { from = f.value; preset.value = 'custom'; });
    t.addEventListener('change', () => { to = t.value; preset.value = 'custom'; });
    toolbar.append(preset, f, el('span', 'muted', 'to'), t);
  } else {
    const a = dateIn(asAt);
    a.addEventListener('change', () => { asAt = a.value; });
    toolbar.append(el('span', 'muted', 'As at'), a);
  }
  toolbar.append(cmpSel);

  const lay = el('select', 'compact');
  lay.style.maxWidth = '200px';
  formats.forEach((f) => option(lay, f.id, f.name + (f.is_default ? ' (default)' : '')));
  lay.value = formatId;
  lay.addEventListener('change', async () => { formatId = lay.value; collapsedState.clear(); try { await loadLines(); } catch (e) { ui.errorFrom(e); } render(); });
  if (formats.length) toolbar.append(lay);

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
  toolbar.append(check('Show all accounts', () => showAll, (v) => { showAll = v; }),
    check('Hide zero accounts', () => hideZero, (v) => { hideZero = v; }),
    btn('Run', 'btn-primary', run), btn('Expand all', '', () => setAll(false)), btn('Collapse all', '', () => setAll(true)),
    el('span', 'spacer'), btn('Print', '', () => window.print()), btn('Export to Excel', '', doExport));
}

async function init() {
  document.getElementById('company-title').textContent = ctx.company.name;
  try { await loadStatic(); await loadLines(); } catch (e) { ui.errorFrom(e, 'Could not load the report setup.'); return; }
  if (IS) applyPreset('fytd'); else asAt = todayIso();
  buildToolbar();
  hint.textContent = IS
    ? 'Built from your layout, using posted journals. Click an account to see its transactions, or a heading to expand or collapse it. Credits show as positive on lines where your layout sign says so.'
    : 'Built from your layout as at the date. Profit not yet closed to equity is added to the Retained earnings control account so the sheet balances. Click an account to see its transactions.';
  await run();
}

if (ctx) await init();