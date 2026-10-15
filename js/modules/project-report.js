import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { exportSheets } from '../core/export.js';
import { loadLayout, loadLayoutLines, buildLayoutRows } from '../core/layout-engine.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const summaryEl = document.getElementById('summary');
const panel = document.getElementById('panel');

const STATUS = { open: 'Open', on_hold: 'On hold', closed: 'Closed' };

let L = null;
let lines = [];
let formatId = '';
let projects = [];
let customers = [];
let fyears = [];
let base = '';
let summary = [];
let set = null;
let scopeType = 'project';
let targetId = new URLSearchParams(location.search).get('project') || '';
let preset = 'all';
let from = '1900-01-01';
let to = '2999-12-31';
let showAll = false;
let hideZero = true;
let forceOpen = false;
let scope = { projects: [], untagged: false, label: '' };
const collapsedState = new Map();

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (n) => (Math.abs(n) < 0.005 ? '–' : (n < 0 ? `(${money(-n)})` : money(n)));
function btn(text, cls, onClick) {
  const b = el('button', `btn ${cls}`.trim(), text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}
function option(select, value, text) { const o = el('option', '', text); o.value = value; select.append(o); }
async function rpcAll(fn, params) {
  const out = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await supabase.rpc(fn, params).range(f, f + 999);
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
const addDays = (s, n) => { const d = D(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const monthStart = (s) => `${s.slice(0, 7)}-01`;
const monthEnd = (s) => { const d = D(monthStart(s)); d.setUTCMonth(d.getUTCMonth() + 1, 0); return iso(d); };
const fyStartFor = (s) => { const y = fyears.find((x) => s >= x.start_date && s <= x.end_date); return y ? y.start_date : `${s.slice(0, 4)}-01-01`; };

function applyPreset(p) {
  const today = todayIso();
  if (p === 'all') { from = '1900-01-01'; to = '2999-12-31'; }
  else if (p === 'fytd') { from = fyStartFor(today); to = today; }
  else if (p === 'lastfy') { const e = addDays(fyStartFor(today), -1); from = fyStartFor(e); to = e; }
  else if (p === 'month') { from = monthStart(today); to = monthEnd(today); }
}
const periodText = () => (preset === 'all' ? 'All time' : `${from} to ${to}`);

/* ---------- data ---------- */

async function loadStatic() {
  const cid = ctx.companyId;
  const [pj, cu, fy, cur] = await Promise.all([
    supabase.from('projects').select('id, code, name, customer_id, status, budget_income, budget_cost').eq('company_id', cid).order('code'),
    supabase.from('customers').select('id, code, name').eq('company_id', cid).order('code'),
    supabase.from('fiscal_years').select('start_date, end_date').eq('company_id', cid).order('start_date'),
    supabase.from('company_currencies').select('code').eq('company_id', cid).eq('is_base', true).maybeSingle(),
  ]);
  for (const r of [pj, cu, fy]) if (r.error) throw r.error;
  projects = pj.data;
  customers = cu.data;
  fyears = fy.data;
  base = cur.data ? cur.data.code : '';
  L = await loadLayout(cid, 'income_statement');
  formatId = L.defaultFormatId;
  lines = await loadLayoutLines(formatId);
}

const custLabel = (id) => { const c = customers.find((x) => x.id === id); return c ? `${c.code} - ${c.name}` : ''; };

function resolveScope() {
  if (scopeType === 'project') {
    const p = projects.find((x) => x.id === targetId);
    return { projects: p ? [p.id] : [], untagged: false, label: p ? `${p.code} - ${p.name}` : '', project: p || null };
  }
  if (scopeType === 'customer') {
    const list = projects.filter((x) => x.customer_id === targetId);
    return { projects: list.map((x) => x.id), untagged: false, label: `Projects of ${custLabel(targetId)}`, project: null };
  }
  if (scopeType === 'all') return { projects: projects.map((x) => x.id), untagged: false, label: 'All projects', project: null };
  return { projects: [], untagged: true, label: 'No project (everything not tagged)', project: null };
}

async function loadSummary() {
  try { summary = await rpcAll('project_summary', { p_company: ctx.companyId, p_from: from, p_to: to }); }
  catch (e) { summary = []; ui.errorFrom(e, 'Could not load the project summary.'); }
  renderSummary();
}

async function run() {
  scope = resolveScope();
  await loadSummary();
  if (!scope.untagged && !scope.projects.length) { set = null; renderReport(); return; }
  let data;
  try {
    data = await rpcAll('project_movements', {
      p_company: ctx.companyId, p_projects: scope.projects, p_untagged: scope.untagged, p_from: from, p_to: to,
    });
  } catch (e) { return ui.errorFrom(e, 'Could not run the report.'); }
  set = { map: new Map(data.map((r) => [r.account_id, { dr: Number(r.debit), cr: Number(r.credit) }])) };
  renderReport();
}

/* ---------- render ---------- */

function renderSummary() {
  if (!summary.length) { summaryEl.innerHTML = '<p class="muted">There are no projects yet. Create one under Projects, then pick it on invoices, bills and journals.</p>'; return; }
  const body = summary.map((s) => {
    const inc = Number(s.income);
    const exp = Number(s.expenses);
    const profit = inc - exp;
    const p = projects.find((x) => x.id === s.project_id) || {};
    const margin = Math.abs(inc) < 0.005 ? '' : `${((profit / inc) * 100).toFixed(1)}%`;
    return `<tr class="clickable" data-pid="${s.project_id}"><td>${esc(s.code)}</td><td>${esc(s.name)}</td><td>${esc(custLabel(s.customer_id))}</td>
      <td><span class="badge ${s.status === 'open' ? 'st-update' : ''}">${STATUS[s.status] || s.status}</span></td>
      <td class="num">${fmt(inc)}</td><td class="num">${fmt(exp)}</td><td class="num"><strong>${fmt(profit)}</strong></td><td class="num">${margin}</td>
      <td class="num">${p.budget_income === null || p.budget_income === undefined ? '' : fmt(Number(p.budget_income))}</td>
      <td class="num">${p.budget_cost === null || p.budget_cost === undefined ? '' : fmt(Number(p.budget_cost))}</td></tr>`;
  }).join('');
  const ti = summary.reduce((s, x) => s + Number(x.income), 0);
  const te = summary.reduce((s, x) => s + Number(x.expenses), 0);
  summaryEl.innerHTML = `<h3 style="margin-top:0">Projects, ${esc(periodText())}</h3><div class="table-wrap"><table class="grid"><thead><tr><th>Code</th><th>Project</th><th>Customer</th><th>Status</th>
    <th style="text-align:right">Income</th><th style="text-align:right">Costs</th><th style="text-align:right">Profit</th><th style="text-align:right">Margin</th>
    <th style="text-align:right">Budget income</th><th style="text-align:right">Budget cost</th></tr></thead><tbody>${body}
    <tr class="row-root"><td colspan="4">Total (${esc(base)})</td><td class="num">${fmt(ti)}</td><td class="num">${fmt(te)}</td><td class="num">${fmt(ti - te)}</td><td colspan="3"></td></tr></tbody></table></div>
    <p class="muted">Click a project to see its profit and loss below.</p>`;
}

summaryEl.addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-pid]');
  if (!tr) return;
  scopeType = 'project';
  targetId = tr.dataset.pid;
  buildToolbar();
  run();
});

function rows() {
  return buildLayoutRows(L, lines, 1, { balOf: (a) => { const r = set.map.get(a.id); return r ? r.dr - r.cr : 0; }, showAll, hideZero, forceOpen, collapsed: collapsedState });
}

function renderReport() {
  if (!L.formats.length) { panel.innerHTML = '<p class="muted">There is no income statement layout yet. Create one in <a href="/pages/reports.html">Report Layouts</a>.</p>'; return; }
  if (!set) { panel.innerHTML = '<p class="muted">Choose a project, a customer, or another scope and click Run.</p>'; return; }
  const r = rows();
  const body = r.map((x) => {
    if (x.kind === 'spacer') return '<tr class="k-spacer"><td colspan="2"></td></tr>';
    if (x.kind === 'error') return `<tr class="k-error"><td colspan="2">${esc(x.label)}: ${esc(x.msg)}</td></tr>`;
    if (x.kind === 'heading') return `<tr class="k-heading"><td colspan="2">${esc(x.label)}</td></tr>`;
    const pad = 0.7 + (x.depth || 0) * 1.3;
    const caret = x.key ? `<span class="tree-caret">${x.collapsed ? '▸' : '▾'}</span>` : '<span class="tree-caret leaf">▾</span>';
    const cls = [`k-${x.kind}`, x.style ? `st-${x.style}` : '', (x.key || x.acc) ? 'clickable' : ''].join(' ').trim();
    const attrs = x.key ? ` data-key="${esc(x.key)}"` : (x.acc ? ` data-acc="${x.acc.id}"` : '');
    return `<tr class="${cls}"${attrs}><td style="padding-left:${pad}rem">${caret}${esc(x.label)}</td><td class="amt">${x.amts ? fmt(x.amts[0]) : ''}</td></tr>`;
  }).join('');

  let budget = '';
  const p = scope.project;
  if (p && (p.budget_income !== null || p.budget_cost !== null)) {
    const s = summary.find((x) => x.project_id === p.id);
    if (s) {
      const bi = p.budget_income === null ? null : Number(p.budget_income);
      const bc = p.budget_cost === null ? null : Number(p.budget_cost);
      budget = `<div class="table-wrap" style="margin-bottom:1rem"><table class="grid"><thead><tr><th>Budget against actual</th><th style="text-align:right">Budget</th><th style="text-align:right">Actual</th><th style="text-align:right">Left</th></tr></thead><tbody>
        ${bi === null ? '' : `<tr><td>Income</td><td class="num">${fmt(bi)}</td><td class="num">${fmt(Number(s.income))}</td><td class="num">${fmt(bi - Number(s.income))}</td></tr>`}
        ${bc === null ? '' : `<tr><td>Costs</td><td class="num">${fmt(bc)}</td><td class="num">${fmt(Number(s.expenses))}</td><td class="num">${fmt(bc - Number(s.expenses))}</td></tr>`}</tbody></table></div>`;
    }
  }
  panel.innerHTML = `<div class="report-head"><h3>${esc(ctx.company.name)}</h3><div>Profit and loss · ${esc(scope.label)}</div>
    <div class="muted">${esc(periodText())} · amounts in ${esc(base)}</div></div>${budget}
    <div class="table-wrap"><table class="report"><thead><tr><th></th><th>${esc(periodText())}</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

panel.addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-key], tr[data-acc]');
  if (!tr) return;
  if (tr.dataset.acc) { openAccount(L.accounts.find((a) => a.id === tr.dataset.acc)); return; }
  const k = tr.dataset.key;
  const cur = rows().find((x) => x.key === k);
  collapsedState.set(k, cur ? !cur.collapsed : true);
  renderReport();
});

function setAll(collapse) {
  if (!set) return;
  collapsedState.clear();
  forceOpen = true;
  const r = rows();
  forceOpen = false;
  r.filter((x) => x.key).forEach((x) => collapsedState.set(x.key, collapse));
  renderReport();
}

async function openAccount(a) {
  if (!a) return;
  const { data, error } = await supabase.rpc('project_transactions', {
    p_company: ctx.companyId, p_projects: scope.projects, p_untagged: scope.untagged, p_account: a.id, p_from: from, p_to: to,
  });
  if (error) return ui.errorFrom(error, 'Could not load the transactions.');
  let dr = 0;
  let cr = 0;
  const body = data.map((r) => {
    const d = Number(r.base_debit);
    const c = Number(r.base_credit);
    dr += d; cr += c;
    return `<tr><td>${r.journal_date}</td><td>${esc(r.journal_no || '')}</td><td>${esc(r.project_code || '')}</td><td>${esc(r.description || '')}</td>
      <td class="num">${d ? money(d) : ''}</td><td class="num">${c ? money(c) : ''}</td></tr>`;
  }).join('');
  const node = el('div', 'table-wrap');
  node.innerHTML = `<p class="muted">${esc(scope.label)} · ${esc(periodText())} · debit positive, credit in brackets${data.length >= 2000 ? ' · showing the first 2,000 lines' : ''}</p>
    <table class="grid"><thead><tr><th>Date</th><th>Journal</th><th>Project</th><th>Description</th><th style="text-align:right">Debit</th><th style="text-align:right">Credit</th></tr></thead><tbody>
    ${body || '<tr><td colspan="6" class="muted">No postings.</td></tr>'}
    <tr class="row-root"><td colspan="4">Total</td><td class="num">${money(dr)}</td><td class="num">${money(cr)}</td></tr></tbody></table>`;
  await ui.dialog({ title: `${a.code} ${a.name}`, node, wide: true, dismissValue: 'close', buttons: [{ label: 'Close', value: 'close', className: 'btn-ghost' }] });
}

/* ---------- export ---------- */

async function doExport() {
  const sheets = [];
  if (set) {
    const out = [];
    rows().forEach((r) => {
      if (r.kind === 'spacer') { out.push({ label: '', _k: 'spacer' }); return; }
      if (r.kind === 'error') { out.push({ label: `${r.label}: ${r.msg}`, _k: 'error' }); return; }
      if (r.kind === 'heading') { out.push({ label: r.label, _k: 'heading' }); return; }
      const row = { label: '   '.repeat(r.depth || 0) + r.label, _k: r.kind, _s: r.style };
      if (r.amts) row.amount = r.amts[0];
      out.push(row);
    });
    sheets.push({
      name: 'Project P&L', title: `Profit and loss: ${scope.label}`, subtitle: `${periodText()} · amounts in ${base}`, totals: false, rows: out,
      columns: [{ key: 'label', header: 'Line', width: 52 }, { key: 'amount', header: periodText(), width: 20 }],
      styleCell: (row) => (row._k === 'heading' || row._s === 'total' ? { bold: true, fill: 'E5E7EB' } : (row._s === 'subtotal' || row._k === 'total' ? { bold: true } : null)),
    });
  }
  if (summary.length) {
    sheets.push({
      name: 'Projects', title: 'Projects', subtitle: `${periodText()} · amounts in ${base}`,
      rows: summary.map((s) => ({
        code: s.code, name: s.name, customer: custLabel(s.customer_id), status: STATUS[s.status] || s.status,
        income: Number(s.income), costs: Number(s.expenses), profit: Number(s.income) - Number(s.expenses),
      })),
      columns: [
        { key: 'code', header: 'Code', width: 12 }, { key: 'name', header: 'Project', width: 32 }, { key: 'customer', header: 'Customer', width: 30 },
        { key: 'status', header: 'Status', width: 10 }, { key: 'income', header: 'Income', width: 16, total: true },
        { key: 'costs', header: 'Costs', width: 16, total: true }, { key: 'profit', header: 'Profit', width: 16, total: true },
      ],
    });
  }
  if (!sheets.length) return ui.warn('Run the report first.');
  try { await exportSheets(`project-report-${todayIso()}.xlsx`, sheets); } catch (e) { ui.errorFrom(e, 'Could not export.'); }
}

/* ---------- controls ---------- */

function buildToolbar() {
  toolbar.replaceChildren();
  const scopeSel = el('select', 'compact');
  [['project', 'One project'], ['customer', 'All projects of a customer'], ['all', 'All projects'], ['none', 'No project']].forEach(([v, l]) => option(scopeSel, v, l));
  scopeSel.value = scopeType;
  const target = el('select', 'compact');
  target.style.maxWidth = '260px';
  const fillTarget = () => {
    target.replaceChildren();
    if (scopeType === 'project') {
      option(target, '', 'Select a project');
      projects.forEach((p) => option(target, p.id, `${p.code} - ${p.name}`));
    } else if (scopeType === 'customer') {
      option(target, '', 'Select a customer');
      const ids = new Set(projects.map((p) => p.customer_id).filter(Boolean));
      customers.filter((c) => ids.has(c.id)).forEach((c) => option(target, c.id, `${c.code} - ${c.name}`));
    }
    target.style.display = scopeType === 'project' || scopeType === 'customer' ? '' : 'none';
    target.value = [...target.options].some((o) => o.value === targetId) ? targetId : '';
    if (!target.value) targetId = '';
  };
  fillTarget();
  scopeSel.addEventListener('change', () => { scopeType = scopeSel.value; targetId = ''; fillTarget(); });
  target.addEventListener('change', () => { targetId = target.value; run(); });

  const per = el('select', 'compact');
  [['all', 'All time'], ['fytd', 'Financial year to date'], ['lastfy', 'Last financial year'], ['month', 'This month'], ['custom', 'Custom dates']].forEach(([v, l]) => option(per, v, l));
  per.value = preset;
  const f = el('input'); f.type = 'date'; f.style.width = 'auto'; f.value = from === '1900-01-01' ? '' : from;
  const t = el('input'); t.type = 'date'; t.style.width = 'auto'; t.value = to === '2999-12-31' ? '' : to;
  const dates = el('span');
  dates.style.cssText = 'display:inline-flex;gap:.4rem;align-items:center';
  dates.append(f, el('span', 'muted', 'to'), t);
  dates.style.display = preset === 'custom' ? '' : 'none';
  per.addEventListener('change', () => {
    preset = per.value;
    if (preset === 'custom') { dates.style.display = ''; return; }
    dates.style.display = 'none';
    applyPreset(preset);
    run();
  });
  f.addEventListener('change', () => { from = f.value || '1900-01-01'; });
  t.addEventListener('change', () => { to = t.value || '2999-12-31'; });

  const lay = el('select', 'compact');
  lay.style.maxWidth = '200px';
  L.formats.forEach((x) => option(lay, x.id, x.name + (x.is_default ? ' (default)' : '')));
  lay.value = formatId;
  lay.addEventListener('change', async () => { formatId = lay.value; collapsedState.clear(); try { lines = await loadLayoutLines(formatId); } catch (e) { ui.errorFrom(e); } renderReport(); });

  const check = (label, get, setv) => {
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = get();
    cb.style.width = 'auto';
    cb.addEventListener('change', () => { setv(cb.checked); renderReport(); });
    const l = el('label');
    l.style.cssText = 'display:flex;align-items:center;gap:.4rem;cursor:pointer';
    l.append(cb, document.createTextNode(label));
    return l;
  };
  toolbar.append(scopeSel, target, per, dates);
  if (L.formats.length) toolbar.append(lay);
  toolbar.append(check('Show all accounts', () => showAll, (v) => { showAll = v; }), check('Hide zero accounts', () => hideZero, (v) => { hideZero = v; }),
    btn('Run', 'btn-primary', run), btn('Expand all', '', () => setAll(false)), btn('Collapse all', '', () => setAll(true)),
    el('span', 'spacer'), btn('Print', '', () => window.print()), btn('Export to Excel', '', doExport));
}

async function init() {
  document.getElementById('company-title').textContent = ctx.company.name;
  try { await loadStatic(); } catch (e) { ui.errorFrom(e, 'Could not load the report setup.'); return; }
  if (targetId && !projects.some((p) => p.id === targetId)) targetId = '';
  buildToolbar();
  hint.textContent = 'Profit and loss for a project, for all of a customer\'s projects, for all projects, or for everything with no project (all projects plus no project equals your income statement). It uses your income statement layout. Click an account for the transactions behind it.';
  await run();
}

if (ctx) await init();