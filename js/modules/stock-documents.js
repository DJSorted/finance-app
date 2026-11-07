import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { exportSheets } from '../core/export.js';

const ctx = await startPage();

const KIND = document.body.dataset.kind === 'transfer' ? 'transfer' : 'adjustment';
const TITLE = KIND === 'transfer' ? 'Stock transfer' : 'Stock adjustment';
const TYPE_LABEL = { opening: 'Opening stock', adjustment: 'Adjustment', revaluation: 'Revaluation', transfer: 'Transfer' };

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const panel = document.getElementById('panel');

const CAN_POST = ctx
  ? (KIND === 'transfer' ? ['owner', 'admin', 'accountant', 'clerk'].includes(ctx.role) : ctx.canEdit)
  : false;

let docs = [];
let warehouses = [];
let items = [];
let balances = new Map();
let groups = [];
let categories = [];
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

/* ---------- data ---------- */

async function load() {
  const cid = ctx.companyId;
  const types = KIND === 'transfer' ? ['transfer'] : ['opening', 'adjustment', 'revaluation'];
  const [d, w, it, b, c, g, k] = await Promise.all([
    supabase.from('stock_documents')
      .select('*, from_wh:warehouses!stock_documents_warehouse_id_fkey(code, name), to_wh:warehouses!stock_documents_to_warehouse_id_fkey(code, name)')
      .eq('company_id', cid).in('doc_type', types)
      .order('doc_date', { ascending: false }).order('posted_at', { ascending: false }).limit(300),
    supabase.from('warehouses').select('id, code, name, is_default').eq('company_id', cid).eq('is_active', true).order('code'),
    supabase.from('items').select('id, code, name, category_id, item_group_id, units_of_measure(code)').eq('company_id', cid)
      .eq('is_active', true).in('item_type', ['stock', 'manufactured']).order('code'),
    supabase.from('stock_balances').select('item_id, warehouse_id, qty_on_hand, value, avg_cost').eq('company_id', cid),
    supabase.from('company_currencies').select('code').eq('company_id', cid).eq('is_base', true).maybeSingle(),
    supabase.from('item_groups').select('id, code, name').eq('company_id', cid).order('code'),
    supabase.from('item_categories').select('id, code, name').eq('company_id', cid).order('code'),
  ]);
  for (const r of [d, w, it, b, c, g, k]) if (r.error) throw r.error;
  docs = d.data;
  warehouses = w.data;
  items = it.data;
  balances = new Map(b.data.map((x) => [`${x.item_id}|${x.warehouse_id}`,
    { qty: Number(x.qty_on_hand), value: Number(x.value), avg: Number(x.avg_cost) }]));
  base = c.data ? c.data.code : '';
  groups = g.data;
  categories = k.data;
}

async function refresh() {
  try { await load(); } catch (e) { ui.errorFrom(e, `Could not load ${TITLE.toLowerCase()}s.`); }
  render();
}

/* ---------- list ---------- */

const whText = (d) => (KIND === 'transfer'
  ? `${d.from_wh ? d.from_wh.code : ''} to ${d.to_wh ? d.to_wh.code : ''}`
  : (d.from_wh ? `${d.from_wh.code} - ${d.from_wh.name}` : ''));

function render() {
  hint.textContent = KIND === 'transfer'
    ? 'Stock moves out of one warehouse at its average cost and into the other at the same value. No journal is needed, because the inventory account is the same.'
    : `Opening stock and adjustments post to the ledger in ${base}. Increases without a unit cost use the current average cost. A revaluation splits one value across the chosen items by their stock value on hand, changing value and average cost but not quantity. Posted documents cannot be changed: correct a mistake with a counter-adjustment.`;
  toolbar.replaceChildren();
  if (CAN_POST) toolbar.append(btn(`New ${TITLE.toLowerCase()}`, 'btn-primary', openEditor));
  if (CAN_POST && KIND === 'adjustment') toolbar.append(btn('New revaluation', '', openRevaluation));
  const box = el('input');
  box.type = 'search';
  box.placeholder = 'Search';
  box.value = needle;
  box.style.maxWidth = '240px';
  box.addEventListener('input', () => { needle = box.value.trim().toLowerCase(); renderTable(); });
  toolbar.append(box, el('span', 'spacer'), btn('Export to Excel', '', doExport));
  renderTable();
}

function visible() {
  return docs.filter((d) => !needle
    || [d.doc_no, whText(d), d.reason, d.reference, d.doc_date].some((x) => String(x || '').toLowerCase().includes(needle)));
}

function renderTable() {
  if (!docs.length) { panel.innerHTML = `<p class="muted">No ${TITLE.toLowerCase()}s yet.</p>`; return; }
  const list = visible();
  if (!list.length) { panel.innerHTML = '<p class="muted">Nothing matches.</p>'; return; }
  const body = list.map((d) => `<tr class="clickable" data-id="${d.id}">
    <td>${esc(d.doc_no)}</td><td>${d.doc_date}</td><td>${esc(TYPE_LABEL[d.doc_type])}</td><td>${esc(whText(d))}</td>
    <td>${esc(d.reason || d.reference || '')}</td><td class="num">${money(d.total_value)}</td></tr>`).join('');
  panel.innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr>
    <th>No</th><th>Date</th><th>Type</th><th>${KIND === 'transfer' ? 'Warehouses' : 'Warehouse'}</th><th>Reason / reference</th>
    <th style="text-align:right">Value (${esc(base)})</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

panel.addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  const d = docs.find((x) => x.id === tr.dataset.id);
  if (d) openViewer(d);
});

async function doExport() {
  try {
    await exportSheets(`${TITLE.toLowerCase().replace(' ', '-')}s-${todayIso()}.xlsx`, [{
      name: `${TITLE}s`,
      rows: visible().map((d) => ({
        no: d.doc_no, date: d.doc_date, type: TYPE_LABEL[d.doc_type], warehouse: whText(d),
        reason: d.reason || '', reference: d.reference || '', value: Number(d.total_value),
      })),
      columns: [
        { key: 'no', header: 'No', width: 14 }, { key: 'date', header: 'Date', width: 12 }, { key: 'type', header: 'Type', width: 16 },
        { key: 'warehouse', header: 'Warehouse', width: 26 }, { key: 'reason', header: 'Reason', width: 30 },
        { key: 'reference', header: 'Reference', width: 18 }, { key: 'value', header: `Value (${base})`, width: 16 },
      ],
    }]);
  } catch (e) { ui.errorFrom(e, 'Could not export.'); }
}

/* ---------- new document ---------- */

async function openEditor() {
  if (!warehouses.length) return ui.warn('Add a warehouse first.');
  if (!items.length) return ui.warn('There are no stock items yet. Create an item in a stock category first.');
  const isTransfer = KIND === 'transfer';

  const prevFocus = document.activeElement;
  const backdrop = el('div', 'modal-backdrop');
  const box = el('div', 'modal xwide');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.append(el('h3', 'modal-title', `New ${TITLE.toLowerCase()}`));

  const field = (text, input, full) => {
    const w = el('div', `field${full ? ' full' : ''}`);
    w.append(el('label', '', text), input);
    return w;
  };
  const defWh = (warehouses.find((w) => w.is_default) || warehouses[0]).id;
  const whOptions = (sel) => { warehouses.forEach((w) => option(sel, w.id, `${w.code} - ${w.name}`)); };

  const dateIn = el('input'); dateIn.type = 'date'; dateIn.value = todayIso();
  const refIn = el('input');
  const typeSel = el('select');
  const whSel = el('select');
  const reasonIn = el('input');
  const fromSel = el('select');
  const toSel = el('select');
  const head = el('div', 'form-grid');
  if (isTransfer) {
    whOptions(fromSel); whOptions(toSel);
    fromSel.value = defWh;
    toSel.value = (warehouses.find((w) => w.id !== defWh) || warehouses[0]).id;
    head.append(field('From warehouse *', fromSel), field('To warehouse *', toSel), field('Date *', dateIn), field('Reference', refIn));
  } else {
    option(typeSel, 'adjustment', 'Stock adjustment (increase or decrease)');
    option(typeSel, 'opening', 'Opening stock (balances brought forward)');
    whOptions(whSel);
    whSel.value = defWh;
    reasonIn.placeholder = 'For example stock count, damaged, expired';
    head.append(field('Type *', typeSel, true), field('Warehouse *', whSel), field('Date *', dateIn),
      field('Reason *', reasonIn), field('Reference', refIn));
  }
  box.append(head);

  const wrap = el('div', 'lines-wrap');
  const table = el('table', 'lines-table stock-lines');
  table.innerHTML = `<thead><tr><th class="c-sitem">Item</th><th class="c-onhand">On hand</th>
    <th class="c-sqty">${isTransfer ? 'Quantity' : 'Quantity change'}</th>
    <th class="c-scost">${isTransfer ? 'Average cost' : `Unit cost (${esc(base)})`}</th>
    <th class="c-sval">Value (${esc(base)})</th><th class="c-sdel"></th></tr></thead>`;
  const tbody = el('tbody');
  table.append(tbody);
  wrap.append(table);
  box.append(wrap);

  const rows = [];
  const totals = el('div', 'totals-bar');
  const curWh = () => (isTransfer ? fromSel.value : whSel.value);
  const bal = (itemId) => balances.get(`${itemId}|${curWh()}`) || { qty: 0, avg: 0 };
  const isOpening = () => !isTransfer && typeSel.value === 'opening';

  function recalc() {
    let total = 0;
    rows.forEach((r) => {
      const b = r.itemSel.value ? bal(r.itemSel.value) : { qty: 0, avg: 0 };
      r.onHand.textContent = r.itemSel.value ? qtyFmt(b.qty) : '';
      const q = Number(r.qty.value) || 0;
      let v = q * b.avg;
      if (!isTransfer && q > 0 && r.cost.value !== '') v = q * Number(r.cost.value);
      if (isTransfer) r.costCell.textContent = r.itemSel.value ? costFmt(b.avg) : '';
      else r.cost.placeholder = q > 0 && !isOpening() ? (b.avg ? `avg ${costFmt(b.avg)}` : 'required') : '';
      v = Math.round((v + Number.EPSILON) * 100) / 100;
      r.val.textContent = q ? money(v) : '';
      total += q ? v : 0;
    });
    totals.innerHTML = `<span class="ok">${isTransfer ? 'Value moved' : 'Net value'} (${esc(base)}): ${money(total)}</span>`;
  }

  function addRow() {
    const tr = el('tr');
    const itemSel = el('select');
    option(itemSel, '', 'Select item');
    items.forEach((i) => option(itemSel, i.id, `${i.code} - ${i.name}${i.units_of_measure ? ` (${i.units_of_measure.code})` : ''}`));
    const onHand = el('td', 'num');
    const qty = el('input'); qty.type = 'number'; qty.step = 'any';
    const costCell = el('td');
    const cost = el('input'); cost.type = 'number'; cost.step = 'any'; cost.min = '0';
    if (!isTransfer) costCell.append(cost);
    const val = el('td', 'num');
    const del = el('button', 'btn btn-sm btn-ghost', '✕');
    del.type = 'button';
    del.title = 'Remove line';

    const td1 = el('td'); td1.append(itemSel);
    const td3 = el('td'); td3.append(qty);
    const td6 = el('td'); td6.append(del);
    tr.append(td1, onHand, td3, costCell, val, td6);
    tbody.append(tr);
    const row = { tr, itemSel, onHand, qty, cost, costCell, val };
    [itemSel, qty, cost].forEach((x) => x.addEventListener('input', recalc));
    itemSel.addEventListener('change', recalc);
    del.addEventListener('click', () => {
      if (rows.length === 1) return ui.warn('A document needs at least one line.');
      rows.splice(rows.indexOf(row), 1);
      tr.remove();
      recalc();
    });
    rows.push(row);
  }
  addRow();
  addRow();

  const syncMode = () => {
    rows.forEach((r) => { r.qty.min = (isTransfer || isOpening()) ? '0' : ''; });
    recalc();
  };
  if (isTransfer) fromSel.addEventListener('change', recalc);
  else { whSel.addEventListener('change', recalc); typeSel.addEventListener('change', syncMode); }

  box.append(btn('Add line', '', () => { addRow(); syncMode(); }), totals);
  syncMode();

  /* ---- buttons ---- */
  const actions = el('div', 'modal-actions');
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const close = () => {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    if (prevFocus && prevFocus.focus) prevFocus.focus();
  };
  document.addEventListener('keydown', onKey);
  const postBtn = btn('Post', 'btn-primary', () => {});
  actions.append(el('span', 'spacer'), btn('Cancel', 'btn-ghost', close), postBtn);
  box.append(actions);
  backdrop.append(box);
  document.body.append(backdrop);

  function collect() {
    if (!dateIn.value) throw new Error('Enter the date.');
    if (isTransfer) {
      if (!fromSel.value || !toSel.value) throw new Error('Choose both warehouses.');
      if (fromSel.value === toSel.value) throw new Error('Choose two different warehouses.');
    } else {
      if (!whSel.value) throw new Error('Choose the warehouse.');
      if (typeSel.value === 'adjustment' && !reasonIn.value.trim()) throw new Error('Enter a reason for the adjustment.');
    }
    const seen = new Set();
    const lines = [];
    rows.forEach((r) => {
      if (!r.itemSel.value && r.qty.value === '') return;
      const n = lines.length + 1;
      if (!r.itemSel.value) throw new Error(`Line ${n}: choose an item.`);
      if (seen.has(r.itemSel.value)) throw new Error(`Line ${n}: each item can appear only once.`);
      seen.add(r.itemSel.value);
      const q = Number(r.qty.value);
      if (!q) throw new Error(`Line ${n}: enter a quantity.`);
      if ((isTransfer || isOpening()) && q < 0) throw new Error(`Line ${n}: the quantity must be above zero.`);
      if (isTransfer) {
        if (q > bal(r.itemSel.value).qty) throw new Error(`Line ${n}: only ${qtyFmt(bal(r.itemSel.value).qty)} on hand in the source warehouse.`);
        lines.push({ item_id: r.itemSel.value, qty: q });
        return;
      }
      const c = r.cost.value === '' ? null : Number(r.cost.value);
      if (isOpening() && c === null) throw new Error(`Line ${n}: enter the unit cost.`);
      if (q > 0 && c === null && !bal(r.itemSel.value).avg) throw new Error(`Line ${n}: enter a unit cost, there is no average cost yet.`);
      lines.push({ item_id: r.itemSel.value, qty: q, unit_cost: q > 0 ? c : null });
    });
    if (!lines.length) throw new Error('Add at least one line.');
    return lines;
  }

  postBtn.addEventListener('click', async () => {
    let lines;
    try { lines = collect(); } catch (e) { return ui.warn(e.message); }
    const ok = await ui.confirm({
      title: `Post ${TITLE.toLowerCase()}`,
      message: isTransfer
        ? `Transfer ${lines.length} item(s) between the warehouses?`
        : `Post this ${isOpening() ? 'opening stock' : 'adjustment'} for ${lines.length} item(s)?\nIt posts to the ledger and cannot be changed afterwards.`,
      confirmText: 'Post',
    });
    if (!ok) return;
    postBtn.disabled = true;
    try {
      const { error } = isTransfer
        ? await supabase.rpc('post_stock_transfer', {
          p_company: ctx.companyId, p_date: dateIn.value, p_from: fromSel.value, p_to: toSel.value,
          p_reference: refIn.value, p_lines: lines,
        })
        : await supabase.rpc('post_stock_adjustment', {
          p_company: ctx.companyId, p_type: typeSel.value, p_date: dateIn.value, p_warehouse: whSel.value,
          p_reason: reasonIn.value, p_reference: refIn.value, p_lines: lines,
        });
      if (error) throw error;
      close();
      ui.success(`${TITLE} posted.`);
      await refresh();
    } catch (e) {
      ui.errorFrom(e, `Could not post the ${TITLE.toLowerCase()}.`);
    } finally {
      postBtn.disabled = false;
    }
  });
  (isTransfer ? fromSel : typeSel).focus();
}

/* ---------- revaluation (split a value by stock value on hand) ---------- */

function openRevaluation() {
  if (!warehouses.length) return ui.warn('Add a warehouse first.');

  const prevFocus = document.activeElement;
  const backdrop = el('div', 'modal-backdrop');
  const box = el('div', 'modal xwide');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.append(el('h3', 'modal-title', 'New stock revaluation'));

  const field = (text, input, full) => {
    const w = el('div', `field${full ? ' full' : ''}`);
    w.append(el('label', '', text), input);
    return w;
  };
  const whSel = el('select');
  warehouses.forEach((w) => option(whSel, w.id, `${w.code} - ${w.name}`));
  whSel.value = (warehouses.find((w) => w.is_default) || warehouses[0]).id;
  const dateIn = el('input'); dateIn.type = 'date'; dateIn.value = todayIso();
  const reasonIn = el('input'); reasonIn.placeholder = 'For example freight on import, write-down to market value';
  const refIn = el('input');
  const totalIn = el('input'); totalIn.type = 'number'; totalIn.step = '0.01';
  totalIn.placeholder = 'Above zero adds value, below zero writes it down';
  const head = el('div', 'form-grid');
  head.append(field('Warehouse *', whSel), field('Date *', dateIn), field(`Value to split (${base}) *`, totalIn),
    field('Reason *', reasonIn), field('Reference', refIn));
  box.append(head);

  /* ---- pick list ---- */
  const searchIn = el('input'); searchIn.type = 'search'; searchIn.placeholder = 'Search items'; searchIn.style.maxWidth = '220px';
  const catSel = el('select');
  option(catSel, '', 'All categories');
  categories.forEach((c) => option(catSel, c.id, `${c.code} - ${c.name}`));
  const grpSel = el('select');
  option(grpSel, '', 'All groups');
  groups.forEach((g) => option(grpSel, g.id, `${g.code} - ${g.name}`));
  const picked = new Set();
  const filters = el('div', 'toolbar');
  filters.append(searchIn, catSel, grpSel, el('span', 'spacer'),
    btn('Select all shown', 'btn-sm', () => { shown().forEach((x) => picked.add(x.item.id)); renderList(); }),
    btn('Clear', 'btn-sm btn-ghost', () => { picked.clear(); renderList(); }));
  box.append(filters);

  const wrap = el('div', 'table-wrap');
  wrap.style.maxHeight = '45vh';
  wrap.style.overflowY = 'auto';
  box.append(wrap);
  const totals = el('div', 'totals-bar');
  box.append(totals);

  // items with stock value in the chosen warehouse; only these can carry a share
  const stocked = () => items
    .map((item) => ({ item, b: balances.get(`${item.id}|${whSel.value}`) }))
    .filter((x) => x.b && x.b.qty > 0 && x.b.value > 0);
  const shown = () => {
    const q = searchIn.value.trim().toLowerCase();
    return stocked().filter((x) => (!catSel.value || x.item.category_id === catSel.value)
      && (!grpSel.value || x.item.item_group_id === grpSel.value)
      && (!q || `${x.item.code} ${x.item.name}`.toLowerCase().includes(q)));
  };

  // same split as post_stock_revaluation: rounded shares, the difference on the largest value
  function split() {
    const total = Math.round((Number(totalIn.value) || 0) * 100) / 100;
    const chosen = stocked().filter((x) => picked.has(x.item.id));
    const weight = chosen.reduce((s, x) => s + x.b.value, 0);
    const shares = new Map();
    if (!weight) return { total, weight, chosen, shares };
    let top = chosen[0];
    chosen.forEach((x) => {
      shares.set(x.item.id, Math.round((total * x.b.value / weight) * 100) / 100);
      if (x.b.value > top.b.value) top = x;
    });
    const left = Math.round((total - [...shares.values()].reduce((s, v) => s + v, 0)) * 100) / 100;
    shares.set(top.item.id, Math.round((shares.get(top.item.id) + left) * 100) / 100);
    return { total, weight, chosen, shares };
  }

  function renderList() {
    const list = shown();
    const { total, weight, chosen, shares } = split();
    if (!list.length) {
      wrap.innerHTML = `<p class="muted">${stocked().length ? 'Nothing matches.' : 'No items have stock value in this warehouse.'}</p>`;
    } else {
      const body = list.map(({ item, b }) => {
        const on = picked.has(item.id);
        const s = on ? shares.get(item.id) || 0 : 0;
        return `<tr data-id="${item.id}" class="clickable"><td><input type="checkbox" ${on ? 'checked' : ''} aria-label="Include ${esc(item.code)}"></td>
          <td>${esc(item.code)} - ${esc(item.name)}</td><td class="num">${qtyFmt(b.qty)}</td><td class="num">${money(b.value)}</td>
          <td class="num">${on && weight ? `${(b.value / weight * 100).toFixed(1)}%` : ''}</td>
          <td class="num">${on && total ? money(s) : ''}</td>
          <td class="num">${costFmt(b.avg)}</td><td class="num">${on && total ? costFmt((b.value + s) / b.qty) : ''}</td></tr>`;
      }).join('');
      wrap.innerHTML = `<table class="grid"><thead><tr><th></th><th>Item</th><th style="text-align:right">On hand</th>
        <th style="text-align:right">Value (${esc(base)})</th><th style="text-align:right">Share</th>
        <th style="text-align:right">Value change</th><th style="text-align:right">Average cost</th>
        <th style="text-align:right">New average cost</th></tr></thead><tbody>${body}</tbody></table>`;
    }
    const over = total < 0 && -total > weight;
    totals.innerHTML = `<span class="${over ? 'bad' : 'ok'}">${chosen.length} item(s) chosen, stock value ${money(weight)} ${esc(base)}`
      + `${total ? `, ${total > 0 ? 'adding' : 'writing down'} ${money(Math.abs(total))}` : ''}${over ? ' (more than the stock value)' : ''}</span>`;
  }

  wrap.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    if (picked.has(tr.dataset.id)) picked.delete(tr.dataset.id); else picked.add(tr.dataset.id);
    renderList();
  });
  searchIn.addEventListener('input', renderList);
  [catSel, grpSel].forEach((s) => s.addEventListener('change', renderList));
  totalIn.addEventListener('input', renderList);
  whSel.addEventListener('change', () => { picked.clear(); renderList(); });
  renderList();

  /* ---- buttons ---- */
  const actions = el('div', 'modal-actions');
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const close = () => {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    if (prevFocus && prevFocus.focus) prevFocus.focus();
  };
  document.addEventListener('keydown', onKey);
  const postBtn = btn('Post', 'btn-primary', async () => {
    const { total, weight, chosen } = split();
    if (!dateIn.value) return ui.warn('Enter the date.');
    if (!reasonIn.value.trim()) return ui.warn('Enter a reason for the revaluation.');
    if (!total) return ui.warn('Enter the value to split.');
    if (!chosen.length) return ui.warn('Choose at least one item.');
    if (total < 0 && -total > weight) return ui.warn(`The write-down is more than the ${money(weight)} stock value of the chosen items.`);
    const ok = await ui.confirm({
      title: 'Post stock revaluation',
      message: `${total > 0 ? 'Add' : 'Write down'} ${money(Math.abs(total))} ${base} across ${chosen.length} item(s) by stock value on hand?\nIt posts to the ledger and cannot be changed afterwards.`,
      confirmText: 'Post',
    });
    if (!ok) return;
    postBtn.disabled = true;
    try {
      const { error } = await supabase.rpc('post_stock_revaluation', {
        p_company: ctx.companyId, p_date: dateIn.value, p_warehouse: whSel.value, p_reason: reasonIn.value,
        p_reference: refIn.value, p_total: total, p_items: chosen.map((x) => x.item.id),
      });
      if (error) throw error;
      close();
      ui.success('Stock revaluation posted.');
      await refresh();
    } catch (e) {
      ui.errorFrom(e, 'Could not post the stock revaluation.');
    } finally {
      postBtn.disabled = false;
    }
  });
  actions.append(el('span', 'spacer'), btn('Cancel', 'btn-ghost', close), postBtn);
  box.append(actions);
  backdrop.append(box);
  document.body.append(backdrop);
  whSel.focus();
}

/* ---------- viewer ---------- */

async function openViewer(d) {
  const [l, j] = await Promise.all([
    supabase.from('stock_document_lines').select('*, items(code, name)').eq('document_id', d.id).order('line_no'),
    d.journal_id ? supabase.from('journals').select('journal_no').eq('id', d.journal_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  if (l.error) return ui.errorFrom(l.error, 'Could not load the lines.');

  const node = el('div');
  const info = el('p', 'muted', [
    `${TYPE_LABEL[d.doc_type]} · ${d.doc_date}`, whText(d),
    d.reason ? `Reason: ${d.reason}` : '', d.reference ? `Reference: ${d.reference}` : '',
    j.data && j.data.journal_no ? `Ledger journal ${j.data.journal_no}` : (KIND === 'transfer' ? 'No journal needed' : ''),
  ].filter(Boolean).join('\n'));
  info.style.whiteSpace = 'pre-line';
  node.append(info);

  const body = l.data.map((x, i) => `<tr><td>${i + 1}</td><td>${esc(x.items ? `${x.items.code} - ${x.items.name}` : '')}</td>
    <td class="num">${qtyFmt(x.qty)}</td><td class="num">${costFmt(x.unit_cost)}</td><td class="num">${money(x.value)}</td></tr>`).join('');
  const t = el('div', 'table-wrap');
  t.innerHTML = `<table class="grid"><thead><tr><th>#</th><th>Item</th><th style="text-align:right">Quantity</th>
    <th style="text-align:right">${d.doc_type === 'revaluation' ? 'Cost change per unit' : 'Unit cost'} (${esc(base)})</th><th style="text-align:right">Value (${esc(base)})</th></tr></thead>
    <tbody>${body}<tr><td colspan="4"><strong>Total</strong></td><td class="num"><strong>${money(d.total_value)}</strong></td></tr></tbody></table>`;
  node.append(t);
  await ui.dialog({
    title: `${TYPE_LABEL[d.doc_type]} ${d.doc_no}`, node, wide: true, dismissValue: 'close',
    buttons: [{ label: 'Close', value: 'close', className: 'btn-ghost' }],
  });
}

if (ctx) {
  document.getElementById('company-title').textContent = ctx.company.name;
  await refresh();
}