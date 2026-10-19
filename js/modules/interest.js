import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { exportSheets } from '../core/export.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const panel = document.getElementById('panel');

const CAN_RUN = ctx ? ctx.canEdit : false;

let tab = 'run';
let preview = [];
let previewDate = '';
let skipped = new Set(); // customers unticked in the preview
let runs = [];
let settings = null;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rateFmt = (n) => `${Number(n).toLocaleString(undefined, { maximumFractionDigits: 4 })}%`;
const todayIso = () => new Date().toISOString().slice(0, 10);
const groupKey = (r) => `${r.customer_id}|${r.currency_code}`;
function btn(text, cls, onClick) {
  const b = el('button', `btn ${cls}`.trim(), text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}
function monthEndBefore() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0)).toISOString().slice(0, 10);
}

const dateEl = el('input'); dateEl.type = 'date'; dateEl.style.width = 'auto';

async function init() {
  document.getElementById('company-title').textContent = ctx.company.name;
  const { data, error } = await supabase.from('company_settings')
    .select('interest_rate, interest_grace_days, interest_account_id').eq('company_id', ctx.companyId).maybeSingle();
  if (error) return ui.errorFrom(error, 'Could not load the interest settings. Has sql/033_customer_interest.sql been run?');
  settings = data || {};
  dateEl.value = monthEndBefore();
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', async () => {
    tab = t.dataset.tab;
    if (tab === 'runs') await loadRuns();
    render();
  }));
  render();
}

function render() {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  toolbar.replaceChildren();
  if (tab === 'run') renderRun();
  else renderRuns();
}

/* ---------- charge interest ---------- */

function renderRun() {
  const rate = settings.interest_rate === null || settings.interest_rate === undefined ? 'not set' : `${rateFmt(settings.interest_rate)} a year`;
  hint.textContent = `Simple interest, daily: outstanding × rate × days ÷ 365, from ${Number(settings.interest_grace_days || 0)} day(s) after the due date `
    + `(company rate ${rate}; customers can have their own rate or none). Each run carries on from the last, so no day is charged twice. `
    + 'One invoice is posted per customer and currency, dated the run date.';
  toolbar.append(el('span', 'muted', 'Charge interest up to'), dateEl, btn('Preview', 'btn-primary', doPreview));
  if (CAN_RUN) toolbar.append(btn('Post interest', '', doPost));
  toolbar.append(el('span', 'spacer'), btn('Export to Excel', '', doExport));
  renderPreview();
}

async function doPreview() {
  if (!dateEl.value) return ui.warn('Choose the date.');
  const { data, error } = await supabase.rpc('interest_calc', { p_company: ctx.companyId, p_as_of: dateEl.value });
  if (error) return ui.errorFrom(error, 'Could not calculate the interest.');
  preview = data;
  previewDate = dateEl.value;
  skipped = new Set();
  renderPreview();
}

function groups() {
  const map = new Map();
  preview.forEach((r) => {
    const k = groupKey(r);
    if (!map.has(k)) map.set(k, { key: k, customer_id: r.customer_id, code: r.customer_code, name: r.customer_name, cur: r.currency_code, rows: [], total: 0 });
    const g = map.get(k);
    g.rows.push(r);
    g.total += Number(r.amount);
  });
  return [...map.values()];
}

function renderPreview() {
  if (!previewDate) { panel.innerHTML = '<p class="muted">Choose the date and click Preview.</p>'; return; }
  if (!preview.length) {
    panel.innerHTML = `<p class="muted">No interest to charge up to ${esc(previewDate)}. Nothing is overdue past the grace days, or no customer has a rate.</p>`;
    return;
  }
  const gs = groups();
  const totals = new Map();
  const live = gs.filter((g) => !skipped.has(g.customer_id));
  live.forEach((g) => totals.set(g.cur, (totals.get(g.cur) || 0) + g.total));
  const body = gs.map((g) => `<tr class="row-parent"><td><input type="checkbox" data-key="${esc(g.customer_id)}"${skipped.has(g.customer_id) ? '' : ' checked'}${CAN_RUN ? '' : ' disabled'} style="width:auto"></td>
      <td colspan="6"><a href="/pages/customer-statement.html?customer=${g.customer_id}">${esc(g.code)} - ${esc(g.name)}</a></td>
      <td>${esc(g.cur)}</td><td class="num">${money(g.total)}</td></tr>
    ${g.rows.map((r) => `<tr><td></td><td>${esc(r.doc_no)}</td><td>${r.due_date}</td><td class="num">${money(r.outstanding)}</td>
      <td class="num">${rateFmt(r.rate)}</td><td>${r.from_date}</td><td class="num">${r.days}</td><td></td><td class="num">${money(r.amount)}</td></tr>`).join('')}`).join('');
  const tot = [...totals.entries()].map(([c, v]) => `${money(v)} ${esc(c)}`).join(' · ') || '0.00';
  panel.innerHTML = `<p class="muted">Up to ${esc(previewDate)}: ${live.length} of ${gs.length} invoice(s) to post, ${tot}. Untick a customer to leave them out.</p>
    <div class="table-wrap"><table class="grid"><thead><tr><th></th><th>Invoice</th><th>Due</th><th style="text-align:right">Outstanding</th>
      <th style="text-align:right">Rate a year</th><th>From</th><th style="text-align:right">Days</th><th>Cur</th><th style="text-align:right">Interest</th></tr></thead>
      <tbody>${body}</tbody></table></div>`;
}

panel.addEventListener('change', (e) => {
  const cb = e.target.closest('input[data-key]');
  if (!cb) return;
  if (cb.checked) skipped.delete(cb.dataset.key); else skipped.add(cb.dataset.key);
  renderPreview();
});

async function doPost() {
  if (!preview.length) return ui.warn('Preview the interest first. There must be something to charge.');
  if (!settings.interest_account_id) return ui.warn('Set the interest income account on Company Defaults first.');
  const chosen = groups().filter((g) => !skipped.has(g.customer_id));
  if (!chosen.length) return ui.warn('Tick at least one customer.');
  const customers = [...new Set(chosen.map((g) => g.customer_id))];
  const ok = await ui.confirm({
    title: 'Post interest',
    message: `Post ${chosen.length} interest invoice(s) dated ${previewDate}?\nThe date must be in an open period. Interest invoices can be printed and sent from Invoices, and reversed with a credit note.`,
    confirmText: 'Post',
  });
  if (!ok) return;
  const { error } = await supabase.rpc('post_interest_run', { p_company: ctx.companyId, p_date: previewDate, p_customers: customers });
  if (error) return ui.errorFrom(error, 'Could not post the interest.');
  ui.success('Interest posted.');
  preview = [];
  previewDate = '';
  tab = 'runs';
  await loadRuns();
  render();
}

/* ---------- runs ---------- */

async function loadRuns() {
  const { data, error } = await supabase.from('interest_runs').select('*').eq('company_id', ctx.companyId)
    .order('run_date', { ascending: false }).order('created_at', { ascending: false }).limit(200);
  if (error) { ui.errorFrom(error, 'Could not load the runs.'); return; }
  runs = data;
}

function renderRuns() {
  hint.textContent = 'Click a run to see what was charged. To waive interest, credit the interest invoice; that period is not charged again.';
  toolbar.append(el('span', 'spacer'), btn('Export to Excel', '', doExport));
  if (!runs.length) { panel.innerHTML = '<p class="muted">No interest runs yet.</p>'; return; }
  panel.innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr><th>Run date</th><th style="text-align:right">Invoices</th><th>Posted</th></tr></thead>
    <tbody>${runs.map((r) => `<tr class="clickable" data-id="${r.id}"><td>${r.run_date}</td><td class="num">${r.invoices_count}</td>
      <td>${esc(new Date(r.created_at).toLocaleString())}</td></tr>`).join('')}</tbody></table></div>`;
}

async function runCharges(runId) {
  const { data, error } = await supabase.from('interest_charges')
    .select('*, customers(code, name), invoice:sales_documents!interest_charges_invoice_id_fkey(doc_no), doc:sales_documents!interest_charges_interest_doc_id_fkey(doc_no)')
    .eq('run_id', runId).order('created_at');
  if (error) throw error;
  return data;
}

panel.addEventListener('click', async (e) => {
  if (tab !== 'runs') return;
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  const run = runs.find((r) => r.id === tr.dataset.id);
  if (!run) return;
  let data;
  try { data = await runCharges(run.id); } catch (err) { return ui.errorFrom(err, 'Could not load the run.'); }
  const node = el('div', 'table-wrap');
  node.innerHTML = `<table class="grid"><thead><tr><th>Customer</th><th>Interest invoice</th><th>On invoice</th><th>From</th><th>To</th>
    <th style="text-align:right">Days</th><th style="text-align:right">Rate</th><th>Cur</th><th style="text-align:right">Interest</th></tr></thead><tbody>
    ${data.map((c) => `<tr><td>${esc(c.customers ? `${c.customers.code} - ${c.customers.name}` : '')}</td><td>${esc(c.doc ? c.doc.doc_no : '')}</td>
      <td>${esc(c.invoice ? c.invoice.doc_no : '')}</td><td>${c.from_date}</td><td>${c.to_date}</td><td class="num">${c.days}</td>
      <td class="num">${rateFmt(c.rate)}</td><td>${esc(c.currency_code)}</td><td class="num">${money(c.amount)}</td></tr>`).join('')}</tbody></table>`;
  await ui.dialog({ title: `Interest run ${run.run_date}`, node, wide: true, dismissValue: 'close',
    buttons: [{ label: 'Close', value: 'close', className: 'btn-ghost' }] });
});

/* ---------- export ---------- */

async function doExport() {
  try {
    if (tab === 'run') {
      if (!preview.length) return ui.warn('Preview the interest first.');
      await exportSheets(`interest-preview-${previewDate}.xlsx`, [{
        name: 'Interest',
        rows: preview.map((r) => ({ cust: `${r.customer_code} - ${r.customer_name}`, doc: r.doc_no, due: r.due_date, cur: r.currency_code,
          out: Number(r.outstanding), rate: Number(r.rate), from: r.from_date, days: r.days, amount: Number(r.amount) })),
        columns: [{ key: 'cust', header: 'Customer', width: 32 }, { key: 'doc', header: 'Invoice', width: 14 }, { key: 'due', header: 'Due', width: 12 },
          { key: 'cur', header: 'Currency', width: 10 }, { key: 'out', header: 'Outstanding', width: 14 }, { key: 'rate', header: 'Rate % a year', width: 12 },
          { key: 'from', header: 'From', width: 12 }, { key: 'days', header: 'Days', width: 8 }, { key: 'amount', header: 'Interest', width: 14 }],
      }]);
    } else {
      if (!runs.length) return ui.warn('There are no runs to export.');
      const all = (await Promise.all(runs.map((r) => runCharges(r.id).then((cs) => cs.map((c) => ({ ...c, run_date: r.run_date })))))).flat();
      await exportSheets(`interest-runs-${todayIso()}.xlsx`, [{
        name: 'Interest charged',
        rows: all.map((c) => ({ run: c.run_date, cust: c.customers ? `${c.customers.code} - ${c.customers.name}` : '', doc: c.doc ? c.doc.doc_no : '',
          inv: c.invoice ? c.invoice.doc_no : '', from: c.from_date, to: c.to_date, days: c.days, rate: Number(c.rate), cur: c.currency_code,
          out: Number(c.outstanding), amount: Number(c.amount) })),
        columns: [{ key: 'run', header: 'Run date', width: 12 }, { key: 'cust', header: 'Customer', width: 32 }, { key: 'doc', header: 'Interest invoice', width: 16 },
          { key: 'inv', header: 'On invoice', width: 14 }, { key: 'from', header: 'From', width: 12 }, { key: 'to', header: 'To', width: 12 },
          { key: 'days', header: 'Days', width: 8 }, { key: 'rate', header: 'Rate % a year', width: 12 }, { key: 'cur', header: 'Currency', width: 10 },
          { key: 'out', header: 'Outstanding', width: 14 }, { key: 'amount', header: 'Interest', width: 14 }],
      }]);
    }
  } catch (e) { ui.errorFrom(e, 'Could not export.'); }
}

if (ctx) await init();
