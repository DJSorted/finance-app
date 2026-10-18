import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { makeModal } from '../core/attachments.js';
import { findByScan, openScanner, isImageUrl, showItemPreview } from '../core/barcode.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const panel = document.getElementById('panel');

const CAN_SELL = ctx ? ['owner', 'admin', 'accountant', 'clerk'].includes(ctx.role) : false;
const KIND_LABEL = { cash: 'Cash', card: 'Card', eft: 'EFT', voucher: 'Voucher', other: 'Other' };
const REG_KEY = () => `pos-register-${ctx.companyId}`;

let registers = [];
let methods = [];
let items = [];
let itemMap = new Map();
let taxRates = new Map();
let customers = [];
let banks = [];
let register = null;
let shift = null;
let warehouse = null;
let balances = new Map();
let base = '';
let dec = 2;
let cart = [];
let customerId = '';
let custTax = new Map();
let term = '';
let sales = { count: 0, total: 0 };

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n).toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec });
const qtyFmt = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 4 });
const roundTo = (n, d) => { const f = 10 ** d; return Math.round((n + Number.EPSILON) * f) / f; };
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

/* ---------- data ---------- */

async function loadSetup() {
  const cid = ctx.companyId;
  const [r, m, tx, cu, c, bk, it] = await Promise.all([
    supabase.from('pos_registers').select('*').eq('company_id', cid).eq('is_active', true).order('code'),
    supabase.from('pos_payment_methods').select('*').eq('company_id', cid).eq('is_active', true).order('sort_order').order('code'),
    supabase.from('tax_codes').select('id, rate').eq('company_id', cid),
    supabase.from('company_currencies').select('code, currencies(decimals)').eq('company_id', cid).eq('is_base', true).maybeSingle(),
    supabase.from('customers').select('id, code, name').eq('company_id', cid).eq('is_active', true).order('code'),
    supabase.from('gl_accounts').select('id, code, name').eq('company_id', cid).eq('control_type', 'bank')
      .eq('is_posting', true).eq('is_active', true).order('code'),
    fetchAll(() => supabase.from('items')
      .select('id, code, name, description, barcode, link_url, item_type, sales_price, sales_price_currency, sales_tax_code_id, item_categories(is_sellable, sales_tax_code_id)')
      .eq('company_id', cid).eq('is_active', true).order('code').order('id')),
  ]);
  for (const x of [r, m, tx, cu, c, bk]) if (x.error) throw x.error;
  registers = r.data;
  methods = m.data;
  taxRates = new Map(tx.data.map((t) => [t.id, Number(t.rate)]));
  base = cu.data ? cu.data.code : '';
  dec = cu.data && cu.data.currencies ? cu.data.currencies.decimals : 2;
  customers = c.data;
  banks = bk.data;
  items = it.filter((i) => i.item_categories && i.item_categories.is_sellable && (!i.sales_price_currency || i.sales_price_currency === base));
  itemMap = new Map(items.map((i) => [i.id, i]));
}

async function loadRegister() {
  warehouse = null;
  shift = null;
  balances = new Map();
  cart = [];
  sales = { count: 0, total: 0 };
  term = '';
  if (!register) return;
  const [w, s, bal] = await Promise.all([
    supabase.from('warehouses').select('id, code, name, allow_negative_stock').eq('id', register.warehouse_id).single(),
    supabase.from('pos_shifts').select('*').eq('register_id', register.id).eq('status', 'open').maybeSingle(),
    fetchAll(() => supabase.from('stock_balances').select('item_id, qty_on_hand')
      .eq('company_id', ctx.companyId).eq('warehouse_id', register.warehouse_id).order('item_id')),
  ]);
  if (w.error) throw w.error;
  if (s.error) throw s.error;
  warehouse = w.data;
  shift = s.data;
  bal.forEach((b) => balances.set(b.item_id, Number(b.qty_on_hand)));
  customerId = register.customer_id;
  await ensureCustTax(customerId);
  if (shift) {
    const ps = await fetchAll(() => supabase.from('pos_sales').select('id, total').eq('shift_id', shift.id).order('id'));
    sales = { count: ps.length, total: ps.reduce((a, x) => a + Number(x.total), 0) };
  }
}

async function ensureCustTax(id) {
  if (!id || custTax.has(id)) return;
  const { data } = await supabase.rpc('customer_defaults', { p_customer: id });
  custTax.set(id, data && data[0] ? (data[0].tax_code_id || '') : '');
}

async function start() {
  try {
    await loadSetup();
    const saved = localStorage.getItem(REG_KEY());
    register = registers.find((x) => x.id === saved) || registers[0] || null;
    await loadRegister();
  } catch (e) { ui.errorFrom(e, 'Could not load the till.'); }
  render();
}

/* ---------- screen ---------- */

function render() {
  document.getElementById('company-title').textContent = ctx.company.name;
  toolbar.replaceChildren();
  if (!registers.length) {
    hint.textContent = '';
    panel.innerHTML = '<p class="muted">There are no registers yet. Set up payment methods and a register first (POS section of the menu).</p>';
    return;
  }
  if (registers.length > 1) {
    const sel = el('select', 'compact');
    registers.forEach((x) => option(sel, x.id, `${x.code} - ${x.name}`));
    sel.value = register.id;
    sel.addEventListener('change', async () => {
      if (cart.length && !(await ui.confirm({ title: 'Change register', message: 'The current cart will be cleared.', confirmText: 'Change' }))) { sel.value = register.id; return; }
      register = registers.find((x) => x.id === sel.value);
      try { localStorage.setItem(REG_KEY(), register.id); } catch (e) { /* ignore */ }
      try { await loadRegister(); } catch (e) { ui.errorFrom(e, 'Could not load the register.'); }
      render();
    });
    toolbar.append(sel);
  } else {
    toolbar.append(el('strong', '', `${register.code} - ${register.name}`));
  }
  if (shift) {
    toolbar.append(el('span', 'muted', `Shift ${shift.shift_no} · ${sales.count} sale(s) · ${money(sales.total)} ${base}`));
  }
  toolbar.append(el('span', 'spacer'));
  const link = el('a', 'btn', 'Shifts');
  link.href = '/pages/pos-shifts.html';
  toolbar.append(link);
  if (shift && CAN_REFUND) toolbar.append(btn('Refund', '', openRefund));
  if (shift && CAN_SELL) toolbar.append(btn('Close shift', '', closeShift));

  if (!CAN_SELL) { hint.textContent = ''; panel.innerHTML = '<p class="muted">Your role cannot use the till.</p>'; return; }
  if (!shift) { hint.textContent = ''; renderOpenShift(); return; }
  hint.textContent = `Selling from ${warehouse ? warehouse.code : ''} in ${base}. Prices are before tax; tax is added from each item. Each sale posts an invoice and a receipt per payment.`;
  renderSell();
}

async function renderOpenShift() {
  const { data } = await supabase.from('pos_shifts').select('float_kept').eq('register_id', register.id).eq('status', 'closed')
    .order('closed_at', { ascending: false }).limit(1);
  const last = data && data[0] && data[0].float_kept !== null ? Number(data[0].float_kept) : 0;
  panel.innerHTML = `<div style="max-width:420px"><h3>Open a shift on ${esc(register.name)}</h3>
    <p class="muted">Count the cash in the drawer and enter it as the opening float. It starts at what was left in the drawer at the last close.</p>
    <div class="field"><label for="pos-float">Opening float (${esc(base)})</label><input id="pos-float" type="number" step="any" min="0" value="${last}"></div>
    <button class="btn btn-primary" id="pos-open" type="button">Open shift</button></div>`;
  document.getElementById('pos-open').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try {
      const { error } = await supabase.rpc('pos_open_shift', {
        p_company: ctx.companyId, p_register: register.id, p_float: Number(document.getElementById('pos-float').value) || 0,
      });
      if (error) throw error;
      ui.success('Shift opened.');
      await loadRegister();
      render();
    } catch (err) { ui.errorFrom(err, 'Could not open the shift.'); e.currentTarget.disabled = false; }
  });
}

function renderSell() {
  panel.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:1rem">
    <div><div style="display:flex;gap:.5rem"><input id="pos-search" type="search" placeholder="Scan a barcode, or type an item code or name" autocomplete="off" style="flex:1;min-width:0">
      <button class="btn" id="pos-cam" type="button" title="Scan barcodes with the camera">Camera</button></div>
      <div id="pos-results" style="margin-top:.5rem"></div></div>
    <div><div id="pos-cust" style="margin-bottom:.5rem"></div><div id="pos-cart"></div>
      <div id="pos-totals" class="totals-bar"></div>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.5rem" id="pos-actions"></div></div></div>`;
  const acts = document.getElementById('pos-actions');
  acts.append(btn('Pay', 'btn-primary', openPay), btn('Customer', '', pickCustomer), btn('Clear cart', '', async () => {
    if (!cart.length) return;
    if (await ui.confirm({ title: 'Clear cart', message: 'Remove everything from this sale?', confirmText: 'Clear' })) { cart = []; renderCart(); }
  }));
  renderCust();
  renderResults();
  renderCart();
  document.getElementById('pos-search').focus();
}

function renderCust() {
  const c = customers.find((x) => x.id === customerId);
  const walk = customerId === register.customer_id;
  const box = document.getElementById('pos-cust');
  if (box) box.innerHTML = `<span class="muted">Customer:</span> <strong>${esc(c ? `${c.code} - ${c.name}` : '')}</strong>${walk ? '' : ' <span class="badge st-update">On account</span>'}`;
}

const matches = (i, q) => i.code.toLowerCase().includes(q) || i.name.toLowerCase().includes(q) || (i.barcode || '').toLowerCase().includes(q);

function renderResults() {
  const q = term.trim().toLowerCase();
  const list = (q ? items.filter((i) => matches(i, q)) : items).slice(0, q ? 40 : 24);
  const box = document.getElementById('pos-results');
  if (!box) return;
  if (!list.length) { box.innerHTML = '<p class="muted">No items match.</p>'; return; }
  const thumb = (i) => (isImageUrl(i.link_url)
    ? `<img src="${esc(i.link_url)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-preview="${i.id}" title="Preview" style="height:28px;width:28px;object-fit:cover;border-radius:4px;vertical-align:middle;margin-right:.4rem;cursor:zoom-in">`
    : (i.link_url ? `<button class="btn btn-sm btn-ghost" type="button" data-preview="${i.id}" title="Preview">🔗</button> ` : ''));
  box.innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr><th>Code</th><th>Item</th><th style="text-align:right">Price</th><th style="text-align:right">On hand</th></tr></thead><tbody>${
    list.map((i) => `<tr class="clickable" data-add="${i.id}"><td>${esc(i.code)}</td><td>${thumb(i)}${esc(i.name)}</td>
      <td class="num">${i.sales_price === null ? '' : money(i.sales_price)}</td>
      <td class="num">${i.item_type === 'service' ? '' : qtyFmt(balances.get(i.id) || 0)}</td></tr>`).join('')}</tbody></table></div>`;
}

function rateOf(it) {
  const id = it.sales_tax_code_id || (it.item_categories && it.item_categories.sales_tax_code_id) || custTax.get(customerId) || '';
  return id ? Number(taxRates.get(id) || 0) : 0;
}

function calc() {
  const rows = cart.map((l) => {
    const it = itemMap.get(l.id);
    const net = roundTo((Number(l.qty) || 0) * (Number(l.price) || 0), dec);
    const tax = roundTo(net * (it ? rateOf(it) : 0) / 100, dec);
    return { net, tax };
  });
  const net = rows.reduce((s, x) => s + x.net, 0);
  const tax = rows.reduce((s, x) => s + x.tax, 0);
  return { rows, net: roundTo(net, dec), tax: roundTo(tax, dec), total: roundTo(net + tax, dec) };
}

function renderCart() {
  const box = document.getElementById('pos-cart');
  if (!box) return;
  if (!cart.length) { box.innerHTML = '<p class="muted">The cart is empty. Click an item to add it.</p>'; renderTotals(); return; }
  box.innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr><th>Item</th><th>Qty</th><th>Price</th><th style="text-align:right">Total</th><th></th></tr></thead><tbody>${
    cart.map((l, i) => {
      const it = itemMap.get(l.id);
      return `<tr><td>${esc(it ? it.name : '')}</td>
        <td><input type="number" step="any" min="0" value="${l.qty}" data-qty="${i}" style="width:5.5rem"></td>
        <td><input type="number" step="any" min="0" value="${l.price}" data-price="${i}" style="width:6.5rem"></td>
        <td class="num" data-line="${i}"></td><td><button class="btn btn-sm btn-ghost" data-rm="${i}" type="button">✕</button></td></tr>`;
    }).join('')}</tbody></table></div>`;
  renderTotals();
}

function renderTotals() {
  const t = calc();
  document.querySelectorAll('[data-line]').forEach((c) => { const r = t.rows[Number(c.dataset.line)]; c.textContent = r ? money(r.net) : ''; });
  const box = document.getElementById('pos-totals');
  if (box) box.innerHTML = `<span>Net: ${money(t.net)}</span><span>Tax: ${money(t.tax)}</span><span class="ok" style="font-size:1.3rem">Total: ${money(t.total)} ${esc(base)}</span>`;
}

function addToCart(id) {
  const it = itemMap.get(id);
  if (!it) return;
  const line = cart.find((l) => l.id === id);
  if (line) line.qty = Number(line.qty) + 1;
  else cart.push({ id, qty: 1, price: it.sales_price === null ? '' : Number(it.sales_price) });
  renderCart();
}

// A scanned or typed code: adds the item and returns its name, or warns and returns ''
function addScanned(raw) {
  const it = findByScan(items, raw);
  if (it) { addToCart(it.id); return it.name; }
  ui.warn(`No item on sale has the barcode or code ${raw}.`);
  return '';
}

async function scanWithCamera() {
  await openScanner({
    title: 'Scan items', continuous: true,
    onCode: (code) => { const name = addScanned(code); return name ? `Added ${name}` : `Not found: ${code}`; },
  });
  const s = document.getElementById('pos-search');
  if (s) s.focus();
}

panel.addEventListener('click', (e) => {
  const pv = e.target.closest('[data-preview]');
  if (pv) {
    const it = itemMap.get(pv.dataset.preview);
    if (it) showItemPreview(it, { price: it.sales_price === null ? '' : `${money(it.sales_price)} ${base} before tax` });
    return;
  }
  if (e.target.closest('#pos-cam')) { scanWithCamera(); return; }
  const add = e.target.closest('[data-add]');
  if (add) { addToCart(add.dataset.add); const s = document.getElementById('pos-search'); if (s) s.focus(); return; }
  const rm = e.target.closest('[data-rm]');
  if (rm) { cart.splice(Number(rm.dataset.rm), 1); renderCart(); }
});
panel.addEventListener('input', (e) => {
  if (e.target.id === 'pos-search') { term = e.target.value; renderResults(); return; }
  if (e.target.dataset.qty !== undefined) { cart[Number(e.target.dataset.qty)].qty = e.target.value; renderTotals(); }
  if (e.target.dataset.price !== undefined) { cart[Number(e.target.dataset.price)].price = e.target.value; renderTotals(); }
});
panel.addEventListener('keydown', (e) => {
  if (e.target.id !== 'pos-search' || e.key !== 'Enter') return;
  e.preventDefault();
  const raw = e.target.value.trim();
  const q = raw.toLowerCase();
  if (!q) return;
  const partial = items.filter((i) => matches(i, q));
  const found = findByScan(items, raw) || (partial.length === 1 ? partial[0] : null);
  if (found) { addToCart(found.id); e.target.value = ''; term = ''; renderResults(); return; }
  if (!partial.length) { ui.warn(`No item on sale has the barcode or code ${raw}.`); e.target.select(); }
});

async function pickCustomer() {
  const saved = await ui.form({
    title: 'Customer for this sale', submitText: 'Use customer',
    fields: [{ name: 'customer', label: 'Customer', type: 'select', required: true, full: true,
      options: customers.map((c) => ({ value: c.id, label: `${c.code} - ${c.name}` })),
      hint: 'The walk-in customer must pay in full. For any other customer, whatever is not paid stays on their account.' }],
    values: { customer: customerId },
    onSubmit: async (v) => { customerId = v.customer; await ensureCustTax(customerId); },
  });
  if (saved) { renderCust(); renderTotals(); }
}

/* ---------- payment ---------- */

function cartProblem() {
  if (!cart.length) return 'The cart is empty.';
  for (let i = 0; i < cart.length; i++) {
    const l = cart[i];
    const it = itemMap.get(l.id);
    if (!(Number(l.qty) > 0)) return `${it.name}: enter a quantity above zero.`;
    if (l.price === '' || !(Number(l.price) >= 0)) return `${it.name}: enter a price.`;
  }
  if (warehouse && !warehouse.allow_negative_stock) {
    const need = new Map();
    cart.forEach((l) => { const it = itemMap.get(l.id); if (it.item_type !== 'service') need.set(l.id, (need.get(l.id) || 0) + Number(l.qty)); });
    for (const [id, q] of need) {
      const have = balances.get(id) || 0;
      if (q > have) return `Only ${qtyFmt(have)} of ${itemMap.get(id).code} in stock, ${qtyFmt(q)} in the cart.`;
    }
  }
  return '';
}

async function openPay() {
  const problem = cartProblem();
  if (problem) return ui.warn(problem);
  const t = calc();
  if (!(t.total > 0)) return ui.warn('The sale total must be above zero.');
  if (!methods.length) return ui.warn('There are no payment methods. Set them up first.');
  const walk = customerId === register.customer_id;
  const payments = [];
  let chosen = methods[0];

  const { box, close } = makeModal('Take payment', 'modal wide');
  const field = (text, input) => { const w = el('div', 'field'); w.append(el('label', '', text), input); return w; };
  const big = el('div');
  big.style.cssText = 'font-size:1.8rem;font-weight:700;margin-bottom:.5rem';
  const mrow = el('div');
  mrow.style.cssText = 'display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:.75rem';
  const amtIn = el('input'); amtIn.type = 'number'; amtIn.step = 'any'; amtIn.min = '0';
  const quick = el('div');
  quick.style.cssText = 'display:flex;gap:.4rem;flex-wrap:wrap;margin:.25rem 0 .5rem';
  const listEl = el('div');
  const sum = el('div', 'totals-bar');
  const addBtn = btn('Add payment', '', () => addPayment());
  const doneBtn = btn('Complete sale', 'btn-primary', () => complete());
  box.append(big, mrow, field('Amount tendered', amtIn), quick, addBtn, listEl, sum);
  const actions = el('div', 'modal-actions');
  actions.append(el('span', 'spacer'), btn('Back', 'btn-ghost', close), doneBtn);
  box.append(actions);

  const paidSoFar = () => roundTo(payments.reduce((s, p) => s + p.amount, 0), dec);
  const remaining = () => roundTo(t.total - paidSoFar(), dec);

  function methodButtons() {
    mrow.replaceChildren();
    methods.forEach((m) => {
      const b = btn(m.name, m.id === chosen.id ? 'btn-primary' : '', () => { chosen = m; methodButtons(); quickButtons(); amtIn.focus(); });
      mrow.append(b);
    });
  }
  function quickButtons() {
    quick.replaceChildren();
    const rem = remaining();
    if (rem <= 0) return;
    quick.append(btn(`Exact ${money(rem)}`, '', () => { amtIn.value = String(rem); }));
    if (chosen.kind === 'cash') {
      const seen = new Set([rem]);
      [10, 50, 100, 200].forEach((d) => {
        const v = Math.ceil(rem / d) * d;
        if (v > rem && !seen.has(v)) { seen.add(v); quick.append(btn(money(v), '', () => { amtIn.value = String(v); })); }
      });
    }
  }
  function refresh() {
    const rem = remaining();
    const change = roundTo(payments.reduce((s, p) => s + p.change, 0), dec);
    big.textContent = `${rem > 0 ? 'Due' : 'Paid'}: ${money(rem > 0 ? rem : t.total)} ${base}`;
    listEl.innerHTML = payments.length ? `<div class="table-wrap"><table class="grid"><tbody>${payments.map((p, i) => `<tr><td>${esc(p.name)}</td>
      <td class="num">${money(p.amount)}</td><td class="num">${p.change > 0 ? `tendered ${money(p.tendered)}` : ''}</td>
      <td><button class="btn btn-sm btn-ghost" data-del="${i}" type="button">✕</button></td></tr>`).join('')}</tbody></table></div>` : '';
    sum.innerHTML = `<span>Total: ${money(t.total)}</span><span>Paid: ${money(paidSoFar())}</span>`
      + `<span class="${rem > 0 ? 'bad' : 'ok'}">Remaining: ${money(Math.max(rem, 0))}</span>`
      + (change > 0 ? `<span class="ok" style="font-size:1.3rem">Change: ${money(change)}</span>` : '');
    doneBtn.disabled = walk ? rem > 0 : payments.length === 0 && false;
    amtIn.value = rem > 0 ? String(rem) : '';
    quickButtons();
  }
  listEl.addEventListener('click', (e) => {
    const d = e.target.closest('[data-del]');
    if (d) { payments.splice(Number(d.dataset.del), 1); refresh(); }
  });

  function addPayment() {
    const rem = remaining();
    if (rem <= 0) return ui.warn('Nothing is left to pay.');
    const tend = roundTo(Number(amtIn.value) || 0, dec);
    if (!(tend > 0)) return ui.warn('Enter the amount.');
    let applied;
    let change = 0;
    if (chosen.kind === 'cash') {
      applied = Math.min(tend, rem);
      change = roundTo(tend - applied, dec);
    } else {
      if (tend > rem + 0.00001) return ui.warn(`A ${KIND_LABEL[chosen.kind].toLowerCase()} payment cannot be more than what is still due (${money(rem)}).`);
      applied = tend;
    }
    payments.push({ method_id: chosen.id, name: chosen.name, kind: chosen.kind, amount: applied, tendered: chosen.kind === 'cash' ? tend : applied, change });
    refresh();
  }

  async function complete() {
    const rem = remaining();
    if (walk && rem > 0) return ui.warn('A walk-in sale must be paid in full. Add the payment, or choose a customer to leave the rest on account.');
    if (!walk && rem > 0) {
      const ok = await ui.confirm({ title: 'Leave on account', message: `${money(rem)} ${base} will stay on the customer's account. Continue?`, confirmText: 'Continue' });
      if (!ok) return;
    }
    doneBtn.disabled = true;
    try {
      const snap = { cart: cart.map((l) => ({ ...l })), totals: t, payments: payments.map((p) => ({ ...p })), customer: customers.find((c) => c.id === customerId) };
      const { data, error } = await supabase.rpc('pos_sell', {
        p_company: ctx.companyId, p_shift: shift.id, p_customer: walk ? null : customerId,
        p_lines: cart.map((l) => ({ item_id: l.id, quantity: Number(l.qty), unit_price: Number(l.price) })),
        p_payments: payments.map((p) => ({ method_id: p.method_id, amount: p.amount, tendered: p.tendered })), p_reference: null,
      });
      if (error) throw error;
      close();
      cart.forEach((l) => { const it = itemMap.get(l.id); if (it && it.item_type !== 'service') balances.set(l.id, (balances.get(l.id) || 0) - Number(l.qty)); });
      cart = [];
      sales = { count: sales.count + 1, total: sales.total + Number(data.total) };
      customerId = register.customer_id;
      await saleDone(data, snap);
      render();
    } catch (e) {
      ui.errorFrom(e, 'Could not complete the sale.');
      doneBtn.disabled = false;
    }
  }

  methodButtons();
  refresh();
  amtIn.focus();
}

async function saleDone(res, snap) {
  const node = el('div');
  node.innerHTML = `<p class="muted">${esc(res.doc_no)} · Total ${money(res.total)} ${esc(base)} · Paid ${money(res.paid)}</p>
    ${Number(res.change) > 0 ? `<div style="font-size:2rem;font-weight:700;margin:.5rem 0">Change: ${money(res.change)}</div>` : '<p>Sale complete.</p>'}`;
  const r = await ui.dialog({
    title: 'Sale complete', node, dismissValue: 'new',
    buttons: [{ label: 'Print slip', value: 'print', className: '' }, { label: 'New sale', value: 'new', className: 'btn-primary' }],
  });
  if (r === 'print') printSlip(res, snap);
}

function printSlip(res, snap) {
  const w = window.open('', '_blank', 'width=380,height=640');
  if (!w) return ui.warn('Allow pop-ups to print the slip.');
  const lines = snap.cart.map((l) => {
    const it = itemMap.get(l.id);
    return `<tr><td>${esc(it ? it.name : '')}<br>${qtyFmt(l.qty)} × ${money(l.price)}</td><td style="text-align:right">${money(roundTo(Number(l.qty) * Number(l.price), dec))}</td></tr>`;
  }).join('');
  const pays = snap.payments.map((p) => `<tr><td>${esc(p.name)}</td><td style="text-align:right">${money(p.tendered)}</td></tr>`).join('');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(res.doc_no)}</title>
    <style>body{font:13px/1.35 monospace;margin:12px;max-width:300px}table{width:100%;border-collapse:collapse}td{padding:2px 0;vertical-align:top}hr{border:0;border-top:1px dashed #000}h3{margin:0 0 4px}</style></head><body>
    <h3>${esc(ctx.company.name)}</h3><div>${esc(res.doc_no)} · ${new Date().toLocaleString()}</div>
    <div>${esc(register.name)}${snap.customer && customerLabelNotWalk(snap.customer) ? ` · ${esc(snap.customer.name)}` : ''}</div><hr>
    <table>${lines}</table><hr>
    <table><tr><td>Net</td><td style="text-align:right">${money(snap.totals.net)}</td></tr>
    <tr><td>Tax</td><td style="text-align:right">${money(snap.totals.tax)}</td></tr>
    <tr><td><b>Total (${esc(base)})</b></td><td style="text-align:right"><b>${money(snap.totals.total)}</b></td></tr></table><hr>
    <table>${pays}${Number(res.change) > 0 ? `<tr><td>Change</td><td style="text-align:right">${money(res.change)}</td></tr>` : ''}</table><hr>
    <div style="text-align:center">Thank you</div><script>window.onload=function(){window.print();}<\/script></body></html>`);
  w.document.close();
}
const customerLabelNotWalk = (c) => c.id !== register.customer_id;

/* ---------- close shift ---------- */

async function closeShift() {
  let pays;
  try { pays = await fetchAll(() => supabase.from('pos_payments').select('method_id, amount, tendered, change_given').eq('shift_id', shift.id).order('id')); }
  catch (e) { return ui.errorFrom(e, 'Could not load the shift payments.'); }
  const byMethod = new Map();
  pays.forEach((p) => {
    const x = byMethod.get(p.method_id) || { count: 0, amount: 0 };
    x.count += 1;
    x.amount += Number(p.amount);
    byMethod.set(p.method_id, x);
  });
  const allMethods = new Map(methods.map((m) => [m.id, m]));
  const hasCash = !!register.cash_method_id;
  let refunds = [];
  try { refunds = await fetchAll(() => supabase.from('pos_refund_payouts').select('method_id, amount').eq('shift_id', shift.id).order('id')); } catch (e) { /* treated as none */ }
  const refundTotal = refunds.reduce((a, x) => a + Number(x.amount), 0);
  const cashRefunds = hasCash ? refunds.filter((x) => x.method_id === register.cash_method_id).reduce((a, x) => a + Number(x.amount), 0) : 0;
  const cashTakings = hasCash ? (byMethod.get(register.cash_method_id) || { amount: 0 }).amount - cashRefunds : 0;
  const expected = roundTo(Number(shift.opening_float) + cashTakings, dec);

  const { box, close } = makeModal(`Close shift ${shift.shift_no}`, 'modal wide');
  const rows = [...byMethod.entries()].map(([id, x]) => `<tr><td>${esc((allMethods.get(id) || {}).name || 'Method')}</td><td class="num">${x.count}</td><td class="num">${money(x.amount)}</td></tr>`).join('');
  const total = [...byMethod.values()].reduce((s, x) => s + x.amount, 0);
  const sumEl = el('div');
  sumEl.innerHTML = `<p class="muted">${sales.count} sale(s) · ${money(sales.total)} ${esc(base)} sold</p>
    <div class="table-wrap"><table class="grid"><thead><tr><th>Payment method</th><th style="text-align:right">Payments</th><th style="text-align:right">Amount</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="3" class="muted">No payments taken.</td></tr>'}<tr class="row-root"><td>Total taken</td><td></td><td class="num">${money(total)}</td></tr>${refundTotal ? `<tr><td>Refunds paid out</td><td></td><td class="num">(${money(refundTotal)})</td></tr>` : ''}</tbody></table></div>`;
  box.append(sumEl);

  const field = (text, input) => { const w = el('div', 'field'); w.append(el('label', '', text), input); return w; };
  const countIn = el('input'); countIn.type = 'number'; countIn.step = 'any'; countIn.min = '0';
  const keepIn = el('input'); keepIn.type = 'number'; keepIn.step = 'any'; keepIn.min = '0'; keepIn.value = String(Number(shift.opening_float));
  const bankSel = el('select');
  option(bankSel, '', 'Select bank account');
  banks.forEach((b) => option(bankSel, b.id, `${b.code} - ${b.name}`));
  const notesIn = el('input');
  const result = el('div', 'totals-bar');

  if (hasCash) {
    const info = el('p', 'muted', `Opening float ${money(shift.opening_float)} + cash takings ${money(cashTakings)} = ${money(expected)} expected in the drawer.`);
    const grid = el('div', 'form-grid');
    grid.append(field('Cash counted in the drawer', countIn), field('Keep in the drawer for the next shift', keepIn), field('Bank the rest into', bankSel), field('Notes', notesIn));
    box.append(el('h4', '', 'Cash-up'), info, grid, result);
  } else {
    box.append(field('Notes', notesIn));
  }
  function recalc() {
    if (!hasCash) return;
    const counted = Number(countIn.value);
    if (countIn.value === '' || !(counted >= 0)) { result.innerHTML = ''; return; }
    const diff = roundTo(counted - expected, dec);
    const keep = Math.min(Number(keepIn.value) || 0, counted);
    result.innerHTML = `<span class="${diff === 0 ? 'ok' : 'bad'}">${diff === 0 ? 'Drawer agrees' : `${diff > 0 ? 'Over' : 'Short'} by ${money(Math.abs(diff))}`}</span>`
      + `<span>To bank: ${money(counted - keep)}</span>`;
  }
  [countIn, keepIn].forEach((x) => x.addEventListener('input', recalc));

  const actions = el('div', 'modal-actions');
  const go = btn('Close shift', 'btn-primary', async () => {
    try {
      let counted = null;
      let keep = null;
      if (hasCash) {
        if (countIn.value === '' || !(Number(countIn.value) >= 0)) throw new Error('Enter the cash counted in the drawer.');
        counted = Number(countIn.value);
        keep = Number(keepIn.value) || 0;
        if (keep > counted) throw new Error('The float kept cannot be more than the cash counted.');
        if (counted - keep > 0 && !bankSel.value) throw new Error('Choose the bank account for the cash being banked, or keep it all in the drawer.');
      }
      const diff = hasCash ? roundTo(counted - expected, dec) : 0;
      const ok = await ui.confirm({
        title: 'Close shift',
        message: hasCash
          ? `Close ${shift.shift_no}?\nExpected ${money(expected)}, counted ${money(counted)}${diff !== 0 ? ` (${diff > 0 ? 'over' : 'short'} ${money(Math.abs(diff))}, posted to cash over / short)` : ''}.\n${money(counted - keep)} is banked and ${money(keep)} stays in the drawer.`
          : `Close ${shift.shift_no}?`,
        confirmText: 'Close shift',
      });
      if (!ok) return;
      go.disabled = true;
      const { error } = await supabase.rpc('pos_close_shift', {
        p_company: ctx.companyId, p_shift: shift.id, p_counted: counted, p_keep: keep,
        p_bank: hasCash && counted - keep > 0 ? bankSel.value : null, p_notes: notesIn.value,
      });
      if (error) throw error;
      close();
      ui.success('Shift closed.');
      await loadRegister();
      render();
    } catch (e) { ui.errorFrom(e, 'Could not close the shift.'); go.disabled = false; }
  });
  actions.append(el('span', 'spacer'), btn('Cancel', 'btn-ghost', close), go);
  box.append(actions);
}

/* ---------- refunds ---------- */

const CAN_REFUND = ctx ? ['owner', 'admin', 'accountant'].includes(ctx.role) : false;

function pickSale() {
  return new Promise((resolve) => {
    const { box, close } = makeModal('Refund: choose the sale', 'modal wide');
    const search = el('input');
    search.type = 'search';
    search.placeholder = 'Invoice number (blank shows the latest sales)';
    search.style.width = '100%';
    const listEl = el('div');
    box.append(search, listEl);
    let sales2 = [];
    let docs = new Map();

    async function load(q) {
      listEl.innerHTML = '<p class="muted">Loading...</p>';
      let sl = [];
      if (q) {
        const d = await supabase.from('sales_documents').select('id').eq('company_id', ctx.companyId)
          .eq('doc_type', 'invoice').ilike('doc_no', `%${q}%`).limit(30);
        const ids = (d.data || []).map((x) => x.id);
        if (ids.length) sl = (await supabase.from('pos_sales').select('*').in('invoice_id', ids)).data || [];
      } else {
        sl = (await supabase.from('pos_sales').select('*').eq('company_id', ctx.companyId).order('created_at', { ascending: false }).limit(30)).data || [];
      }
      docs = new Map();
      const ids = [...new Set(sl.map((x) => x.invoice_id))];
      if (ids.length) (((await supabase.from('sales_documents').select('id, doc_no').in('id', ids)).data) || []).forEach((x) => docs.set(x.id, x.doc_no));
      sales2 = sl;
      if (!sl.length) { listEl.innerHTML = '<p class="muted">No POS sales found.</p>'; return; }
      listEl.innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr><th>Invoice</th><th>Time</th><th style="text-align:right">Total</th></tr></thead><tbody>${
        sl.map((x) => `<tr class="clickable" data-sale="${x.id}"><td>${esc(docs.get(x.invoice_id) || '')}</td>
          <td>${esc(String(x.created_at).slice(0, 16).replace('T', ' '))}</td><td class="num">${money(x.total)}</td></tr>`).join('')}</tbody></table></div>`;
    }
    listEl.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-sale]');
      if (!tr) return;
      const sale = sales2.find((x) => x.id === tr.dataset.sale);
      close();
      resolve({ ...sale, doc_no: docs.get(sale.invoice_id) });
    });
    let t;
    search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => load(search.value.trim()), 300); });
    const actions = el('div', 'modal-actions');
    actions.append(el('span', 'spacer'), btn('Cancel', 'btn-ghost', () => { close(); resolve(null); }));
    box.append(actions);
    load('');
  });
}

async function openRefund() {
  if (!CAN_REFUND) return;
  const sale = await pickSale();
  if (!sale) return;
  const [l, pays] = await Promise.all([
    supabase.from('sales_document_lines').select('*, items(code, name, item_type)').eq('document_id', sale.invoice_id).order('line_no'),
    supabase.from('pos_payments').select('method_id').eq('sale_id', sale.id),
  ]);
  if (l.error) return ui.errorFrom(l.error, 'Could not load the sale.');
  const rf = await supabase.from('pos_refund_lines').select('source_line_id, qty').in('source_line_id', l.data.map((x) => x.id));
  const refunded = new Map();
  (rf.data || []).forEach((x) => refunded.set(x.source_line_id, (refunded.get(x.source_line_id) || 0) + Number(x.qty)));
  const rows = l.data.filter((x) => x.item_id && x.items).map((x) => {
    const stock = x.items.item_type !== 'service';
    return { line: x, stock, left: roundTo(Number(x.quantity) - (stock ? Number(x.qty_credited) : (refunded.get(x.id) || 0)), 4) };
  }).filter((r) => r.left > 0);
  if (!rows.length) return ui.warn('Nothing on this sale can still be refunded.');
  const walkCust = (registers.find((r) => r.id === sale.register_id) || register).customer_id;
  const walk = sale.customer_id === walkCust;
  const usedMethod = pays.data && pays.data[0] ? pays.data[0].method_id : null;
  const defMethod = methods.find((m) => m.id === usedMethod) || methods.find((m) => m.kind === 'cash') || methods[0];

  const { box, close } = makeModal(`Refund ${sale.doc_no}`, 'modal xwide');
  const body = el('div');
  const tbl = el('div', 'table-wrap');
  tbl.innerHTML = '<table class="grid"><thead><tr><th></th><th>Item</th><th style="text-align:right">Sold</th><th style="text-align:right">Can refund</th><th>Quantity</th><th style="text-align:right">Price</th><th style="text-align:right">Refund</th></tr></thead><tbody></tbody></table>';
  const tb = tbl.querySelector('tbody');
  const lineRows = rows.map((r) => {
    const tr = el('tr');
    const cb = el('input'); cb.type = 'checkbox'; cb.style.width = 'auto';
    const qty = el('input'); qty.type = 'number'; qty.step = 'any'; qty.min = '0'; qty.max = String(r.left); qty.value = String(r.left); qty.disabled = true; qty.style.width = '6rem';
    const amt = el('td', 'num');
    const c0 = el('td'); c0.append(cb);
    const c4 = el('td'); c4.append(qty);
    tr.append(c0, el('td', '', `${r.line.items.name}`), el('td', 'num', qtyFmt(r.line.quantity)), el('td', 'num', qtyFmt(r.left)), c4,
      el('td', 'num', money(r.line.unit_price)), amt);
    tb.append(tr);
    cb.addEventListener('change', () => { qty.disabled = !cb.checked; recalc(); });
    qty.addEventListener('input', recalc);
    return { r, cb, qty, amt };
  });
  body.append(tbl);

  const reasonIn = el('input'); reasonIn.placeholder = 'Reason (optional)'; reasonIn.style.width = '100%';
  const totals = el('div', 'totals-bar');
  const payBox = el('div');
  const payRows = [];
  const mOptions = () => methods.map((m) => ({ value: m.id, label: `${m.name}` }));

  function refundTotal() {
    let net = 0;
    let tax = 0;
    lineRows.forEach((x) => {
      if (!x.cb.checked) { x.amt.textContent = ''; return; }
      const q = Number(x.qty.value) || 0;
      const n = roundTo(q * Number(x.r.line.unit_price), dec);
      const t = roundTo(n * (x.r.line.tax_code_id ? Number(taxRates.get(x.r.line.tax_code_id) || 0) : 0) / 100, dec);
      x.amt.textContent = money(n + t);
      net += n; tax += t;
    });
    return roundTo(net + tax, dec);
  }
  function paidOut() { return roundTo(payRows.reduce((s, p) => s + (Number(p.amt.value) || 0), 0), dec); }
  function recalc() {
    const total = refundTotal();
    if (payRows.length === 1 && !payRows[0].manual) payRows[0].amt.value = total > 0 ? String(total) : '';
    const po = paidOut();
    totals.innerHTML = `<span>Refund total: ${money(total)} ${esc(base)}</span><span>Paid out: ${money(po)}</span>`
      + (walk ? '' : `<span>Left as credit on the account: ${money(Math.max(total - po, 0))}</span>`);
  }
  function addPayRow() {
    const row = el('div', 'form-grid');
    const sel = el('select');
    mOptions().forEach((o) => option(sel, o.value, o.label));
    sel.value = payRows.length ? methods[0].id : defMethod.id;
    const amt = el('input'); amt.type = 'number'; amt.step = 'any'; amt.min = '0';
    const wrapSel = el('div', 'field'); wrapSel.append(el('label', '', 'Pay out by'), sel);
    const wrapAmt = el('div', 'field'); wrapAmt.append(el('label', '', 'Amount'), amt);
    row.append(wrapSel, wrapAmt);
    payBox.append(row);
    const pr = { sel, amt, manual: payRows.length > 0 };
    amt.addEventListener('input', () => { pr.manual = true; recalc(); });
    payRows.push(pr);
  }
  addPayRow();
  box.append(body, el('h4', '', 'Pay the customer back'), payBox, btn('Split across another method', '', () => { addPayRow(); recalc(); }),
    el('div', 'field', ''), reasonIn, totals);
  recalc();

  const actions = el('div', 'modal-actions');
  const go = btn('Refund', 'btn-primary', async () => {
    const chosen = lineRows.filter((x) => x.cb.checked);
    if (!chosen.length) return ui.warn('Tick the lines being returned.');
    for (const x of chosen) {
      const q = Number(x.qty.value) || 0;
      if (!(q > 0) || q > x.r.left + 0.00001) return ui.warn(`${x.r.line.items.name}: enter a quantity from 0 to ${qtyFmt(x.r.left)}.`);
    }
    const total = refundTotal();
    const po = paidOut();
    if (po > total + 0.00001) return ui.warn('The payouts are more than the refund total.');
    if (walk && Math.abs(po - total) > 0.00001) return ui.warn('A walk-in refund must be paid out in full.');
    const cashOut = payRows.filter((p) => (methods.find((m) => m.id === p.sel.value) || {}).kind === 'cash').reduce((s, p) => s + (Number(p.amt.value) || 0), 0);
    const ok = await ui.confirm({
      title: 'Refund',
      message: `Refund ${money(total)} ${base} against ${sale.doc_no}?\nStock lines go back into stock. ${money(po)} is paid out${cashOut ? `, ${money(cashOut)} of it in cash from the drawer` : ''}.`,
      confirmText: 'Refund', danger: true,
    });
    if (!ok) return;
    go.disabled = true;
    try {
      const { data, error } = await supabase.rpc('pos_refund', {
        p_company: ctx.companyId, p_shift: shift.id, p_sale: sale.id,
        p_lines: chosen.map((x) => ({ line_id: x.r.line.id, quantity: Number(x.qty.value) })),
        p_payouts: payRows.filter((p) => Number(p.amt.value) > 0).map((p) => ({ method_id: p.sel.value, amount: Number(p.amt.value) })),
        p_reason: reasonIn.value,
      });
      if (error) throw error;
      close();
      chosen.forEach((x) => { if (x.r.stock) balances.set(x.r.line.item_id, (balances.get(x.r.line.item_id) || 0) + Number(x.qty.value)); });
      renderResults();
      await ui.dialog({
        title: 'Refund complete',
        node: Object.assign(el('div'), { innerHTML: `<p>Credit note ${esc(data.doc_no)} · ${money(data.total)} ${esc(base)}</p>
          ${cashOut ? `<div style="font-size:2rem;font-weight:700;margin:.5rem 0">Hand back cash: ${money(cashOut)}</div>` : ''}` }),
        dismissValue: 'ok', buttons: [{ label: 'Done', value: 'ok', className: 'btn-primary' }],
      });
    } catch (e) { ui.errorFrom(e, 'Could not refund the sale.'); go.disabled = false; }
  });
  actions.append(el('span', 'spacer'), btn('Cancel', 'btn-ghost', close), go);
  box.append(actions);
}

if (ctx) await start();