import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { exportSheets } from '../core/export.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const recon = document.getElementById('recon');
const panel = document.getElementById('panel');

let base = '';
let rows = [];

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (n) => (Math.abs(n) < 0.005 ? '' : (n < 0 ? `(${money(-n)})` : money(n)));
const todayIso = () => new Date().toISOString().slice(0, 10);
function btn(text, cls, onClick) {
  const b = el('button', `btn ${cls}`.trim(), text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

const asOfEl = el('input');
asOfEl.type = 'date';
asOfEl.style.width = 'auto';
const basisEl = el('select', 'compact');
[['due', 'By due date'], ['document', 'By document date']].forEach(([v, l]) => {
  const o = el('option', '', l);
  o.value = v;
  basisEl.append(o);
});

async function init() {
  document.getElementById('company-title').textContent = ctx.company.name;
  const { data } = await supabase.from('company_currencies').select('code')
    .eq('company_id', ctx.companyId).eq('is_base', true).maybeSingle();
  base = data ? data.code : '';
  asOfEl.value = todayIso();
  toolbar.append(el('span', 'muted', 'As at'), asOfEl, basisEl, btn('Run', 'btn-primary', run),
    el('span', 'spacer'), btn('Export summary', '', exportSummary), btn('Export detail', '', exportDetail));
  hint.textContent = `Amounts in ${base}, at the rate each document was booked. Current means not yet overdue. Unapplied credits are credit notes, receipts and credit journals not yet matched to invoices. Brackets are credits.`;
  await run();
}

async function run() {
  if (!asOfEl.value) return ui.warn('Choose the date.');
  const [ag, rc] = await Promise.all([
    supabase.rpc('sales_ageing', { p_company: ctx.companyId, p_as_of: asOfEl.value, p_basis: basisEl.value }),
    supabase.rpc('sales_reconciliation', { p_company: ctx.companyId, p_as_of: asOfEl.value }),
  ]);
  if (ag.error) return ui.errorFrom(ag.error, 'Could not run the ageing.');
  rows = ag.data;
  render();
  renderRecon(rc);
}

function renderRecon(rc) {
  if (rc.error) { recon.innerHTML = ''; return; }
  const r = rc.data[0];
  const diff = Number(r.difference);
  const ok = Math.abs(diff) < 0.005;
  recon.innerHTML = `<div class="card" style="display:flex;gap:1.5rem;flex-wrap:wrap;align-items:center">
    <span class="badge ${ok ? 'open' : 'st-error'}">${ok ? 'Reconciled to the debtors control accounts' : 'Does not reconcile'}</span>
    <span class="muted">Sub-ledger ${money(r.subledger)} ${esc(base)}</span>
    <span class="muted">Ledger ${money(r.ledger)} ${esc(base)}</span>
    ${ok ? '' : `<span class="muted">Difference ${money(diff)}. Check for journals posted to a debtors account by an owner or admin override, or send me this figure.</span>`}
  </div>`;
}

function render() {
  if (!rows.length) { panel.innerHTML = '<p class="muted">No open debtor balances at this date.</p>'; return; }
  const sum = (k) => rows.reduce((s, r) => s + Number(r[k]), 0);
  const keys = ['not_due', 'd1_30', 'd31_60', 'd61_90', 'd90_plus', 'unapplied', 'total'];
  const body = rows.map((r) => `<tr>
    <td><a href="/pages/customer-statement.html?customer=${r.customer_id}">${esc(r.code)} - ${esc(r.name)}</a></td>
    ${keys.map((k) => `<td class="num">${fmt(Number(r[k]))}</td>`).join('')}</tr>`).join('');
  panel.innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr><th>Customer</th>
    <th style="text-align:right">Current</th><th style="text-align:right">1 - 30</th><th style="text-align:right">31 - 60</th>
    <th style="text-align:right">61 - 90</th><th style="text-align:right">Over 90</th>
    <th style="text-align:right">Unapplied credits</th><th style="text-align:right">Total</th></tr></thead>
    <tbody>${body}<tr class="row-root"><td>Total</td>${keys.map((k) => `<td class="num">${fmt(sum(k))}</td>`).join('')}</tr></tbody></table></div>`;
}

async function exportSummary() {
  if (!rows.length) return ui.warn('Run the report first.');
  try {
    await exportSheets(`debtors-ageing-${asOfEl.value}.xlsx`, [{
      name: 'Ageing',
      rows: rows.map((r) => ({
        code: r.code, name: r.name, current: Number(r.not_due), d30: Number(r.d1_30), d60: Number(r.d31_60),
        d90: Number(r.d61_90), over: Number(r.d90_plus), unapplied: Number(r.unapplied), total: Number(r.total),
      })),
      columns: [
        { key: 'code', header: 'Code', width: 12 }, { key: 'name', header: 'Customer', width: 34 },
        { key: 'current', header: `Current (${base})`, width: 16 }, { key: 'd30', header: '1 - 30', width: 14 },
        { key: 'd60', header: '31 - 60', width: 14 }, { key: 'd90', header: '61 - 90', width: 14 },
        { key: 'over', header: 'Over 90', width: 14 }, { key: 'unapplied', header: 'Unapplied credits', width: 18 },
        { key: 'total', header: 'Total', width: 16 },
      ],
    }]);
  } catch (e) { ui.errorFrom(e, 'Could not export.'); }
}

async function exportDetail() {
  if (!asOfEl.value) return ui.warn('Choose the date.');
  try {
    const [oi, cu] = await Promise.all([
      supabase.rpc('sales_open_items', { p_company: ctx.companyId, p_customer: null, p_as_of: asOfEl.value }),
      supabase.from('customers').select('id, code, name').eq('company_id', ctx.companyId),
    ]);
    if (oi.error) throw oi.error;
    if (cu.error) throw cu.error;
    const names = new Map(cu.data.map((c) => [c.id, c]));
    const KIND = { invoice: 'Invoice', credit_note: 'Credit note', receipt: 'Receipt', journal: 'Journal' };
    const rowsOut = oi.data.map((i) => {
      const c = names.get(i.customer_id) || {};
      const basisDate = basisEl.value === 'document' ? i.doc_date : i.due_date;
      const days = Math.round((new Date(`${asOfEl.value}T00:00:00Z`) - new Date(`${basisDate}T00:00:00Z`)) / 86400000);
      return {
        code: c.code || '', customer: c.name || '', kind: KIND[i.doc_kind] || i.doc_kind, no: i.doc_no || '', date: i.doc_date,
        due: i.due_date, currency: i.currency_code, rate: Number(i.fx_rate), original: Number(i.original),
        outstanding: Number(i.outstanding), base: Number(i.base_outstanding), days: Number(i.base_outstanding) > 0 ? days : '',
        reference: i.reference || '',
      };
    }).sort((a, b) => (a.code + a.date).localeCompare(b.code + b.date));
    await exportSheets(`debtors-open-items-${asOfEl.value}.xlsx`, [{
      name: 'Open items', rows: rowsOut,
      columns: [
        { key: 'code', header: 'Customer code', width: 14 }, { key: 'customer', header: 'Customer', width: 30 },
        { key: 'kind', header: 'Type', width: 12 }, { key: 'no', header: 'No', width: 14 },
        { key: 'date', header: 'Date', width: 12 }, { key: 'due', header: 'Due', width: 12 },
        { key: 'currency', header: 'Currency', width: 10 }, { key: 'rate', header: 'Rate', width: 12 },
        { key: 'original', header: 'Original', width: 14 }, { key: 'outstanding', header: 'Outstanding', width: 14 },
        { key: 'base', header: `Outstanding (${base})`, width: 18 }, { key: 'days', header: 'Days overdue', width: 12 },
        { key: 'reference', header: 'Reference', width: 18 },
      ],
    }]);
  } catch (e) { ui.errorFrom(e, 'Could not export.'); }
}

if (ctx) await init();