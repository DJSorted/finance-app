import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { exportSheets } from '../core/export.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const recon = document.getElementById('recon');
const panel = document.getElementById('panel');

const TYPE_LABEL = {
  opening: 'Opening stock', adjustment: 'Adjustment', transfer_in: 'Transfer in', transfer_out: 'Transfer out',
  receipt: 'Goods received', return_out: 'Return to supplier', issue: 'Issue', sale: 'Sale', sale_return: 'Sales return',
  production_in: 'Production in', production_out: 'Production out',
};

let base = '';
let rows = [];
let warehouses = [];

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyFmt = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 4 });
const costFmt = (n) => Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const todayIso = () => new Date().toISOString().slice(0, 10);
function btn(text, cls, onClick) {
  const b = el('button', `btn ${cls}`.trim(), text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

const asOfEl = el('input');
asOfEl.type = 'date';
asOfEl.style.width = 'auto';
const whSel = el('select', 'compact');

async function init() {
  document.getElementById('company-title').textContent = ctx.company.name;
  const cid = ctx.companyId;
  const [c, w] = await Promise.all([
    supabase.from('company_currencies').select('code').eq('company_id', cid).eq('is_base', true).maybeSingle(),
    supabase.from('warehouses').select('id, code, name').eq('company_id', cid).order('code'),
  ]);
  base = c.data ? c.data.code : '';
  warehouses = w.data || [];
  asOfEl.value = todayIso();
  const all = el('option', '', 'All warehouses');
  all.value = '';
  whSel.append(all);
  warehouses.forEach((x) => { const o = el('option', '', `${x.code} - ${x.name}`); o.value = x.id; whSel.append(o); });
  whSel.addEventListener('change', render);
  toolbar.append(el('span', 'muted', 'As at'), asOfEl, whSel, btn('Run', 'btn-primary', run),
    el('span', 'spacer'), btn('Export to Excel', '', doExport));
  hint.textContent = `Values in ${base}, at weighted average cost. Click a row to see its movements.`;
  await run();
}

async function run() {
  if (!asOfEl.value) return ui.warn('Choose the date.');
  const [v, r] = await Promise.all([
    supabase.rpc('stock_valuation', { p_company: ctx.companyId, p_as_of: asOfEl.value }),
    supabase.rpc('stock_reconciliation', { p_company: ctx.companyId, p_as_of: asOfEl.value }),
  ]);
  if (v.error) return ui.errorFrom(v.error, 'Could not run the valuation.');
  rows = v.data;
  render();
  renderRecon(r);
}

function renderRecon(r) {
  if (r.error) { recon.innerHTML = ''; return; }
  const x = r.data[0];
  const diff = Number(x.difference);
  const ok = Math.abs(diff) < 0.005;
  recon.innerHTML = `<div class="card" style="display:flex;gap:1.5rem;flex-wrap:wrap;align-items:center">
    <span class="badge ${ok ? 'open' : 'st-error'}">${ok ? 'Reconciled to the inventory control accounts' : 'Does not reconcile'}</span>
    <span class="muted">Stock ledger ${money(x.stock_value)} ${esc(base)}</span>
    <span class="muted">General ledger ${money(x.ledger)} ${esc(base)}</span>
    ${ok ? '' : `<span class="muted">Difference ${money(diff)}. A journal posted to an inventory account with the control override explains this. Reverse it, or send me the figure.</span>`}
  </div>`;
}

function shown() { return rows.filter((r) => !whSel.value || r.warehouse_id === whSel.value); }

function render() {
  const list = shown();
  if (!list.length) { panel.innerHTML = '<p class="muted">No stock on hand at this date.</p>'; return; }
  const total = list.reduce((s, r) => s + Number(r.value), 0);
  const body = list.map((r) => `<tr class="clickable" data-item="${r.item_id}" data-wh="${r.warehouse_id}">
    <td>${esc(r.item_code)}</td><td>${esc(r.item_name)}</td><td>${esc(r.warehouse_code)}</td><td>${esc(r.uom)}</td>
    <td class="num">${qtyFmt(r.qty)}</td><td class="num">${Number(r.qty) > 0 ? costFmt(r.avg_cost) : ''}</td>
    <td class="num">${money(r.value)}</td></tr>`).join('');
  panel.innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr>
    <th>Item</th><th>Name</th><th>Warehouse</th><th>Unit</th><th style="text-align:right">Quantity</th>
    <th style="text-align:right">Average cost</th><th style="text-align:right">Value (${esc(base)})</th></tr></thead>
    <tbody>${body}<tr class="row-root"><td colspan="6">Total</td><td class="num">${money(total)}</td></tr></tbody></table></div>`;
}

panel.addEventListener('click', async (e) => {
  const tr = e.target.closest('tr[data-item]');
  if (!tr) return;
  const row = rows.find((r) => r.item_id === tr.dataset.item && r.warehouse_id === tr.dataset.wh);
  if (!row) return;
  const { data, error } = await supabase.from('stock_movements').select('*')
    .eq('company_id', ctx.companyId).eq('item_id', row.item_id).eq('warehouse_id', row.warehouse_id)
    .lte('movement_date', asOfEl.value).order('created_at');
  if (error) return ui.errorFrom(error, 'Could not load the movements.');
  const body = data.map((m) => `<tr><td>${m.movement_date}</td><td>${esc(TYPE_LABEL[m.movement_type] || m.movement_type)}</td>
    <td>${esc(m.source_no || '')}</td><td class="num">${qtyFmt(m.qty)}</td><td class="num">${money(m.value)}</td>
    <td class="num">${qtyFmt(m.qty_after)}</td><td class="num">${money(m.value_after)}</td></tr>`).join('');
  const node = el('div', 'table-wrap');
  node.innerHTML = `<table class="grid"><thead><tr><th>Date</th><th>Type</th><th>Document</th>
    <th style="text-align:right">Quantity</th><th style="text-align:right">Value</th>
    <th style="text-align:right">Qty after</th><th style="text-align:right">Value after</th></tr></thead><tbody>${body}</tbody></table>`;
  await ui.dialog({
    title: `${row.item_code} - ${row.item_name} in ${row.warehouse_code}`, node, wide: true, dismissValue: 'close',
    buttons: [{ label: 'Close', value: 'close', className: 'btn-ghost' }],
  });
});

async function doExport() {
  const list = shown();
  if (!list.length) return ui.warn('Run the report first.');
  try {
    await exportSheets(`stock-valuation-${asOfEl.value}.xlsx`, [{
      name: 'Valuation',
      rows: list.map((r) => ({
        code: r.item_code, name: r.item_name, warehouse: r.warehouse_code, uom: r.uom,
        qty: Number(r.qty), cost: Number(r.avg_cost), value: Number(r.value),
      })),
      columns: [
        { key: 'code', header: 'Item', width: 14 }, { key: 'name', header: 'Name', width: 34 },
        { key: 'warehouse', header: 'Warehouse', width: 12 }, { key: 'uom', header: 'Unit', width: 8 },
        { key: 'qty', header: 'Quantity', width: 14 }, { key: 'cost', header: 'Average cost', width: 14 },
        { key: 'value', header: `Value (${base})`, width: 16 },
      ],
    }]);
  } catch (e) { ui.errorFrom(e, 'Could not export.'); }
}

if (ctx) await init();