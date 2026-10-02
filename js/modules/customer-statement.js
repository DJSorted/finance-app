import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { exportSheets } from '../core/export.js';
import { createAllocationGrid } from '../core/allocation-grid.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const panel = document.getElementById('panel');

const CAN_APPLY = ctx ? ['owner', 'admin', 'accountant', 'clerk'].includes(ctx.role) : false;
const CAN_REVERSE = ctx ? ctx.canEdit : false;
const KIND = { invoice: 'Invoice', credit_note: 'Credit note', receipt: 'Receipt', receipt_reversal: 'Receipt reversal', journal: 'Journal' };

let customers = [];
let currencies = [];
let base = '';
let custId = new URLSearchParams(location.search).get('customer') || '';
let stmt = [];
let openItems = [];
let apps = [];
let ran = false;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n, d = 2) => Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const fmt = (n, d = 2) => (Math.abs(n) < 0.00005 ? '' : (n < 0 ? `(${money(-n, d)})` : money(n, d)));
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

const custSel = el('select');
custSel.style.maxWidth = '300px';
const fromEl = el('input'); fromEl.type = 'date'; fromEl.style.width = 'auto';
const toEl = el('input'); toEl.type = 'date'; toEl.style.width = 'auto';

async function init() {
  document.getElementById('company-title').textContent = ctx.company.name;
  const cid = ctx.companyId;
  const [c, cu, fy] = await Promise.all([
    supabase.from('customers').select('id, code, name').eq('company_id', cid).order('code'),
    supabase.from('company_currencies').select('code, is_base, currencies(decimals)').eq('company_id', cid).order('code'),
    supabase.from('fiscal_years').select('start_date, end_date').eq('company_id', cid).order('start_date'),
  ]);
  for (const r of [c, cu, fy]) if (r.error) { ui.errorFrom(r.error, 'Could not load the statement setup.'); return; }
  customers = c.data;
  currencies = cu.data;
  base = (currencies.find((x) => x.is_base) || {}).code || '';

  option(custSel, '', 'Select a customer');
  customers.forEach((x) => option(custSel, x.id, `${x.code} - ${x.name}`));
  custSel.value = custId;
  const today = todayIso();
  const year = fy.data.find((y) => today >= y.start_date && today <= y.end_date);
  fromEl.value = year ? year.start_date : `${today.slice(0, 4)}-01-01`;
  toEl.value = today;

  custSel.addEventListener('change', () => { custId = custSel.value; if (custId) run(); });
  toolbar.append(custSel, el('span', 'muted', 'From'), fromEl, el('span', 'muted', 'To'), toEl,
    btn('Run', 'btn-primary', run));
  if (CAN_APPLY) toolbar.append(btn('Apply credits', '', openApply));
  toolbar.append(el('span', 'spacer'), btn('Export to Excel', '', doExport));
  hint.textContent = 'Balances are in each document currency. Open items are at the To date, and base amounts are at the rate each document was booked.';
  if (custId) await run(); else panel.innerHTML = '<div class="card"><p class="muted">Choose a customer to see their statement.</p></div>';
}

async function run() {
  if (!custId) return ui.warn('Choose a customer.');
  if (!fromEl.value || !toEl.value) return ui.warn('Choose both dates.');
  const [s, o, a] = await Promise.all([
    supabase.rpc('sales_statement', { p_company: ctx.companyId, p_customer: custId, p_to: toEl.value }),
    supabase.rpc('sales_open_items', { p_company: ctx.companyId, p_customer: custId, p_as_of: toEl.value }),
    supabase.from('sales_applications').select('*').eq('company_id', ctx.companyId).eq('customer_id', custId)
      .order('app_date', { ascending: false }).order('created_at', { ascending: false }).limit(50),
  ]);
  for (const r of [s, o, a]) if (r.error) return ui.errorFrom(r.error, 'Could not load the statement.');
  stmt = s.data;
  openItems = o.data;
  apps = a.data;
  ran = true;
  render();
}

/* ---------- render ---------- */

function statementBlocks() {
  const byCur = new Map();
  stmt.forEach((r) => {
    if (!byCur.has(r.currency_code)) byCur.set(r.currency_code, []);
    byCur.get(r.currency_code).push(r);
  });
  const blocks = [];
  byCur.forEach((list, cur) => {
    const dec = decOf(cur);
    const opening = list.filter((r) => r.tx_date < fromEl.value).reduce((s, r) => s + Number(r.debit) - Number(r.credit), 0);
    const lines = list.filter((r) => r.tx_date >= fromEl.value);
    if (Math.abs(opening) < 0.00005 && !lines.length) return;
    let bal = opening;
    const out = lines.map((r) => {
      bal += Number(r.debit) - Number(r.credit);
      return { ...r, balance: bal };
    });
    blocks.push({ cur, dec, opening, lines: out, closing: bal });
  });
  return blocks.sort((a, b) => a.cur.localeCompare(b.cur));
}

function render() {
  const cust = customers.find((c) => c.id === custId);
  let html = '';

  const blocks = statementBlocks();
  if (!blocks.length) html += '<div class="card" style="margin-bottom:1rem"><p class="muted">No activity for this customer up to the To date.</p></div>';
  blocks.forEach((b) => {
    const body = b.lines.map((r) => `<tr>
      <td>${r.tx_date}</td><td>${esc(KIND[r.kind] || r.kind)}</td><td>${esc(r.doc_no || '')}</td><td>${esc(r.reference || '')}</td>
      <td class="num">${fmt(Number(r.debit), b.dec)}</td><td class="num">${fmt(Number(r.credit), b.dec)}</td>
      <td class="num">${fmt(r.balance, b.dec)}</td><td class="num">${b.cur === base ? '' : fmt(Number(r.base_amount))}</td></tr>`).join('');
    html += `<div class="card" style="margin-bottom:1rem"><h3>${esc(cust ? cust.name : '')} - ${esc(b.cur)}</h3>
      <div class="table-wrap"><table class="grid"><thead><tr><th>Date</th><th>Type</th><th>No</th><th>Reference</th>
        <th style="text-align:right">Debit</th><th style="text-align:right">Credit</th>
        <th style="text-align:right">Balance (${esc(b.cur)})</th><th style="text-align:right">${b.cur === base ? '' : `At booked rate (${esc(base)})`}</th></tr></thead>
      <tbody><tr class="row-parent"><td colspan="6">Opening balance at ${esc(fromEl.value)}</td><td class="num">${fmt(b.opening, b.dec) || '0.00'}</td><td></td></tr>
      ${body}
      <tr class="row-root"><td colspan="6">Closing balance at ${esc(toEl.value)}</td><td class="num">${fmt(b.closing, b.dec) || '0.00'}</td><td></td></tr></tbody></table></div></div>`;
  });

  // open items
  const baseTotal = openItems.reduce((s, i) => s + Number(i.base_outstanding), 0);
  const oiBody = openItems.map((i) => {
    const d = decOf(i.currency_code);
    const over = i.doc_kind === 'invoice' ? Math.round((new Date(`${toEl.value}T00:00:00Z`) - new Date(`${i.due_date}T00:00:00Z`)) / 86400000) : '';
    return `<tr><td>${esc(KIND[i.doc_kind] || i.doc_kind)}</td><td>${esc(i.doc_no || '')}</td><td>${i.doc_date}</td>
      <td>${i.doc_kind === 'invoice' ? i.due_date : ''}</td><td>${esc(i.currency_code)}</td>
      <td class="num">${fmt(Number(i.original), d)}</td><td class="num">${fmt(Number(i.outstanding), d)}</td>
      <td class="num">${fmt(Number(i.base_outstanding))}</td>
      <td class="num">${over !== '' && over > 0 ? over : ''}</td></tr>`;
  }).join('');
  html += `<div class="card" style="margin-bottom:1rem"><h3>Open items at ${esc(toEl.value)}</h3>
    ${openItems.length ? `<div class="table-wrap"><table class="grid"><thead><tr><th>Type</th><th>No</th><th>Date</th><th>Due</th><th>Cur</th>
      <th style="text-align:right">Original</th><th style="text-align:right">Outstanding</th>
      <th style="text-align:right">${esc(base)}</th><th style="text-align:right">Days overdue</th></tr></thead>
      <tbody>${oiBody}<tr class="row-root"><td colspan="7">Total (${esc(base)})</td><td class="num">${fmt(baseTotal) || '0.00'}</td><td></td></tr></tbody></table></div>`
    : '<p class="muted">Nothing outstanding.</p>'}
    <p class="muted">Journal items cannot be allocated. Correct them with a reversing journal.</p></div>`;

  // applications
  const appBody = apps.map((a) => `<tr data-app="${a.id}"><td>${a.app_date}</td><td>${esc(a.currency_code)}</td>
    <td class="num">${money(a.total_amount, decOf(a.currency_code))}</td>
    <td><span class="badge ${a.status === 'applied' ? 'open' : ''}">${a.status === 'applied' ? 'Applied' : `Reversed ${a.reversed_on}`}</span></td>
    <td>${CAN_REVERSE && a.status === 'applied' ? '<div class="row-actions"><button class="btn btn-sm" data-act="unapply">Reverse</button></div>' : ''}</td></tr>`).join('');
  html += `<div class="card"><h3>Credit applications</h3>
    ${apps.length ? `<div class="table-wrap"><table class="grid"><thead><tr><th>Date</th><th>Cur</th><th style="text-align:right">Amount</th><th>Status</th><th></th></tr></thead>
      <tbody>${appBody}</tbody></table></div>` : '<p class="muted">No credits have been applied for this customer.</p>'}</div>`;

  panel.innerHTML = html;
}

panel.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-act="unapply"]');
  if (!t) return;
  const app = apps.find((a) => a.id === t.closest('tr').dataset.app);
  if (!app) return;
  const saved = await ui.form({
    title: 'Reverse credit application',
    submitText: 'Reverse',
    fields: [{ name: 'date', label: 'Reversal date', type: 'date', required: true, full: true,
      hint: 'Must fall in an open period. The invoices and credits become open again.' }],
    values: { date: todayIso() },
    onSubmit: async (v) => {
      const { error } = await supabase.rpc('reverse_sales_application', { p_app: app.id, p_date: v.date });
      if (error) throw error;
    },
  });
  if (saved) { ui.success('Application reversed.'); await run(); }
});

/* ---------- apply credits ---------- */

async function openApply() {
  if (!custId) return ui.warn('Choose a customer first.');
  const { data, error } = await supabase.rpc('sales_open_items', { p_company: ctx.companyId, p_customer: custId, p_as_of: todayIso() });
  if (error) return ui.errorFrom(error, 'Could not load the open items.');
  const credits = data.filter((i) => (i.doc_kind === 'credit_note' || i.doc_kind === 'receipt') && Number(i.outstanding) < 0);
  const invoices = data.filter((i) => i.doc_kind === 'invoice' && Number(i.outstanding) > 0);
  const curs = [...new Set(credits.map((c) => c.currency_code))].filter((c) => invoices.some((i) => i.currency_code === c));
  if (!curs.length) return ui.warn('This customer has no open credit notes or receipts to apply against open invoices in the same currency.');

  const prevFocus = document.activeElement;
  const backdrop = el('div', 'modal-backdrop');
  const box = el('div', 'modal xwide');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.append(el('h3', 'modal-title', 'Apply credits to invoices'));

  const field = (text, input) => { const w = el('div', 'field'); w.append(el('label', '', text), input); return w; };
  const curSel = el('select');
  curs.forEach((c) => option(curSel, c, c));
  const dateIn = el('input'); dateIn.type = 'date'; dateIn.value = todayIso();
  const head = el('div', 'form-grid');
  head.append(field('Currency', curSel), field('Application date', dateIn));
  box.append(head);

  const totals = el('div', 'totals-bar');
  const credGrid = createAllocationGrid({
    firstHeader: 'Credit', autoLabel: 'Use all', emptyText: 'No open credits in this currency.', onChange: sync,
  });
  const invGrid = createAllocationGrid({ onChange: sync });
  credGrid.setTotal(1e15);

  const h1 = el('h4', '', 'Credits to use'); h1.style.margin = '1rem 0 .25rem';
  const h2 = el('h4', '', 'Apply to invoices'); h2.style.margin = '1rem 0 .25rem';
  box.append(h1, credGrid.node, h2, invGrid.node, totals);

  function load() {
    const cur = curSel.value;
    const dec = decOf(cur);
    credGrid.setItems(credits.filter((c) => c.currency_code === cur).map((c) => ({
      id: c.doc_id, kind: c.doc_kind, doc_no: c.doc_no, doc_date: c.doc_date, due_date: c.due_date,
      outstanding: -Number(c.outstanding), fx_rate: Number(c.fx_rate),
    })), dec);
    invGrid.setItems(invoices.filter((i) => i.currency_code === cur).map((i) => ({
      id: i.doc_id, doc_no: i.doc_no, doc_date: i.doc_date, due_date: i.due_date,
      outstanding: Number(i.outstanding), fx_rate: Number(i.fx_rate),
    })), dec);
    sync();
  }

  function sync() {
    const dec = decOf(curSel.value);
    const used = roundTo(credGrid.detailed().reduce((s, x) => s + x.amount, 0), dec);
    invGrid.setTotal(used);
    const applied = roundTo(invGrid.detailed().reduce((s, x) => s + x.amount, 0), dec);
    const diff = roundTo(used - applied, dec);
    totals.innerHTML = `<span>Credits used: ${money(used, dec)}</span><span>Applied to invoices: ${money(applied, dec)}</span>`
      + `<span class="${diff === 0 && used > 0 ? 'ok' : 'bad'}">Difference: ${money(diff, dec)}</span>`;
  }
  curSel.addEventListener('change', load);
  load();

  const actions = el('div', 'modal-actions');
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const close = () => {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    if (prevFocus && prevFocus.focus) prevFocus.focus();
  };
  document.addEventListener('keydown', onKey);
  const goBtn = btn('Apply', 'btn-primary', () => {});
  actions.append(el('span', 'spacer'), btn('Cancel', 'btn-ghost', close), goBtn);
  box.append(actions);
  backdrop.append(box);
  document.body.append(backdrop);

  goBtn.addEventListener('click', async () => {
    const cur = curSel.value;
    const dec = decOf(cur);
    const srcs = credGrid.detailed();
    const invs = invGrid.allocations();
    const used = roundTo(srcs.reduce((s, x) => s + x.amount, 0), dec);
    const applied = roundTo(invs.reduce((s, x) => s + x.amount, 0), dec);
    if (!srcs.length || !invs.length) return ui.warn('Choose at least one credit and one invoice.');
    if (used !== applied) return ui.warn('The credits used and the amount applied to invoices must be equal.');
    if (!dateIn.value) return ui.warn('Enter the application date.');
    const ok = await ui.confirm({
      title: 'Apply credits',
      message: `Apply ${money(used, dec)} ${cur} of credits to ${invs.length} invoice(s)?\nAny exchange difference is posted to the exchange gains / losses account.`,
      confirmText: 'Apply',
    });
    if (!ok) return;
    goBtn.disabled = true;
    try {
      const { error: e2 } = await supabase.rpc('apply_sales_credits', {
        p_company: ctx.companyId, p_customer: custId, p_date: dateIn.value, p_currency: cur,
        p_sources: srcs.map((x) => ({ kind: x.item.kind, id: x.item.id, amount: x.amount })),
        p_invoices: invs,
      });
      if (e2) throw e2;
      close();
      ui.success('Credits applied.');
      await run();
    } catch (e) {
      ui.errorFrom(e, 'Could not apply the credits.');
    } finally {
      goBtn.disabled = false;
    }
  });
}

/* ---------- export ---------- */

async function doExport() {
  if (!ran) return ui.warn('Run the statement first.');
  try {
    const cust = customers.find((c) => c.id === custId);
    const lines = [];
    statementBlocks().forEach((b) => {
      lines.push({ cur: b.cur, date: fromEl.value, type: 'Opening balance', no: '', ref: '', debit: '', credit: '', balance: b.opening, base: '' });
      b.lines.forEach((r) => lines.push({
        cur: b.cur, date: r.tx_date, type: KIND[r.kind] || r.kind, no: r.doc_no || '', ref: r.reference || '',
        debit: Number(r.debit) || '', credit: Number(r.credit) || '', balance: r.balance, base: b.cur === base ? '' : Number(r.base_amount),
      }));
      lines.push({ cur: b.cur, date: toEl.value, type: 'Closing balance', no: '', ref: '', debit: '', credit: '', balance: b.closing, base: '' });
    });
    await exportSheets(`statement-${cust ? cust.code : 'customer'}-${toEl.value}.xlsx`, [
      { name: 'Statement', rows: lines, columns: [
        { key: 'cur', header: 'Currency', width: 10 }, { key: 'date', header: 'Date', width: 12 },
        { key: 'type', header: 'Type', width: 18 }, { key: 'no', header: 'No', width: 14 },
        { key: 'ref', header: 'Reference', width: 18 }, { key: 'debit', header: 'Debit', width: 14 },
        { key: 'credit', header: 'Credit', width: 14 }, { key: 'balance', header: 'Balance', width: 16 },
        { key: 'base', header: `At booked rate (${base})`, width: 20 } ] },
      { name: 'Open items', rows: openItems.map((i) => ({
        type: KIND[i.doc_kind] || i.doc_kind, no: i.doc_no || '', date: i.doc_date, due: i.doc_kind === 'invoice' ? i.due_date : '',
        cur: i.currency_code, original: Number(i.original), outstanding: Number(i.outstanding), base: Number(i.base_outstanding),
      })), columns: [
        { key: 'type', header: 'Type', width: 14 }, { key: 'no', header: 'No', width: 14 }, { key: 'date', header: 'Date', width: 12 },
        { key: 'due', header: 'Due', width: 12 }, { key: 'cur', header: 'Currency', width: 10 },
        { key: 'original', header: 'Original', width: 14 }, { key: 'outstanding', header: 'Outstanding', width: 14 },
        { key: 'base', header: `Outstanding (${base})`, width: 18 } ] },
    ]);
  } catch (e) { ui.errorFrom(e, 'Could not export.'); }
}

if (ctx) await init();