import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { exportSheets } from '../core/export.js';

const ctx = await startPage();

const TYPE = document.body.dataset.docType === 'credit_note' ? 'credit_note' : 'invoice';
const LABEL = TYPE === 'invoice' ? 'Invoice' : 'Credit note';
const TRX = TYPE === 'invoice' ? 'sales_invoice' : 'sales_credit_note';

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const panel = document.getElementById('panel');

const CAN_DRAFT = ctx ? ['owner', 'admin', 'accountant', 'clerk'].includes(ctx.role) : false;
const CAN_RATE = ctx ? ctx.canEdit : false;

let docs = [];
let customers = [];
let currencies = [];
let terms = [];
let taxes = [];
let items = [];
let itemMap = new Map();
let accounts = [];
let warehouses = [];
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
function calcDue(termsId, dateStr) {
  const t = terms.find((x) => x.id === termsId);
  if (!dateStr) return '';
  if (!t) return dateStr;
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (t.basis === 'days_from_month_end') d.setUTCMonth(d.getUTCMonth() + 1, 0);
  d.setUTCDate(d.getUTCDate() + t.days);
  return d.toISOString().slice(0, 10);
}

/* ---------- data ---------- */

async function load() {
  const cid = ctx.companyId;
  const [d, c, cu, t, tx, it, a, w] = await Promise.all([
    supabase.from('sales_documents').select('*, customers(code, name)').eq('company_id', cid).eq('doc_type', TYPE)
      .order('doc_date', { ascending: false }).order('created_at', { ascending: false }).limit(300),
    supabase.from('customers').select('id, code, name').eq('company_id', cid).eq('is_active', true).order('code'),
    supabase.from('company_currencies').select('code, is_base, currencies(decimals)').eq('company_id', cid).order('code'),
    supabase.from('payment_terms').select('id, code, name, basis, days').eq('company_id', cid).eq('is_active', true).order('code'),
    supabase.from('tax_codes').select('id, code, name, rate, applies_to').eq('company_id', cid).eq('is_active', true).order('code'),
    supabase.from('items').select('id, code, name, item_type, sales_price, sales_price_currency, sales_tax_code_id, item_categories(is_sellable, sales_tax_code_id)')
      .eq('company_id', cid).eq('is_active', true).order('code'),
    supabase.from('gl_accounts').select('id, code, name, account_groups(class_type)')
      .eq('company_id', cid).eq('is_posting', true).eq('is_active', true).is('control_type', null).order('code'),
    supabase.from('warehouses').select('id, code, name, is_default, allow_negative_stock')
      .eq('company_id', cid).eq('is_active', true).order('code'),
  ]);
  for (const r of [d, c, cu, t, tx, it, a, w]) if (r.error) throw r.error;
  docs = d.data;
  customers = c.data;
  currencies = cu.data;
  terms = t.data;
  taxes = tx.data.filter((x) => x.applies_to === 'sales' || x.applies_to === 'both');
  const sellable = it.data.filter((x) => x.item_categories && x.item_categories.is_sellable);
  itemMap = new Map(sellable.map((x) => [x.id, x]));
  items = TYPE === 'credit_note' ? sellable.filter((x) => x.item_type === 'service') : sellable;
  accounts = a.data.filter((x) => x.account_groups && x.account_groups.class_type === 'income_statement');
  warehouses = w.data;
  base = (currencies.find((x) => x.is_base) || {}).code || '';
}

async function refresh() {
  try { await load(); } catch (e) { ui.errorFrom(e, `Could not load ${LABEL.toLowerCase()}s.`); }
  render();
}

async function customerDefaults(id) {
  if (!id) return null;
  const { data, error } = await supabase.rpc('customer_defaults', { p_customer: id });
  return error || !data || !data.length ? null : data[0];
}

/* ---------- list ---------- */

function render() {
  hint.textContent = `${LABEL}s post to the ledger when you post them. Posted documents are locked`
    + (TYPE === 'invoice'
      ? ': correct them with a credit note. Stock items go out of the chosen warehouse at average cost.'
      : '. Stock items are credited from the original invoice line, and go back into stock at the cost they were sold at.');
  toolbar.replaceChildren();
  if (CAN_DRAFT) toolbar.append(btn(`New ${LABEL.toLowerCase()}`, 'btn-primary', () => openEditor(null)));
  const box = el('input');
  box.type = 'search';
  box.placeholder = 'Search';
  box.value = needle;
  box.style.maxWidth = '240px';
  box.addEventListener('input', () => { needle = box.value.trim().toLowerCase(); renderTable(); });
  const sel = el('select', 'compact');
  [['all', 'All'], ['draft', 'Drafts'], ['posted', 'Posted']].forEach(([v, l]) => option(sel, v, l));
  sel.value = statusFilter;
  sel.addEventListener('change', () => { statusFilter = sel.value; renderTable(); });
  toolbar.append(box, sel, el('span', 'spacer'), btn('Export to Excel', '', doExport));
  renderTable();
}

const custName = (d) => (d.customers ? `${d.customers.code} - ${d.customers.name}` : '');
function visible() {
  return docs.filter((d) => (statusFilter === 'all' || d.status === statusFilter)
    && (!needle || [d.doc_no, custName(d), d.reference, d.doc_date].some((x) => String(x || '').toLowerCase().includes(needle))));
}

function renderTable() {
  if (!docs.length) { panel.innerHTML = `<p class="muted">No ${LABEL.toLowerCase()}s yet.</p>`; return; }
  const list = visible();
  if (!list.length) { panel.innerHTML = '<p class="muted">Nothing matches.</p>'; return; }
  const body = list.map((d) => `<tr class="clickable" data-id="${d.id}">
    <td>${esc(d.doc_no || 'Draft')}</td><td>${d.doc_date}</td><td>${esc(custName(d))}</td><td>${esc(d.reference || '')}</td>
    <td>${esc(d.currency_code)}</td><td class="num">${money(d.gross_total, decOf(d.currency_code))}</td>
    <td><span class="badge ${d.status === 'posted' ? 'open' : ''}">${d.status === 'posted' ? 'Posted' : 'Draft'}</span></td></tr>`).join('');
  panel.innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr>
    <th>No</th><th>Date</th><th>Customer</th><th>Reference</th><th>Cur</th><th style="text-align:right">Total</th><th>Status</th>
    </tr></thead><tbody>${body}</tbody></table></div>`;
}

panel.addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  const d = docs.find((x) => x.id === tr.dataset.id);
  if (!d) return;
  if (d.status === 'draft') { if (CAN_DRAFT) openEditor(d); } else openViewer(d);
});

async function doExport() {
  try {
    await exportSheets(`${LABEL.toLowerCase().replace(' ', '-')}s-${todayIso()}.xlsx`, [{
      name: `${LABEL}s`,
      rows: visible().map((d) => ({
        no: d.doc_no || 'Draft', date: d.doc_date, due: d.due_date, customer: custName(d), reference: d.reference || '',
        currency: d.currency_code, net: Number(d.net_total), tax: Number(d.tax_total), total: Number(d.gross_total), status: d.status,
      })),
      columns: [
        { key: 'no', header: 'No', width: 14 }, { key: 'date', header: 'Date', width: 12 }, { key: 'due', header: 'Due', width: 12 },
        { key: 'customer', header: 'Customer', width: 34 }, { key: 'reference', header: 'Reference', width: 18 },
        { key: 'currency', header: 'Currency', width: 10 }, { key: 'net', header: 'Net', width: 14 },
        { key: 'tax', header: 'Tax', width: 14 }, { key: 'total', header: 'Total', width: 14 }, { key: 'status', header: 'Status', width: 10 },
      ],
    }]);
  } catch (e) { ui.errorFrom(e, 'Could not export.'); }
}

/* ---------- editor ---------- */

async function openEditor(existing) {
  let docId = existing ? existing.id : null;
  let seed = [];
  const srcInfo = new Map();
  if (existing) {
    const { data, error } = await supabase.from('sales_document_lines').select('*').eq('document_id', existing.id).order('line_no');
    if (error) return ui.errorFrom(error, 'Could not load the document lines.');
    const ids = data.map((l) => l.source_line_id).filter(Boolean);
    if (ids.length) {
      const s = await supabase.from('sales_document_lines')
        .select('id, quantity, qty_credited, unit_price, items(code, name), sales_documents(doc_no)').in('id', ids);
      if (s.error) return ui.errorFrom(s.error, 'Could not load the invoice lines.');
      s.data.forEach((x) => srcInfo.set(x.id, x));
    }
    seed = data.map((l) => ({
      item_id: l.item_id || '', description: l.description, quantity: Number(l.quantity), unit_price: Number(l.unit_price),
      tax_code_id: l.tax_code_id || '', account_id: l.account_id || '', source_line_id: l.source_line_id || '',
    }));
  }
  if (!seed.length) seed.push({});
  let custDef = existing ? await customerDefaults(existing.customer_id) : null;

  const bal = new Map();
  const bq = await supabase.from('stock_balances').select('item_id, warehouse_id, qty_on_hand').eq('company_id', ctx.companyId);
  if (!bq.error) bq.data.forEach((b) => bal.set(`${b.item_id}|${b.warehouse_id}`, Number(b.qty_on_hand)));

  const prevFocus = document.activeElement;
  const backdrop = el('div', 'modal-backdrop');
  const box = el('div', 'modal xwide');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.append(el('h3', 'modal-title', existing ? `Edit draft ${LABEL.toLowerCase()}` : `New ${LABEL.toLowerCase()}`));

  const field = (text, input, full) => {
    const w = el('div', `field${full ? ' full' : ''}`);
    w.append(el('label', '', text), input);
    return w;
  };
  const custSel = el('select');
  option(custSel, '', 'Select a customer');
  customers.forEach((c) => option(custSel, c.id, `${c.code} - ${c.name}`));
  custSel.value = existing ? existing.customer_id : '';
  const dateIn = el('input'); dateIn.type = 'date'; dateIn.value = existing ? existing.doc_date : todayIso();
  const curSel = el('select');
  currencies.forEach((c) => option(curSel, c.code, c.code + (c.is_base ? ' (base)' : '')));
  curSel.value = existing ? existing.currency_code : base;
  const termSel = el('select');
  option(termSel, '', 'Customer default');
  terms.forEach((t) => option(termSel, t.id, `${t.code} - ${t.name}`));
  termSel.value = existing ? (existing.payment_terms_id || '') : '';
  const dueIn = el('input'); dueIn.type = 'date'; dueIn.value = existing ? existing.due_date : '';
  const refIn = el('input'); refIn.value = existing ? (existing.reference || '') : '';
  const rateIn = el('input'); rateIn.type = 'number'; rateIn.step = 'any';
  const whSel = el('select');
  warehouses.forEach((w) => option(whSel, w.id, `${w.code} - ${w.name}`));
  whSel.value = existing && existing.warehouse_id ? existing.warehouse_id
    : ((warehouses.find((w) => w.is_default) || warehouses[0] || {}).id || '');
  const notesIn = el('input'); notesIn.value = existing ? (existing.notes || '') : '';

  let dueManual = !!existing;
  let rateManual = !!(existing && existing.manual_rate);
  if (rateManual) rateIn.value = String(Number(existing.manual_rate));

  const head = el('div', 'form-grid');
  head.append(field('Customer *', custSel, true), field('Date *', dateIn), field('Currency', curSel),
    field('Payment terms', termSel), field('Due date', dueIn), field('Reference', refIn),
    field(CAN_RATE ? 'Exchange rate (override allowed)' : 'Exchange rate', rateIn),
    field(TYPE === 'invoice' ? 'Warehouse (stock leaves from)' : 'Warehouse (stock returns to)', whSel),
    field('Notes', notesIn, true));
  box.append(head);

  const wrap = el('div', 'lines-wrap');
  const table = el('table', 'lines-table doc-lines');
  table.innerHTML = '<thead><tr><th class="c-item">Item</th><th class="c-desc">Description</th><th class="c-onh">On hand</th>'
    + '<th class="c-qty">Qty</th><th class="c-price">Price</th><th class="c-tax">Tax</th><th class="c-acc">Account</th>'
    + '<th class="c-net" style="text-align:right">Net</th><th class="c-del"></th></tr></thead>';
  const tbody = el('tbody');
  table.append(tbody);
  wrap.append(table);
  box.append(wrap);

  const rows = [];
  const totals = el('div', 'totals-bar');
  const taxRate = (id) => { const t = taxes.find((x) => x.id === id); return t ? Number(t.rate) : 0; };

  function recalc() {
    const dec = decOf(curSel.value);
    let net = 0;
    let tax = 0;
    rows.forEach((r) => {
      const n = roundTo((Number(r.qty.value) || 0) * (Number(r.price.value) || 0), dec);
      const t = roundTo(n * taxRate(r.taxSel.value) / 100, dec);
      r.netCell.textContent = money(n, dec);
      net += n;
      tax += t;
      if (r.src) r.onh.textContent = `max ${qtyFmt(r.maxQty)}`;
      else {
        const it = r.itemSel.value ? itemMap.get(r.itemSel.value) : null;
        r.onh.textContent = it && it.item_type !== 'service' ? qtyFmt(bal.get(`${it.id}|${whSel.value}`) || 0) : '';
      }
    });
    totals.innerHTML = `<span>Net: ${money(net, dec)}</span><span>Tax: ${money(tax, dec)}</span>`
      + `<span class="ok">Total (${esc(curSel.value)}): ${money(net + tax, dec)}</span>`;
  }

  async function syncRate() {
    const cur = curSel.value;
    if (cur === base) { rateIn.value = '1'; rateIn.disabled = true; rateManual = false; return; }
    rateIn.disabled = !CAN_RATE;
    if (rateManual || !dateIn.value) return;
    const { data, error } = await supabase.rpc('resolve_fx_rate', {
      p_company: ctx.companyId, p_trx_type: TRX, p_from: cur,
      p_doc_date: dateIn.value, p_trx_date: dateIn.value, p_posting_date: dateIn.value,
    });
    if (curSel.value !== cur) return;
    rateIn.value = error ? '' : String(Number(data[0].rate));
    rateIn.placeholder = error ? 'no rate available' : '';
  }

  function syncDue() {
    if (dueManual) return;
    const t = termSel.value || (custDef && custDef.payment_terms_id) || '';
    dueIn.value = calcDue(t, dateIn.value);
  }

  function addRow(s) {
    const info = s.source_line_id ? srcInfo.get(s.source_line_id) : null;
    const tr = el('tr');
    const itemSel = el('select');
    if (info) {
      option(itemSel, s.item_id, `${info.items.code} - ${info.items.name} (${info.sales_documents.doc_no})`);
      itemSel.disabled = true;
    } else {
      option(itemSel, '', 'Free text line');
      items.forEach((i) => option(itemSel, i.id, `${i.code} - ${i.name}${i.item_type === 'service' ? '' : ' (stock)'}`));
      itemSel.value = s.item_id || '';
    }
    const desc = el('input'); desc.value = s.description || '';
    const onh = el('td', 'onh');
    const maxQty = info ? roundTo(Number(info.quantity) - Number(info.qty_credited), 4) : null;
    const qty = el('input'); qty.type = 'number'; qty.step = 'any'; qty.min = '0'; qty.value = s.quantity ?? 1;
    if (info) qty.max = String(maxQty);
    const price = el('input'); price.type = 'number'; price.step = 'any'; price.min = '0'; price.value = s.unit_price ?? '';
    const taxSel = el('select');
    option(taxSel, '', 'No tax');
    taxes.forEach((t) => option(taxSel, t.id, `${t.code} (${Number(t.rate)}%)`));
    taxSel.value = s.tax_code_id || (existing || info ? '' : ((custDef && custDef.tax_code_id) || ''));
    const accSel = el('select');
    if (info) {
      option(accSel, '', 'Item category account');
      accSel.disabled = true;
    } else {
      option(accSel, '', '');
      accounts.forEach((a) => option(accSel, a.id, `${a.code} - ${a.name}`));
      accSel.value = s.account_id || '';
    }
    const netCell = el('td', 'num');
    const del = el('button', 'btn btn-sm btn-ghost', '✕');
    del.type = 'button';
    del.title = 'Remove line';

    const td = (x) => { const c = el('td'); c.append(x); return c; };
    const dtd = el('td');
    dtd.append(del);
    tr.append(td(itemSel), td(desc), onh, td(qty), td(price), td(taxSel), td(accSel), netCell, dtd);
    tbody.append(tr);

    const row = {
      tr, itemSel, desc, onh, qty, price, taxSel, accSel, netCell,
      src: info ? s.source_line_id : null, itemId: info ? s.item_id : null, maxQty,
    };
    const syncAcc = () => {
      if (info) return;
      accSel.options[0].text = itemSel.value ? 'Item category account' : 'Select account';
    };
    syncAcc();

    if (!info) {
      itemSel.addEventListener('change', () => {
        syncAcc();
        const it = itemMap.get(itemSel.value);
        if (it) {
          if (!desc.value.trim()) desc.value = it.name;
          const itemCur = it.sales_price_currency || base;
          if (it.sales_price !== null && itemCur === curSel.value) price.value = String(Number(it.sales_price));
          taxSel.value = it.sales_tax_code_id || (it.item_categories && it.item_categories.sales_tax_code_id)
            || (custDef && custDef.tax_code_id) || '';
          accSel.value = '';
        }
        recalc();
      });
    }
    qty.addEventListener('input', () => {
      if (info && Number(qty.value) > maxQty) qty.value = String(maxQty);
      recalc();
    });
    price.addEventListener('input', recalc);
    taxSel.addEventListener('change', recalc);
    del.addEventListener('click', () => {
      if (rows.length === 1) return ui.warn('A document needs at least one line.');
      rows.splice(rows.indexOf(row), 1);
      tr.remove();
      recalc();
    });
    rows.push(row);
  }

  seed.forEach(addRow);

  function dropLinked() {
    const stale = rows.filter((r) => r.src);
    if (!stale.length) return;
    stale.forEach((r) => { r.tr.remove(); rows.splice(rows.indexOf(r), 1); });
    if (!rows.length) addRow({});
    ui.warn('Lines credited from an invoice were removed because the customer or currency changed.');
  }

  async function pickInvoiceLines() {
    if (!custSel.value) return ui.warn('Choose a customer first.');
    const { data, error } = await supabase.rpc('sales_creditable_lines', { p_company: ctx.companyId, p_customer: custSel.value });
    if (error) return ui.errorFrom(error, 'Could not load the invoice lines.');
    const used = new Set(rows.filter((r) => r.src).map((r) => r.src));
    const list = data.filter((l) => l.currency_code === curSel.value && !used.has(l.line_id));
    if (!list.length) return ui.warn(`No stock lines on this customer's invoices in ${curSel.value} can still be credited.`);

    const node = el('div');
    const wrapT = el('div', 'table-wrap');
    const t = el('table', 'grid');
    t.innerHTML = '<thead><tr><th></th><th>Invoice</th><th>Date</th><th>Item</th>'
      + '<th style="text-align:right">Can credit</th><th style="text-align:right">Price</th></tr></thead>';
    const tb = el('tbody');
    const checks = [];
    list.forEach((l) => {
      const tr2 = el('tr');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.style.width = 'auto';
      const c0 = el('td');
      c0.append(cb);
      tr2.append(c0, el('td', '', l.doc_no), el('td', '', l.doc_date), el('td', '', `${l.item_code} - ${l.item_name}`),
        el('td', 'num', qtyFmt(l.qty_creditable)), el('td', 'num', money(l.unit_price, decOf(curSel.value))));
      tb.append(tr2);
      checks.push({ cb, l });
    });
    t.append(tb);
    wrapT.append(t);
    node.append(wrapT);
    const res = await ui.dialog({
      title: 'Credit from invoice', node, wide: true, dismissValue: 'close',
      buttons: [{ label: 'Cancel', value: 'close', className: 'btn-ghost' }, { label: 'Add selected', value: 'add', className: 'btn-primary' }],
    });
    if (res !== 'add') return;
    const chosen = checks.filter((c) => c.cb.checked).map((c) => c.l);
    if (!chosen.length) return;

    rows.filter((r) => !r.src && !r.itemSel.value && !r.accSel.value && !r.desc.value.trim() && r.price.value === '')
      .forEach((r) => { r.tr.remove(); rows.splice(rows.indexOf(r), 1); });
    chosen.forEach((l) => {
      srcInfo.set(l.line_id, {
        id: l.line_id, quantity: Number(l.qty_sold), qty_credited: Number(l.qty_sold) - Number(l.qty_creditable),
        unit_price: l.unit_price, items: { code: l.item_code, name: l.item_name }, sales_documents: { doc_no: l.doc_no },
      });
      addRow({
        source_line_id: l.line_id, item_id: l.item_id, description: l.description,
        quantity: Number(l.qty_creditable), unit_price: Number(l.unit_price), tax_code_id: l.tax_code_id || '',
      });
    });
    if (chosen[0].warehouse_id && warehouses.some((w) => w.id === chosen[0].warehouse_id)) whSel.value = chosen[0].warehouse_id;
    recalc();
  }

  custSel.addEventListener('change', async () => {
    dropLinked();
    custDef = await customerDefaults(custSel.value);
    if (!custDef) return;
    if (currencies.some((c) => c.code === custDef.currency_code)) curSel.value = custDef.currency_code;
    termSel.value = '';
    dueManual = false;
    rateManual = false;
    rows.forEach((r) => { if (!r.taxSel.value && !r.itemSel.value) r.taxSel.value = custDef.tax_code_id || ''; });
    await syncRate();
    syncDue();
    recalc();
  });
  curSel.addEventListener('change', () => { dropLinked(); rateManual = false; rateIn.value = ''; syncRate(); recalc(); });
  dateIn.addEventListener('change', () => { syncDue(); syncRate(); });
  termSel.addEventListener('change', () => { dueManual = false; syncDue(); });
  dueIn.addEventListener('input', () => { dueManual = true; });
  rateIn.addEventListener('input', () => { rateManual = true; });
  whSel.addEventListener('change', recalc);

  const lineButtons = el('div');
  lineButtons.style.cssText = 'display:flex;gap:.5rem;flex-wrap:wrap';
  lineButtons.append(btn('Add line', '', () => { addRow({}); recalc(); }));
  if (TYPE === 'credit_note') lineButtons.append(btn('Credit from invoice', '', pickInvoiceLines));
  box.append(lineButtons, totals);
  syncRate();
  if (!existing) syncDue();
  recalc();

  /* ---- buttons ---- */
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
      if (!(await ui.confirmDelete(LABEL))) return;
      const { error } = await supabase.rpc('delete_sales_draft', { p_doc: docId });
      if (error) return ui.errorFrom(error);
      close();
      ui.deleted(LABEL);
      await refresh();
    }));
  }
  actions.append(el('span', 'spacer'), btn('Cancel', 'btn-ghost', close));
  const saveBtn = btn('Save draft', '', () => {});
  const postBtn = btn('Post', 'btn-primary', () => {});
  actions.append(saveBtn, postBtn);
  box.append(actions);
  backdrop.append(box);
  document.body.append(backdrop);

  function collect() {
    if (!custSel.value) throw new Error('Choose a customer.');
    if (!dateIn.value) throw new Error('Enter the date.');
    const wh = warehouses.find((w) => w.id === whSel.value);
    const need = new Map();
    const lines = rows.map((r, i) => {
      const n = i + 1;
      if (!(Number(r.qty.value) > 0)) throw new Error(`Line ${n}: enter a quantity above zero.`);
      if (r.price.value === '' || Number(r.price.value) < 0) throw new Error(`Line ${n}: enter a price.`);
      if (r.src) {
        return {
          item_id: r.itemId, source_line_id: r.src, description: r.desc.value.trim(), quantity: Number(r.qty.value),
          unit_price: Number(r.price.value), tax_code_id: r.taxSel.value || null, account_id: null,
        };
      }
      if (!r.itemSel.value && !r.accSel.value) throw new Error(`Line ${n}: choose an item or an account.`);
      if (!r.itemSel.value && !r.desc.value.trim()) throw new Error(`Line ${n}: enter a description.`);
      const it = r.itemSel.value ? itemMap.get(r.itemSel.value) : null;
      if (it && it.item_type !== 'service') {
        if (TYPE === 'credit_note') throw new Error(`Line ${n}: credit stock items from the invoice (Credit from invoice).`);
        need.set(it.id, (need.get(it.id) || 0) + Number(r.qty.value));
      }
      return {
        item_id: r.itemSel.value || null, source_line_id: null, description: r.desc.value.trim(), quantity: Number(r.qty.value),
        unit_price: Number(r.price.value), tax_code_id: r.taxSel.value || null, account_id: r.accSel.value || null,
      };
    });
    const hasStock = need.size > 0 || lines.some((l) => l.source_line_id);
    if (hasStock && !wh) throw new Error('Choose the warehouse for the stock lines.');
    need.forEach((q, id) => {
      const have = bal.get(`${id}|${wh.id}`) || 0;
      if (q > have && !wh.allow_negative_stock) {
        throw new Error(`Only ${qtyFmt(have)} of ${itemMap.get(id).code} on hand in ${wh.code}, ${qtyFmt(q)} needed.`);
      }
    });
    return lines;
  }

  async function persist() {
    const p_lines = collect();
    const { data, error } = await supabase.rpc('save_sales_document', {
      p_company: ctx.companyId, p_doc: docId, p_type: TYPE, p_customer: custSel.value, p_date: dateIn.value,
      p_due: dueIn.value || null, p_terms: termSel.value || null, p_currency: curSel.value,
      p_reference: refIn.value, p_notes: notesIn.value,
      p_manual_rate: (curSel.value !== base && rateManual && Number(rateIn.value) > 0) ? Number(rateIn.value) : null,
      p_lines, p_warehouse: whSel.value || null,
    });
    if (error) throw error;
    docId = data;
    return data;
  }

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try { await persist(); close(); ui.saved(LABEL); await refresh(); }
    catch (e) { ui.errorFrom(e, `Could not save the ${LABEL.toLowerCase()}.`); }
    finally { saveBtn.disabled = false; }
  });

  postBtn.addEventListener('click', async () => {
    try { collect(); } catch (e) { return ui.warn(e.message); }
    const ok = await ui.confirm({
      title: `Post ${LABEL.toLowerCase()}`,
      message: `Post this ${LABEL.toLowerCase()}?\nIt will be numbered, posted to the ledger and locked. Stock lines move stock and post cost of sales.`,
      confirmText: 'Post',
    });
    if (!ok) return;
    postBtn.disabled = true;
    try {
      const id = await persist();
      const { error } = await supabase.rpc('post_sales_document', { p_doc: id });
      if (error) { await refresh(); throw new Error(`Saved as a draft, but it could not be posted: ${error.message}`); }
      close();
      ui.success(`${LABEL} posted.`);
      await refresh();
    } catch (e) { ui.errorFrom(e, `Could not post the ${LABEL.toLowerCase()}.`); }
    finally { postBtn.disabled = false; }
  });
  custSel.focus();
}

/* ---------- viewer (posted) ---------- */

async function openViewer(d) {
  const [l, j] = await Promise.all([
    supabase.from('sales_document_lines').select('*, items(code, item_type), gl_accounts(code, name)').eq('document_id', d.id).order('line_no'),
    d.journal_id ? supabase.from('journals').select('journal_no').eq('id', d.journal_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  if (l.error) return ui.errorFrom(l.error, 'Could not load the document lines.');
  const dec = decOf(d.currency_code);
  const wh = warehouses.find((w) => w.id === d.warehouse_id);
  const isStock = (x) => x.items && x.items.item_type !== 'service';
  const stockLines = l.data.filter(isStock);
  const cogs = stockLines.reduce((s, x) => s + Number(x.cogs_value), 0);
  const rate = d.currency_code === base ? 1 : Number(d.fx_rate);
  const stockNet = stockLines.reduce((s, x) => s + Number(x.net_amount) * rate, 0);

  const node = el('div');
  const info = el('p', 'muted',
    [`${custName(d)}`, `Date ${d.doc_date} · Due ${d.due_date}${d.reference ? ` · Ref ${d.reference}` : ''}`,
      d.currency_code === base ? `Currency ${d.currency_code}` : `Currency ${d.currency_code} · Rate ${Number(d.fx_rate).toFixed(6)} to ${base}`,
      wh ? `Warehouse ${wh.code} - ${wh.name}` : '',
      j.data && j.data.journal_no ? `Ledger journal ${j.data.journal_no}` : ''].filter(Boolean).join('\n'));
  info.style.whiteSpace = 'pre-line';
  node.append(info);

  const body = l.data.map((x, i) => `<tr><td>${i + 1}</td><td>${esc(x.items ? x.items.code : '')}</td><td>${esc(x.description)}</td>
    <td class="num">${money(x.quantity, 2)}</td><td class="num">${money(x.unit_price, dec)}</td>
    <td class="num">${Number(x.tax_rate)}%</td><td class="num">${money(x.net_amount, dec)}</td><td class="num">${money(x.tax_amount, dec)}</td>
    <td class="num">${isStock(x) ? money(x.cogs_value) : ''}</td></tr>`).join('');
  const wrapT = el('div', 'table-wrap');
  wrapT.innerHTML = `<table class="grid"><thead><tr><th>#</th><th>Item</th><th>Description</th>
    <th style="text-align:right">Qty</th><th style="text-align:right">Price</th><th style="text-align:right">Tax</th>
    <th style="text-align:right">Net</th><th style="text-align:right">Tax amount</th>
    <th style="text-align:right">Cost (${esc(base)})</th></tr></thead>
    <tbody>${body}
    <tr><td colspan="6"><strong>Total ${esc(d.currency_code)}</strong></td><td class="num"><strong>${money(d.net_total, dec)}</strong></td>
    <td class="num"><strong>${money(d.tax_total, dec)}</strong></td><td class="num"><strong>${cogs ? money(cogs) : ''}</strong></td></tr>
    <tr><td colspan="6"><strong>Amount ${TYPE === 'invoice' ? 'due' : 'credited'}</strong></td><td colspan="3" class="num"><strong>${money(d.gross_total, dec)}</strong></td></tr>
    </tbody></table>`;
  node.append(wrapT);
  if (stockLines.length) {
    const m = el('p', 'muted', TYPE === 'invoice'
      ? `Stock lines: sales ${money(stockNet)} ${base}, cost of sales ${money(cogs)}, margin ${money(stockNet - cogs)}.`
      : `Cost returned to stock: ${money(cogs)} ${base}.`);
    node.append(m);
  }
  await ui.dialog({
    title: `${LABEL} ${d.doc_no}`, node, wide: true, dismissValue: 'close',
    buttons: [{ label: 'Close', value: 'close', className: 'btn-ghost' }],
  });
}

if (ctx) {
  document.getElementById('company-title').textContent = ctx.company.name;
  await refresh();
}