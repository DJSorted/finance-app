import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { exportSheets } from '../core/export.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const accountsBox = document.getElementById('accounts');
const hint = document.getElementById('hint');
const panel = document.getElementById('panel');

const API_PAGE = 1000;            // the database returns at most 1000 rows per request
const LINE_LIMIT = 50000;         // more lines than this across the chosen accounts: ask for a shorter period
const PICK_KEY = () => `bank-trx-accounts-${ctx.companyId}`;

let banks = [];
let base = '';
let report = [];                  // [{ acct, sum, lines }] for the last run
let ran = false;
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

const fromEl = el('input'); fromEl.type = 'date'; fromEl.style.width = 'auto';
const toEl = el('input'); toEl.type = 'date'; toEl.style.width = 'auto';
const searchEl = el('input'); searchEl.type = 'search'; searchEl.placeholder = 'Filter lines'; searchEl.style.maxWidth = '190px';
const dirSel = el('select', 'compact');
[['all', 'Money in and out'], ['in', 'Money in only'], ['out', 'Money out only']].forEach(([v, t]) => { const o = el('option', '', t); o.value = v; dirSel.append(o); });
const progress = el('span', 'muted');
const runBtn = btn('Run', 'btn-primary', () => run());
const exportBtn = btn('Export to Excel', '', doExport);
const checks = new Map();         // account id -> checkbox

async function init() {
  document.getElementById('company-title').textContent = ctx.company.name;
  const cid = ctx.companyId;
  const [a, fy, c] = await Promise.all([
    supabase.from('gl_accounts').select('id, code, name, currency_code, is_active').eq('company_id', cid)
      .eq('control_type', 'bank').eq('is_posting', true).order('code'),
    supabase.from('fiscal_years').select('start_date, end_date').eq('company_id', cid).order('start_date'),
    supabase.from('company_currencies').select('code').eq('company_id', cid).eq('is_base', true).maybeSingle(),
  ]);
  for (const r of [a, fy, c]) if (r.error) { ui.errorFrom(r.error, 'Could not load the report setup.'); return; }
  banks = a.data.sort((x, y) => x.code.localeCompare(y.code, undefined, { numeric: true }));
  base = c.data ? c.data.code : '';

  if (!banks.length) {
    panel.innerHTML = '<p class="muted">There are no bank accounts. Mark the bank accounts in the Chart of Accounts as bank control accounts first.</p>';
    return;
  }

  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(PICK_KEY()) || 'null'); } catch (e) { /* ignore */ }
  accountsBox.append(el('strong', '', 'Bank accounts:'));
  banks.forEach((b) => {
    const lab = el('label');
    lab.style.cssText = 'display:inline-flex;gap:.35rem;align-items:center;cursor:pointer;white-space:nowrap';
    const cb = el('input');
    cb.type = 'checkbox';
    cb.style.width = 'auto';
    cb.checked = Array.isArray(saved) ? saved.includes(b.id) : b.is_active;
    checks.set(b.id, cb);
    lab.append(cb, document.createTextNode(`${b.code} - ${b.name}${b.currency_code && b.currency_code !== base ? ` (${b.currency_code})` : ''}${b.is_active ? '' : ' (inactive)'}`));
    accountsBox.append(lab);
  });
  const setAll = (v) => checks.forEach((cb) => { cb.checked = v; });
  accountsBox.append(btn('All', 'btn-sm btn-ghost', () => setAll(true)), btn('None', 'btn-sm btn-ghost', () => setAll(false)));

  const today = todayIso();
  const year = fy.data.find((y) => today >= y.start_date && today <= y.end_date);
  fromEl.value = `${today.slice(0, 8)}01`;
  if (year && fromEl.value < year.start_date) fromEl.value = year.start_date;
  toEl.value = today;
  searchEl.addEventListener('input', () => { if (ran) render(); });
  dirSel.addEventListener('change', () => { if (ran) render(); });

  toolbar.append(el('span', 'muted', 'From'), fromEl, el('span', 'muted', 'To'), toEl, runBtn, dirSel, searchEl,
    el('span', 'spacer'), progress, exportBtn);
  hint.textContent = `Posted journals only. Amounts in ${base}: money in is a debit to the bank account, money out a credit. `
    + 'Foreign currency bank lines also show the original amount. Tick the accounts, choose the dates and press Run.';
  panel.innerHTML = '<p class="muted">Choose the accounts and dates and press Run.</p>';
}

/* ---------- data ---------- */

async function fetchLines(acctId) {
  const out = [];
  for (let off = 0; ; off += API_PAGE) {
    const { data, error } = await supabase.rpc('gl_lines_page', {
      p_company: ctx.companyId, p_from: fromEl.value, p_to: toEl.value, p_account: acctId,
      p_search: null, p_offset: off, p_limit: API_PAGE, p_opening: 0,
    });
    if (error) throw error;
    out.push(...data);
    if (data.length < API_PAGE) break;
  }
  return out;
}

async function run() {
  if (busy) return;
  const picked = banks.filter((b) => checks.get(b.id).checked);
  if (!picked.length) return ui.warn('Tick at least one bank account.');
  if (!fromEl.value || !toEl.value) return ui.warn('Choose both dates.');
  if (fromEl.value > toEl.value) return ui.warn('The from date must not be after the to date.');
  try { localStorage.setItem(PICK_KEY(), JSON.stringify(picked.map((b) => b.id))); } catch (e) { /* ignore */ }

  busy = true;
  runBtn.disabled = true;
  exportBtn.disabled = true;
  panel.innerHTML = '<p class="muted">Loading...</p>';
  try {
    const sums = await Promise.all(picked.map(async (b) => {
      const { data, error } = await supabase.rpc('period_balance_summary', {
        p_company: ctx.companyId, p_from: fromEl.value, p_to: toEl.value, p_account: b.id,
      });
      if (error) throw error;
      const r = data[0];
      return r
        ? { opening: Number(r.r_opening), debit: Number(r.r_debit), credit: Number(r.r_credit), closing: Number(r.r_closing), lines: Number(r.r_lines) }
        : { opening: 0, debit: 0, credit: 0, closing: 0, lines: 0 };
    }));
    const total = sums.reduce((s, x) => s + x.lines, 0);
    if (total > LINE_LIMIT) {
      panel.innerHTML = '';
      ui.warn(`These accounts have ${num0(total)} lines in the period. Choose a shorter period or fewer accounts (${num0(LINE_LIMIT)} at most).`);
      return;
    }
    report = [];
    for (let i = 0; i < picked.length; i += 1) {
      progress.textContent = `Reading ${i + 1} of ${picked.length} accounts...`;
      report.push({ acct: picked[i], sum: sums[i], lines: sums[i].lines ? await fetchLines(picked[i].id) : [] });
    }
    ran = true;
    render();
  } catch (e) {
    panel.innerHTML = '';
    ui.errorFrom(e, 'Could not load the bank transactions.');
  } finally {
    progress.textContent = '';
    busy = false;
    runBtn.disabled = false;
    exportBtn.disabled = false;
  }
}

/* ---------- screen ---------- */

// Lines after the in / out and text filters. The running balance is always worked out over every line.
function shownLines(entry) {
  const q = searchEl.value.trim().toLowerCase();
  const dir = dirSel.value;
  let bal = entry.sum.opening;
  const out = [];
  entry.lines.forEach((r) => {
    const dr = Number(r.r_debit);
    const cr = Number(r.r_credit);
    bal += dr - cr;
    if (dir === 'in' && !(dr > 0)) return;
    if (dir === 'out' && !(cr > 0)) return;
    if (q && ![r.r_journal_no, r.r_source, r.r_description, r.r_reference, r.r_party, money(dr), money(cr)]
      .some((x) => String(x || '').toLowerCase().includes(q))) return;
    out.push({ r, dr, cr, bal });
  });
  return out;
}

function render() {
  const filtered = !!searchEl.value.trim() || dirSel.value !== 'all';
  const th = (t, right) => `<th${right ? ' style="text-align:right"' : ''}>${t}</th>`;

  const tot = report.reduce((s, x) => ({
    opening: s.opening + x.sum.opening, debit: s.debit + x.sum.debit, credit: s.credit + x.sum.credit,
    closing: s.closing + x.sum.closing, lines: s.lines + x.sum.lines,
  }), { opening: 0, debit: 0, credit: 0, closing: 0, lines: 0 });
  const sumRows = report.map((x) => `<tr class="clickable" data-jump="${x.acct.id}"><td>${esc(x.acct.code)}</td><td>${esc(x.acct.name)}</td>
    <td class="num">${signed(x.sum.opening)}</td><td class="num">${plain(x.sum.debit)}</td><td class="num">${plain(x.sum.credit)}</td>
    <td class="num">${signed(x.sum.debit - x.sum.credit)}</td><td class="num">${signed(x.sum.closing)}</td><td class="num">${num0(x.sum.lines)}</td></tr>`).join('');
  const summary = `<h3 style="margin-top:0">Summary, ${esc(fromEl.value)} to ${esc(toEl.value)}</h3>
    <div class="table-wrap"><table class="grid"><thead><tr>${th('Code')}${th('Bank account')}${th('Opening', 1)}${th('Money in', 1)}${th('Money out', 1)}${th('Net movement', 1)}${th('Closing', 1)}${th('Lines', 1)}</tr></thead>
    <tbody>${sumRows}${report.length > 1 ? `<tr class="row-root"><td></td><td>Total</td><td class="num">${signed(tot.opening)}</td><td class="num">${money(tot.debit)}</td>
      <td class="num">${money(tot.credit)}</td><td class="num">${signed(tot.debit - tot.credit)}</td><td class="num">${signed(tot.closing)}</td><td class="num">${num0(tot.lines)}</td></tr>` : ''}</tbody></table></div>`;

  const sections = report.map((x) => {
    const foreign = x.acct.currency_code && x.acct.currency_code !== base;
    const list = shownLines(x);
    const body = list.map(({ r, dr, cr, bal }) => {
      const orig = r.r_currency === base ? '' : `${esc(r.r_currency)} ${signed(Number(r.r_trx_debit) - Number(r.r_trx_credit))}`;
      return `<tr><td>${r.r_date}</td><td>${esc(r.r_journal_no || '')}</td><td>${esc(nice(r.r_source))}</td><td>${esc(r.r_description || '')}</td>
        <td>${esc(r.r_reference || '')}</td><td>${esc(r.r_party || '')}</td><td class="num">${orig}</td>
        <td class="num">${plain(dr)}</td><td class="num">${plain(cr)}</td><td class="num">${signed(bal)}</td></tr>`;
    }).join('');
    const shownIn = list.reduce((s, l) => s + l.dr, 0);
    const shownOut = list.reduce((s, l) => s + l.cr, 0);
    const empty = !list.length ? `<tr><td colspan="10" class="muted">${filtered ? 'No lines match the filter.' : 'No transactions in this period.'}</td></tr>` : '';
    return `<h3 id="acct-${x.acct.id}" style="margin-top:1.5rem">${esc(x.acct.code)} - ${esc(x.acct.name)}${foreign ? ` <span class="muted">(${esc(x.acct.currency_code)} account, amounts in ${esc(base)})</span>` : ''}</h3>
      <div class="table-wrap"><table class="grid"><thead><tr>${th('Date')}${th('Journal')}${th('Source')}${th('Description')}${th('Reference')}${th('Customer / supplier')}
        ${th('Original', 1)}${th(`Money in (${esc(base)})`, 1)}${th(`Money out (${esc(base)})`, 1)}${th('Balance', 1)}</tr></thead>
      <tbody><tr><td colspan="9">Opening balance at ${esc(fromEl.value)}</td><td class="num">${signed(x.sum.opening)}</td></tr>${empty}${body}
        <tr class="row-root"><td colspan="7">${filtered ? `Shown lines (${num0(list.length)} of ${num0(x.lines.length)})` : 'Period total'} and closing balance at ${esc(toEl.value)}</td>
        <td class="num">${money(filtered ? shownIn : x.sum.debit)}</td><td class="num">${money(filtered ? shownOut : x.sum.credit)}</td><td class="num">${signed(x.sum.closing)}</td></tr></tbody></table></div>`;
  }).join('');

  panel.innerHTML = summary + sections;
}

panel.addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-jump]');
  if (!tr) return;
  const h = document.getElementById(`acct-${tr.dataset.jump}`);
  if (h) h.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

/* ---------- export ---------- */

async function doExport() {
  if (busy) return;
  if (!ran || !report.length) return ui.warn('Run the report first.');
  try {
    const filtered = !!searchEl.value.trim() || dirSel.value !== 'all';
    const lines = [];
    report.forEach((x) => {
      const head = { code: x.acct.code, account: x.acct.name };
      lines.push({ ...head, date: fromEl.value, jno: '', source: '', desc: 'Opening balance', ref: '', party: '', cur: '', orig: '', rate: '', dr: '', cr: '', bal: x.sum.opening });
      shownLines(x).forEach(({ r, dr, cr, bal }) => {
        lines.push({
          ...head, date: r.r_date, jno: r.r_journal_no || '', source: nice(r.r_source), desc: r.r_description || '', ref: r.r_reference || '',
          party: r.r_party || '', cur: r.r_currency, orig: r.r_currency === base ? '' : Number(r.r_trx_debit) - Number(r.r_trx_credit),
          rate: r.r_currency === base ? '' : Number(r.r_rate), dr: dr || '', cr: cr || '', bal,
        });
      });
      lines.push({ ...head, date: toEl.value, jno: '', source: '', desc: 'Closing balance', ref: '', party: '', cur: '', orig: '', rate: '', dr: '', cr: '', bal: x.sum.closing });
    });
    const period = `${fromEl.value} to ${toEl.value}, amounts in ${base}`;
    await exportSheets(`bank-transactions-${fromEl.value}-to-${toEl.value}.xlsx`, [
      {
        name: 'Summary', title: 'Bank transactions: summary', subtitle: period,
        rows: report.map((x) => ({
          code: x.acct.code, account: x.acct.name, cur: x.acct.currency_code || base, opening: x.sum.opening,
          dr: x.sum.debit, cr: x.sum.credit, net: x.sum.debit - x.sum.credit, closing: x.sum.closing, lines: x.sum.lines,
        })),
        columns: [
          { key: 'code', header: 'Account code', width: 14 }, { key: 'account', header: 'Bank account', width: 32 },
          { key: 'cur', header: 'Account currency', width: 12 },
          { key: 'opening', header: `Opening (${base})`, width: 18 }, { key: 'dr', header: `Money in (${base})`, width: 18 },
          { key: 'cr', header: `Money out (${base})`, width: 18 }, { key: 'net', header: `Net movement (${base})`, width: 18 },
          { key: 'closing', header: `Closing (${base})`, width: 18 }, { key: 'lines', header: 'Lines', width: 10 },
        ],
      },
      {
        name: 'Transactions', title: 'Bank transactions',
        subtitle: `${period}${filtered ? ' (filtered)' : ''}`,
        rows: lines,
        columns: [
          { key: 'code', header: 'Account code', width: 14 }, { key: 'account', header: 'Bank account', width: 28 },
          { key: 'date', header: 'Date', width: 12 }, { key: 'jno', header: 'Journal', width: 14 },
          { key: 'source', header: 'Source', width: 14 }, { key: 'desc', header: 'Description', width: 36 },
          { key: 'ref', header: 'Reference', width: 18 }, { key: 'party', header: 'Customer / supplier', width: 28 },
          { key: 'cur', header: 'Currency', width: 10 }, { key: 'orig', header: 'Original amount', width: 16, total: false },
          { key: 'rate', header: 'Rate', width: 12 },
          { key: 'dr', header: `Money in (${base})`, width: 16 }, { key: 'cr', header: `Money out (${base})`, width: 16 },
          { key: 'bal', header: `Balance (${base})`, width: 18 },
        ],
      },
    ]);
  } catch (e) { ui.errorFrom(e, 'Could not export.'); }
}

if (ctx) await init();
