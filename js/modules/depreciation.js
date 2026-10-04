import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { exportSheets } from '../core/export.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const panel = document.getElementById('panel');

const CAN_RUN = ctx ? ctx.canEdit : false;

let tab = 'run';
let base = '';
let preview = [];
let previewThrough = '';
let runs = [];
let schedule = [];

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (n) => (Math.abs(Number(n)) < 0.005 ? '' : money(n));
const todayIso = () => new Date().toISOString().slice(0, 10);
function btn(text, cls, onClick) {
  const b = el('button', `btn ${cls}`.trim(), text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}
function monthEnd(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
function previousMonth() {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

const monthEl = el('input'); monthEl.type = 'month'; monthEl.style.width = 'auto';
const fromEl = el('input'); fromEl.type = 'date'; fromEl.style.width = 'auto';
const toEl = el('input'); toEl.type = 'date'; toEl.style.width = 'auto';

async function init() {
  document.getElementById('company-title').textContent = ctx.company.name;
  const cid = ctx.companyId;
  const [c, fy] = await Promise.all([
    supabase.from('company_currencies').select('code').eq('company_id', cid).eq('is_base', true).maybeSingle(),
    supabase.from('fiscal_years').select('start_date, end_date').eq('company_id', cid).order('start_date'),
  ]);
  base = c.data ? c.data.code : '';
  const today = todayIso();
  const year = (fy.data || []).find((y) => today >= y.start_date && today <= y.end_date);
  monthEl.value = previousMonth();
  fromEl.value = year ? year.start_date : `${today.slice(0, 4)}-01-01`;
  toEl.value = today;
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', async () => {
    tab = t.dataset.tab;
    if (tab === 'runs') await loadRuns();
    render();
  }));
  render();
}

function render() {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  toolbar.replaceChildren();
  if (tab === 'run') renderRun();
  else if (tab === 'runs') renderRuns();
  else renderSchedule();
}

/* ---------- run depreciation ---------- */

function renderRun() {
  hint.textContent = `Depreciation is monthly, from the month an asset is put in service. Choose the month to depreciate up to, preview what will post, then post it. Missed months are caught up in one run and posted at the month end. Amounts in ${base}.`;
  toolbar.append(el('span', 'muted', 'Depreciate up to the end of'), monthEl, btn('Preview', 'btn-primary', doPreview));
  if (CAN_RUN) toolbar.append(btn('Post depreciation run', '', doPost));
  toolbar.append(el('span', 'spacer'), btn('Export to Excel', '', doExport));
  renderPreview();
}

async function doPreview() {
  if (!monthEl.value) return ui.warn('Choose the month.');
  const through = monthEnd(monthEl.value);
  const { data, error } = await supabase.rpc('depreciation_calc', { p_company: ctx.companyId, p_through: through });
  if (error) return ui.errorFrom(error, 'Could not preview the depreciation.');
  preview = data;
  previewThrough = through;
  renderPreview();
}

function renderPreview() {
  if (!previewThrough) { panel.innerHTML = '<p class="muted">Choose a month and click Preview.</p>'; return; }
  if (!preview.length) { panel.innerHTML = `<p class="muted">Nothing to depreciate up to ${esc(previewThrough)}. Every asset is already up to date or fully depreciated.</p>`; return; }
  const byCat = new Map();
  preview.forEach((r) => byCat.set(r.category_code, (byCat.get(r.category_code) || 0) + Number(r.amount)));
  const total = preview.reduce((s, r) => s + Number(r.amount), 0);
  const body = preview.map((r) => `<tr><td>${esc(r.asset_no)}</td><td>${esc(r.name)}</td><td>${esc(r.category_code)}</td>
    <td class="num">${r.months}</td><td class="num">${money(r.amount)}</td></tr>`).join('');
  const cats = [...byCat.entries()].map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${money(v)}</td></tr>`).join('');
  panel.innerHTML = `<p class="muted">Up to ${esc(previewThrough)}: ${preview.length} asset(s), ${money(total)} ${esc(base)}.</p>
    <div class="table-wrap"><table class="grid"><thead><tr><th>Asset</th><th>Name</th><th>Category</th>
      <th style="text-align:right">Months</th><th style="text-align:right">Depreciation</th></tr></thead>
      <tbody>${body}<tr class="row-root"><td colspan="4">Total</td><td class="num">${money(total)}</td></tr></tbody></table></div>
    <h4 style="margin-top:1rem">By category</h4>
    <div class="table-wrap"><table class="grid"><thead><tr><th>Category</th><th style="text-align:right">Depreciation</th></tr></thead>
      <tbody>${cats}</tbody></table></div>`;
}

async function doPost() {
  if (!preview.length) return ui.warn('Preview the depreciation first. There must be something to post.');
  const total = preview.reduce((s, r) => s + Number(r.amount), 0);
  const ok = await ui.confirm({
    title: 'Post depreciation run',
    message: `Post ${money(total)} ${base} of depreciation for ${preview.length} asset(s) up to ${previewThrough}?\nIt posts one journal at that date, which must be in an open period.`,
    confirmText: 'Post',
  });
  if (!ok) return;
  const { error } = await supabase.rpc('post_depreciation_run', { p_company: ctx.companyId, p_through: previewThrough, p_notes: '' });
  if (error) return ui.errorFrom(error, 'Could not post the run.');
  ui.success('Depreciation posted.');
  preview = [];
  previewThrough = '';
  tab = 'runs';
  await loadRuns();
  render();
}

/* ---------- runs ---------- */

async function loadRuns() {
  const { data, error } = await supabase.from('depreciation_runs').select('*').eq('company_id', ctx.companyId)
    .order('through_date', { ascending: false }).order('created_at', { ascending: false }).limit(200);
  if (error) { ui.errorFrom(error, 'Could not load the runs.'); return; }
  runs = data;
}

function renderRuns() {
  hint.textContent = 'Only the latest run can be reversed, and not if one of its assets has been disposed of since. Click a run to see its assets.';
  toolbar.append(el('span', 'spacer'), btn('Export to Excel', '', doExport));
  if (!runs.length) { panel.innerHTML = '<p class="muted">No depreciation runs yet.</p>'; return; }
  const latest = runs.find((r) => r.status === 'posted');
  const body = runs.map((r) => `<tr class="clickable" data-id="${r.id}">
    <td>${esc(r.run_no)}</td><td>${r.through_date}</td><td class="num">${r.assets_count}</td><td class="num">${money(r.total)}</td>
    <td><span class="badge ${r.status === 'posted' ? 'open' : ''}">${r.status === 'posted' ? 'Posted' : `Reversed ${r.reversed_on}`}</span></td>
    <td>${CAN_RUN && latest && latest.id === r.id ? '<div class="row-actions"><button class="btn btn-sm" data-act="reverse">Reverse</button></div>' : ''}</td></tr>`).join('');
  panel.innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr><th>Run</th><th>Up to</th>
    <th style="text-align:right">Assets</th><th style="text-align:right">Total (${esc(base)})</th><th>Status</th><th></th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

panel.addEventListener('click', async (e) => {
  if (tab !== 'runs') return;
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  const run = runs.find((r) => r.id === tr.dataset.id);
  if (!run) return;
  if (e.target.closest('[data-act="reverse"]')) {
    const saved = await ui.form({
      title: `Reverse ${run.run_no}`,
      submitText: 'Reverse',
      fields: [{ name: 'date', label: 'Reversal date', type: 'date', required: true, full: true,
        hint: 'Must fall in an open period and not before the run date. The assets go back to where they were.' }],
      values: { date: todayIso() > run.through_date ? todayIso() : run.through_date },
      onSubmit: async (v) => {
        const { error } = await supabase.rpc('reverse_depreciation_run', { p_run: run.id, p_date: v.date });
        if (error) throw error;
      },
    });
    if (saved) { ui.success('Run reversed.'); await loadRuns(); render(); }
    return;
  }
  const { data, error } = await supabase.from('asset_movements')
    .select('accum_change, months, fixed_assets(asset_no, name)')
    .eq('run_id', run.id).eq('movement_type', 'depreciation');
  if (error) return ui.errorFrom(error, 'Could not load the run.');
  const body = data.map((m) => `<tr><td>${esc(m.fixed_assets ? m.fixed_assets.asset_no : '')}</td>
    <td>${esc(m.fixed_assets ? m.fixed_assets.name : '')}</td><td class="num">${m.months}</td><td class="num">${money(m.accum_change)}</td></tr>`).join('');
  const node = el('div', 'table-wrap');
  node.innerHTML = `<table class="grid"><thead><tr><th>Asset</th><th>Name</th><th style="text-align:right">Months</th>
    <th style="text-align:right">Depreciation</th></tr></thead><tbody>${body}
    <tr class="row-root"><td colspan="3">Total</td><td class="num">${money(run.total)}</td></tr></tbody></table>`;
  await ui.dialog({ title: `${run.run_no} up to ${run.through_date}`, node, wide: true, dismissValue: 'close',
    buttons: [{ label: 'Close', value: 'close', className: 'btn-ghost' }] });
});

/* ---------- schedule ---------- */

function renderSchedule() {
  hint.textContent = `Cost and accumulated depreciation roll-forward per asset for the period, in ${base}.`;
  toolbar.append(el('span', 'muted', 'From'), fromEl, el('span', 'muted', 'To'), toEl,
    btn('Run', 'btn-primary', runSchedule), el('span', 'spacer'), btn('Export to Excel', '', doExport));
  renderScheduleTable();
}

async function runSchedule() {
  if (!fromEl.value || !toEl.value) return ui.warn('Choose both dates.');
  const { data, error } = await supabase.rpc('depreciation_schedule', {
    p_company: ctx.companyId, p_from: fromEl.value, p_to: toEl.value,
  });
  if (error) return ui.errorFrom(error, 'Could not run the schedule.');
  schedule = data;
  renderScheduleTable();
}

const SCHED_KEYS = ['cost_open', 'additions', 'disposals_cost', 'cost_close', 'accum_open', 'depreciation', 'disposals_accum', 'accum_close', 'nbv_close'];

function renderScheduleTable() {
  if (!schedule.length) { panel.innerHTML = '<p class="muted">Choose the period and click Run.</p>'; return; }
  const sum = (k) => schedule.reduce((s, r) => s + Number(r[k]), 0);
  const body = schedule.map((r) => `<tr><td>${esc(r.asset_no)}</td><td>${esc(r.name)}</td><td>${esc(r.category_code)}</td>
    ${SCHED_KEYS.map((k) => `<td class="num">${fmt(r[k])}</td>`).join('')}</tr>`).join('');
  panel.innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr><th>Asset</th><th>Name</th><th>Category</th>
    <th style="text-align:right">Cost at start</th><th style="text-align:right">Additions</th><th style="text-align:right">Disposals</th>
    <th style="text-align:right">Cost at end</th><th style="text-align:right">Accum. at start</th>
    <th style="text-align:right">Depreciation</th><th style="text-align:right">Disposals</th>
    <th style="text-align:right">Accum. at end</th><th style="text-align:right">Net book value</th></tr></thead>
    <tbody>${body}<tr class="row-root"><td colspan="3">Total</td>${SCHED_KEYS.map((k) => `<td class="num">${money(sum(k))}</td>`).join('')}</tr></tbody></table></div>`;
}

/* ---------- export ---------- */

async function doExport() {
  try {
    if (tab === 'run') {
      if (!preview.length) return ui.warn('Preview the depreciation first.');
      await exportSheets(`depreciation-preview-${previewThrough}.xlsx`, [{
        name: 'Depreciation',
        rows: preview.map((r) => ({ no: r.asset_no, name: r.name, cat: r.category_code, months: r.months, amount: Number(r.amount) })),
        columns: [{ key: 'no', header: 'Asset', width: 12 }, { key: 'name', header: 'Name', width: 34 },
          { key: 'cat', header: 'Category', width: 12 }, { key: 'months', header: 'Months', width: 10 },
          { key: 'amount', header: `Depreciation (${base})`, width: 20 }],
      }]);
    } else if (tab === 'runs') {
      if (!runs.length) return ui.warn('There are no runs to export.');
      await exportSheets(`depreciation-runs-${todayIso()}.xlsx`, [{
        name: 'Runs',
        rows: runs.map((r) => ({ no: r.run_no, through: r.through_date, assets: r.assets_count, total: Number(r.total), status: r.status })),
        columns: [{ key: 'no', header: 'Run', width: 12 }, { key: 'through', header: 'Up to', width: 12 },
          { key: 'assets', header: 'Assets', width: 10 }, { key: 'total', header: `Total (${base})`, width: 18 },
          { key: 'status', header: 'Status', width: 12 }],
      }]);
    } else {
      if (!schedule.length) return ui.warn('Run the schedule first.');
      await exportSheets(`depreciation-schedule-${fromEl.value}-to-${toEl.value}.xlsx`, [{
        name: 'Schedule',
        rows: schedule.map((r) => ({
          no: r.asset_no, name: r.name, cat: r.category_code, co: Number(r.cost_open), add: Number(r.additions),
          dc: Number(r.disposals_cost), cc: Number(r.cost_close), ao: Number(r.accum_open), dep: Number(r.depreciation),
          da: Number(r.disposals_accum), ac: Number(r.accum_close), nbv: Number(r.nbv_close),
        })),
        columns: [{ key: 'no', header: 'Asset', width: 12 }, { key: 'name', header: 'Name', width: 34 }, { key: 'cat', header: 'Category', width: 12 },
          { key: 'co', header: 'Cost at start', width: 16 }, { key: 'add', header: 'Additions', width: 14 },
          { key: 'dc', header: 'Disposals (cost)', width: 16 }, { key: 'cc', header: 'Cost at end', width: 16 },
          { key: 'ao', header: 'Accum. at start', width: 16 }, { key: 'dep', header: 'Depreciation', width: 14 },
          { key: 'da', header: 'Disposals (accum.)', width: 18 }, { key: 'ac', header: 'Accum. at end', width: 16 },
          { key: 'nbv', header: 'Net book value', width: 16 }],
      }]);
    }
  } catch (e) { ui.errorFrom(e, 'Could not export.'); }
}

if (ctx) await init();