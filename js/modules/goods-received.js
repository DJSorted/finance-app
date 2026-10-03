import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { exportSheets } from '../core/export.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const recon = document.getElementById('recon');
const panel = document.getElementById('panel');

const CAN_RECEIVE = ctx ? ['owner', 'admin', 'accountant', 'clerk'].includes(ctx.role) : false;
const CAN_RATE = ctx ? ctx.canEdit : false;

let receipts = [];
let suppliers = [];
let warehouses = [];
let items = [];
let openOrders = [];
let currencies = [];
let base = '';
let requirePo = false;
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
  const [g, s, w, it, po, st, cu, rc] = await Promise.all([
    supabase.from('goods_receipts').select('*, suppliers(code, name), warehouses(code, name), purchase_orders(po_no)')
      .eq('company_id', cid).order('receipt_date', { ascending: false }).order('posted_at', { ascending: false }).limit(300),
    supabase.from('suppliers').select('id, code, name').eq('company_id', cid).eq('is_active', true).order('code'),
    supabase.from('warehouses').select('id, code, name, is_default').eq('company_id', cid).eq('is_active', true).order('code'),
    supabase.from('items').select('id, code, name, units_of_measure(code), item_categories(is_purchasable)')
      .eq('company_id', cid).eq('is_active', true).in('item_type', ['stock', 'manufactured']).order('code'),
    supabase.from('purchase_orders').select('id, po_no, supplier_id, currency_code, warehouse_id, order_date')
      .eq('company_id', cid).eq('status', 'approved').order('order_date'),
    supabase.from('company_settings').select('require_po_for_receiving').eq('company_id', cid).maybeSingle(),
    supabase.from('company_currencies').select('code, is_base, currencies(decimals)').eq('company_id', cid).order('code'),
    supabase.rpc('grni_reconciliation', { p_company: cid }),
  ]);
  for (const r of [g, s, w, it, po, st, cu]) if (r.error) throw r.error;
  receipts = g.data;
  suppliers = s.data;
  warehouses = w.data;
  items = it.data.filter((x) => x.item_categories && x.item_categories.is_purchasable);
  openOrders = po.data;
  requirePo = !!(st.data && st.data.require_po_for_receiving);
  currencies = cu.data;
  base = (currencies.find((x) => x.is_base) || {}).code || '';
  renderRecon(rc);
}

async function refresh() {
  try { await load(); } catch (e) { ui.errorFrom(e, 'Could not load goods received.'); }
  render();
}

function renderRecon(rc) {
  if (rc.error) { recon.innerHTML = ''; return; }
  const r = rc.data[0];
  const diff = Number(r.difference);
  const ok = Math.abs(diff) < 0.005;
  recon.innerHTML = `<div class="card" style="display:flex;gap:1.5rem;flex-wrap:wrap;align-items:center">
    <span class="badge ${ok ? 'open' : 'st-error'}">${ok ? 'Goods received not invoiced reconciles to the ledger' : 'Does not reconcile'}</span>
    <span class="muted">Received, not yet billed ${money(r.subledger)} ${esc(base)}</span>
    <span class="muted">Ledger ${money(r.ledger)} ${esc(base)}</span>
    ${ok ? '' : `<span class="muted">Difference ${money(diff)}. A journal posted to a goods received not invoiced account with the control override explains this.</span>`}
  </div>`;
}

/* ---------- list ---------- */

const supName = (g) => (g.suppliers ? `${g.suppliers.code} - ${g.suppliers.name}` : '');

function render() {
  hint.textContent = requirePo
    ? 'Goods are received against approved purchase orders. Each receipt puts stock in at cost and posts to goods received not invoiced.'
    : 'Receive goods against an approved purchase order or directly. Each receipt puts stock in at cost and posts to goods received not invoiced, until the supplier bill is matched.';
  toolbar.replaceChildren();
  if (CAN_RECEIVE) toolbar.append(btn('New goods received note', 'btn-primary', () => openEditor(null)));
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
  return receipts.filter((g) => !needle
    || [g.grn_no, supName(g), g.supplier_ref, g.reference, g.receipt_date, g.purchase_orders && g.purchase_orders.po_no]
      .some((x) => String(x || '').toLowerCase().includes(needle)));
}

function renderTable() {
  if (!receipts.length) { panel.innerHTML = '<p class="muted">No goods received yet.</p>'; return; }
  const list = visible();
  if (!list.length) { panel.innerHTML = '<p class="muted">Nothing matches.</p>'; return; }
  const body = list.map((g) => `<tr class="clickable" data-id="${g.id}">
    <td>${esc(g.grn_no)}</td><td>${g.receipt_date}</td><td>${esc(supName(g))}</td><td>${esc(g.supplier_ref || '')}</td>
    <td>${esc(g.purchase_orders ? g.purchase_orders.po_no : 'Direct')}</td><td>${esc(g.warehouses ? g.warehouses.code : '')}</td>
    <td>${esc(g.currency_code)}</td><td class="num">${money(g.total_trx, decOf(g.currency_code))}</td>
    <td class="num">${money(g.total_base)}</td></tr>`).join('');
  panel.innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr>
    <th>No</th><th>Date</th><th>Supplier</th><th>Delivery note</th><th>Order</th><th>Warehouse</th><th>Cur</th>
    <th style="text-align:right">Value</th><th style="text-align:right">${esc(base)}</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

panel.addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  const g = receipts.find((x) => x.id === tr.dataset.id);
  if (g) openViewer(g);
});

async function doExport() {
  try {
    await exportSheets(`goods-received-${todayIso()}.xlsx`, [{
      name: 'Goods received',
      rows: visible().map((g) => ({
        no: g.grn_no, date: g.receipt_date, supplier: supName(g), note: g.supplier_ref || '',
        order: g.purchase_orders ? g.purchase_orders.po_no : 'Direct', warehouse: g.warehouses ? g.warehouses.code : '',
        currency: g.currency_code, rate: Number(g.fx_rate), value: Number(g.total_trx), base: Number(g.total_base),
      })),
      columns: [
        { key: 'no', header: 'No', width: 14 }, { key: 'date', header: 'Date', width: 12 }, { key: 'supplier', header: 'Supplier', width: 34 },
        { key: 'note', header: 'Delivery note', width: 18 }, { key: 'order', header: 'Order', width: 14 },
        { key: 'warehouse', header: 'Warehouse', width: 12 }, { key: 'currency', header: 'Currency', width: 10 },
        { key: 'rate', header: 'Rate', width: 14 }, { key: 'value', header: 'Value', width: 14 }, { key: 'base', header: `Value (${base})`, width: 16 },
      ],
    }]);
  } catch (e) { ui.errorFrom(e, 'Could not export.'); }
}

/* ---------- new goods received note ---------- */

async function openEditor(preOrderId) {
  if (!warehouses.length) return ui.warn('Add a warehouse first.');
  if (!suppliers.length) return ui.warn('Add a supplier first.');

  const prevFocus = document.activeElement;
  const backdrop = el('div', 'modal-backdrop');
  const box = el('div', 'modal xwide');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.append(el('h3', 'modal-title', 'New goods received note'));

  const field = (text, input, full) => {
    const w = el('div', `field${full ? ' full' : ''}`);
    w.append(el('label', '', text), input);
    return w;
  };
  const supSel = el('select');
  option(supSel, '', 'Select a supplier');
  suppliers.forEach((s) => option(supSel, s.id, `${s.code} - ${s.name}`));
  const poSel = el('select');
  const dateIn = el('input'); dateIn.type = 'date'; dateIn.value = todayIso();
  const whSel = el('select');
  warehouses.forEach((w) => option(whSel, w.id, `${w.code} - ${w.name}`));
  whSel.value = (warehouses.find((w) => w.is_default) || warehouses[0]).id;
  const curSel = el('select');
  currencies.forEach((c) => option(curSel, c.code, c.code + (c.is_base ? ' (base)' : '')));
  curSel.value = base;
  const srefIn = el('input');
  srefIn.placeholder = 'The number on the delivery note';
  const refIn = el('input');
  const rateIn = el('input'); rateIn.type = 'number'; rateIn.step = 'any';
  const notesIn = el('input');
  let rateManual = false;
  let mode = 'direct';

  const head = el('div', 'form-grid');
  head.append(field('Supplier *', supSel, true), field('Purchase order', poSel), field('Receipt date *', dateIn),
    field('Warehouse *', whSel), field('Currency', curSel), field('Supplier delivery note', srefIn), field('Our reference', refIn),
    field(CAN_RATE ? 'Exchange rate (override allowed)' : 'Exchange rate', rateIn), field('Notes', notesIn));
  box.append(head);

  const wrap = el('div', 'lines-wrap');
  const table = el('table', 'lines-table grn-lines');
  table.innerHTML = '<thead><tr><th class="c-gitem">Item</th><th class="c-gord">Ordered</th><th class="c-gout">Outstanding</th>'
    + '<th class="c-gqty">Receive</th><th class="c-gprice">Unit price</th><th class="c-gval">Value</th><th class="c-gdel"></th></tr></thead>';
  const tbody = el('tbody');
  table.append(tbody);
  wrap.append(table);
  box.append(wrap);

  const rows = [];
  const totals = el('div', 'totals-bar');
  const addLineBtn = btn('Add line', '', () => addDirectRow());
  box.append(addLineBtn, totals);

  const priceOf = (r) => (r.kind === 'po' ? r.priceNum : Number(r.price.value) || 0);
  function recalc() {
    const cur = curSel.value;
    const dec = decOf(cur);
    const rate = cur === base ? 1 : Number(rateIn.value);
    let total = 0;
    rows.forEach((r) => {
      const v = roundTo((Number(r.qty.value) || 0) * priceOf(r), dec);
      r.val.textContent = Number(r.qty.value) ? money(v, dec) : '';
      total += v;
    });
    let html = `<span class="ok">Value (${esc(cur)}): ${money(total, dec)}</span>`;
    if (cur !== base) {
      html += rate > 0 ? `<span>Stock value (${esc(base)}) at this rate: ${money(roundTo(total * rate, 2))}</span>`
        : '<span class="bad">No exchange rate available</span>';
    }
    totals.innerHTML = html;
  }

  function clearRows() { rows.length = 0; tbody.replaceChildren(); }
  function notice(text) {
    const tr = el('tr');
    const td = el('td', 'muted', text);
    td.colSpan = 7;
    tr.append(td);
    tbody.append(tr);
  }

  function addDirectRow() {
    const tr = el('tr');
    const itemSel = el('select');
    option(itemSel, '', 'Select item');
    items.forEach((i) => option(itemSel, i.id, `${i.code} - ${i.name}${i.units_of_measure ? ` (${i.units_of_measure.code})` : ''}`));
    const qty = el('input'); qty.type = 'number'; qty.step = 'any'; qty.min = '0';
    const price = el('input'); price.type = 'number'; price.step = 'any'; price.min = '0';
    const val = el('td', 'num');
    const del = el('button', 'btn btn-sm btn-ghost', '✕');
    del.type = 'button';
    del.title = 'Remove line';
    const c1 = el('td'); c1.append(itemSel);
    const c4 = el('td'); c4.append(qty);
    const c5 = el('td'); c5.append(price);
    const c7 = el('td'); c7.append(del);
    tr.append(c1, el('td'), el('td'), c4, c5, val, c7);
    tbody.append(tr);
    const row = { kind: 'direct', tr, itemSel, qty, price, val };
    [qty, price].forEach((x) => x.addEventListener('input', recalc));
    del.addEventListener('click', () => {
      if (rows.length === 1) return ui.warn('A receipt needs at least one line.');
      rows.splice(rows.indexOf(row), 1);
      tr.remove();
      recalc();
    });
    rows.push(row);
  }

  function addPoRow(l, uom) {
    const tr = el('tr');
    const outstanding = roundTo(Number(l.qty_ordered) - Number(l.qty_received), 4);
    const qty = el('input'); qty.type = 'number'; qty.step = 'any'; qty.min = '0'; qty.value = String(outstanding);
    qty.addEventListener('input', () => {
      if (Number(qty.value) > outstanding) qty.value = String(outstanding);
      recalc();
    });
    const val = el('td', 'num');
    const c4 = el('td'); c4.append(qty);
    const c1 = el('td', '', `${l.items.code} - ${l.items.name}${uom ? ` (${uom})` : ''}`);
    tr.append(c1, el('td', 'num', qtyFmt(l.qty_ordered)), el('td', 'num', qtyFmt(outstanding)), c4,
      el('td', 'num', money(l.unit_price, decOf(curSel.value))), val, el('td'));
    tbody.append(tr);
    rows.push({ kind: 'po', tr, qty, val, olId: l.id, priceNum: Number(l.unit_price) });
  }

  function poOptions() {
    poSel.replaceChildren();
    option(poSel, '', requirePo ? 'Select a purchase order' : 'No purchase order (direct receipt)');
    openOrders.filter((p) => p.supplier_id === supSel.value)
      .forEach((p) => option(poSel, p.id, `${p.po_no} · ${p.order_date} · ${p.currency_code}`));
  }

  async function syncRate() {
    const cur = curSel.value;
    if (cur === base) { rateIn.value = '1'; rateIn.disabled = true; rateManual = false; recalc(); return; }
    rateIn.disabled = !CAN_RATE;
    if (rateManual || !dateIn.value) return;
    const { data, error } = await supabase.rpc('resolve_fx_rate', {
      p_company: ctx.companyId, p_trx_type: 'stock_receipt', p_from: cur,
      p_doc_date: dateIn.value, p_trx_date: dateIn.value, p_posting_date: dateIn.value,
    });
    if (curSel.value !== cur) return;
    rateIn.value = error ? '' : String(Number(data[0].rate));
    rateIn.placeholder = error ? 'no rate available' : '';
    recalc();
  }

  async function onPo() {
    clearRows();
    if (!poSel.value) {
      mode = 'direct';
      curSel.disabled = false;
      addLineBtn.style.display = '';
      if (requirePo) { addLineBtn.style.display = 'none'; notice('Choose an approved purchase order to receive against.'); }
      else addDirectRow();
      rateManual = false;
      await syncRate();
      recalc();
      return;
    }
    mode = 'po';
    addLineBtn.style.display = 'none';
    const po = openOrders.find((p) => p.id === poSel.value);
    curSel.value = po.currency_code;
    curSel.disabled = true;
    whSel.value = po.warehouse_id;
    rateManual = false;
    const { data, error } = await supabase.from('purchase_order_lines')
      .select('*, items(code, name, units_of_measure(code))').eq('order_id', po.id).order('line_no');
    if (error) { ui.errorFrom(error, 'Could not load the order lines.'); return; }
    const pending = data.filter((l) => Number(l.qty_ordered) - Number(l.qty_received) > 0);
    if (!pending.length) notice('Everything on this order has been received.');
    pending.forEach((l) => addPoRow(l, l.items && l.items.units_of_measure ? l.items.units_of_measure.code : ''));
    await syncRate();
    recalc();
  }

  async function onSupplier() {
    poOptions();
    if (supSel.value) {
      const { data } = await supabase.rpc('supplier_defaults', { p_supplier: supSel.value });
      const d = data && data[0];
      if (d && currencies.some((c) => c.code === d.currency_code)) curSel.value = d.currency_code;
    }
    await onPo();
  }

  supSel.addEventListener('change', onSupplier);
  poSel.addEventListener('change', onPo);
  curSel.addEventListener('change', () => { rateManual = false; rateIn.value = ''; syncRate(); recalc(); });
  dateIn.addEventListener('change', syncRate);
  rateIn.addEventListener('input', () => { rateManual = true; recalc(); });

  poOptions();
  await onPo();

  /* ---- buttons ---- */
  const actions = el('div', 'modal-actions');
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const close = () => {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    if (prevFocus && prevFocus.focus) prevFocus.focus();
  };
  document.addEventListener('keydown', onKey);
  const postBtn = btn('Post goods received', 'btn-primary', () => {});
  actions.append(el('span', 'spacer'), btn('Cancel', 'btn-ghost', close), postBtn);
  box.append(actions);
  backdrop.append(box);
  document.body.append(backdrop);

  if (preOrderId) {
    const po = openOrders.find((p) => p.id === preOrderId);
    if (po) {
      supSel.value = po.supplier_id;
      poOptions();
      poSel.value = po.id;
      await onPo();
    }
  }

  function collect() {
    if (!supSel.value) throw new Error('Choose a supplier.');
    if (!dateIn.value) throw new Error('Enter the receipt date.');
    if (!whSel.value) throw new Error('Choose the warehouse.');
    if (requirePo && !poSel.value) throw new Error('Choose an approved purchase order.');
    const cur = curSel.value;
    if (cur !== base && !(Number(rateIn.value) > 0)) throw new Error('No exchange rate is available. Enter a company rate or type the rate.');
    const lines = [];
    rows.forEach((r) => {
      const q = Number(r.qty.value);
      if (r.kind === 'po') {
        if (q > 0) lines.push({ order_line_id: r.olId, qty: q });
        return;
      }
      if (!r.itemSel.value && !q && r.price.value === '') return;
      const n = lines.length + 1;
      if (!r.itemSel.value) throw new Error(`Line ${n}: choose an item.`);
      if (!(q > 0)) throw new Error(`Line ${n}: enter a quantity above zero.`);
      if (r.price.value === '' || Number(r.price.value) < 0) throw new Error(`Line ${n}: enter the unit price.`);
      lines.push({ item_id: r.itemSel.value, qty: q, unit_price: Number(r.price.value) });
    });
    if (!lines.length) throw new Error(mode === 'po' ? 'Enter a quantity on at least one line.' : 'Add at least one line.');
    return lines;
  }

  postBtn.addEventListener('click', async () => {
    let lines;
    try { lines = collect(); } catch (e) { return ui.warn(e.message); }
    const ok = await ui.confirm({
      title: 'Post goods received',
      message: `Receive ${lines.length} line(s) into stock?\nStock goes in at cost and posts to goods received not invoiced. This cannot be changed afterwards.`,
      confirmText: 'Post',
    });
    if (!ok) return;
    postBtn.disabled = true;
    try {
      const cur = curSel.value;
      const { error } = await supabase.rpc('post_goods_receipt', {
        p_company: ctx.companyId, p_supplier: supSel.value, p_date: dateIn.value, p_warehouse: whSel.value,
        p_currency: cur, p_supplier_ref: srefIn.value, p_order: poSel.value || null,
        p_reference: refIn.value, p_notes: notesIn.value,
        p_manual_rate: (cur !== base && rateManual && Number(rateIn.value) > 0) ? Number(rateIn.value) : null,
        p_lines: lines,
      });
      if (error) throw error;
      close();
      ui.success('Goods received posted.');
      if (location.search) history.replaceState(null, '', location.pathname);
      await refresh();
    } catch (e) {
      ui.errorFrom(e, 'Could not post the goods received note.');
    } finally {
      postBtn.disabled = false;
    }
  });
  supSel.focus();
}

/* ---------- viewer ---------- */

async function openViewer(g) {
  const [l, j] = await Promise.all([
    supabase.from('goods_receipt_lines').select('*, items(code, name)').eq('grn_id', g.id).order('line_no'),
    g.journal_id ? supabase.from('journals').select('journal_no').eq('id', g.journal_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  if (l.error) return ui.errorFrom(l.error, 'Could not load the lines.');
  const dec = decOf(g.currency_code);

  const node = el('div');
  const info = el('p', 'muted', [
    supName(g), `Received ${g.receipt_date} into ${g.warehouses ? `${g.warehouses.code} - ${g.warehouses.name}` : ''}`,
    `Order: ${g.purchase_orders ? g.purchase_orders.po_no : 'direct receipt'}${g.supplier_ref ? ` · Delivery note ${g.supplier_ref}` : ''}`,
    g.currency_code === base ? `Currency ${g.currency_code}` : `Currency ${g.currency_code} · Rate ${Number(g.fx_rate).toFixed(6)} to ${base}`,
    j.data && j.data.journal_no ? `Ledger journal ${j.data.journal_no}` : 'No ledger journal (nothing of value)',
  ].filter(Boolean).join('\n'));
  info.style.whiteSpace = 'pre-line';
  node.append(info);

  const body = l.data.map((x, i) => `<tr><td>${i + 1}</td><td>${esc(x.items ? `${x.items.code} - ${x.items.name}` : '')}</td>
    <td class="num">${qtyFmt(x.qty)}</td><td class="num">${money(x.unit_price, dec)}</td>
    <td class="num">${money(x.line_trx, dec)}</td><td class="num">${money(x.line_base)}</td>
    <td class="num">${qtyFmt(Number(x.qty) - Number(x.qty_billed))}</td></tr>`).join('');
  const t = el('div', 'table-wrap');
  t.innerHTML = `<table class="grid"><thead><tr><th>#</th><th>Item</th><th style="text-align:right">Quantity</th>
    <th style="text-align:right">Unit price</th><th style="text-align:right">Value ${esc(g.currency_code)}</th>
    <th style="text-align:right">${esc(base)}</th><th style="text-align:right">Not yet billed</th></tr></thead>
    <tbody>${body}<tr><td colspan="4"><strong>Total</strong></td><td class="num"><strong>${money(g.total_trx, dec)}</strong></td>
    <td class="num"><strong>${money(g.total_base)}</strong></td><td></td></tr></tbody></table>`;
  node.append(t);
  await ui.dialog({
    title: `Goods received ${g.grn_no}`, node, wide: true, dismissValue: 'close',
    buttons: [{ label: 'Close', value: 'close', className: 'btn-ghost' }],
  });
}

if (ctx) {
  document.getElementById('company-title').textContent = ctx.company.name;
  await refresh();
  const pre = new URLSearchParams(location.search).get('order');
  if (pre && CAN_RECEIVE) await openEditor(pre);
}