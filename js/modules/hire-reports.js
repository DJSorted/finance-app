import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { exportSheets } from '../core/export.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const panel = document.getElementById('panel');

let tab = 'util';
let base = '';
let util = [];
let cust = [];
let loss = [];

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyFmt = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 4 });
const todayIso = () => new Date().toISOString().slice(0, 10);
function btn(text, cls, onClick) {
  const b = el('button', `btn ${cls}`.trim(), text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

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
  fromEl.value = year ? year.start_date : `${today.slice(0, 4)}-01-01`;
  toEl.value = today;
  toolbar.append(el('span', 'muted', 'From'), fromEl, el('span', 'muted', 'To'), toEl, btn('Run', 'btn-primary', run),
    el('span', 'spacer'), btn('Export to Excel', '', doExport));
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => { tab = t.dataset.tab; render(); }));
  await run();
}

async function run() {
  if (!fromEl.value || !toEl.value || toEl.value < fromEl.value) return ui.warn('Choose a valid date range.');
  const args = { p_company: ctx.companyId, p_from: fromEl.value, p_to: toEl.value };
  const [u, c, l] = await Promise.all([
    supabase.rpc('hire_utilisation', args), supabase.rpc('hire_customer_summary', args), supabase.rpc('hire_loss_summary', args),
  ]);
  for (const r of [u, c, l]) if (r.error) return ui.errorFrom(r.error, 'Could not run the reports.');
  util = u.data;
  cust = c.data;
  loss = l.data;
  render();
}

function render() {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  if (tab === 'util') renderUtil(); else if (tab === 'cust') renderCust(); else renderLoss();
}

const pctBadge = (p) => `<span class="badge ${p >= 60 ? 'open' : (p < 20 ? 'st-error' : '')}">${Number(p).toFixed(1)}%</span>`;

function renderUtil() {
  hint.textContent = `Unit-days booked are quantity × days in the period, for confirmed, dispatched, returned and closed bookings. Available is units owned today × days in the period. Bookings and revenue (${base}, excl. tax) count bookings that start in the period.`;
  if (!util.length) { panel.innerHTML = '<p class="muted">No hire items yet.</p>'; return; }
  const sum = (k) => util.reduce((s, r) => s + Number(r[k]), 0);
  const booked = sum('unit_days_booked');
  const avail = sum('unit_days_available');
  const body = util.map((r) => `<tr><td>${esc(r.code)}</td><td>${esc(r.name)}</td><td class="num">${qtyFmt(r.owned)}</td>
    <td class="num">${r.bookings_count}</td><td class="num">${qtyFmt(r.qty_booked)}</td><td class="num">${qtyFmt(r.unit_days_booked)}</td>
    <td class="num">${qtyFmt(r.unit_days_available)}</td><td class="num">${pctBadge(r.utilisation)}</td><td class="num">${money(r.revenue)}</td></tr>`).join('');
  panel.innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr><th>Code</th><th>Hire item</th>
    <th style="text-align:right">Owned</th><th style="text-align:right">Bookings</th><th style="text-align:right">Units booked</th>
    <th style="text-align:right">Unit-days booked</th><th style="text-align:right">Unit-days available</th>
    <th style="text-align:right">Utilisation</th><th style="text-align:right">Revenue (${esc(base)})</th></tr></thead>
    <tbody>${body}<tr class="row-root"><td colspan="5">Total</td><td class="num">${qtyFmt(booked)}</td><td class="num">${qtyFmt(avail)}</td>
    <td class="num">${avail > 0 ? pctBadge((100 * booked) / avail) : ''}</td><td class="num">${money(sum('revenue'))}</td></tr></tbody></table></div>`;
}

function renderCust() {
  hint.textContent = `Customers with confirmed, dispatched, returned or closed bookings that start in the period. Revenue is hire charges excl. tax in ${base}. Repeat means two or more bookings in the period.`;
  if (!cust.length) { panel.innerHTML = '<p class="muted">No bookings in this period.</p>'; return; }
  const body = cust.map((r) => `<tr><td>${esc(r.code)}</td><td>${esc(r.name)}</td><td class="num">${r.bookings_count}</td>
    <td class="num">${money(r.revenue)}</td><td class="num">${money(r.avg_booking)}</td><td>${r.first_booking}</td><td>${r.last_booking}</td>
    <td>${Number(r.bookings_count) > 1 ? '<span class="badge open">Repeat</span>' : ''}</td></tr>`).join('');
  panel.innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr><th>Code</th><th>Customer</th>
    <th style="text-align:right">Bookings</th><th style="text-align:right">Revenue (${esc(base)})</th><th style="text-align:right">Average booking</th>
    <th>First</th><th>Last</th><th></th></tr></thead><tbody>${body}
    <tr class="row-root"><td colspan="2">Total</td><td class="num">${cust.reduce((s, r) => s + Number(r.bookings_count), 0)}</td>
    <td class="num">${money(cust.reduce((s, r) => s + Number(r.revenue), 0))}</td><td colspan="4"></td></tr></tbody></table></div>`;
}

function renderLoss() {
  hint.textContent = `Units checked back in during the period. Loss rate is damaged plus missing as a share of units returned. Replacement value uses the replacement cost on each hire item (${base}).`;
  if (!loss.length) { panel.innerHTML = '<p class="muted">No returns in this period.</p>'; return; }
  const body = loss.map((r) => `<tr><td>${esc(r.code)}</td><td>${esc(r.name)}</td><td class="num">${qtyFmt(r.qty_returned)}</td>
    <td class="num">${qtyFmt(r.qty_damaged)}</td><td class="num">${qtyFmt(r.qty_missing)}</td>
    <td class="num">${Number(r.loss_rate).toFixed(2)}%</td><td class="num">${money(r.replacement_value)}</td></tr>`).join('');
  panel.innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr><th>Code</th><th>Hire item</th>
    <th style="text-align:right">Units returned</th><th style="text-align:right">Damaged</th><th style="text-align:right">Missing</th>
    <th style="text-align:right">Loss rate</th><th style="text-align:right">Replacement value (${esc(base)})</th></tr></thead><tbody>${body}
    <tr class="row-root"><td colspan="6">Total</td><td class="num">${money(loss.reduce((s, r) => s + Number(r.replacement_value), 0))}</td></tr></tbody></table></div>`;
}

async function doExport() {
  const sub = `${fromEl.value} to ${toEl.value}`;
  try {
    if (tab === 'util') {
      if (!util.length) return ui.warn('There is nothing to export.');
      await exportSheets(`hire-utilisation-${fromEl.value}-to-${toEl.value}.xlsx`, [{
        name: 'Utilisation', title: 'Hire utilisation', subtitle: sub,
        rows: util.map((r) => ({ code: r.code, name: r.name, owned: Number(r.owned), bookings: Number(r.bookings_count), qty: Number(r.qty_booked),
          booked: Number(r.unit_days_booked), avail: Number(r.unit_days_available), util: Number(r.utilisation), revenue: Number(r.revenue) })),
        columns: [
          { key: 'code', header: 'Code', width: 12 }, { key: 'name', header: 'Hire item', width: 32 },
          { key: 'owned', header: 'Owned', width: 10, total: false }, { key: 'bookings', header: 'Bookings', width: 11, total: false },
          { key: 'qty', header: 'Units booked', width: 13 },
          { key: 'booked', header: 'Unit-days booked', width: 17, total: true }, { key: 'avail', header: 'Unit-days available', width: 19, total: true },
          { key: 'util', header: 'Utilisation %', width: 14, format: '0.0' }, { key: 'revenue', header: `Revenue (${base})`, width: 16 },
        ],
        styleCell: (row, col) => (col.key === 'util' ? (row.util >= 60 ? { fill: 'D1FAE5' } : (row.util < 20 ? { fill: 'FEF3C7' } : null)) : null),
      }]);
    } else if (tab === 'cust') {
      if (!cust.length) return ui.warn('There is nothing to export.');
      await exportSheets(`hire-customers-${fromEl.value}-to-${toEl.value}.xlsx`, [{
        name: 'Customers', title: 'Hire customers', subtitle: sub,
        rows: cust.map((r) => ({ code: r.code, name: r.name, bookings: Number(r.bookings_count), revenue: Number(r.revenue),
          avg: Number(r.avg_booking), first: r.first_booking, last: r.last_booking, repeat: Number(r.bookings_count) > 1 ? 'Yes' : '' })),
        columns: [
          { key: 'code', header: 'Code', width: 12 }, { key: 'name', header: 'Customer', width: 34 }, { key: 'bookings', header: 'Bookings', width: 11 },
          { key: 'revenue', header: `Revenue (${base})`, width: 16 }, { key: 'avg', header: 'Average booking', width: 16 },
          { key: 'first', header: 'First booking', width: 14 }, { key: 'last', header: 'Last booking', width: 14 }, { key: 'repeat', header: 'Repeat', width: 9 },
        ],
      }]);
    } else {
      if (!loss.length) return ui.warn('There is nothing to export.');
      await exportSheets(`hire-damage-loss-${fromEl.value}-to-${toEl.value}.xlsx`, [{
        name: 'Damage and loss', title: 'Hire damage and loss', subtitle: sub,
        rows: loss.map((r) => ({ code: r.code, name: r.name, returned: Number(r.qty_returned), damaged: Number(r.qty_damaged),
          missing: Number(r.qty_missing), rate: Number(r.loss_rate), value: Number(r.replacement_value) })),
        columns: [
          { key: 'code', header: 'Code', width: 12 }, { key: 'name', header: 'Hire item', width: 32 },
          { key: 'returned', header: 'Units returned', width: 15 }, { key: 'damaged', header: 'Damaged', width: 11, total: false },
          { key: 'missing', header: 'Missing', width: 11, total: false }, { key: 'rate', header: 'Loss rate %', width: 13, format: '0.00' },
          { key: 'value', header: `Replacement value (${base})`, width: 24 },
        ],
      }]);
    }
  } catch (e) { ui.errorFrom(e, 'Could not export.'); }
}

if (ctx) await init();