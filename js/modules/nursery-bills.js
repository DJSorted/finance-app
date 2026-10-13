import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { exportSheets } from '../core/export.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const panel = document.getElementById('panel');

const CAN_WORK = ctx ? ['owner', 'admin', 'accountant', 'clerk'].includes(ctx.role) : false;
const PAGE = 1000;
const ACTIVE = ['growing', 'partly_released'];
const KINDS = [['other', 'Other costs'], ['labour', 'Labour'], ['overhead', 'Overheads']];
const KIND_LABEL = Object.fromEntries(KINDS);

let suppliers = [];
let batches = [];
let batchMap = new Map();
let base = '';
let lines = [];
let history = [];
let ran = false;
const selected = new Set();

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const todayIso = () => new Date().toISOString().slice(0, 10);

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
function option(select, value, text) { const o = el('option', '', text); o.value = value; select.append(o); }

const supSel = el('select'); supSel.style.maxWidth = '260px';
const fromEl = el('input'); fromEl.type = 'date'; fromEl.style.width = 'auto';
const toEl = el('input'); toEl.type = 'date'; toEl.style.width = 'auto';
const countEl = el('span', 'muted');

const rpcGo = async (fn, args) => { const { error } = await supabase.rpc(fn, { p_company: ctx.companyId, ...args }); if (error) throw error; };

async function init() {
  document.getElementById('company-title').textContent = ctx.company.name;
  const cid = ctx.companyId;
  const [s, b, c] = await Promise.all([
    supabase.from('suppliers').select('id, code, name').eq('company_id', cid).order('code'),
    supabase.from('nursery_batches').select('id, batch_no, name, status').eq('company_id', cid).order('batch_no', { ascending: false }).limit(1000),
    supabase.from('company_currencies').select('code').eq('company_id', cid).eq('is_base', true).maybeSingle(),
  ]);
  for (const r of [s, b, c]) if (r.error) { ui.errorFrom(r.error, 'Could not load the page setup.'); return; }
  suppliers = s.data;
  batches = b.data;
  batchMap = new Map(batches.map((x) => [x.id, x]));
  base = c.data ? c.data.code : '';

  option(supSel, '', 'All suppliers');
  suppliers.forEach((x) => option(supSel, x.id, `${x.code} - ${x.name}`));
  const from = new Date();
  from.setUTCDate(from.getUTCDate() - 180);
  fromEl.value = from.toISOString().slice(0, 10);
  toEl.value = todayIso();

  toolbar.append(supSel, el('span', 'muted', 'From'), fromEl, el('span', 'muted', 'To'), toEl, btn('Run', 'btn-primary', run), countEl, el('span', 'spacer'));
  if (CAN_WORK) toolbar.append(btn('Allocate selected', '', allocateSelected));
  toolbar.append(btn('Export to Excel', '', doExport));
  hint.textContent = `Posted supplier bill lines charged to an ordinary expense account, in ${base}, that have not been fully allocated. Allocating moves the cost out of the expense and into a batch's work in progress. Stock item lines are not shown.`;
  await run();
}

async function fetchLines() {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.rpc('nursery_bill_lines', {
      p_company: ctx.companyId, p_from: fromEl.value, p_to: toEl.value, p_supplier: supSel.value || null,
    }).range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

async function run() {
  if (!fromEl.value || !toEl.value) return ui.warn('Choose both dates.');
  try {
    const [l, h] = await Promise.all([
      fetchLines(),
      supabase.from('nursery_bill_allocations').select('*').eq('company_id', ctx.companyId)
        .order('alloc_date', { ascending: false }).order('created_at', { ascending: false }).limit(100),
    ]);
    if (h.error) throw h.error;
    lines = l;
    history = h.data;
  } catch (e) { return ui.errorFrom(e, 'Could not load the bill lines.'); }
  selected.clear();
  ran = true;
  render();
}

function updateCount() {
  const total = lines.reduce((s, l) => s + Number(l.r_remaining), 0);
  countEl.textContent = `${lines.length} line(s) · ${money(total)} ${base} left to allocate · ${selected.size} selected`;
}

function render() {
  const rows = lines.map((l) => `<tr data-id="${l.r_line_id}"><td><input type="checkbox" data-sel ${selected.has(l.r_line_id) ? 'checked' : ''} style="width:auto"></td>
    <td>${l.r_doc_date}</td><td>${esc(l.r_doc_no)}${l.r_supplier_ref ? ` <span class="muted">${esc(l.r_supplier_ref)}</span>` : ''}</td>
    <td>${esc(l.r_supplier)}</td><td>${esc(l.r_description || '')}</td><td>${esc(l.r_account)}</td>
    <td class="num">${l.r_currency === base ? '' : `${money(l.r_net)} ${esc(l.r_currency)}`}</td>
    <td class="num">${money(l.r_base)}</td><td class="num">${Number(l.r_allocated) ? money(l.r_allocated) : ''}</td>
    <td class="num"><strong>${money(l.r_remaining)}</strong></td>
    <td>${CAN_WORK ? '<button class="btn btn-sm" data-act="alloc">Allocate</button>' : ''}</td></tr>`).join('');
  const th = (t, right) => `<th${right ? ' style="text-align:right"' : ''}>${t}</th>`;
  const hrows = history.map((h) => {
    const b = batchMap.get(h.batch_id);
    return `<tr><td>${h.alloc_date}</td><td>${esc(b ? `${b.batch_no} - ${b.name}` : '')}</td><td>${esc(h.doc_no || '')}</td>
      <td>${esc(h.supplier_name || '')}</td><td>${esc(h.description || '')}</td><td>${esc(KIND_LABEL[h.kind] || h.kind)}</td>
      <td class="num">${money(h.amount)}</td></tr>`;
  }).join('');
  panel.innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr><th><input type="checkbox" data-all style="width:auto"></th>${th('Date')}${th('Bill')}${th('Supplier')}${th('Line')}${th('Account')}
    ${th('Original', 1)}${th(`Net (${esc(base)})`, 1)}${th('Allocated', 1)}${th('Left', 1)}<th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="11" class="muted">Nothing to allocate for these dates.</td></tr>'}</tbody></table></div>
    <h3 style="margin-top:1.2rem">Recent allocations</h3>
    ${history.length ? `<div class="table-wrap"><table class="grid"><thead><tr>${th('Date')}${th('Batch')}${th('Bill')}${th('Supplier')}${th('Line')}${th('Type')}${th('Amount', 1)}</tr></thead>
    <tbody>${hrows}</tbody></table></div><p class="muted">Showing the latest ${history.length} allocations.</p>` : '<p class="muted">No bill lines have been allocated yet.</p>'}`;
  updateCount();
}

panel.addEventListener('change', (e) => {
  if (e.target.matches('[data-all]')) {
    panel.querySelectorAll('input[data-sel]').forEach((c) => {
      c.checked = e.target.checked;
      const id = c.closest('tr').dataset.id;
      if (c.checked) selected.add(id); else selected.delete(id);
    });
  } else if (e.target.matches('input[data-sel]')) {
    const id = e.target.closest('tr').dataset.id;
    if (e.target.checked) selected.add(id); else selected.delete(id);
  } else return;
  updateCount();
});

panel.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act="alloc"]');
  if (!b) return;
  const line = lines.find((l) => l.r_line_id === b.closest('tr').dataset.id);
  if (line) await allocateOne(line);
});

function batchOptions() {
  const growing = batches.filter((b) => ACTIVE.includes(b.status));
  return [{ value: '', label: 'Select a batch' }].concat(growing.map((b) => ({ value: b.id, label: `${b.batch_no} - ${b.name}` })));
}
const kindOptions = () => KINDS.map(([value, label]) => ({ value, label }));

async function allocateOne(l) {
  if (batchOptions().length < 2) return ui.warn('There are no growing batches. Start a batch first.');
  const saved = await ui.form({
    title: 'Allocate to a batch', submitText: 'Allocate',
    fields: [
      { name: 'batch', label: 'Batch', type: 'select', required: true, full: true, options: batchOptions(),
        hint: `${l.r_doc_no}: ${l.r_description || l.r_account}. ${money(l.r_remaining)} ${base} is left on this line.` },
      { name: 'amount', label: `Amount (${base})`, type: 'number', required: true, hint: 'Allocate part of the line here and the rest to another batch if you need to.' },
      { name: 'kind', label: 'Cost type', type: 'select', required: true, options: kindOptions() },
      { name: 'date', label: 'Date', type: 'date', required: true, hint: 'The date of the journal that moves the cost into the batch. It must fall in an open period.' },
    ],
    values: { amount: Number(l.r_remaining), kind: 'other', date: todayIso(), batch: '' },
    onSubmit: async (v) => {
      if (!(v.amount > 0) || v.amount > Number(l.r_remaining) + 0.005) throw new Error(`Enter an amount up to ${money(l.r_remaining)}.`);
      await rpcGo('nursery_allocate_bill_line', { p_line: l.r_line_id, p_batch: v.batch, p_amount: v.amount, p_kind: v.kind, p_date: v.date });
    },
  });
  if (saved) { ui.success('Cost allocated to the batch.'); await run(); }
}

async function allocateSelected() {
  const chosen = lines.filter((l) => selected.has(l.r_line_id));
  if (!chosen.length) return ui.warn('Tick at least one line.');
  if (batchOptions().length < 2) return ui.warn('There are no growing batches. Start a batch first.');
  const total = chosen.reduce((s, l) => s + Number(l.r_remaining), 0);
  const saved = await ui.form({
    title: `Allocate ${chosen.length} line(s) to one batch`, submitText: 'Allocate',
    fields: [
      { name: 'batch', label: 'Batch', type: 'select', required: true, full: true, options: batchOptions(),
        hint: `The whole amount left on each ticked line, ${money(total)} ${base} in all, goes to this batch.` },
      { name: 'kind', label: 'Cost type', type: 'select', required: true, options: kindOptions() },
      { name: 'date', label: 'Date', type: 'date', required: true, hint: 'Must fall in an open period.' },
    ],
    values: { kind: 'other', date: todayIso(), batch: '' },
    onSubmit: async (v) => {
      let done = 0;
      for (const l of chosen) {
        try {
          await rpcGo('nursery_allocate_bill_line', { p_line: l.r_line_id, p_batch: v.batch, p_amount: null, p_kind: v.kind, p_date: v.date });
          done++;
        } catch (e) {
          throw new Error(`${done} line(s) were allocated before this error. ${e.message || e}`);
        }
      }
    },
  });
  if (saved) { ui.success(`${chosen.length} line(s) allocated.`); await run(); }
}

async function doExport() {
  if (!ran || !lines.length) return ui.warn('There is nothing to export.');
  try {
    await exportSheets(`bill-lines-to-allocate-${todayIso()}.xlsx`, [{
      name: 'Bill lines', title: 'Bill lines not yet allocated to batches', subtitle: `${fromEl.value} to ${toEl.value}, amounts in ${base}`,
      rows: lines.map((l) => ({
        date: l.r_doc_date, bill: l.r_doc_no, sref: l.r_supplier_ref || '', supplier: l.r_supplier, line: l.r_description || '', account: l.r_account,
        cur: l.r_currency, orig: Number(l.r_net), net: Number(l.r_base), allocated: Number(l.r_allocated), left: Number(l.r_remaining),
      })),
      columns: [
        { key: 'date', header: 'Date', width: 12 }, { key: 'bill', header: 'Bill', width: 14 }, { key: 'sref', header: 'Supplier ref', width: 16 },
        { key: 'supplier', header: 'Supplier', width: 28 }, { key: 'line', header: 'Line', width: 34 }, { key: 'account', header: 'Account', width: 28 },
        { key: 'cur', header: 'Currency', width: 10 }, { key: 'orig', header: 'Original', width: 14, total: false },
        { key: 'net', header: `Net (${base})`, width: 16, total: true }, { key: 'allocated', header: 'Allocated', width: 14, total: true },
        { key: 'left', header: 'Left', width: 14, total: true },
      ],
    }]);
  } catch (e) { ui.errorFrom(e, 'Could not export.'); }
}

if (ctx) await init();