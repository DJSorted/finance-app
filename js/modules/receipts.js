import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { exportSheets } from '../core/export.js';
import { createAllocationGrid } from '../core/allocation-grid.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const panel = document.getElementById('panel');

const CAN_ADD = ctx ? ['owner', 'admin', 'accountant', 'clerk'].includes(ctx.role) : false;
const CAN_RATE = ctx ? ctx.canEdit : false;

let receipts = [];
let customers = [];
let currencies = [];
let banks = [];
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
  const [r, c, cu, b] = await Promise.all([
    supabase.from('customer_receipts').select('*, customers(code, name)').eq('company_id', cid)
      .order('receipt_date', { ascending: false }).order('posted_at', { ascending: false }).limit(300),
    supabase.from('customers').select('id, code, name').eq('company_id', cid).eq('is_active', true).order('code'),
    supabase.from('company_currencies').select('code, is_base, currencies(decimals)').eq('company_id', cid).order('code'),
    supabase.from('gl_accounts').select('id, code, name, currency_code').eq('company_id', cid)
      .eq('control_type', 'bank').eq('is_posting', true).eq('is_active', true).order('code'),
  ]);
  for (const x of [r, c, cu, b]) if (x.error) throw x.error;
  receipts = r.data;
  customers = c.data;
  currencies = cu.data;
  banks = b.data;
  base = (currencies.find((x) => x.is_base) || {}).code || '';
}

async function refresh() {
  try { await load(); } catch (e) { ui.errorFrom(e, 'Could not load receipts.'); }
  render();
}

/* ---------- list ---------- */

const custName = (r) => (r.customers ? `${r.customers.code} - ${r.customers.name}` : '');

function render() {
  hint.textContent = 'A receipt posts to the ledger as soon as you record it. Allocated invoices are cleared at their own rate, and any exchange difference goes to the exchange gains / losses account.';
  toolbar.replaceChildren();
  if (CAN_ADD) toolbar.append(btn('New receipt', 'btn-primary', openEditor));
  const box = el('input');
  box.type = 'search';
  box.placeholder = 'Search';
  box.value = needle;
  box.style.maxWidth = '240px';
  box.addEventListener('input', () => { needle = box.value.trim().toLowerCase(); renderTable(); });
  const sel = el('select', 'compact');
  [['all', 'All'], ['posted', 'Posted'], ['reversed', 'Reversed']].forEach(([v, l]) => option(sel, v, l));
  sel.value = statusFilter;
  sel.addEventListener('change', () => { statusFilter = sel.value; renderTable(); });
  toolbar.append(box, sel, el('span', 'spacer'), btn('Export to Excel', '', doExport));
  renderTable();
}

function visible() {
  return receipts.filter((r) => (statusFilter === 'all' || r.status === statusFilter)
    && (!needle || [r.receipt_no, custName(r), r.reference, r.receipt_date].some((x) => String(x || '').toLowerCase().includes(needle))));
}

function renderTable() {
  if (!receipts.length) { panel.innerHTML = '<p class="muted">No receipts yet.</p>'; return; }
  const list = visible();
  if (!list.length) { panel.innerHTML = '<p class="muted">Nothing matches.</p>'; return; }
  const body = list.map((r) => {
    const d = decOf(r.currency_code);
    return `<tr class="clickable" data-id="${r.id}">
      <td>${esc(r.receipt_no)}</td><td>${r.receipt_date}</td><td>${esc(custName(r))}</td><td>${esc(r.reference || '')}</td>
      <td>${esc(r.currency_code)}</td><td class="num">${money(r.amount, d)}</td>
      <td class="num">${money(Number(r.amount) - Number(r.allocated_amount), d)}</td>
      <td><span class="badge ${r.status === 'posted' ? 'open' : ''}">${r.status === 'posted' ? 'Posted' : 'Reversed'}</span></td></tr>`;
  }).join('');
  panel.innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr>
    <th>No</th><th>Date</th><th>Customer</th><th>Reference</th><th>Cur</th><th style="text-align:right">Amount</th>
    <th style="text-align:right">On account</th><th>Status</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

panel.addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  const r = receipts.find((x) => x.id === tr.dataset.id);
  if (r) openViewer(r);
});

async function doExport() {
  try {
    await exportSheets(`receipts-${todayIso()}.xlsx`, [{
      name: 'Receipts',
      rows: visible().map((r) => ({
        no: r.receipt_no, date: r.receipt_date, customer: custName(r), reference: r.reference || '', currency: r.currency_code,
        rate: Number(r.fx_rate), amount: Number(r.amount), allocated: Number(r.allocated_amount),
        onAccount: Number(r.amount) - Number(r.allocated_amount), status: r.status,
      })),
      columns: [
        { key: 'no', header: 'No', width: 14 }, { key: 'date', header: 'Date', width: 12 },
        { key: 'customer', header: 'Customer', width: 34 }, { key: 'reference', header: 'Reference', width: 18 },
        { key: 'currency', header: 'Currency', width: 10 }, { key: 'rate', header: 'Rate', width: 14 },
        { key: 'amount', header: 'Amount', width: 14 }, { key: 'allocated', header: 'Allocated', width: 14 },
        { key: 'onAccount', header: 'On account', width: 14 }, { key: 'status', header: 'Status', width: 10 },
      ],
    }]);
  } catch (e) { ui.errorFrom(e, 'Could not export.'); }
}

/* ---------- new receipt ---------- */

async function openEditor() {
  if (!banks.length) return ui.warn('Create a bank account first: a posting account with control type Bank in the Chart of Accounts.');
  const prevFocus = document.activeElement;
  const backdrop = el('div', 'modal-backdrop');
  const box = el('div', 'modal xwide');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.append(el('h3', 'modal-title', 'New receipt'));

  const field = (text, input, full) => {
    const w = el('div', `field${full ? ' full' : ''}`);
    w.append(el('label', '', text), input);
    return w;
  };
  const custSel = el('select');
  option(custSel, '', 'Select a customer');
  customers.forEach((c) => option(custSel, c.id, `${c.code} - ${c.name}`));
  const dateIn = el('input'); dateIn.type = 'date'; dateIn.value = todayIso();
  const curSel = el('select');
  currencies.forEach((c) => option(curSel, c.code, c.code + (c.is_base ? ' (base)' : '')));
  curSel.value = base;
  const amtIn = el('input'); amtIn.type = 'number'; amtIn.step = 'any'; amtIn.min = '0';
  const bankSel = el('select');
  const refIn = el('input');
  const rateIn = el('input'); rateIn.type = 'number'; rateIn.step = 'any';
  const notesIn = el('input');
  let rateManual = false;

  const head = el('div', 'form-grid');
  head.append(field('Customer *', custSel, true), field('Receipt date *', dateIn), field('Currency', curSel),
    field('Amount received *', amtIn), field('Bank account *', bankSel),
    field('Reference', refIn), field(CAN_RATE ? 'Exchange rate (override allowed)' : 'Exchange rate', rateIn),
    field('Notes', notesIn));
  box.append(head);

  const grid = createAllocationGrid({ onChange: () => recalc() });
  const gridTitle = el('h4', '', 'Apply to invoices');
  gridTitle.style.margin = '1rem 0 .25rem';
  const gridNote = el('p', 'muted', 'Only open invoices in the receipt currency are listed. Whatever you do not allocate stays on the customer\'s account.');
  const totals = el('div', 'totals-bar');
  box.append(gridTitle, gridNote, grid.node, totals);

  let allItems = [];

  function fillBanks() {
    const cur = curSel.value;
    const keep = bankSel.value;
    bankSel.replaceChildren();
    option(bankSel, '', 'Select bank account');
    const ok = banks.filter((b) => !b.currency_code || b.currency_code === cur);
    ok.forEach((b) => option(bankSel, b.id, `${b.code} - ${b.name}${b.currency_code ? ` (${b.currency_code})` : ''}`));
    bankSel.value = ok.some((b) => b.id === keep) ? keep : '';
    if (!bankSel.value && ok.length === 1) bankSel.value = ok[0].id;
  }

  function applyItems() {
    const cur = curSel.value;
    const list = allItems
      .filter((i) => i.currency_code === cur && (!dateIn.value || i.doc_date <= dateIn.value))
      .map((i) => ({
        id: i.doc_id, doc_no: i.doc_no, doc_date: i.doc_date, due_date: i.due_date,
        outstanding: Number(i.outstanding), fx_rate: Number(i.fx_rate),
      }));
    grid.setItems(list, decOf(cur));
    recalc();
  }

  async function loadItems() {
    allItems = [];
    if (custSel.value) {
      const { data, error } = await supabase.rpc('sales_open_items', {
        p_company: ctx.companyId, p_customer: custSel.value, p_as_of: todayIso(),
      });
      if (error) ui.errorFrom(error, 'Could not load the open invoices.');
      else allItems = data.filter((i) => i.doc_kind === 'invoice' && Number(i.outstanding) > 0);
    }
    applyItems();
  }

  async function syncRate() {
    const cur = curSel.value;
    if (cur === base) { rateIn.value = '1'; rateIn.disabled = true; rateManual = false; recalc(); return; }
    rateIn.disabled = !CAN_RATE;
    if (rateManual || !dateIn.value) return;
    const { data, error } = await supabase.rpc('resolve_fx_rate', {
      p_company: ctx.companyId, p_trx_type: 'customer_receipt', p_from: cur,
      p_doc_date: dateIn.value, p_trx_date: dateIn.value, p_posting_date: dateIn.value,
    });
    if (curSel.value !== cur) return;
    rateIn.value = error ? '' : String(Number(data[0].rate));
    rateIn.placeholder = error ? 'no rate available' : '';
    recalc();
  }

  function recalc() {
    const cur = curSel.value;
    const dec = decOf(cur);
    const total = roundTo(Number(amtIn.value) || 0, dec);
    grid.setTotal(total);
    const allocs = grid.detailed();
    const allocated = roundTo(allocs.reduce((s, x) => s + x.amount, 0), dec);
    const left = roundTo(total - allocated, dec);
    const rate = cur === base ? 1 : Number(rateIn.value);
    let html = `<span>Receipt: ${money(total, dec)} ${esc(cur)}</span><span>Allocated: ${money(allocated, dec)}</span>`
      + `<span class="${left < 0 ? 'bad' : 'ok'}">On account: ${money(left, dec)}</span>`;
    if (cur !== base && rate > 0 && allocs.length) {
      const fx = allocs.reduce((s, x) => s + x.amount * (rate - x.item.fx_rate), 0);
      html += `<span>Estimated exchange ${fx >= 0 ? 'gain' : 'loss'}: ${money(Math.abs(fx), 2)} ${esc(base)}</span>`;
    }
    totals.innerHTML = html;
  }

  custSel.addEventListener('change', async () => {
    if (custSel.value) {
      const { data } = await supabase.rpc('customer_defaults', { p_customer: custSel.value });
      const d = data && data[0];
      if (d && currencies.some((c) => c.code === d.currency_code)) curSel.value = d.currency_code;
    }
    rateManual = false;
    rateIn.value = '';
    fillBanks();
    await syncRate();
    await loadItems();
  });
  curSel.addEventListener('change', () => { rateManual = false; rateIn.value = ''; fillBanks(); syncRate(); applyItems(); });
  dateIn.addEventListener('change', () => { syncRate(); applyItems(); });
  amtIn.addEventListener('input', recalc);
  rateIn.addEventListener('input', () => { rateManual = true; recalc(); });

  fillBanks();
  syncRate();
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
  const postBtn = btn('Post receipt', 'btn-primary', () => {});
  actions.append(el('span', 'spacer'), btn('Cancel', 'btn-ghost', close), postBtn);
  box.append(actions);
  backdrop.append(box);
  document.body.append(backdrop);

  postBtn.addEventListener('click', async () => {
    const cur = curSel.value;
    const dec = decOf(cur);
    const amount = roundTo(Number(amtIn.value) || 0, dec);
    if (!custSel.value) return ui.warn('Choose a customer.');
    if (!dateIn.value) return ui.warn('Enter the receipt date.');
    if (!(amount > 0)) return ui.warn('Enter the amount received.');
    if (!bankSel.value) return ui.warn('Choose a bank account.');
    if (cur !== base && !(Number(rateIn.value) > 0)) return ui.warn('No exchange rate is available. Enter a company rate or type the rate.');
    const allocs = grid.allocations();
    const allocated = roundTo(allocs.reduce((s, x) => s + x.amount, 0), dec);
    if (allocated > amount) return ui.warn('The allocated amount is more than the receipt amount.');

    const cust = customers.find((c) => c.id === custSel.value);
    const ok = await ui.confirm({
      title: 'Post receipt',
      message: `Post a receipt of ${money(amount, dec)} ${cur} from ${cust ? cust.name : 'the customer'}?\n`
        + `${money(allocated, dec)} is allocated to invoices and ${money(amount - allocated, dec)} stays on account.`,
      confirmText: 'Post',
    });
    if (!ok) return;
    postBtn.disabled = true;
    try {
      const { error } = await supabase.rpc('post_customer_receipt', {
        p_company: ctx.companyId, p_customer: custSel.value, p_date: dateIn.value, p_currency: cur,
        p_amount: amount, p_bank: bankSel.value, p_reference: refIn.value, p_notes: notesIn.value,
        p_manual_rate: (cur !== base && rateManual && Number(rateIn.value) > 0) ? Number(rateIn.value) : null,
        p_allocs: allocs,
      });
      if (error) throw error;
      close();
      ui.success('Receipt posted.');
      await refresh();
    } catch (e) {
      ui.errorFrom(e, 'Could not post the receipt.');
    } finally {
      postBtn.disabled = false;
    }
  });
  custSel.focus();
}

/* ---------- viewer ---------- */

async function openViewer(r) {
  const [al, j] = await Promise.all([
    supabase.from('sales_allocations').select('*, sales_documents(doc_no)').eq('receipt_id', r.id).order('created_at'),
    r.journal_id ? supabase.from('journals').select('journal_no').eq('id', r.journal_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  if (al.error) return ui.errorFrom(al.error, 'Could not load the allocations.');
  const dec = decOf(r.currency_code);
  const bank = banks.find((b) => b.id === r.bank_account_id);

  const node = el('div');
  const info = el('p', 'muted', [
    custName(r),
    `Date ${r.receipt_date} · ${r.currency_code}${r.currency_code === base ? '' : ` · Rate ${Number(r.fx_rate).toFixed(6)} to ${base}`}`,
    `Bank ${bank ? `${bank.code} - ${bank.name}` : ''}${r.reference ? ` · Ref ${r.reference}` : ''}`,
    j.data && j.data.journal_no ? `Ledger journal ${j.data.journal_no}` : '',
    r.status === 'reversed' ? `Reversed on ${r.reversed_on}` : '',
  ].filter(Boolean).join('\n'));
  info.style.whiteSpace = 'pre-line';
  node.append(info);

  let fxTotal = 0;
  const body = al.data.map((a) => {
    fxTotal += Number(a.fx_difference);
    return `<tr><td>${esc(a.sales_documents ? a.sales_documents.doc_no : '')}</td>
      <td class="num">${money(a.amount, dec)}</td>
      <td class="num">${a.currency_code === base ? '' : Number(a.invoice_rate).toFixed(6)}</td>
      <td class="num">${a.currency_code === base ? '' : Number(a.receipt_rate).toFixed(6)}</td>
      <td class="num">${a.currency_code === base ? '' : money(a.fx_difference, 2)}</td></tr>`;
  }).join('');
  const t = el('div', 'table-wrap');
  t.innerHTML = `<table class="grid"><thead><tr><th>Invoice</th><th style="text-align:right">Applied (${esc(r.currency_code)})</th>
    <th style="text-align:right">Invoice rate</th><th style="text-align:right">Receipt rate</th>
    <th style="text-align:right">Exchange ${esc(base)}</th></tr></thead><tbody>
    ${body || '<tr><td colspan="5" class="muted">Nothing allocated. The full amount is on the customer\'s account.</td></tr>'}
    ${r.currency_code === base ? '' : `<tr><td colspan="4"><strong>Realised exchange ${fxTotal >= 0 ? 'gain' : 'loss'}</strong></td>
      <td class="num"><strong>${money(Math.abs(fxTotal), 2)}</strong></td></tr>`}
    <tr><td><strong>Receipt total</strong></td><td class="num"><strong>${money(r.amount, dec)}</strong></td>
      <td colspan="3" class="muted">On account: ${money(Number(r.amount) - Number(r.allocated_amount), dec)}</td></tr></tbody></table>`;
  node.append(t);

  const buttons = [{ label: 'Close', value: 'close', className: 'btn-ghost' }];
  if (CAN_RATE && r.status === 'posted') buttons.push({ label: 'Reverse', value: 'reverse', className: 'btn-danger' });
  const res = await ui.dialog({ title: `Receipt ${r.receipt_no}`, node, buttons, dismissValue: 'close', wide: true });
  if (res === 'reverse') await reverseReceipt(r);
}

async function reverseReceipt(r) {
  const saved = await ui.form({
    title: `Reverse ${r.receipt_no}`,
    submitText: 'Reverse',
    fields: [{ name: 'date', label: 'Reversal date', type: 'date', required: true, full: true,
      hint: 'Must fall in an open period. The invoices it settled become open again.' }],
    values: { date: todayIso() },
    onSubmit: async (v) => {
      const { error } = await supabase.rpc('reverse_customer_receipt', { p_receipt: r.id, p_date: v.date });
      if (error) throw error;
    },
  });
  if (saved) { ui.success('Receipt reversed.'); await refresh(); }
}

if (ctx) {
  document.getElementById('company-title').textContent = ctx.company.name;
  await refresh();
}