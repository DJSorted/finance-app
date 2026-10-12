import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { exportSheets } from '../core/export.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const panel = document.getElementById('panel');

const PAGE = 1000;          // the database returns at most 1000 rows per request, so the report is fetched in pages
const SHOW_LIMIT = 6000;    // above this many lines the screen shows account totals only; the export always has every line

let accounts = [];
let base = '';
let blocks = [];
let lineCount = 0;
let ran = false;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (n) => (n < 0 ? `(${money(-n)})` : money(n));
const plain = (n) => (Math.abs(n) < 0.005 ? '' : money(n));
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

  toolbar.append(accSel, el('span', 'muted', 'From'), fromEl, el('span', 'muted', 'To'), toEl,
    btn('Run', 'btn-primary', run), el('span', 'spacer'), btn('Export to Excel', '', doExport));
  hint.textContent = `Amounts in ${base}. Posted journals only. Brackets are credit balances. Income statement accounts restart at the start of the financial year, as on the trial balance.`;
  panel.innerHTML = '<p class="muted">Choose the dates and press Run.</p>';
}

async function fetchAll(params) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.rpc('general_ledger', params).range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

async function run() {
  if (!fromEl.value || !toEl.value) return ui.warn('Choose both dates.');
  panel.innerHTML = '<p class="muted">Loading...</p>';
  let rows;
  try {
    rows = await fetchAll({ p_company: ctx.companyId, p_from: fromEl.value, p_to: toEl.value, p_account: accSel.value || null });
  } catch (e) { panel.innerHTML = ''; return ui.errorFrom(e, 'Could not load the general ledger.'); }

  blocks = [];
  lineCount = 0;
  let cur = null;
  rows.forEach((r) => {
    if (!cur || cur.id !== r.r_account_id) {
      cur = { id: r.r_account_id, code: r.r_code, name: r.r_name, opening: 0, dr: 0, cr: 0, lines: [] };
      blocks.push(cur);
    }
    const dr = Number(r.r_debit);
    const cr = Number(r.r_credit);
    if (r.r_kind === 'opening') { cur.opening = dr - cr; return; }
    cur.dr += dr;
    cur.cr += cr;
    lineCount++;
    cur.lines.push({
      date: r.r_date, jno: r.r_journal_no || '', source: nice(r.r_source), desc: r.r_description || '', ref: r.r_reference || '',
      party: r.r_party || '', cur: r.r_currency, tdr: Number(r.r_trx_debit), tcr: Number(r.r_trx_credit), rate: Number(r.r_rate), dr, cr,
    });
  });
  blocks.forEach((b) => {
    let bal = b.opening;
    b.lines.forEach((l) => { bal += l.dr - l.cr; l.bal = bal; });
    b.closing = b.opening + b.dr - b.cr;
  });
  ran = true;
  render();
}

function render() {
  if (!blocks.length) { panel.innerHTML = '<p class="muted">No activity for the chosen account and dates.</p>'; return; }
  const tdr = blocks.reduce((s, b) => s + b.dr, 0);
  const tcr = blocks.reduce((s, b) => s + b.cr, 0);
  const th = (t, right) => `<th${right ? ' style="text-align:right"' : ''}>${t}</th>`;

  if (lineCount > SHOW_LIMIT) {
    const body = blocks.map((b) => `<tr><td>${esc(b.code)}</td><td>${esc(b.name)}</td><td class="num">${signed(b.opening)}</td>
      <td class="num">${plain(b.dr)}</td><td class="num">${plain(b.cr)}</td><td class="num">${signed(b.closing)}</td></tr>`).join('');
    panel.innerHTML = `<p class="muted">${lineCount.toLocaleString()} lines are too many to show on screen. Account totals are shown below. Choose a single account to see its lines, or use Export to Excel for everything.</p>
      <div class="table-wrap"><table class="grid"><thead><tr>${th('Code')}${th('Account')}${th('Opening', 1)}${th('Debit', 1)}${th('Credit', 1)}${th('Closing', 1)}</tr></thead>
      <tbody>${body}<tr class="row-root"><td></td><td>Total</td><td></td><td class="num">${money(tdr)}</td><td class="num">${money(tcr)}</td><td></td></tr></tbody></table></div>`;
    return;
  }

  const body = blocks.map((b) => {
    const lines = b.lines.map((l) => `<tr><td>${l.date}</td><td>${esc(l.jno)}</td><td>${esc(l.source)}</td><td>${esc(l.desc)}</td>
      <td>${esc(l.ref)}</td><td>${esc(l.party)}</td>
      <td class="num">${l.cur === base ? '' : `${esc(l.cur)} ${signed(l.tdr - l.tcr)}`}</td>
      <td class="num">${plain(l.dr)}</td><td class="num">${plain(l.cr)}</td><td class="num">${signed(l.bal)}</td></tr>`).join('');
    return `<tr class="row-parent"><td colspan="10"><strong>${esc(b.code)} - ${esc(b.name)}</strong></td></tr>
      <tr><td colspan="9">Opening balance at ${esc(fromEl.value)}</td><td class="num">${signed(b.opening)}</td></tr>
      ${lines}
      <tr class="row-root"><td colspan="7">Closing balance at ${esc(toEl.value)}</td><td class="num">${money(b.dr)}</td>
        <td class="num">${money(b.cr)}</td><td class="num">${signed(b.closing)}</td></tr>`;
  }).join('');
  panel.innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr>${th('Date')}${th('Journal')}${th('Source')}${th('Description')}${th('Reference')}${th('Customer / supplier')}
    ${th('Original', 1)}${th(`Debit (${esc(base)})`, 1)}${th(`Credit (${esc(base)})`, 1)}${th('Balance', 1)}</tr></thead>
    <tbody>${body}<tr class="row-root"><td colspan="7">Period total</td><td class="num">${money(tdr)}</td><td class="num">${money(tcr)}</td><td></td></tr></tbody></table></div>`;
}

async function doExport() {
  if (!ran || !blocks.length) return ui.warn('Run the report first.');
  try {
    const out = [];
    blocks.forEach((b) => {
      const head = { code: b.code, account: b.name };
      out.push({ ...head, date: fromEl.value, jno: '', source: '', desc: 'Opening balance', ref: '', party: '', cur: '', fdr: '', fcr: '', rate: '', dr: '', cr: '', bal: b.opening });
      b.lines.forEach((l) => out.push({
        ...head, date: l.date, jno: l.jno, source: l.source, desc: l.desc, ref: l.ref, party: l.party, cur: l.cur,
        fdr: l.tdr || '', fcr: l.tcr || '', rate: l.cur === base ? '' : l.rate, dr: l.dr || '', cr: l.cr || '', bal: l.bal,
      }));
      out.push({ ...head, date: toEl.value, jno: '', source: '', desc: 'Closing balance', ref: '', party: '', cur: '', fdr: '', fcr: '', rate: '', dr: '', cr: '', bal: b.closing });
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
  } catch (e) { ui.errorFrom(e, 'Could not export.'); }
}

if (ctx) await init();