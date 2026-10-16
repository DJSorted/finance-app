import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { exportSheets } from '../core/export.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const panel = document.getElementById('panel');

const PAGE = 1000;          // the database returns at most 1000 rows per request
const PARALLEL = 5;
const PARTIES_PER_PAGE = 100;
const EXPORT_PARTY_WARN = 1500;
const EXCEL_MAX = 1000000;

const MODES = {
  customers: {
    label: 'Customers', one: 'Customer', table: 'customers', stmt: 'sales_statement', open: 'sales_open_items',
    param: 'p_customer', asOf: 'p_as_of', dr: 'debit', cr: 'credit', drH: 'Debit', crH: 'Credit', balH: 'Balance',
    dueKind: 'invoice', hasSupRef: false,
    kind: { invoice: 'Invoice', credit_note: 'Credit note', receipt: 'Receipt', receipt_reversal: 'Receipt reversal', refund: 'Refund', journal: 'Journal' },
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
let page = 0;
let total = 0;
let pageRows = [];
let detail = null;            // { party, summary, ledger, open } when one party is open
let ran = false;
let busy = false;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n, d = 2) => Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const fmt = (n, d = 2) => (Math.abs(n) < 0.00005 ? '' : (n < 0 ? `(${money(-n, d)})` : money(n, d)));
const num0 = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
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
const searchEl = el('input'); searchEl.type = 'search'; searchEl.placeholder = 'Search code or name'; searchEl.style.maxWidth = '190px';
const progress = el('span', 'muted');
const runBtn = btn('Run', 'btn-primary', () => run());
const exportBtn = btn('Export to Excel', '', doExport);

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

  modeSel.addEventListener('change', () => { mode = modeSel.value; ran = false; detail = null; setHint(); panel.innerHTML = '<p class="muted">Press Run to build the ledger.</p>'; });
  searchEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  toolbar.append(modeSel, el('span', 'muted', 'From'), fromEl, el('span', 'muted', 'To'), toEl, searchEl,
    runBtn, el('span', 'spacer'), progress, exportBtn);
  setHint();
  panel.innerHTML = '<p class="muted">Choose customers or suppliers, set the dates and press Run.</p>';
}

function setHint() {
  hint.textContent = `${MODES[mode].note} Balances are in each document currency. Open items are at the To date, and base amounts are at the rate each document was booked. `
    + `The list shows ${PARTIES_PER_PAGE} ${MODES[mode].label.toLowerCase()} at a time: click one to see its ledger lines and open items. Export to Excel includes everything, or just the one you have open.`;
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

/* ---------- one party: ledger lines, open items, summary rows ---------- */

function buildParty(m, party, stmt, open) {
  const out = { summary: [], ledger: [], open: [] };
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
    out.ledger.push({ ...head, date: fromEl.value, type: 'Opening balance', no: '', sref: '', ref: '', dr: '', cr: '', bal: opening, base: '' });
    lines.forEach((r) => {
      const d = Number(r[m.dr]);
      const c = Number(r[m.cr]);
      bal += d - c; dr += d; cr += c;
      out.ledger.push({
        ...head, date: r.tx_date, type: m.kind[r.kind] || r.kind, no: r.doc_no || '', sref: r.supplier_ref || '', ref: r.reference || '',
        dr: d || '', cr: c || '', bal, base: cur === base ? '' : Number(r.base_amount),
      });
    });
    out.ledger.push({ ...head, date: toEl.value, type: 'Closing balance', no: '', sref: '', ref: '', dr: '', cr: '', bal, base: '' });
    out.summary.push({ ...head, opening, dr, cr, closing: bal, base: baseByCur.get(cur) || 0 });
  });

  open.forEach((i) => out.open.push({
    code: party.code, name: party.name, type: m.openKind[i.doc_kind] || i.doc_kind, no: i.doc_no || '', sref: i.supplier_ref || '',
    date: i.doc_date, due: i.doc_kind === m.dueKind ? i.due_date : '', cur: i.currency_code,
    original: Number(i.original), outstanding: Number(i.outstanding), base: Number(i.base_outstanding),
  }));
  return out;
}

async function fetchParty(m, party) {
  const [s, o] = await Promise.all([
    rpcAll(m.stmt, { p_company: ctx.companyId, [m.param]: party.id, p_to: toEl.value }),
    rpcAll(m.open, { p_company: ctx.companyId, [m.param]: party.id, [m.asOf]: toEl.value }),
  ]);
  return buildParty(m, party, s, o);
}

/* ---------- list, one page of parties ---------- */

async function run() {
  if (busy) return;
  if (!fromEl.value || !toEl.value) return ui.warn('Choose both dates.');
  if (fromEl.value > toEl.value) return ui.warn('The from date must not be after the to date.');
  page = 0;
  detail = null;
  await loadPage();
}

async function loadPage() {
  panel.innerHTML = '<p class="muted">Loading...</p>';
  const { data, error } = await supabase.rpc('party_ledger_summary', {
    p_company: ctx.companyId, p_kind: mode, p_from: fromEl.value, p_to: toEl.value,
    p_search: searchEl.value.trim() || null, p_offset: page * PARTIES_PER_PAGE, p_limit: PARTIES_PER_PAGE,
  });
  if (error) { panel.innerHTML = ''; return ui.errorFrom(error, 'Could not load the ledger.'); }
  total = data.length ? Number(data[0].r_total) : (page === 0 ? 0 : total);
  pageRows = data.map((r) => ({
    id: r.r_party_id, code: r.r_code, name: r.r_name, cur: r.r_currency, opening: Number(r.r_opening),
    dr: Number(r.r_debit), cr: Number(r.r_credit), closing: Number(r.r_closing), base: Number(r.r_base),
  }));
  ran = true;
  render();
}

function render() {
  const m = MODES[mode];
  const first = total ? page * PARTIES_PER_PAGE + 1 : 0;
  const last = Math.min(total, (page + 1) * PARTIES_PER_PAGE);
  const head = el('div');
  head.style.cssText = 'display:flex;gap:.6rem;align-items:center;flex-wrap:wrap;margin-bottom:.6rem';
  const prev = btn('Previous', '', () => { page -= 1; loadPage(); });
  const next = btn('Next', '', () => { page += 1; loadPage(); });
  prev.disabled = page === 0;
  next.disabled = last >= total;
  head.append(el('span', 'muted', total
    ? `${m.label} ${num0(first)} to ${num0(last)} of ${num0(total)}${searchEl.value.trim() ? ' matching your search' : ''}. ${m.label} with no balance or activity in the period are left out.`
    : `No ${m.label.toLowerCase()} match.`), el('span', 'spacer'), prev, next);

  if (!pageRows.length) {
    const empty = el('p', 'muted', `No ${m.label.toLowerCase()} on this page have activity or a balance up to the To date.`);
    panel.replaceChildren(head, empty);
    return;
  }
  const body = pageRows.map((r, i) => {
    const d = decOf(r.cur);
    return `<tr class="clickable" data-i="${i}"><td>${esc(r.code)}</td><td>${esc(r.name)}</td><td>${esc(r.cur)}</td>
      <td class="num">${fmt(r.opening, d)}</td><td class="num">${fmt(r.dr, d)}</td><td class="num">${fmt(r.cr, d)}</td>
      <td class="num">${fmt(r.closing, d)}</td><td class="num">${fmt(r.base)}</td></tr>`;
  }).join('');
  const baseTotal = pageRows.reduce((s, r) => s + r.base, 0);
  const th = (t, right) => `<th${right ? ' style="text-align:right"' : ''}>${t}</th>`;
  const wrap = el('div', 'table-wrap');
  wrap.innerHTML = `<table class="grid"><thead><tr>${th('Code')}${th(m.one)}${th('Cur')}${th('Opening', 1)}${th(m.drH, 1)}${th(m.crH, 1)}
    ${th('Closing', 1)}${th(`Outstanding (${esc(base)})`, 1)}</tr></thead>
    <tbody>${body}<tr class="row-root"><td colspan="7">Total outstanding on this page (${esc(base)}, at booked rates)</td><td class="num">${fmt(baseTotal) || '0.00'}</td></tr></tbody></table>`;
  panel.replaceChildren(head, wrap);
}

panel.addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-i]');
  if (!tr || busy || detail) return;
  const r = pageRows[Number(tr.dataset.i)];
  if (r) openParty({ id: r.id, code: r.code, name: r.name });
});

/* ---------- one party in detail ---------- */

async function openParty(party) {
  const m = MODES[mode];
  panel.innerHTML = '<p class="muted">Loading...</p>';
  let built;
  try { built = await fetchParty(m, party); } catch (e) { render(); return ui.errorFrom(e, 'Could not load the ledger.'); }
  detail = { party, ...built };
  renderDetail();
}

function renderDetail() {
  const m = MODES[mode];
  const { party, ledger, open } = detail;
  const head = el('div');
  head.style.cssText = 'display:flex;gap:.6rem;align-items:center;flex-wrap:wrap;margin-bottom:.6rem';
  head.append(btn(`All ${m.label.toLowerCase()}`, 'btn-ghost', () => { detail = null; render(); }), el('strong', '', `${party.code} - ${party.name}`));

  const th = (t, right) => `<th${right ? ' style="text-align:right"' : ''}>${t}</th>`;
  const lbody = ledger.map((r) => {
    const d = decOf(r.cur);
    const strong = r.type === 'Opening balance' || r.type === 'Closing balance';
    return `<tr${strong ? ' class="row-root"' : ''}><td>${esc(r.cur)}</td><td>${r.date}</td><td>${esc(r.type)}</td><td>${esc(r.no)}</td>
      ${m.hasSupRef ? `<td>${esc(r.sref)}</td>` : ''}<td>${esc(r.ref)}</td>
      <td class="num">${r.dr === '' ? '' : fmt(r.dr, d)}</td><td class="num">${r.cr === '' ? '' : fmt(r.cr, d)}</td>
      <td class="num">${fmt(r.bal, d) || '0.00'}</td><td class="num">${r.base === '' ? '' : fmt(r.base)}</td></tr>`;
  }).join('');
  const lwrap = el('div', 'table-wrap');
  lwrap.innerHTML = ledger.length
    ? `<table class="grid"><thead><tr>${th('Cur')}${th('Date')}${th('Type')}${th('No')}${m.hasSupRef ? th('Supplier ref') : ''}${th('Reference')}
      ${th(m.drH, 1)}${th(m.crH, 1)}${th(m.balH, 1)}${th(`At booked rate (${esc(base)})`, 1)}</tr></thead><tbody>${lbody}</tbody></table>`
    : '<p class="muted">No ledger lines in this period.</p>';

  const obody = open.map((r) => {
    const d = decOf(r.cur);
    return `<tr><td>${esc(r.type)}</td><td>${esc(r.no)}</td>${m.hasSupRef ? `<td>${esc(r.sref)}</td>` : ''}<td>${r.date}</td><td>${r.due || ''}</td>
      <td>${esc(r.cur)}</td><td class="num">${fmt(r.original, d)}</td><td class="num">${fmt(r.outstanding, d)}</td><td class="num">${fmt(r.base)}</td></tr>`;
  }).join('');
  const owrap = el('div', 'table-wrap');
  owrap.innerHTML = open.length
    ? `<table class="grid"><thead><tr>${th('Type')}${th('No')}${m.hasSupRef ? th('Supplier ref') : ''}${th('Date')}${th('Due')}${th('Cur')}
      ${th('Original', 1)}${th('Outstanding', 1)}${th(`Outstanding (${esc(base)})`, 1)}</tr></thead><tbody>${obody}</tbody></table>`
    : '<p class="muted">No open items at the To date.</p>';

  const h4 = el('h4', '', 'Open items');
  h4.style.margin = '1rem 0 .4rem';
  panel.replaceChildren(head, lwrap, h4, owrap);
}

/* ---------- export (everything, or the party that is open) ---------- */

async function doExport() {
  if (busy) return;
  if (!ran) return ui.warn('Run the ledger first.');
  const m = MODES[mode];
  busy = true;
  runBtn.disabled = true;
  exportBtn.disabled = true;
  try {
    let all;
    if (detail) {
      all = { summary: detail.summary, ledger: detail.ledger, open: detail.open };
    } else {
      const { data: parties, error } = await supabase.from(m.table).select('id, code, name').eq('company_id', ctx.companyId).order('code');
      if (error) throw error;
      if (parties.length > EXPORT_PARTY_WARN) {
        const ok = await ui.confirm({
          title: 'Large export',
          message: `This reads ${num0(parties.length)} ${m.label.toLowerCase()} one by one and can take several minutes. Keep this tab open. Continue?`,
          confirmText: 'Continue',
        });
        if (!ok) return;
      }
      const results = new Array(parties.length);
      let done = 0;
      await pool(parties, PARALLEL, async (p, i) => {
        results[i] = await fetchParty(m, p);
        done += 1;
        if (done % 5 === 0 || done === parties.length) progress.textContent = `Reading ${num0(done)} of ${num0(parties.length)} ${m.label.toLowerCase()}...`;
      });
      all = { summary: [], ledger: [], open: [] };
      results.forEach((r) => { all.summary.push(...r.summary); all.ledger.push(...r.ledger); all.open.push(...r.open); });
    }
    if (!all.summary.length) { progress.textContent = ''; return ui.warn(`No ${m.label.toLowerCase()} have activity or a balance up to the To date.`); }
    if (all.ledger.length > EXCEL_MAX || all.open.length > EXCEL_MAX) {
      progress.textContent = '';
      return ui.warn('This export has more rows than one Excel sheet can hold. Choose a shorter period or export one party at a time.');
    }
    progress.textContent = 'Building the file...';
    const partyCols = [{ key: 'code', header: `${m.one} code`, width: 14 }, { key: 'name', header: m.one, width: 32 }];
    await exportSheets(`${mode}-ledger-${toEl.value}.xlsx`, [
      { name: 'Summary', title: `${m.label} ledger summary`, subtitle: `${fromEl.value} to ${toEl.value}, amounts in each document currency`,
        rows: all.summary, columns: [...partyCols, { key: 'cur', header: 'Currency', width: 10 },
          { key: 'opening', header: 'Opening', width: 16 }, { key: 'dr', header: m.drH, width: 16 }, { key: 'cr', header: m.crH, width: 16 },
          { key: 'closing', header: 'Closing', width: 16 }, { key: 'base', header: `Outstanding (${base})`, width: 20 }] },
      { name: 'Ledger', title: `${m.label} ledger`, subtitle: `${fromEl.value} to ${toEl.value}`,
        rows: all.ledger, columns: [...partyCols, { key: 'cur', header: 'Currency', width: 10 },
          { key: 'date', header: 'Date', width: 12 }, { key: 'type', header: 'Type', width: 22 }, { key: 'no', header: 'No', width: 14 },
          ...(m.hasSupRef ? [{ key: 'sref', header: 'Supplier ref', width: 18 }] : []),
          { key: 'ref', header: 'Reference', width: 18 },
          { key: 'dr', header: m.drH, width: 16 }, { key: 'cr', header: m.crH, width: 16 },
          { key: 'bal', header: m.balH, width: 16 }, { key: 'base', header: `At booked rate (${base})`, width: 20 }] },
      { name: 'Open items', title: `${m.label} open items`, subtitle: `At ${toEl.value}`,
        rows: all.open, columns: [...partyCols, { key: 'type', header: 'Type', width: 22 }, { key: 'no', header: 'No', width: 14 },
          ...(m.hasSupRef ? [{ key: 'sref', header: 'Supplier ref', width: 18 }] : []),
          { key: 'date', header: 'Date', width: 12 }, { key: 'due', header: 'Due', width: 12 }, { key: 'cur', header: 'Currency', width: 10 },
          { key: 'original', header: 'Original', width: 16 }, { key: 'outstanding', header: 'Outstanding', width: 16 },
          { key: 'base', header: `Outstanding (${base})`, width: 20 }] },
    ]);
    progress.textContent = '';
  } catch (e) {
    progress.textContent = '';
    ui.errorFrom(e, 'Could not export.');
  } finally {
    busy = false;
    runBtn.disabled = false;
    exportBtn.disabled = false;
  }
}

if (ctx) await init();