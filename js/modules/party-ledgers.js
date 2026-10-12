import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { exportSheets } from '../core/export.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const panel = document.getElementById('panel');

const PAGE = 1000;
const PARALLEL = 5;

const MODES = {
  customers: {
    label: 'Customers', one: 'Customer', table: 'customers', stmt: 'sales_statement', open: 'sales_open_items',
    param: 'p_customer', asOf: 'p_as_of', dr: 'debit', cr: 'credit', drH: 'Debit', crH: 'Credit', balH: 'Balance',
    dueKind: 'invoice', hasSupRef: false,
    kind: { invoice: 'Invoice', credit_note: 'Credit note', receipt: 'Receipt', receipt_reversal: 'Receipt reversal', journal: 'Journal' },
    openKind: { invoice: 'Invoice', credit_note: 'Credit note', receipt: 'Receipt', journal: 'Journal' },
    note: 'Debtors: debit balances are owed to us, brackets are credit balances.',
  },
  suppliers: {
    label: 'Suppliers', one: 'Supplier', table: 'suppliers', stmt: 'purchase_statement', open: 'purchase_open_items',
    param: 'p_supplier', asOf: 'p_as_of', dr: 'charges', cr: 'credits', drH: 'Charges', crH: 'Credits', balH: 'Owed',
    dueKind: 'bill', hasSupRef: true,
    kind: { bill: 'Bill', credit_note: 'Supplier credit note', payment: 'Payment', payment_reversal: 'Payment reversal', journal: 'Journal' },
    openKind: { bill: 'Bill', credit_note: 'Supplier credit note', payment: 'Payment on account', journal: 'Journal' },
    note: 'Creditors: positive balances are owed to suppliers, brackets are amounts owed to us.',
  },
};

let mode = 'customers';
let currencies = [];
let base = '';
let summary = [];
let ledger = [];
let openRows = [];
let ran = false;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n, d = 2) => Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const fmt = (n, d = 2) => (Math.abs(n) < 0.00005 ? '' : (n < 0 ? `(${money(-n, d)})` : money(n, d)));
const todayIso = () => new Date().toISOString().slice(0, 10);
const decOf = (code) => { const c = currencies.find((x) => x.code === code); return c && c.currencies ? c.currencies.decimals : 2; };

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function btn(text, cls, onClick) {
  const b = el('button', `btn ${cls}`.trim(), text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

const modeSel = el('select');
modeSel.style.width = 'auto';
Object.entries(MODES).forEach(([k, m]) => { const o = el('option', '', m.label); o.value = k; modeSel.append(o); });
const fromEl = el('input'); fromEl.type = 'date'; fromEl.style.width = 'auto';
const toEl = el('input'); toEl.type = 'date'; toEl.style.width = 'auto';

async function init() {
  document.getElementById('company-title').textContent = ctx.company.name;
  const cid = ctx.companyId;
  const [cu, fy] = await Promise.all([
    supabase.from('company_currencies').select('code, is_base, currencies(decimals)').eq('company_id', cid).order('code'),
    supabase.from('fiscal_years').select('start_date, end_date').eq('company_id', cid).order('start_date'),
  ]);
  for (const r of [cu, fy]) if (r.error) { ui.errorFrom(r.error, 'Could not load the report setup.'); return; }
  currencies = cu.data;
  base = (currencies.find((x) => x.is_base) || {}).code || '';
  const today = todayIso();
  const year = fy.data.find((y) => today >= y.start_date && today <= y.end_date);
  fromEl.value = year ? year.start_date : `${today.slice(0, 4)}-01-01`;
  toEl.value = today;

  modeSel.addEventListener('change', () => { mode = modeSel.value; ran = false; setHint(); panel.innerHTML = '<p class="muted">Press Run to build the ledger.</p>'; });
  toolbar.append(modeSel, el('span', 'muted', 'From'), fromEl, el('span', 'muted', 'To'), toEl,
    btn('Run', 'btn-primary', run), el('span', 'spacer'), btn('Export to Excel', '', doExport));
  setHint();
  panel.innerHTML = '<p class="muted">Choose customers or suppliers, set the dates and press Run.</p>';
}

function setHint() {
  hint.textContent = `${MODES[mode].note} Balances are in each document currency. Open items are at the To date, and base amounts are at the rate each document was booked.`;
}

async function rpcAll(fn, params) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.rpc(fn, params).range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

async function pool(items, size, fn) {
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}

async function run() {
  if (!fromEl.value || !toEl.value) return ui.warn('Choose both dates.');
  if (fromEl.value > toEl.value) return ui.warn('The from date must not be after the to date.');
  const m = MODES[mode];
  panel.innerHTML = '<p class="muted">Loading...</p>';

  const { data: parties, error } = await supabase.from(m.table).select('id, code, name').eq('company_id', ctx.companyId).order('code');
  if (error) { panel.innerHTML = ''; return ui.errorFrom(error, `Could not load the ${m.label.toLowerCase()}.`); }

  const results = new Array(parties.length);
  let done = 0;
  try {
    await pool(parties, PARALLEL, async (p, i) => {
      const [s, o] = await Promise.all([
        rpcAll(m.stmt, { p_company: ctx.companyId, [m.param]: p.id, p_to: toEl.value }),
        rpcAll(m.open, { p_company: ctx.companyId, [m.param]: p.id, [m.asOf]: toEl.value }),
      ]);
      results[i] = { party: p, stmt: s, open: o };
      done++;
      if (done % 5 === 0 || done === parties.length) panel.innerHTML = `<p class="muted">Loading ${done} of ${parties.length} ${m.label.toLowerCase()}...</p>`;
    });
  } catch (e) { panel.innerHTML = ''; return ui.errorFrom(e, 'Could not load the ledger.'); }

  summary = [];
  ledger = [];
  openRows = [];
  results.forEach(({ party, stmt, open }) => {
    const byCur = new Map();
    stmt.forEach((r) => { if (!byCur.has(r.currency_code)) byCur.set(r.currency_code, []); byCur.get(r.currency_code).push(r); });
    const baseByCur = new Map();
    open.forEach((i) => baseByCur.set(i.currency_code, (baseByCur.get(i.currency_code) || 0) + Number(i.base_outstanding)));

    [...byCur.keys()].sort().forEach((cur) => {
      const list = byCur.get(cur);
      const opening = list.filter((r) => r.tx_date < fromEl.value).reduce((s, r) => s + Number(r[m.dr]) - Number(r[m.cr]), 0);
      const lines = list.filter((r) => r.tx_date >= fromEl.value);
      if (Math.abs(opening) < 0.00005 && !lines.length) return;
      let bal = opening;
      let dr = 0;
      let cr = 0;
      const head = { code: party.code, name: party.name, cur };
      ledger.push({ ...head, date: fromEl.value, type: 'Opening balance', no: '', sref: '', ref: '', dr: '', cr: '', bal: opening, base: '' });
      lines.forEach((r) => {
        const d = Number(r[m.dr]);
        const c = Number(r[m.cr]);
        bal += d - c; dr += d; cr += c;
        ledger.push({
          ...head, date: r.tx_date, type: m.kind[r.kind] || r.kind, no: r.doc_no || '', sref: r.supplier_ref || '', ref: r.reference || '',
          dr: d || '', cr: c || '', bal, base: cur === base ? '' : Number(r.base_amount),
        });
      });
      ledger.push({ ...head, date: toEl.value, type: 'Closing balance', no: '', sref: '', ref: '', dr: '', cr: '', bal, base: '' });
      summary.push({ ...head, opening, dr, cr, closing: bal, base: baseByCur.get(cur) || 0 });
    });

    open.forEach((i) => openRows.push({
      code: party.code, name: party.name, type: m.openKind[i.doc_kind] || i.doc_kind, no: i.doc_no || '', sref: i.supplier_ref || '',
      date: i.doc_date, due: i.doc_kind === m.dueKind ? i.due_date : '', cur: i.currency_code,
      original: Number(i.original), outstanding: Number(i.outstanding), base: Number(i.base_outstanding),
    }));
  });
  ran = true;
  render();
}

function render() {
  const m = MODES[mode];
  if (!summary.length) { panel.innerHTML = `<p class="muted">No ${m.label.toLowerCase()} have activity or a balance up to the To date.</p>`; return; }
  const body = summary.map((r) => {
    const d = decOf(r.cur);
    return `<tr><td>${esc(r.code)}</td><td>${esc(r.name)}</td><td>${esc(r.cur)}</td>
      <td class="num">${fmt(r.opening, d)}</td><td class="num">${fmt(r.dr, d)}</td><td class="num">${fmt(r.cr, d)}</td>
      <td class="num">${fmt(r.closing, d)}</td><td class="num">${fmt(r.base)}</td></tr>`;
  }).join('');
  const baseTotal = summary.reduce((s, r) => s + r.base, 0);
  const th = (t, right) => `<th${right ? ' style="text-align:right"' : ''}>${t}</th>`;
  panel.innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr>${th('Code')}${th(m.one)}${th('Cur')}${th('Opening', 1)}${th(m.drH, 1)}${th(m.crH, 1)}
    ${th('Closing', 1)}${th(`Outstanding (${esc(base)})`, 1)}</tr></thead>
    <tbody>${body}<tr class="row-root"><td colspan="7">Total outstanding (${esc(base)}, at booked rates)</td><td class="num">${fmt(baseTotal) || '0.00'}</td></tr></tbody></table></div>
    <p class="muted">${summary.length} ${m.label.toLowerCase()} lines. The Excel file also has every ledger line and every open item.</p>`;
}

async function doExport() {
  if (!ran || !summary.length) return ui.warn('Run the ledger first.');
  const m = MODES[mode];
  try {
    const partyCols = [{ key: 'code', header: `${m.one} code`, width: 14 }, { key: 'name', header: m.one, width: 32 }];
    await exportSheets(`${mode}-ledger-${toEl.value}.xlsx`, [
      { name: 'Summary', title: `${m.label} ledger summary`, subtitle: `${fromEl.value} to ${toEl.value}, amounts in each document currency`,
        rows: summary, columns: [...partyCols, { key: 'cur', header: 'Currency', width: 10 },
          { key: 'opening', header: 'Opening', width: 16 }, { key: 'dr', header: m.drH, width: 16 }, { key: 'cr', header: m.crH, width: 16 },
          { key: 'closing', header: 'Closing', width: 16 }, { key: 'base', header: `Outstanding (${base})`, width: 20 }] },
      { name: 'Ledger', title: `${m.label} ledger`, subtitle: `${fromEl.value} to ${toEl.value}`,
        rows: ledger, columns: [...partyCols, { key: 'cur', header: 'Currency', width: 10 },
          { key: 'date', header: 'Date', width: 12 }, { key: 'type', header: 'Type', width: 22 }, { key: 'no', header: 'No', width: 14 },
          ...(m.hasSupRef ? [{ key: 'sref', header: 'Supplier ref', width: 18 }] : []),
          { key: 'ref', header: 'Reference', width: 18 },
          { key: 'dr', header: m.drH, width: 16 }, { key: 'cr', header: m.crH, width: 16 },
          { key: 'bal', header: m.balH, width: 16 }, { key: 'base', header: `At booked rate (${base})`, width: 20 }] },
      { name: 'Open items', title: `${m.label} open items`, subtitle: `At ${toEl.value}`,
        rows: openRows, columns: [...partyCols, { key: 'type', header: 'Type', width: 22 }, { key: 'no', header: 'No', width: 14 },
          ...(m.hasSupRef ? [{ key: 'sref', header: 'Supplier ref', width: 18 }] : []),
          { key: 'date', header: 'Date', width: 12 }, { key: 'due', header: 'Due', width: 12 }, { key: 'cur', header: 'Currency', width: 10 },
          { key: 'original', header: 'Original', width: 16 }, { key: 'outstanding', header: 'Outstanding', width: 16 },
          { key: 'base', header: `Outstanding (${base})`, width: 20 }] },
    ]);
  } catch (e) { ui.errorFrom(e, 'Could not export.'); }
}

if (ctx) await init();