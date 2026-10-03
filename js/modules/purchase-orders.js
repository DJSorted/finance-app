import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { exportSheets } from '../core/export.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const panel = document.getElementById('panel');

const CAN_DRAFT = ctx ? ['owner', 'admin', 'accountant', 'clerk'].includes(ctx.role) : false;
const CAN_APPROVE = ctx ? ctx.canEdit : false;
const STATUS = { draft: 'Draft', approved: 'Approved', closed: 'Closed', cancelled: 'Cancelled' };

let orders = [];
let suppliers = [];
let warehouses = [];
let items = [];
let currencies = [];
let base = '';
let statusFilter = 'all';
let needle = '';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n, d = 2) => Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const qtyFmt = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 4 });
const roundTo = (n, d) => { const f = 10 ** d; return Math.round((n + Number.EPSILON) * f) / f; };
const todayIso = () => new Date().toISOString().slice(0, 10);
const decOf = (code) => { const c = currencies.find((x) => x.code === code); return c && c.currencies ? c.currencies.decimals : 2; };
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
  const [o, s, w, it, cu] = await Promise.all([
    supabase.from('purchase_orders')
      .select('*, suppliers(code, name), warehouses(code, name), purchase_order_lines(qty_ordered, qty_received)')
      .eq('company_id', cid).order('order_date', { ascending: false }).order('created_at', { ascending: false }).limit(300),
    supabase.from('suppliers').select('id, code, name').eq('company_id', cid).eq('is_active', true).order('code'),
    supabase.from('warehouses').select('id, code, name, is_default').eq('company_id', cid).eq('is_active', true).order('code'),
    supabase.from('items').select('id, code, name, units_of_measure(code), item_categories(is_purchasable)')
      .eq('company_id', cid).eq('is_active', true).in('item_type', ['stock', 'manufactured']).order('code'),
    supabase.from('company_currencies').select('code, is_base, currencies(decimals)').eq('company_id', cid).order('code'),
  ]);
  for (const r of [o, s, w, it, cu]) if (r.error) throw r.error;
  orders = o.data;
  suppliers = s.data;
  warehouses = w.data;
  items = it.data.filter((x) => x.item_categories && x.item_categories.is_purchasable);
  currencies = cu.data;
  base = (currencies.find((x) => x.is_base) || {}).code || '';
}

async function refresh() {
  try { await load(); } catch (e) { ui.errorFrom(e, 'Could not load purchase orders.'); }
  render();
}

function receiptState(o) {
  const ls = o.purchase_order_lines || [];
  const ord = ls.reduce((s, l) => s + Number(l.qty_ordered), 0);
  const rec = ls.reduce((s, l) => s + Number(l.qty_received), 0);
  if (!rec) return 'Not received';
  return rec >= ord ? 'Fully received' : 'Partly received';
}
const supName = (o) => (o.suppliers ? `${o.suppliers.code} - ${o.suppliers.name}` : '');

/* ---------- list ---------- */

function render() {
  hint.textContent = 'Purchase orders are for stock items. An accountant approves an order, which numbers it and opens it for receiving. Goods are received on the Goods Received screen.';
  toolbar.replaceChildren();
  if (CAN_DRAFT) toolbar.append(btn('New purchase order', 'btn-primary', () => openEditor(null)));
  const box = el('input');
  box.type = 'search';
  box.placeholder = 'Search';
  box.value = needle;
  box.style.maxWidth = '240px';
  box.addEventListener('input', () => { needle = box.value.trim().toLowerCase(); renderTable(); });
  const sel = el('select', 'compact');
  [['all', 'All'], ['draft', 'Drafts'], ['approved', 'Open'], ['closed', 'Closed'], ['cancelled', 'Cancelled']]
    .forEach(([v, l]) => option(sel, v, l));
  sel.value = statusFilter;
  sel.addEventListener('change', () => { statusFilter = sel.value; renderTable(); });
  toolbar.append(box, sel, el('span', 'spacer'), btn('Export to Excel', '', doExport));
  renderTable();
}

function visible() {
  return orders.filter((o) => (statusFilter === 'all' || o.status === statusFilter)
    && (!needle || [o.po_no, supName(o), o.reference, o.order_date].some((x) => String(x || '').toLowerCase().includes(needle))));
}

function renderTable() {
  if (!orders.length) { panel.innerHTML = '<p class="muted">No purchase orders yet.</p>'; return; }
  const list = visible();
  if (!list.length) { panel.innerHTML = '<p class="muted">Nothing matches.</p>'; return; }
  const body = list.map((o) => `<tr class="clickable" data-id="${o.id}">
    <td>${esc(o.po_no || 'Draft')}</td><td>${o.order_date}</td><td>${esc(supName(o))}</td>
    <td>${esc(o.warehouses ? o.warehouses.code : '')}</td><td>${esc(o.currency_code)}</td>
    <td class="num">${money(o.total, decOf(o.currency_code))}</td>
    <td><span class="badge ${o.status === 'approved' ? 'open' : ''}">${STATUS[o.status]}</span>
      ${o.status === 'approved' || o.status === 'closed' ? `<span class="badge">${receiptState(o)}</span>` : ''}</td></tr>`).join('');
  panel.innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr>
    <th>No</th><th>Date</th><th>Supplier</th><th>Warehouse</th><th>Cur</th><th style="text-align:right">Total</th><th>Status</th>
    </tr></thead><tbody>${body}</tbody></table></div>`;
}

panel.addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  const o = orders.find((x) => x.id === tr.dataset.id);
  if (!o) return;
  if (o.status === 'draft') { if (CAN_DRAFT) openEditor(o); } else openViewer(o);
});

async function doExport() {
  try {
    await exportSheets(`purchase-orders-${todayIso()}.xlsx`, [{
      name: 'Purchase orders',
      rows: visible().map((o) => ({
        no: o.po_no || 'Draft', date: o.order_date, expected: o.expected_date || '', supplier: supName(o),
        warehouse: o.warehouses ? o.warehouses.code : '', currency: o.currency_code, total: Number(o.total),
        status: STATUS[o.status], received: receiptState(o), reference: o.reference || '',
      })),
      columns: [
        { key: 'no', header: 'No', width: 14 }, { key: 'date', header: 'Date', width: 12 }, { key: 'expected', header: 'Expected', width: 12 },
        { key: 'supplier', header: 'Supplier', width: 34 }, { key: 'warehouse', header: 'Warehouse', width: 12 },
        { key: 'currency', header: 'Currency', width: 10 }, { key: 'total', header: 'Total', width: 14 },
        { key: 'status', header: 'Status', width: 12 }, { key: 'received', header: 'Receiving', width: 16 },
        { key: 'reference', header: 'Reference', width: 18 },
      ],
    }]);
  } catch (e) { ui.errorFrom(e, 'Could not export.'); }
}

/* ---------- editor (drafts) ---------- */

async function openEditor(existing) {
  if (!suppliers.length) return ui.warn('Add a supplier first.');
  if (!warehouses.length) return ui.warn('Add a warehouse first.');
  if (!items.length) return ui.warn('There are no stock items that are bought yet. Create one in a stock category first.');
  let orderId = existing ? existing.id : null;
  let seed = [];
  if (existing) {
    const { data, error } = await supabase.from('purchase_order_lines').select('*').eq('order_id', existing.id).order('line_no');
    if (error) return ui.errorFrom(error, 'Could not load the order lines.');
    seed = data.map((l) => ({ item_id: l.item_id, description: l.description, qty: Number(l.qty_ordered), price: Number(l.unit_price) }));
  }
  if (!seed.length) seed.push({});

  const prevFocus = document.activeElement;
  const backdrop = el('div', 'modal-backdrop');
  const box = el('div', 'modal xwide');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.append(el('h3', 'modal-title', existing ? 'Edit draft purchase order' : 'New purchase order'));

  const field = (text, input, full) => {
    const w = el('div', `field${full ? ' full' : ''}`);
    w.append(el('label', '', text), input);
    return w;
  };
  const supSel = el('select');
  option(supSel, '', 'Select a supplier');
  suppliers.forEach((s) => option(supSel, s.id, `${s.code} - ${s.name}`));
  supSel.value = existing ? existing.supplier_id : '';
  const dateIn = el('input'); dateIn.type = 'date'; dateIn.value = existing ? existing.order_date : todayIso();
  const expIn = el('input'); expIn.type = 'date'; expIn.value = existing ? (existing.expected_date || '') : '';
  const curSel = el('select');
  currencies.forEach((c) => option(curSel, c.code, c.code + (c.is_base ? ' (base)' : '')));
  curSel.value = existing ? existing.currency_code : base;
  const whSel = el('select');
  warehouses.forEach((w) => option(whSel, w.id, `${w.code} - ${w.name}`));
  whSel.value = existing ? existing.warehouse_id : (warehouses.find((w) => w.is_default) || warehouses[0]).id;
  const refIn = el('input'); refIn.value = existing ? (existing.reference || '') : '';
  const notesIn = el('input'); notesIn.value = existing ? (existing.notes || '') : '';

  const head = el('div', 'form-grid');
  head.append(field('Supplier *', supSel, true), field('Order date *', dateIn), field('Expected delivery', expIn),
    field('Currency', curSel), field('Deliver to warehouse *', whSel), field('Reference', refIn), field('Notes', notesIn));
  box.append(head);

  const wrap = el('div', 'lines-wrap');
  const table = el('table', 'lines-table po-lines');
  table.innerHTML = '<thead><tr><th class="c-pitem">Item</th><th class="c-pdesc">Description</th><th class="c-pqty">Quantity</th>'
    + '<th class="c-pprice">Unit price</th><th class="c-ptotal">Total</th><th class="c-pdel"></th></tr></thead>';
  const tbody = el('tbody');
  table.append(tbody);
  wrap.append(table);
  box.append(wrap);

  const rows = [];
  const totals = el('div', 'totals-bar');
  function recalc() {
    const dec = decOf(curSel.value);
    let total = 0;
    rows.forEach((r) => {
      const t = roundTo((Number(r.qty.value) || 0) * (Number(r.price.value) || 0), dec);
      r.tot.textContent = money(t, dec);
      total += t;
    });
    totals.innerHTML = `<span class="ok">Order total (${esc(curSel.value)}): ${money(total, dec)}</span>`;
  }
  function addRow(s) {
    const tr = el('tr');
    const itemSel = el('select');
    option(itemSel, '', 'Select item');
    items.forEach((i) => option(itemSel, i.id, `${i.code} - ${i.name}${i.units_of_measure ? ` (${i.units_of_measure.code})` : ''}`));
    itemSel.value = s.item_id || '';
    const desc = el('input'); desc.value = s.description || '';
    const qty = el('input'); qty.type = 'number'; qty.step = 'any'; qty.min = '0'; qty.value = s.qty ?? '';
    const price = el('input'); price.type = 'number'; price.step = 'any'; price.min = '0'; price.value = s.price ?? '';
    const tot = el('td', 'num');
    const del = el('button', 'btn btn-sm btn-ghost', '✕');
    del.type = 'button';
    del.title = 'Remove line';
    [itemSel, desc, qty, price].forEach((x) => { const td = el('td'); td.append(x); tr.append(td); });
    const dtd = el('td'); dtd.append(del);
    tr.append(tot, dtd);
    tbody.append(tr);
    const row = { tr, itemSel, desc, qty, price, tot };
    itemSel.addEventListener('change', () => {
      const it = items.find((x) => x.id === itemSel.value);
      if (it && !desc.value.trim()) desc.value = it.name;
      recalc();
    });
    [qty, price].forEach((x) => x.addEventListener('input', recalc));
    del.addEventListener('click', () => {
      if (rows.length === 1) return ui.warn('An order needs at least one line.');
      rows.splice(rows.indexOf(row), 1);
      tr.remove();
      recalc();
    });
    rows.push(row);
  }
  seed.forEach(addRow);

  supSel.addEventListener('change', async () => {
    if (!supSel.value) return;
    const { data } = await supabase.rpc('supplier_defaults', { p_supplier: supSel.value });
    const d = data && data[0];
    if (d && currencies.some((c) => c.code === d.currency_code)) curSel.value = d.currency_code;
    recalc();
  });
  curSel.addEventListener('change', recalc);

  box.append(btn('Add line', '', () => { addRow({}); recalc(); }), totals);
  recalc();

  const actions = el('div', 'modal-actions');
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const close = () => {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    if (prevFocus && prevFocus.focus) prevFocus.focus();
  };
  document.addEventListener('keydown', onKey);
  if (existing) {
    actions.append(btn('Delete draft', 'btn-danger', async () => {
      if (!(await ui.confirmDelete('Purchase order'))) return;
      const { error } = await supabase.rpc('delete_purchase_order_draft', { p_order: orderId });
      if (error) return ui.errorFrom(error);
      close();
      ui.deleted('Purchase order');
      await refresh();
    }));
  }
  actions.append(el('span', 'spacer'), btn('Cancel', 'btn-ghost', close));
  const saveBtn = btn('Save draft', CAN_APPROVE ? '' : 'btn-primary', () => {});
  actions.append(saveBtn);
  const approveBtn = CAN_APPROVE ? btn('Save and approve', 'btn-primary', () => {}) : null;
  if (approveBtn) actions.append(approveBtn);
  box.append(actions);
  backdrop.append(box);
  document.body.append(backdrop);

  function collect() {
    if (!supSel.value) throw new Error('Choose a supplier.');
    if (!dateIn.value) throw new Error('Enter the order date.');
    const lines = [];
    rows.forEach((r) => {
      if (!r.itemSel.value && r.qty.value === '' && r.price.value === '') return;
      const n = lines.length + 1;
      if (!r.itemSel.value) throw new Error(`Line ${n}: choose an item.`);
      if (!(Number(r.qty.value) > 0)) throw new Error(`Line ${n}: enter a quantity above zero.`);
      if (r.price.value === '' || Number(r.price.value) < 0) throw new Error(`Line ${n}: enter the unit price.`);
      lines.push({ item_id: r.itemSel.value, description: r.desc.value.trim(), qty: Number(r.qty.value), unit_price: Number(r.price.value) });
    });
    if (!lines.length) throw new Error('Add at least one line.');
    return lines;
  }
  async function persist() {
    const p_lines = collect();
    const { data, error } = await supabase.rpc('save_purchase_order', {
      p_company: ctx.companyId, p_order: orderId, p_supplier: supSel.value, p_date: dateIn.value,
      p_expected: expIn.value || null, p_currency: curSel.value, p_warehouse: whSel.value,
      p_reference: refIn.value, p_notes: notesIn.value, p_lines,
    });
    if (error) throw error;
    orderId = data;
    return data;
  }

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try { await persist(); close(); ui.saved('Purchase order'); await refresh(); }
    catch (e) { ui.errorFrom(e, 'Could not save the purchase order.'); }
    finally { saveBtn.disabled = false; }
  });
  if (approveBtn) {
    approveBtn.addEventListener('click', async () => {
      try { collect(); } catch (e) { return ui.warn(e.message); }
      approveBtn.disabled = true;
      try {
        const id = await persist();
        const { error } = await supabase.rpc('set_purchase_order_status', { p_order: id, p_action: 'approve' });
        if (error) { await refresh(); throw new Error(`Saved as a draft, but it could not be approved: ${error.message}`); }
        close();
        ui.success('Purchase order approved.');
        await refresh();
      } catch (e) { ui.errorFrom(e, 'Could not approve the purchase order.'); }
      finally { approveBtn.disabled = false; }
    });
  }
  supSel.focus();
}

/* ---------- viewer ---------- */

async function openViewer(o) {
  const { data: lines, error } = await supabase.from('purchase_order_lines').select('*, items(code, name)')
    .eq('order_id', o.id).order('line_no');
  if (error) return ui.errorFrom(error, 'Could not load the order lines.');
  const dec = decOf(o.currency_code);
  const anyReceived = lines.some((l) => Number(l.qty_received) > 0);

  const node = el('div');
  const info = el('p', 'muted', [
    supName(o), `Order date ${o.order_date}${o.expected_date ? ` · Expected ${o.expected_date}` : ''}`,
    `Deliver to ${o.warehouses ? `${o.warehouses.code} - ${o.warehouses.name}` : ''} · ${o.currency_code}`,
    o.reference ? `Reference ${o.reference}` : '', `Status: ${STATUS[o.status]} · ${receiptState(o)}`,
  ].filter(Boolean).join('\n'));
  info.style.whiteSpace = 'pre-line';
  node.append(info);

  const body = lines.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.items ? l.items.code : '')}</td><td>${esc(l.description)}</td>
    <td class="num">${qtyFmt(l.qty_ordered)}</td><td class="num">${qtyFmt(l.qty_received)}</td>
    <td class="num">${qtyFmt(Number(l.qty_ordered) - Number(l.qty_received))}</td>
    <td class="num">${money(l.unit_price, dec)}</td><td class="num">${money(l.line_total, dec)}</td></tr>`).join('');
  const t = el('div', 'table-wrap');
  t.innerHTML = `<table class="grid"><thead><tr><th>#</th><th>Item</th><th>Description</th>
    <th style="text-align:right">Ordered</th><th style="text-align:right">Received</th><th style="text-align:right">Outstanding</th>
    <th style="text-align:right">Price</th><th style="text-align:right">Total</th></tr></thead>
    <tbody>${body}<tr><td colspan="7"><strong>Order total ${esc(o.currency_code)}</strong></td>
    <td class="num"><strong>${money(o.total, dec)}</strong></td></tr></tbody></table>`;
  node.append(t);

  const buttons = [{ label: 'Close', value: 'close', className: 'btn-ghost' }];
  if (o.status === 'approved') {
    if (CAN_APPROVE && !anyReceived) {
      buttons.push({ label: 'Cancel order', value: 'cancel', className: 'btn-danger' });
      buttons.push({ label: 'Back to draft', value: 'revert', className: '' });
    }
    if (CAN_APPROVE) buttons.push({ label: 'Close order', value: 'close_order', className: '' });
    if (CAN_DRAFT) buttons.push({ label: 'Receive goods', value: 'receive', className: 'btn-primary' });
  }
  const res = await ui.dialog({ title: `Purchase order ${o.po_no || ''}`, node, buttons, dismissValue: 'close', wide: true });
  if (res === 'receive') { location.href = `/pages/goods-received.html?order=${o.id}`; return; }
  const action = { cancel: 'cancel', revert: 'revert', close_order: 'close' }[res];
  if (!action) return;
  const ok = await ui.confirm({
    title: { cancel: 'Cancel order', revert: 'Back to draft', close: 'Close order' }[action],
    message: { cancel: 'Cancel this order? Nothing has been received.', revert: 'Move this order back to draft so it can be edited?',
      close: 'Close this order? Anything not yet received can no longer be received.' }[action],
    confirmText: 'Yes', danger: action === 'cancel',
  });
  if (!ok) return;
  const { error: e2 } = await supabase.rpc('set_purchase_order_status', { p_order: o.id, p_action: action });
  if (e2) return ui.errorFrom(e2);
  ui.updated('Purchase order');
  await refresh();
}

if (ctx) {
  document.getElementById('company-title').textContent = ctx.company.name;
  await refresh();
}