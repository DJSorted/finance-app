import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { exportSheets } from '../core/export.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const panel = document.getElementById('panel');

const CAN_EDIT = ctx ? ctx.canEdit : false;

let boms = [];
let items = [];
let itemMap = new Map();
let uomMap = new Map();
let costMap = new Map();
let base = '';
let needle = '';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyFmt = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 4 });
function btn(text, cls, onClick) {
  const b = el('button', `btn ${cls}`.trim(), text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}
function option(select, value, text) { const o = el('option', '', text); o.value = value; select.append(o); }

async function fetchAll(make) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await make().range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

async function load() {
  const cid = ctx.companyId;
  const [b, it, u, cu, sb] = await Promise.all([
    supabase.from('boms').select('*, bom_lines(*)').eq('company_id', cid).order('name'),
    supabase.from('items').select('id, code, name, item_type, is_active, nursery_batch_id, uom_id').eq('company_id', cid).order('code'),
    supabase.from('units_of_measure').select('id, code').eq('company_id', cid),
    supabase.from('company_currencies').select('code').eq('company_id', cid).eq('is_base', true).maybeSingle(),
    fetchAll(() => supabase.from('stock_balances').select('item_id, qty_on_hand, value, avg_cost').eq('company_id', cid).order('item_id').order('warehouse_id')),
  ]);
  for (const r of [b, it, u, cu]) if (r.error) throw r.error;
  boms = b.data;
  items = it.data;
  itemMap = new Map(items.map((x) => [x.id, x]));
  uomMap = new Map(u.data.map((x) => [x.id, x.code]));
  base = cu.data ? cu.data.code : '';
  costMap = new Map();
  sb.forEach((r) => {
    const c = costMap.get(r.item_id) || { qty: 0, value: 0, avg: 0 };
    c.qty += Number(r.qty_on_hand);
    c.value += Number(r.value);
    if (Number(r.avg_cost) > 0) c.avg = Number(r.avg_cost);
    costMap.set(r.item_id, c);
  });
}

// Weighted average cost over all warehouses, or the last known average when nothing is on hand
function unitCost(id) {
  const c = costMap.get(id);
  if (!c) return 0;
  return c.qty > 0 ? c.value / c.qty : c.avg;
}
const lineCost = (l) => Number(l.qty) * (1 + Number(l.scrap_percent || 0) / 100) * unitCost(l.item_id);
const bomCost = (b) => b.bom_lines.reduce((s, l) => s + lineCost(l), 0) / Number(b.output_qty);

async function refresh() {
  try { await load(); } catch (e) { ui.errorFrom(e, 'Could not load the bills of materials.'); }
  render();
}

function visible() {
  return boms.filter((b) => !needle || [b.name, (itemMap.get(b.item_id) || {}).code, (itemMap.get(b.item_id) || {}).name]
    .some((v) => String(v || '').toLowerCase().includes(needle)));
}

function render() {
  document.getElementById('company-title').textContent = ctx.company.name;
  toolbar.replaceChildren();
  if (CAN_EDIT) toolbar.append(btn('New bill of materials', 'btn-primary', () => openEditor(null)));
  const box = el('input');
  box.type = 'search';
  box.placeholder = 'Search';
  box.value = needle;
  box.style.maxWidth = '240px';
  box.addEventListener('input', () => { needle = box.value.trim().toLowerCase(); renderTable(); });
  toolbar.append(box, el('span', 'spacer'), btn('Export to Excel', '', doExport));
  hint.textContent = `A bill of materials lists the stock items needed to make a quantity of one finished item. Work orders copy it. Components must be stock items, so bills are single level. Costs are estimates at current average cost, in ${base}.`;
  renderTable();
}

function renderTable() {
  if (!boms.length) { panel.innerHTML = '<p class="muted">No bills of materials yet.</p>'; return; }
  const list = visible();
  if (!list.length) { panel.innerHTML = '<p class="muted">Nothing matches.</p>'; return; }
  const body = list.map((b) => {
    const it = itemMap.get(b.item_id);
    const comps = b.bom_lines.slice().sort((x, y) => x.line_no - y.line_no).map((l) => {
      const c = itemMap.get(l.item_id);
      return `${esc(c ? c.name : '')} × ${qtyFmt(l.qty)}`;
    }).join(', ');
    return `<tr class="${CAN_EDIT ? 'clickable' : ''}" data-id="${b.id}"><td>${esc(it ? `${it.code} - ${it.name}` : '')}</td><td>${esc(b.name)}
      <div class="muted" style="font-size:.8rem">${comps}</div></td>
      <td class="num">${qtyFmt(b.output_qty)} ${esc(it ? uomMap.get(it.uom_id) || '' : '')}</td><td class="num">${b.bom_lines.length}</td>
      <td class="num">${money(bomCost(b))}</td>
      <td><span class="badge ${b.is_active ? 'open' : ''}">${b.is_active ? 'Active' : 'Inactive'}</span></td></tr>`;
  }).join('');
  panel.innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr><th>Finished item</th><th>Bill of materials</th>
    <th style="text-align:right">Makes</th><th style="text-align:right">Components</th><th style="text-align:right">Material cost per unit (${esc(base)})</th><th>Status</th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

panel.addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr || !CAN_EDIT) return;
  const b = boms.find((x) => x.id === tr.dataset.id);
  if (b) openEditor(b);
});

async function doExport() {
  const list = visible();
  if (!list.length) return ui.warn('There is nothing to export.');
  try {
    const rows = [];
    list.forEach((b) => {
      const it = itemMap.get(b.item_id);
      b.bom_lines.slice().sort((x, y) => x.line_no - y.line_no).forEach((l) => {
        const c = itemMap.get(l.item_id);
        rows.push({
          item: it ? it.code : '', name: it ? it.name : '', bom: b.name, makes: Number(b.output_qty),
          comp: c ? c.code : '', compName: c ? c.name : '', qty: Number(l.qty), scrap: Number(l.scrap_percent),
          unit: unitCost(l.item_id), cost: lineCost(l),
        });
      });
    });
    await exportSheets(`bills-of-materials-${new Date().toISOString().slice(0, 10)}.xlsx`, [{
      name: 'Bills of materials', title: 'Bills of materials', subtitle: `Costs at current average cost, ${base}`,
      rows, columns: [
        { key: 'item', header: 'Finished item', width: 14 }, { key: 'name', header: 'Name', width: 28 }, { key: 'bom', header: 'Bill', width: 24 },
        { key: 'makes', header: 'Makes', width: 10, total: false }, { key: 'comp', header: 'Component', width: 14 }, { key: 'compName', header: 'Component name', width: 28 },
        { key: 'qty', header: 'Quantity', width: 12, total: false }, { key: 'scrap', header: 'Scrap %', width: 10, total: false },
        { key: 'unit', header: `Unit cost (${base})`, width: 16, total: false }, { key: 'cost', header: `Line cost (${base})`, width: 16, total: false },
      ],
    }]);
  } catch (e) { ui.errorFrom(e, 'Could not export.'); }
}

/* ---------- editor ---------- */

function openEditor(existing) {
  const used = new Set(boms.filter((b) => !existing || b.id !== existing.id).map((b) => b.item_id));
  const finished = items.filter((i) => i.item_type === 'manufactured' && !i.nursery_batch_id && !used.has(i.id)
    && (i.is_active || (existing && i.id === existing.item_id)));
  if (!finished.length && !existing) { ui.warn('Every manufactured item already has a bill of materials, or none exist yet. Create a manufactured item first.'); return; }
  const comps = items.filter((i) => i.item_type === 'stock' && i.is_active);
  if (!comps.length) { ui.warn('There are no stock items to use as components.'); return; }

  const prevFocus = document.activeElement;
  const backdrop = el('div', 'modal-backdrop');
  const box = el('div', 'modal xwide');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.append(el('h3', 'modal-title', existing ? 'Edit bill of materials' : 'New bill of materials'));

  const field = (text, input, full) => { const w = el('div', `field${full ? ' full' : ''}`); w.append(el('label', '', text), input); return w; };
  const itemSel = el('select');
  option(itemSel, '', 'Select the finished item');
  finished.forEach((i) => option(itemSel, i.id, `${i.code} - ${i.name}`));
  itemSel.value = existing ? existing.item_id : '';
  const nameIn = el('input'); nameIn.value = existing ? existing.name : '';
  const outIn = el('input'); outIn.type = 'number'; outIn.step = 'any'; outIn.value = existing ? Number(existing.output_qty) : 1;
  const notesIn = el('input'); notesIn.value = existing ? (existing.notes || '') : '';
  const activeIn = el('input'); activeIn.type = 'checkbox'; activeIn.checked = existing ? existing.is_active : true; activeIn.style.width = 'auto';
  const activeRow = el('div', 'field check');
  activeRow.append(activeIn, el('label', '', 'Active (work orders use the active bill)'));
  const head = el('div', 'form-grid');
  head.append(field('Finished item *', itemSel, true), field('Bill name *', nameIn), field('Makes (quantity) *', outIn), field('Notes', notesIn, true));
  box.append(head, activeRow);
  itemSel.addEventListener('change', () => { if (!nameIn.value.trim()) { const i = itemMap.get(itemSel.value); if (i) nameIn.value = `${i.name} bill`; } });

  const wrap = el('div', 'lines-wrap');
  const table = el('table', 'lines-table');
  table.innerHTML = '<thead><tr><th style="min-width:260px">Component (stock item)</th><th>Quantity</th><th>Scrap %</th><th>Est. cost</th><th></th></tr></thead>';
  const tbody = el('tbody');
  table.append(tbody);
  wrap.append(table);
  box.append(wrap);
  const totals = el('div', 'totals-bar');

  const rows = [];
  function recalc() {
    let t = 0;
    rows.forEach((r) => {
      const q = Number(r.qty.value) || 0;
      const s = Number(r.scrap.value) || 0;
      const c = q * (1 + s / 100) * (r.sel.value ? unitCost(r.sel.value) : 0);
      r.cost.textContent = c ? money(c) : '';
      t += c;
    });
    const out = Number(outIn.value) || 0;
    totals.innerHTML = `<span>Material cost for the whole bill: ${money(t)} ${esc(base)}</span>${out > 0 ? `<span>Per unit: ${money(t / out)}</span>` : ''}`;
  }
  function addRow(s) {
    const tr = el('tr');
    const sel = el('select');
    option(sel, '', 'Select a component');
    comps.forEach((c) => option(sel, c.id, `${c.code} - ${c.name} (${uomMap.get(c.uom_id) || ''})`));
    sel.value = s.item_id || '';
    const qty = el('input'); qty.type = 'number'; qty.step = 'any'; qty.value = s.qty ? Number(s.qty) : '';
    const scrap = el('input'); scrap.type = 'number'; scrap.step = 'any'; scrap.value = s.scrap_percent ? Number(s.scrap_percent) : '';
    const cost = el('td', 'num');
    const del = el('button', 'btn btn-sm btn-ghost', '✕'); del.type = 'button'; del.title = 'Remove';
    const row = { tr, sel, qty, scrap, cost };
    [sel, qty, scrap].forEach((x) => { const td = el('td'); td.append(x); tr.append(td); });
    const dtd = el('td'); dtd.append(del);
    tr.append(cost, dtd);
    tbody.append(tr);
    [sel, qty, scrap].forEach((x) => x.addEventListener('input', recalc));
    del.addEventListener('click', () => { rows.splice(rows.indexOf(row), 1); tr.remove(); recalc(); });
    rows.push(row);
  }
  const seed = existing ? existing.bom_lines.slice().sort((a, b) => a.line_no - b.line_no) : [{}, {}];
  seed.forEach(addRow);
  outIn.addEventListener('input', recalc);
  box.append(btn('Add component', '', () => { addRow({}); recalc(); }), totals);
  recalc();

  const actions = el('div', 'modal-actions');
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const close = () => { document.removeEventListener('keydown', onKey); backdrop.remove(); if (prevFocus && prevFocus.focus) prevFocus.focus(); };
  document.addEventListener('keydown', onKey);
  if (existing) {
    actions.append(btn('Delete', 'btn-danger', async () => {
      if (!(await ui.confirmDelete('Bill of materials'))) return;
      const { error } = await supabase.from('boms').delete().eq('id', existing.id);
      if (error) return ui.errorFrom(error, 'Could not delete it. A bill that work orders were made from cannot be deleted: mark it inactive instead.');
      close();
      ui.deleted('Bill of materials');
      await refresh();
    }));
  }
  const save = btn('Save', 'btn-primary', async () => {
    try {
      if (!itemSel.value) throw new Error('Choose the finished item.');
      if (!nameIn.value.trim()) throw new Error('Enter the bill name.');
      if (!(Number(outIn.value) > 0)) throw new Error('Enter the quantity this bill makes.');
      const lines = [];
      const seen = new Set();
      rows.forEach((r, i) => {
        const q = Number(r.qty.value) || 0;
        if (!r.sel.value && !q) return;
        if (!r.sel.value) throw new Error(`Line ${i + 1}: choose a component.`);
        if (!(q > 0)) throw new Error(`Line ${i + 1}: enter a quantity above zero.`);
        const s = Number(r.scrap.value) || 0;
        if (s < 0 || s >= 100) throw new Error(`Line ${i + 1}: scrap must be from 0 to under 100 percent.`);
        if (seen.has(r.sel.value)) throw new Error(`Line ${i + 1}: that component is listed twice.`);
        seen.add(r.sel.value);
        lines.push({ item_id: r.sel.value, qty: q, scrap_percent: s });
      });
      if (!lines.length) throw new Error('Add at least one component.');
      save.disabled = true;
      const { error } = await supabase.rpc('save_bom', {
        p_company: ctx.companyId, p_bom: existing ? existing.id : null, p_item: itemSel.value, p_name: nameIn.value,
        p_output: Number(outIn.value), p_notes: notesIn.value, p_active: activeIn.checked, p_lines: lines,
      });
      if (error) throw error;
      close();
      ui.saved('Bill of materials');
      await refresh();
    } catch (e) { ui.errorFrom(e, 'Could not save.'); save.disabled = false; }
  });
  actions.append(el('span', 'spacer'), btn('Cancel', 'btn-ghost', close), save);
  box.append(actions);
  backdrop.append(box);
  document.body.append(backdrop);
}

if (ctx) await refresh();