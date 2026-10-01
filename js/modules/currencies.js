import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';

const ctx = await startPage();

const TRX_TYPES = [
  ['*', 'Any other transaction'], ['sales_invoice', 'Sales invoice'], ['sales_credit_note', 'Sales credit note'],
  ['supplier_bill', 'Supplier bill'], ['supplier_credit_note', 'Supplier credit note'],
  ['customer_receipt', 'Customer receipt'], ['supplier_payment', 'Supplier payment'],
  ['stock_receipt', 'Stock receipt (goods received)'], ['asset_purchase', 'Asset purchase'], ['journal', 'Manual journal'],
];
const SOURCES = [
  ['auto', 'Company rate, else web rate'], ['market', 'Web rate only'], ['company', 'Company rate only'],
  ['fixed', 'Fixed rate'], ['manual', 'Entered manually on the document'],
];
const DATE_BASES = [
  ['document_date', 'Document date (invoice or bill date)'], ['trx_date', 'Payment / transaction date'],
  ['posting_date', 'Posting date'], ['due_date', 'Due date'], ['period_start', 'Start of the period'],
  ['period_end', 'End of the period'], ['prior_period_end', 'End of the previous period'], ['fixed_date', 'A fixed date'],
];
const label = (list, v) => (list.find((x) => x[0] === v) || [v, v])[1];
const opts = (list) => list.map(([value, l]) => ({ value, label: l }));

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const panel = document.getElementById('panel');

let tab = 'currencies';
let enabled = [];
let catalogue = [];
let companyRates = [];
let rules = [];
let usedCodes = new Set();
let liveRates = new Map();

const base = () => (enabled.find((c) => c.is_base) || {}).code || '';
const nameOf = (code) => (catalogue.find((c) => c.code === code) || {}).name || '';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const todayIso = () => new Date().toISOString().slice(0, 10);
const fmtRate = (n) => Number(n).toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 8 });

function btn(text, cls, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `btn ${cls}`.trim();
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}
function table(headers, body) {
  return `<div class="table-wrap"><table class="grid"><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
}
function actions(...acts) {
  if (!ctx.canEdit) return '';
  return `<div class="row-actions">${acts.map(([a, t]) => `<button class="btn btn-sm" data-act="${a}">${t}</button>`).join('')}</div>`;
}
function currencyOptions(includeAny) {
  const list = enabled.map((c) => ({ value: c.code, label: c.code + (c.is_base ? ' (base)' : '') }));
  return includeAny ? [{ value: '', label: 'Any currency' }, ...list] : list;
}

/* ---------- data ---------- */

async function load() {
  const cid = ctx.companyId;
  const [cc, cur, cr, ru, used] = await Promise.all([
    supabase.from('company_currencies').select('code, is_base').eq('company_id', cid).order('code'),
    supabase.from('currencies').select('code, name').order('code'),
    supabase.from('company_rates').select('*').eq('company_id', cid).order('rate_date', { ascending: false }).order('from_code'),
    supabase.from('fx_rate_rules').select('*').eq('company_id', cid).order('trx_type').order('currency_code', { nullsFirst: true }),
    supabase.from('gl_accounts').select('currency_code').eq('company_id', cid).not('currency_code', 'is', null),
  ]);
  for (const r of [cc, cur, cr, ru, used]) if (r.error) throw r.error;
  enabled = cc.data;
  catalogue = cur.data;
  companyRates = cr.data;
  rules = ru.data;
  usedCodes = new Set(used.data.map((a) => a.currency_code));
}

async function loadLive() {
  liveRates = new Map();
  const b = base();
  await Promise.all(enabled.filter((c) => !c.is_base).map(async (c) => {
    const { data, error } = await supabase.rpc('fx_rate', {
      p_company: ctx.companyId, p_from: c.code, p_to: b, p_date: todayIso(),
    });
    liveRates.set(c.code, error ? null : Number(data));
  }));
}

async function refresh() {
  try { await load(); await loadLive(); } catch (e) { ui.errorFrom(e, 'Could not load currencies and rates.'); }
  render();
}

/* ---------- render ---------- */

function render() {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  toolbar.replaceChildren();
  if (tab === 'currencies') renderCurrencies();
  else if (tab === 'rates') renderRates();
  else renderRules();
}

function renderCurrencies() {
  hint.textContent = 'Enabled currencies can be used on accounts, customers, suppliers and transactions. The base currency cannot change once transactions are posted.';
  if (ctx.canEdit) toolbar.append(btn('Add currency', 'btn-primary', addCurrency));
  const rows = enabled.map((c) => {
    const live = liveRates.get(c.code);
    const rate = c.is_base ? '' : (live ? `1 ${c.code} = ${fmtRate(live)} ${base()}` : '<span class="muted">No rate yet</span>');
    return `<tr data-code="${c.code}"><td>${c.code}</td><td>${esc(nameOf(c.code))}</td>
      <td>${c.is_base ? '<span class="badge open">Base</span>' : ''}</td>
      <td class="num">${rate}</td>
      <td>${c.is_base ? '' : actions(['remove', 'Remove'])}</td></tr>`;
  }).join('');
  panel.innerHTML = table(['Code', 'Name', '', 'Current rate (today)', ''], rows);
}

function renderRates() {
  hint.textContent = 'Company rates override web rates. A company rate stays in force until you enter a newer one for the same pair, and a reverse pair is inverted automatically.';
  if (ctx.canEdit) toolbar.append(btn('Add company rate', 'btn-primary', () => rateForm(null)));
  if (!companyRates.length) { panel.innerHTML = '<p class="muted">No company rates yet. Web rates are used automatically.</p>'; return; }
  const rows = companyRates.map((r) => `<tr data-key="${r.rate_date}|${r.from_code}|${r.to_code}">
    <td>${r.rate_date}</td><td>${r.from_code}</td><td>${r.to_code}</td>
    <td class="num">${fmtRate(r.rate)}</td><td>${actions(['edit', 'Edit'], ['del', 'Delete'])}</td></tr>`).join('');
  panel.innerHTML = table(['Date', 'From', 'To', 'Rate', ''], rows);
}

function renderRules() {
  hint.textContent = 'A rule says which rate a transaction type uses and which of its dates drives the conversion. The most specific active rule wins: type and currency, then type alone, then the fallback.';
  if (ctx.canEdit) toolbar.append(btn('Add rule', 'btn-primary', () => ruleForm(null)));
  toolbar.append(btn('Test a rate', '', testRate));
  const rows = rules.map((r) => `<tr data-id="${r.id}" class="${r.is_active ? '' : 'inactive'}">
    <td>${esc(label(TRX_TYPES, r.trx_type))}</td>
    <td>${r.currency_code || 'Any'}</td>
    <td>${esc(label(SOURCES, r.rate_source))}${r.rate_source === 'fixed' ? ` (${fmtRate(r.fixed_rate)})` : ''}</td>
    <td>${esc(label(DATE_BASES, r.date_basis))}${r.date_basis === 'fixed_date' ? ` (${r.fixed_date})` : ''}</td>
    <td>${r.is_active ? 'Yes' : 'No'}</td>
    <td>${esc(r.notes || '')}</td>
    <td>${actions(['edit', 'Edit'], ['del', 'Delete'])}</td></tr>`).join('');
  panel.innerHTML = table(['Transaction', 'Currency', 'Rate', 'Date used', 'Active', 'Notes', ''], rows);
}

/* ---------- currencies ---------- */

async function addCurrency() {
  const have = new Set(enabled.map((c) => c.code));
  const options = catalogue.filter((c) => !have.has(c.code)).map((c) => ({ value: c.code, label: `${c.code} - ${c.name}` }));
  if (!options.length) return ui.warn('All available currencies are already enabled.');
  const saved = await ui.form({
    title: 'Add currency',
    fields: [{ name: 'code', label: 'Currency', type: 'select', required: true, full: true,
      options: [{ value: '', label: 'Select a currency' }, ...options],
      hint: 'Web rates for a new currency arrive with the next scheduled rate fetch. Company rates can be entered straight away.' }],
    values: {},
    onSubmit: async (v) => {
      const { error } = await supabase.from('company_currencies').insert({ company_id: ctx.companyId, code: v.code, is_base: false });
      if (error) throw error;
    },
  });
  if (saved) { ui.created('Currency'); await refresh(); }
}

async function removeCurrency(code) {
  if (usedCodes.has(code)) return ui.warn(`${code} is restricted on one or more accounts. Change those accounts first.`);
  if (companyRates.some((r) => r.from_code === code || r.to_code === code)) {
    return ui.warn(`${code} has company rates. Delete those first.`);
  }
  if (!(await ui.confirmDelete('Currency'))) return;
  const { error } = await supabase.from('company_currencies').delete().eq('company_id', ctx.companyId).eq('code', code);
  if (error) return ui.errorFrom(error);
  ui.deleted('Currency');
  await refresh();
}

/* ---------- company rates ---------- */

async function rateForm(row) {
  const isEdit = !!row;
  const b = base();
  const saved = await ui.form({
    title: isEdit ? 'Edit company rate' : 'Add company rate',
    fields: [
      { name: 'rate_date', label: 'Effective from', type: 'date', required: true, disabled: isEdit },
      { name: 'rate', label: 'Rate', type: 'number', required: true, hint: '1 unit of the From currency in the To currency.' },
      { name: 'from_code', label: 'From', type: 'select', options: currencyOptions(false), required: true, disabled: isEdit },
      { name: 'to_code', label: 'To', type: 'select', options: currencyOptions(false), required: true, disabled: isEdit },
    ],
    values: row || { rate_date: todayIso(), to_code: b },
    onSubmit: async (v) => {
      if (!(v.rate > 0)) throw new Error('The rate must be greater than zero.');
      if (v.from_code === v.to_code) throw new Error('Choose two different currencies.');
      const q = isEdit
        ? supabase.from('company_rates').update({ rate: v.rate }).eq('company_id', ctx.companyId)
          .eq('rate_date', row.rate_date).eq('from_code', row.from_code).eq('to_code', row.to_code)
        : supabase.from('company_rates').insert({
          company_id: ctx.companyId, rate_date: v.rate_date, from_code: v.from_code, to_code: v.to_code, rate: v.rate,
        });
      const { error } = await q;
      if (error) {
        if (error.code === '23505') throw new Error('A rate already exists for that date and pair. Edit it instead.');
        throw error;
      }
    },
  });
  if (saved) { if (isEdit) ui.updated('Rate'); else ui.created('Rate'); await refresh(); }
}

async function deleteRate(row) {
  if (!(await ui.confirmDelete('Rate'))) return;
  const { error } = await supabase.from('company_rates').delete().eq('company_id', ctx.companyId)
    .eq('rate_date', row.rate_date).eq('from_code', row.from_code).eq('to_code', row.to_code);
  if (error) return ui.errorFrom(error);
  ui.deleted('Rate');
  await refresh();
}

/* ---------- rules ---------- */

async function ruleForm(row) {
  const isEdit = !!row;
  const saved = await ui.form({
    title: isEdit ? 'Edit rate rule' : 'Add rate rule',
    fields: [
      { name: 'trx_type', label: 'Transaction type', type: 'select', options: opts(TRX_TYPES), required: true, full: true },
      { name: 'currency_code', label: 'Currency', type: 'select', options: currencyOptions(true), full: true,
        hint: 'Leave on Any currency, or give one currency its own rule.' },
      { name: 'rate_source', label: 'Rate to use', type: 'select', options: opts(SOURCES), required: true, full: true },
      { name: 'date_basis', label: 'Date that drives the rate', type: 'select', options: opts(DATE_BASES), required: true, full: true },
      { name: 'fixed_rate', label: 'Fixed rate', type: 'number', hint: 'Only for the Fixed rate option.' },
      { name: 'fixed_date', label: 'Fixed date', type: 'date', hint: 'Only for the A fixed date option.' },
      { name: 'priority', label: 'Priority', type: 'number', hint: 'Lower wins when two rules tie.' },
      { name: 'is_active', label: 'Active', type: 'checkbox' },
      { name: 'notes', label: 'Notes', type: 'textarea', full: true },
    ],
    values: row ? { ...row, currency_code: row.currency_code || '', fixed_date: row.fixed_date || '', notes: row.notes || '' }
      : { trx_type: 'sales_invoice', rate_source: 'auto', date_basis: 'document_date', priority: 100, is_active: true },
    onSubmit: async (v) => {
      if (v.rate_source === 'fixed' && !(v.fixed_rate > 0)) throw new Error('Enter the fixed rate.');
      if (v.date_basis === 'fixed_date' && !v.fixed_date) throw new Error('Enter the fixed date.');
      const payload = {
        trx_type: v.trx_type, currency_code: v.currency_code || null, rate_source: v.rate_source, date_basis: v.date_basis,
        fixed_rate: v.rate_source === 'fixed' ? v.fixed_rate : null,
        fixed_date: v.date_basis === 'fixed_date' ? v.fixed_date : null,
        priority: v.priority ?? 100, is_active: v.is_active, notes: v.notes || null,
      };
      const q = isEdit
        ? supabase.from('fx_rate_rules').update(payload).eq('id', row.id)
        : supabase.from('fx_rate_rules').insert({ ...payload, company_id: ctx.companyId });
      const { error } = await q;
      if (error) {
        if (error.code === '23505') throw new Error('A rule already exists for that transaction type and currency.');
        throw error;
      }
    },
  });
  if (saved) { if (isEdit) ui.updated('Rule'); else ui.created('Rule'); await refresh(); }
}

async function deleteRule(row) {
  if (row.trx_type === '*' && !row.currency_code) return ui.warn('The fallback rule can be edited but not deleted.');
  if (!(await ui.confirmDelete('Rule'))) return;
  const { error } = await supabase.from('fx_rate_rules').delete().eq('id', row.id);
  if (error) return ui.errorFrom(error);
  ui.deleted('Rule');
  await refresh();
}

async function testRate() {
  const foreign = enabled.filter((c) => !c.is_base);
  if (!foreign.length) return ui.warn('Add a foreign currency first.');
  let result = null;
  const saved = await ui.form({
    title: 'Test a rate',
    submitText: 'Test',
    fields: [
      { name: 'trx_type', label: 'Transaction type', type: 'select', options: opts(TRX_TYPES.filter((t) => t[0] !== '*')), required: true, full: true },
      { name: 'currency', label: 'Currency', type: 'select', options: foreign.map((c) => ({ value: c.code, label: c.code })), required: true },
      { name: 'date', label: 'Document / payment date', type: 'date', required: true },
    ],
    values: { trx_type: 'sales_invoice', currency: foreign[0].code, date: todayIso() },
    onSubmit: async (v) => {
      const { data, error } = await supabase.rpc('resolve_fx_rate', {
        p_company: ctx.companyId, p_trx_type: v.trx_type, p_from: v.currency,
        p_doc_date: v.date, p_trx_date: v.date, p_posting_date: v.date,
      });
      if (error) throw error;
      result = { row: data[0], currency: v.currency };
    },
  });
  if (saved && result) {
    await ui.alert({
      title: 'Rate result',
      message: `1 ${result.currency} = ${fmtRate(result.row.rate)} ${base()}\nRate date: ${result.row.rate_date}\nSource: ${label(SOURCES, result.row.source)}`,
    });
  }
}

/* ---------- events ---------- */

panel.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-act]');
  if (!t || !ctx.canEdit) return;
  const tr = t.closest('tr');
  const act = t.dataset.act;
  if (tab === 'currencies') { if (act === 'remove') await removeCurrency(tr.dataset.code); return; }
  if (tab === 'rates') {
    const [date, from, to] = tr.dataset.key.split('|');
    const row = companyRates.find((r) => r.rate_date === date && r.from_code === from && r.to_code === to);
    if (!row) return;
    if (act === 'edit') await rateForm(row); else if (act === 'del') await deleteRate(row);
    return;
  }
  const row = rules.find((r) => r.id === tr.dataset.id);
  if (!row) return;
  if (act === 'edit') await ruleForm(row); else if (act === 'del') await deleteRule(row);
});

if (ctx) {
  document.getElementById('company-title').textContent = ctx.company.name;
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => { tab = t.dataset.tab; render(); }));
  await refresh();
}