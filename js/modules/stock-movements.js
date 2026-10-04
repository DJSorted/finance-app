import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { exportSheets } from '../core/export.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const panel = document.getElementById('panel');

const TYPE_LABEL = {
  opening: 'Opening stock', adjustment: 'Adjustment', transfer_in: 'Transfer in', transfer_out: 'Transfer out',
  receipt: 'Goods received', return_out: 'Return to supplier', issue: 'Issue', sale: 'Sale', sale_return: 'Sales return',
  production_in: 'Production in', production_out: 'Production out',
};

let items = [];
let warehouses = [];
let rows = [];
let opening = null;
let base = '';

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
function option(select, value, text) {
  const o = el('option', '', text);
  o.value = value;
  select.append(o);
}

const fromEl = el('input'); fromEl.type = 'date'; fromEl.style.width = 'auto';
const toEl = el('input'); toEl.type = 'date'; toEl.style.width = 'auto';
const itemSel = el('select', 'compact');
const whSel = el('select', 'compact');
const typeSel = el('select', 'compact');
itemSel.style.maxWidth = '260px';

async function init() {
  document.getElementById('company-title').textContent = ctx.company.name;
  const cid = ctx.companyId;
  const [it, w, c, fy] = await Promise.all([
    supabase.from('items').select('id, code, name').eq('company_id', cid).in('item_type', ['stock', 'manufactured']).order('code'),
    supabase.from('warehouses').select('id, code, name').eq('company_id', cid).order('code'),
    supabase.from('company_currencies').select('code').eq('company_id', cid).eq('is_base', true).maybeSingle(),
    supabase.from('fiscal_years').select('start_date, end_date').eq('company_id', cid).order('start_date'),
  ]);
  for (const r of [it, w, fy]) if (r.error) { ui.errorFrom(r.error, 'Could not load the report setup.'); return; }
  items = it.data;
  warehouses = w.data;
  base = c.data ? c.data.code : '';
  const today = todayIso();
  const year = fy.data.find((y) => today >= y.start_date && today <= y.end_date);
  fromEl.value = year ? year.start_date : `${today.slice(0, 4)}-01-01`;
  toEl.value = today;

  option(itemSel, '', 'All items');
  items.forEach((x) => option(itemSel, x.id, `${x.code} - ${x.name}`));
  option(whSel, '', 'All warehouses');
  warehouses.forEach((x) => option(whSel, x.id, `${x.code} - ${x.name}`));
  option(typeSel, '', 'All types');
  Object.entries(TYPE_LABEL).forEach(([k, v]) => option(typeSel, k, v));
  typeSel.addEventListener('change', render);

  toolbar.append(el('span', 'muted', 'From'), fromEl, el('span', 'muted', 'To'), toEl, itemSel, whSel, typeSel,
    btn('Run', 'btn-primary', run), el('span', 'spacer'), btn('Export to Excel', '', doExport));
  hint.textContent = `Every stock movement in ${base}. Pick one item and one warehouse to see the opening and running balance. Quantities are signed: positive in, negative out.`;
  await run();
}

async function run() {
  if (!fromEl.value || !toEl.value) return ui.warn('Choose both dates.');
  const args = { p_company: ctx.companyId, p_item: itemSel.value || null, p_warehouse: whSel.value || null };
  const [m, o] = await Promise.all([
    supabase.rpc('stock_ledger', { ...args, p_from: fromEl.value, p_to: toEl.value }),
    itemSel.value ? supabase.rpc('stock_opening', { ...args, p_date: fromEl.value }) : Promise.resolve({ data: null }),
  ]);
  if (m.error) return ui.errorFrom(m.error, 'Could not load the movements.');
  rows = m.data;
  opening = o && o.data && o.data[0] ? { qty: Number(o.data[0].qty), value: Number(o.data[0].value) } : null;
  if (rows.length >= 5000) ui.warn('Showing the first 5,000 movements. Narrow the dates, item or warehouse to see the rest.');
  render();
}

function shown() { return rows.filter((r) => !typeSel.value || r.movement_type === typeSel.value); }

function render() {
  const list = shown();
  if (!list.length && !opening) { panel.innerHTML = '<p class="muted">No movements for these choices.</p>'; return; }
  const running = !!(itemSel.value && whSel.value);
  let q = opening ? opening.qty : 0;
  let v = opening ? opening.value : 0;
  let qin = 0; let qout = 0; let vin = 0; let vout = 0;
  const body = list.map((r) => {
    const qty = Number(r.qty);
    const val = Number(r.value);
    if (qty >= 0) { qin += qty; vin += val; } else { qout += -qty; vout += -val; }
    q += qty;
    v += val;
    return `<tr><td>${r.movement_date}</td><td>${esc(TYPE_LABEL[r.movement_type] || r.movement_type)}</td><td>${esc(r.source_no || '')}</td>
      <td>${esc(r.item_code)}</td><td>${esc(r.warehouse_code)}</td>
      <td class="num">${qtyFmt(qty)}</td><td class="num">${costFmt(r.unit_cost)}</td><td class="num">${money(val)}</td>
      <td class="num">${running ? qtyFmt(q) : ''}</td><td class="num">${running ? money(v) : ''}</td></tr>`;
  }).join('');
  const openRow = opening ? `<tr class="row-parent"><td colspan="5">Opening balance at ${esc(fromEl.value)}</td>
    <td class="num">${qtyFmt(opening.qty)}</td><td></td><td class="num">${money(opening.value)}</td>
    <td class="num">${running ? qtyFmt(opening.qty) : ''}</td><td class="num">${running ? money(opening.value) : ''}</td></tr>` : '';
  panel.innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr><th>Date</th><th>Type</th><th>Document</th><th>Item</th>
    <th>Warehouse</th><th style="text-align:right">Quantity</th><th style="text-align:right">Unit cost</th>
    <th style="text-align:right">Value (${esc(base)})</th><th style="text-align:right">Qty balance</th>
    <th style="text-align:right">Value balance</th></tr></thead>
    <tbody>${openRow}${body}
    <tr class="row-root"><td colspan="5">Total in / out</td><td class="num">${qtyFmt(qin)} / ${qtyFmt(qout)}</td><td></td>
    <td class="num">${money(vin)} / ${money(vout)}</td><td></td><td></td></tr></tbody></table></div>`;
}

async function doExport() {
  const list = shown();
  if (!list.length) return ui.warn('Run the report first.');
  try {
    await exportSheets(`stock-movements-${fromEl.value}-to-${toEl.value}.xlsx`, [{
      name: 'Movements',
      rows: list.map((r) => ({
        date: r.movement_date, type: TYPE_LABEL[r.movement_type] || r.movement_type, doc: r.source_no || '',
        item: r.item_code, name: r.item_name, wh: r.warehouse_code, qty: Number(r.qty), cost: Number(r.unit_cost), value: Number(r.value),
      })),
      columns: [
        { key: 'date', header: 'Date', width: 12 }, { key: 'type', header: 'Type', width: 18 }, { key: 'doc', header: 'Document', width: 14 },
        { key: 'item', header: 'Item', width: 14 }, { key: 'name', header: 'Name', width: 30 }, { key: 'wh', header: 'Warehouse', width: 12 },
        { key: 'qty', header: 'Quantity', width: 12 }, { key: 'cost', header: 'Unit cost', width: 14 },
        { key: 'value', header: `Value (${base})`, width: 16 },
      ],
    }]);
  } catch (e) { ui.errorFrom(e, 'Could not export.'); }
}

if (ctx) await init();