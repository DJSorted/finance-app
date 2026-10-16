import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { exportSheets } from '../core/export.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const panel = document.getElementById('panel');

const API_PAGE = 1000;            // the database returns at most 1000 rows per request
const DIRECT_LIMIT = 20000;       // an account with more lines than this is exported month by month
const EXCEL_WARN = 200000;        // above this many lines the Excel build may be slow
const EXCEL_MAX = 1000000;        // a sheet holds 1,048,576 rows at most

let accounts = [];
let base = '';
let summary = [];                 // period_balance_summary rows for the last run (all accounts or one)
let ran = false;
let view = { acct: null, page: 0, total: 0 };
let busy = false;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (n) => (n < 0 ? `(${money(-n)})` : money(n));
const plain = (n) => (Math.abs(n) < 0.005 ? '' : money(n));
const num0 = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
const todayIso = () => new Date().toISOString().slice(0, 10);
const nice = (s) => (s ? String(s).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : '');

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

const accSel = el('select');
accSel.style.maxWidth = '300px';
const fromEl = el('input'); fromEl.type = 'date'; fromEl.style.width = 'auto';
const toEl = el('input'); toEl.type = 'date'; toEl.style.width = 'auto';
const searchEl = el('input'); searchEl.type = 'search'; searchEl.placeholder = 'Search lines'; searchEl.style.maxWidth = '190px';
const sizeSel = el('select', 'compact');
[100, 200, 500].forEach((n) => { const o = el('option', '', `${n} per page`); o.value = String(n); sizeSel.append(o); });
sizeSel.value = '200';
const progress = el('span', 'muted');
const runBtn = btn('Run', 'btn-primary', () => run());
const exportBtn = btn('Export to Excel', '', doExport);

const pageSize = () => Number(sizeSel.value);
const codeSort = (x, y) => String(x.r_code).localeCompare(String(y.r_code), undefined, { numeric: true });

async function init() {
  document.getElementById('company-title').textContent = ctx.company.name;
  const cid = ctx.companyId;
  const [a, fy, c] = await Promise.all([
    supabase.from('gl_accounts').select('id, code, name, is_posting').eq('company_id', cid).eq('is_posting', true).order('code'),
    supabase.from('fiscal_years').select('start_date, end_date').eq('company_id', cid).order('start_date'),
    supabase.from('company_currencies').select('code').eq('company_id', cid).eq('is_base', true).maybeSingle(),
  ]);
  for (const r of [a, fy, c]) if (r.error) { ui.errorFrom(r.error, 'Could not load the report setup.'); return; }
  accounts = a.data.sort((x, y) => x.code.localeCompare(y.code, undefined, { numeric: true }));
  base = c.data ? c.data.code : '';

  const all = el('option', '', 'All accounts');
  all.value = '';
  accSel.append(all);
  accounts.forEach((x) => { const o = el('option', '', `${x.code} - ${x.name}`); o.value = x.id; accSel.append(o); });

  const today = todayIso();
  const year = fy.data.find((y) => today >= y.start_date && today <= y.end_date);
  fromEl.value = year ? year.start_date : `${today.slice(0, 4)}-01-01`;
  toEl.value = today;
  searchEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  sizeSel.addEventListener('change', () => { if (view.acct) { view.page = 0; loadAccountPage(); } });

  toolbar.append(accSel, el('span', 'muted', 'From'), fromEl, el('span', 'muted', 'To'), toEl, searchEl, runBtn,
    el('span', 'spacer'), progress, exportBtn);
  hint.textContent = `Amounts in ${base}. Posted journals only. Brackets are credit balances. Income statement accounts restart at the start of the financial year, as on the trial balance. `
    + 'All accounts shows account totals: click an account to see its lines. Choose one account to page through its lines and search them.';
  panel.innerHTML = '<p class="muted">Choose the dates and press Run.</p>';
}

/* ---------- summary (all accounts) ---------- */

async function loadSummary(accountId) {
  const { data, error } = await supabase.rpc('period_balance_summary', {
    p_company: ctx.companyId, p_from: fromEl.value, p_to: toEl.value, p_account: accountId || null,
  });
  if (error) throw error;
  return data.map((r) => ({
    ...r, r_opening: Number(r.r_opening), r_debit: Number(r.r_debit), r_credit: Number(r.r_credit),
    r_closing: Number(r.r_closing), r_lines: Number(r.r_lines),
  })).sort(codeSort);
}

function renderSummary() {
  view = { acct: null, page: 0, total: 0 };
  if (!summary.length) { panel.innerHTML = '<p class="muted">No activity for the chosen dates.</p>'; return; }
  const tdr = summary.reduce((s, b) => s + b.r_debit, 0);
  const tcr = summary.reduce((s, b) => s + b.r_credit, 0);
  const tl = summary.reduce((s, b) => s + b.r_lines, 0);
  const th = (t, right) => `<th${right ? ' style="text-align:right"' : ''}>${t}</th>`;
  const body = summary.map((b) => `<tr class="clickable" data-id="${b.r_account_id}"><td>${esc(b.r_code)}</td><td>${esc(b.r_name)}</td>
    <td class="num">${signed(b.r_opening)}</td><td class="num">${plain(b.r_debit)}</td><td class="num">${plain(b.r_credit)}</td>
    <td class="num">${signed(b.r_closing)}</td><td class="num">${num0(b.r_lines)}</td></tr>`).join('');
  panel.innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr>${th('Code')}${th('Account')}${th('Opening', 1)}${th('Debit', 1)}${th('Credit', 1)}${th('Closing', 1)}${th('Lines', 1)}</tr></thead>
    <tbody>${body}<tr class="row-root"><td></td><td>Total</td><td></td><td class="num">${money(tdr)}</td><td class="num">${money(tcr)}</td><td></td><td class="num">${num0(tl)}</td></tr></tbody></table></div>`;
}

panel.addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr || busy) return;
  accSel.value = tr.dataset.id;
  run();
});

/* ---------- one account, paged ---------- */

async function loadAccountPage() {
  const a = view.acct;
  panel.innerHTML = '<p class="muted">Loading...</p>';
  const size = pageSize();
  let res;
  try {
    res = await supabase.rpc('gl_lines_page', {
      p_company: ctx.companyId, p_from: fromEl.value, p_to: toEl.value, p_account: a.r_account_id,
      p_search: searchEl.value.trim() || null, p_offset: view.page * size, p_limit: size, p_opening: a.r_opening,
    });
    if (res.error) throw res.error;
  } catch (e) { panel.innerHTML = ''; return ui.errorFrom(e, 'Could not load the general ledger.'); }
  const rows = res.data;
  view.total = rows.length ? Number(rows[0].r_total) : (view.page === 0 ? 0 : view.total);
  if (!rows.length && view.page > 0) { view.page = 0; return loadAccountPage(); }
  renderAccount(rows, size);
}

function renderAccount(rows, size) {
  const a = view.acct;
  const filtered = !!searchEl.value.trim();
  const first = view.total ? view.page * size + 1 : 0;
  const last = Math.min(view.total, view.page * size + rows.length);
  const lastPage = last >= view.total;
  const th = (t, right) => `<th${right ? ' style="text-align:right"' : ''}>${t}</th>`;

  const head = el('div');
  head.style.cssText = 'display:flex;gap:.6rem;align-items:center;flex-wrap:wrap;margin-bottom:.6rem';
  const back = btn('All accounts', 'btn-ghost', () => { accSel.value = ''; searchEl.value = ''; run(); });
  const prev = btn('Previous', '', () => { view.page -= 1; loadAccountPage(); });
  const next = btn('Next', '', () => { view.page += 1; loadAccountPage(); });
  prev.disabled = view.page === 0;
  next.disabled = lastPage;
  const title = el('strong', '', `${a.r_code} - ${a.r_name}`);
  const info = el('span', 'muted', view.total
    ? `Lines ${num0(first)} to ${num0(last)} of ${num0(view.total)}${filtered ? ' matching your search' : ''}`
    : (filtered ? 'No lines match your search.' : 'No lines in this period.'));
  head.append(back, title, el('span', 'spacer'), info, prev, next);

  const body = rows.map((r) => {
    const dr = Number(r.r_debit);
    const cr = Number(r.r_credit);
    const orig = r.r_currency === base ? '' : `${esc(r.r_currency)} ${signed(Number(r.r_trx_debit) - Number(r.r_trx_credit))}`;
    return `<tr><td>${r.r_date}</td><td>${esc(r.r_journal_no || '')}</td><td>${esc(nice(r.r_source))}</td><td>${esc(r.r_description || '')}</td>
      <td>${esc(r.r_reference || '')}</td><td>${esc(r.r_party || '')}</td><td class="num">${orig}</td>
      <td class="num">${plain(dr)}</td><td class="num">${plain(cr)}</td><td class="num">${signed(Number(r.r_balance))}</td></tr>`;
  }).join('');
  const openRow = view.page === 0
    ? `<tr><td colspan="9">Opening balance at ${esc(fromEl.value)}</td><td class="num">${signed(a.r_opening)}</td></tr>` : '';
  const closeRow = lastPage
    ? `<tr class="row-root"><td colspan="7">Period total and closing balance at ${esc(toEl.value)}</td><td class="num">${money(a.r_debit)}</td>
      <td class="num">${money(a.r_credit)}</td><td class="num">${signed(a.r_closing)}</td></tr>` : '';
  const wrap = el('div', 'table-wrap');
  wrap.innerHTML = `<table class="grid"><thead><tr>${th('Date')}${th('Journal')}${th('Source')}${th('Description')}${th('Reference')}${th('Customer / supplier')}
    ${th('Original', 1)}${th(`Debit (${esc(base)})`, 1)}${th(`Credit (${esc(base)})`, 1)}${th('Balance', 1)}</tr></thead><tbody>${openRow}${body}${closeRow}</tbody></table>`;
  panel.replaceChildren(head, wrap);
}

/* ---------- run ---------- */

async function run() {
  if (busy) return;
  if (!fromEl.value || !toEl.value) return ui.warn('Choose both dates.');
  if (fromEl.value > toEl.value) return ui.warn('The from date must not be after the to date.');
  if (!accSel.value && searchEl.value.trim()) ui.warn('Choose an account to search its lines.');
  panel.innerHTML = '<p class="muted">Loading...</p>';
  try {
    summary = await loadSummary(accSel.value);
  } catch (e) { panel.innerHTML = ''; return ui.errorFrom(e, 'Could not load the general ledger.'); }
  ran = true;
  if (!accSel.value) { renderSummary(); return; }
  const a = summary[0] || (() => {
    const x = accounts.find((y) => y.id === accSel.value);
    return { r_account_id: accSel.value, r_code: x ? x.code : '', r_name: x ? x.name : '', r_opening: 0, r_debit: 0, r_credit: 0, r_closing: 0, r_lines: 0 };
  })();
  view = { acct: a, page: 0, total: 0 };
  await loadAccountPage();
}

/* ---------- export (fetched in chunks so very large ledgers stay possible) ---------- */

function monthChunks(from, to) {
  const out = [];
  let s = from;
  while (s <= to) {
    const d = new Date(`${s}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 1, 0);
    let e = d.toISOString().slice(0, 10);
    if (e > to) e = to;
    out.push([s, e]);
    const n = new Date(`${e}T00:00:00Z`);
    n.setUTCDate(n.getUTCDate() + 1);
    s = n.toISOString().slice(0, 10);
  }
  return out;
}

async function fetchRange(acctId, from, to) {
  const out = [];
  for (let off = 0; ; off += API_PAGE) {
    const { data, error } = await supabase.rpc('gl_lines_page', {
      p_company: ctx.companyId, p_from: from, p_to: to, p_account: acctId,
      p_search: null, p_offset: off, p_limit: API_PAGE, p_opening: 0,
    });
    if (error) throw error;
    out.push(...data);
    if (data.length < API_PAGE) break;
  }
  return out;
}

async function fetchAccountLines(a) {
  if (a.r_lines <= DIRECT_LIMIT) return fetchRange(a.r_account_id, fromEl.value, toEl.value);
  const out = [];
  for (const [s, e] of monthChunks(fromEl.value, toEl.value)) out.push(...await fetchRange(a.r_account_id, s, e));
  return out;
}

async function pool(list, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, list.length) }, async () => {
    while (i < list.length) { const k = i; i += 1; await fn(list[k], k); }
  });
  await Promise.all(workers);
}

async function doExport() {
  if (busy) return;
  if (!ran || !summary.length) return ui.warn('Run the report first.');
  const total = summary.reduce((s, b) => s + b.r_lines, 0);
  if (total + summary.length * 2 > EXCEL_MAX) {
    return ui.warn(`This export has ${num0(total)} lines, more than one Excel sheet can hold. Choose a shorter period or a single account.`);
  }
  if (total > EXCEL_WARN) {
    const ok = await ui.confirm({
      title: 'Large export',
      message: `This export has ${num0(total)} lines. Reading and building it can take a few minutes. Keep this tab open. Continue?`,
      confirmText: 'Continue',
    });
    if (!ok) return;
  }
  busy = true;
  runBtn.disabled = true;
  exportBtn.disabled = true;
  try {
    const results = new Array(summary.length);
    let done = 0;
    let linesRead = 0;
    await pool(summary, 4, async (a, k) => {
      results[k] = a.r_lines ? await fetchAccountLines(a) : [];
      done += 1;
      linesRead += results[k].length;
      progress.textContent = `Reading ${done} of ${summary.length} accounts (${num0(linesRead)} lines)...`;
    });

    progress.textContent = 'Building the file...';
    const out = [];
    summary.forEach((b, k) => {
      const head = { code: b.r_code, account: b.r_name };
      out.push({ ...head, date: fromEl.value, jno: '', source: '', desc: 'Opening balance', ref: '', party: '', cur: '', fdr: '', fcr: '', rate: '', dr: '', cr: '', bal: b.r_opening });
      let bal = b.r_opening;
      results[k].forEach((r) => {
        const dr = Number(r.r_debit);
        const cr = Number(r.r_credit);
        bal += dr - cr;
        out.push({
          ...head, date: r.r_date, jno: r.r_journal_no || '', source: nice(r.r_source), desc: r.r_description || '', ref: r.r_reference || '',
          party: r.r_party || '', cur: r.r_currency, fdr: Number(r.r_trx_debit) || '', fcr: Number(r.r_trx_credit) || '',
          rate: r.r_currency === base ? '' : Number(r.r_rate), dr: dr || '', cr: cr || '', bal,
        });
      });
      out.push({ ...head, date: toEl.value, jno: '', source: '', desc: 'Closing balance', ref: '', party: '', cur: '', fdr: '', fcr: '', rate: '', dr: '', cr: '', bal: b.r_closing });
      results[k] = null;
    });
    await exportSheets(`general-ledger-${fromEl.value}-to-${toEl.value}.xlsx`, [{
      name: 'General ledger', title: 'General ledger',
      subtitle: `${fromEl.value} to ${toEl.value}, amounts in ${base}${accSel.value ? `, ${accSel.options[accSel.selectedIndex].text}` : ''}`,
      rows: out,
      columns: [
        { key: 'code', header: 'Account code', width: 14 }, { key: 'account', header: 'Account', width: 32 },
        { key: 'date', header: 'Date', width: 12 }, { key: 'jno', header: 'Journal', width: 14 },
        { key: 'source', header: 'Source', width: 14 }, { key: 'desc', header: 'Description', width: 36 },
        { key: 'ref', header: 'Reference', width: 18 }, { key: 'party', header: 'Customer / supplier', width: 28 },
        { key: 'cur', header: 'Currency', width: 10 },
        { key: 'fdr', header: 'Original debit', width: 16 }, { key: 'fcr', header: 'Original credit', width: 16 },
        { key: 'rate', header: 'Rate', width: 12 },
        { key: 'dr', header: `Debit (${base})`, width: 16 }, { key: 'cr', header: `Credit (${base})`, width: 16 },
        { key: 'bal', header: `Balance (${base})`, width: 18 },
      ],
    }]);
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