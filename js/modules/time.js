import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { exportSheets } from '../core/export.js';
import { printTimeReport } from '../core/print-docs.js';

const ctx = await startPage();

const timerEl = document.getElementById('timer');
const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const panel = document.getElementById('panel');

const CAN_BILL = ctx ? ['owner', 'admin', 'accountant', 'clerk'].includes(ctx.role) : false;
const RECENT_DAYS = 120;

let projects = [];
let entries = [];
let running = null; // your running entry, in any company
let projFilter = '';
let statusFilter = 'unbilled';
let needle = '';
const picked = new Set();
let tick = null;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hrs = (m) => (Number(m || 0) / 60).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (n) => Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad = (n) => String(n).padStart(2, '0');
const localDate = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const localTime = (iso) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const todayLocal = () => localDate(new Date().toISOString());
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
const projLabel = (p) => (p ? `${p.code} - ${p.name}` : '');
const custLabel = (p) => (p && p.customers ? `${p.customers.code} - ${p.customers.name}` : 'Internal');
const projOf = (e) => projects.find((p) => p.id === e.project_id);
function elapsed(iso) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}
function state(e) {
  if (e.invoice_id) return e.sales_documents && e.sales_documents.status === 'posted' ? 'posted' : 'draft';
  if (!e.end_at) return 'running';
  return e.billable ? 'unbilled' : 'nonbill';
}
const STATE_TEXT = { running: 'Running', unbilled: 'Unbilled', nonbill: 'Not billable', draft: 'On draft invoice', posted: 'Invoiced' };
const billableNow = (e) => state(e) === 'unbilled';
const rateOf = (p) => (p ? (p.hourly_rate !== null && p.hourly_rate !== undefined ? Number(p.hourly_rate)
  : (p.items && p.items.sales_price !== null ? Number(p.items.sales_price) : null)) : null);

/* ---------- data ---------- */

async function load() {
  const cid = ctx.companyId;
  const since = new Date(Date.now() - RECENT_DAYS * 86400000).toISOString();
  const [p, e, r] = await Promise.all([
    supabase.from('projects').select('id, code, name, status, customer_id, hourly_rate, time_item_id, customers(code, name), items:time_item_id(code, name, sales_price)')
      .eq('company_id', cid).order('code'),
    supabase.from('time_entries').select('*, sales_documents(doc_no, status)')
      .eq('company_id', cid).or(`invoice_id.is.null,start_at.gte.${since}`)
      .order('start_at', { ascending: false }).limit(2000),
    supabase.from('time_entries').select('*, projects(code, name, company_id, companies(name))')
      .eq('user_id', ctx.session.user.id).is('end_at', null).maybeSingle(),
  ]);
  for (const x of [p, e, r]) if (x.error) throw x.error;
  projects = p.data;
  entries = e.data;
  running = r.data;
  const ids = new Set(entries.filter(billableNow).map((x) => x.id));
  [...picked].forEach((id) => { if (!ids.has(id)) picked.delete(id); });
}

async function refresh() {
  try { await load(); } catch (e) { ui.errorFrom(e, 'Could not load time. Has sql/035_time_tracking.sql been run?'); }
  render();
}

/* ---------- timer ---------- */

function renderTimer() {
  clearInterval(tick);
  timerEl.replaceChildren();
  const row = el('div', 'time-timer-row');
  if (running) {
    const p = running.projects;
    const here = p && p.company_id === ctx.companyId;
    const info = el('div', 'time-timer-info');
    info.append(el('div', 'tile-label', here ? 'Timer running' : `Timer running in ${p && p.companies ? p.companies.name : 'another company'}`),
      el('div', 'tile-sub', p ? `${p.code} - ${p.name}` : ''));
    const clock = el('div', 'tile-value time-clock', elapsed(running.start_at));
    tick = setInterval(() => { clock.textContent = elapsed(running.start_at); }, 1000);
    const notes = el('input');
    notes.placeholder = 'What did you work on?';
    notes.value = running.notes || '';
    const stop = btn('Stop', 'btn-danger', async () => {
      stop.disabled = true;
      const { error } = await supabase.rpc('stop_timer', { p_notes: notes.value });
      if (error) { stop.disabled = false; return ui.errorFrom(error, 'Could not stop the timer.'); }
      ui.success('Timer stopped.');
      await refresh();
    });
    row.append(info, clock, notes, stop);
  } else {
    const open = projects.filter((p) => p.status !== 'closed');
    const sel = el('select');
    option(sel, '', open.length ? 'Choose a project' : 'Add a project first (Projects page)');
    open.forEach((p) => option(sel, p.id, `${projLabel(p)} (${custLabel(p)})`));
    if (projFilter && open.some((p) => p.id === projFilter)) sel.value = projFilter;
    const notes = el('input');
    notes.placeholder = 'What are you working on?';
    const start = btn('Start', 'btn-primary', async () => {
      if (!sel.value) return ui.warn('Choose a project.');
      start.disabled = true;
      const { error } = await supabase.rpc('start_timer', { p_project: sel.value, p_notes: notes.value });
      if (error) { start.disabled = false; return ui.errorFrom(error, 'Could not start the timer.'); }
      await refresh();
    });
    notes.addEventListener('keydown', (e) => { if (e.key === 'Enter') start.click(); });
    row.append(el('div', 'tile-value time-clock', '0:00:00'), sel, notes, start);
  }
  timerEl.append(row);
}

/* ---------- list ---------- */

function render() {
  renderTimer();
  hint.textContent = 'Time is logged against a project. Set the hourly rate and the item time is billed as on the project. '
    + 'Tick unbilled time for one customer and choose Bill selected: a draft invoice is made, and it takes the next invoice number when you post it. '
    + 'Deleting the draft puts the time back to unbilled.';
  toolbar.replaceChildren();
  toolbar.append(btn('Add time', '', () => openEntry(null)));
  const ps = el('select', 'compact');
  option(ps, '', 'All projects');
  projects.forEach((p) => option(ps, p.id, projLabel(p)));
  ps.value = projFilter;
  ps.addEventListener('change', () => { projFilter = ps.value; renderTimer(); renderTable(); });
  const ss = el('select', 'compact');
  [['unbilled', 'Unbilled'], ['billed', 'Billed'], ['nonbill', 'Not billable'], ['all', `All (last ${RECENT_DAYS} days)`]].forEach(([v, l]) => option(ss, v, l));
  ss.value = statusFilter;
  ss.addEventListener('change', () => { statusFilter = ss.value; renderTable(); });
  const box = el('input');
  box.type = 'search';
  box.placeholder = 'Search';
  box.value = needle;
  box.style.maxWidth = '200px';
  box.addEventListener('input', () => { needle = box.value.trim().toLowerCase(); renderTable(); });
  toolbar.append(ps, ss, box, el('span', 'spacer'));
  if (CAN_BILL) {
    const billBtn = btn('Bill selected', 'btn-primary', openBill);
    billBtn.id = 'bill-btn';
    toolbar.append(billBtn);
  }
  toolbar.append(btn('Print report', '', openReport), btn('Export to Excel', '', doExport));
  renderTable();
}

function visible() {
  return entries.filter((e) => {
    const s = state(e);
    if (projFilter && e.project_id !== projFilter) return false;
    if (statusFilter === 'unbilled' && !(s === 'unbilled' || s === 'running')) return false;
    if (statusFilter === 'billed' && !(s === 'draft' || s === 'posted')) return false;
    if (statusFilter === 'nonbill' && s !== 'nonbill') return false;
    if (!needle) return true;
    const p = projOf(e);
    return [projLabel(p), custLabel(p), e.notes, localDate(e.start_at), e.sales_documents && e.sales_documents.doc_no]
      .some((x) => String(x || '').toLowerCase().includes(needle));
  });
}

function updateBillButton() {
  const b = document.getElementById('bill-btn');
  if (!b) return;
  const mins = entries.filter((e) => picked.has(e.id)).reduce((s, e) => s + Number(e.minutes || 0), 0);
  b.textContent = picked.size ? `Bill selected (${hrs(mins)} h)` : 'Bill selected';
  b.disabled = !picked.size;
}

function renderTable() {
  updateBillButton();
  const list = visible();
  if (!entries.length) { panel.innerHTML = '<p class="muted">No time logged yet. Start the timer or choose Add time.</p>'; return; }
  if (!list.length) { panel.innerHTML = '<p class="muted">Nothing matches.</p>'; return; }

  const unbilled = list.filter(billableNow);
  const mins = list.reduce((s, e) => s + Number(e.minutes || 0), 0);
  const value = unbilled.reduce((s, e) => { const r = rateOf(projOf(e)); return s + (r === null ? 0 : r * Number(e.minutes) / 60); }, 0);
  const sum = `<p class="muted">${list.length} entr${list.length === 1 ? 'y' : 'ies'} · ${hrs(mins)} hours`
    + (unbilled.length ? ` · unbilled value about ${money(value)} at project rates` : '') + '</p>';

  const all = unbilled.length > 0 && unbilled.every((e) => picked.has(e.id));
  const body = list.map((e) => {
    const p = projOf(e);
    const s = state(e);
    const pick = billableNow(e) && CAN_BILL ? `<input type="checkbox" data-pick="${e.id}" ${picked.has(e.id) ? 'checked' : ''} aria-label="Select">` : '';
    const doc = e.sales_documents;
    const status = s === 'draft' || s === 'posted'
      ? `<a href="/pages/invoices.html?open=${e.invoice_id}">${esc(doc && doc.doc_no ? doc.doc_no : 'Draft invoice')}</a>`
      : `<span class="badge ${s === 'unbilled' ? 'open' : ''}">${STATE_TEXT[s]}</span>`;
    const notesBtn = `<button class="btn btn-sm" type="button" data-notes="${e.id}" title="Time on an invoice: only the notes can change">Notes</button>`;
    const actions = s === 'posted' ? `<div class="row-actions">${notesBtn}</div>` : s === 'draft'
      ? `<div class="row-actions">${notesBtn}${CAN_BILL ? `<button class="btn btn-sm btn-ghost" type="button" data-release="${e.invoice_id}"
        title="Take all time off this draft invoice">Release</button>` : ''}</div>`
      : `<div class="row-actions">
      <button class="btn btn-sm" type="button" data-edit="${e.id}">Edit</button>
      <button class="btn btn-sm btn-ghost" type="button" data-del="${e.id}">Delete</button></div>`;
    return `<tr><td>${pick}</td><td>${localDate(e.start_at)}</td>
      <td>${localTime(e.start_at)}–${e.end_at ? localTime(e.end_at) : '…'}</td><td class="num">${e.end_at ? hrs(e.minutes) : ''}</td>
      <td>${esc(projLabel(p))}</td><td>${esc(custLabel(p))}</td><td>${esc(e.notes || '')}</td><td>${status}</td><td>${actions}</td></tr>`;
  }).join('');
  panel.innerHTML = `${sum}<div class="table-wrap"><table class="grid"><thead><tr>
    <th>${unbilled.length && CAN_BILL ? `<input type="checkbox" data-pick-all ${all ? 'checked' : ''} aria-label="Select all">` : ''}</th>
    <th>Date</th><th>Time</th><th style="text-align:right">Hours</th><th>Project</th><th>Customer</th><th>Notes</th><th>Status</th><th></th>
    </tr></thead><tbody>${body}</tbody></table></div>`;
}

panel.addEventListener('change', (ev) => {
  const t = ev.target;
  if (t.matches('[data-pick-all]')) {
    visible().filter(billableNow).forEach((e) => { if (t.checked) picked.add(e.id); else picked.delete(e.id); });
    renderTable();
  } else if (t.matches('[data-pick]')) {
    if (t.checked) picked.add(t.dataset.pick); else picked.delete(t.dataset.pick);
    updateBillButton();
  }
});

panel.addEventListener('click', async (ev) => {
  const ed = ev.target.closest('[data-edit]');
  if (ed) return openEntry(entries.find((e) => e.id === ed.dataset.edit));
  const nt = ev.target.closest('[data-notes]');
  if (nt) return openNotes(entries.find((e) => e.id === nt.dataset.notes));
  const rel = ev.target.closest('[data-release]');
  if (rel) {
    const ok = await ui.confirm({ title: 'Release time', confirmText: 'Release',
      message: 'Take all time off this draft invoice and mark it unbilled again?\nThe draft keeps its lines: edit or delete it on the Invoices page.' });
    if (!ok) return;
    const { error } = await supabase.rpc('release_time', { p_doc: rel.dataset.release });
    if (error) return ui.errorFrom(error);
    ui.success('Time released.');
    return refresh();
  }
  const del = ev.target.closest('[data-del]');
  if (del) {
    if (!(await ui.confirmDelete('Time entry'))) return;
    const { error } = await supabase.from('time_entries').delete().eq('id', del.dataset.del);
    if (error) return ui.errorFrom(error);
    picked.delete(del.dataset.del);
    ui.deleted('Time entry');
    await refresh();
  }
});

/* ---------- add / edit ---------- */

function toIso(date, time) { return new Date(`${date}T${time}`).toISOString(); }

async function openEntry(e) {
  const choices = projects.filter((p) => p.status !== 'closed' || (e && p.id === e.project_id));
  if (!choices.length) return ui.warn('Add a project first (Projects page).');
  const isRunning = e && !e.end_at;
  const saved = await ui.form({
    title: e ? 'Edit time' : 'Add time',
    fields: [
      { name: 'project_id', label: 'Project', type: 'select', required: true, full: true,
        options: [{ value: '', label: 'Choose a project' }].concat(choices.map((p) => ({ value: p.id, label: `${projLabel(p)} (${custLabel(p)})` }))) },
      { name: 'date', label: 'Date', type: 'date', required: true },
      { name: 'start', label: 'Start', type: 'time', required: true },
      ...(isRunning ? [] : [{ name: 'end', label: 'End', type: 'time', required: true, hint: 'An end before the start means the next day.' }]),
      { name: 'billable', label: 'Billable', type: 'checkbox' },
      { name: 'notes', label: 'Notes', type: 'textarea', full: true, hint: 'Printed on the invoice when you bill one line per entry.' },
    ],
    values: e
      ? { project_id: e.project_id, date: localDate(e.start_at), start: localTime(e.start_at), end: e.end_at ? localTime(e.end_at) : '',
        billable: e.billable, notes: e.notes || '' }
      : { project_id: projFilter, date: todayLocal(), start: '', end: '', billable: true, notes: '' },
    onSubmit: async (v) => {
      const startAt = toIso(v.date, v.start);
      let endAt = null;
      if (!isRunning) {
        const d = new Date(`${v.date}T${v.end}`);
        if (v.end <= v.start) d.setDate(d.getDate() + 1);
        endAt = d.toISOString();
      }
      const row = { project_id: v.project_id, start_at: startAt, billable: v.billable, notes: v.notes || null };
      if (!isRunning) row.end_at = endAt;
      const { error } = e
        ? await supabase.from('time_entries').update(row).eq('id', e.id)
        : await supabase.from('time_entries').insert({ ...row, company_id: ctx.companyId });
      if (error) throw error;
    },
  });
  if (saved) { ui.saved('Time'); await refresh(); }
}

// Billed time is locked except for its notes. The invoice line keeps its own text, so this does not change the invoice.
async function openNotes(e) {
  const saved = await ui.form({
    title: 'Edit notes',
    fields: [{ name: 'notes', label: 'Notes', type: 'textarea', full: true,
      hint: 'This time is on an invoice, so only the notes can change. The invoice line keeps the text it was raised with.' }],
    values: { notes: e.notes || '' },
    onSubmit: async (v) => {
      const { error } = await supabase.from('time_entries').update({ notes: v.notes || null }).eq('id', e.id);
      if (error) throw error;
    },
  });
  if (saved) { ui.saved('Notes'); await refresh(); }
}

/* ---------- bill ---------- */

async function openBill() {
  const chosen = entries.filter((e) => picked.has(e.id));
  if (!chosen.length) return ui.warn('Tick the time to bill.');
  const custs = new Set(chosen.map((e) => (projOf(e) || {}).customer_id || ''));
  if (custs.has('')) return ui.warn('Some of the ticked time is on an internal project (no customer), so it cannot be invoiced.');
  if (custs.size > 1) return ui.warn('Tick time for one customer at a time.');
  const p0 = projOf(chosen[0]);
  const mins = chosen.reduce((s, e) => s + Number(e.minutes || 0), 0);
  let docId = null;
  const ok = await ui.form({
    title: `Bill ${hrs(mins)} hours to ${custLabel(p0)}`,
    submitText: 'Create draft invoice',
    fields: [
      { name: 'date', label: 'Invoice date', type: 'date', required: true },
      { name: 'detail', label: 'Invoice lines', type: 'select', options: [
        { value: 'project', label: 'One line per project (total hours)' },
        { value: 'entry', label: 'One line per entry (date and notes)' }] },
      { name: 'discount', label: 'Discount %', type: 'number', hint: 'Optional. Taken off the hourly rate.' },
    ],
    values: { date: todayLocal(), detail: 'project', discount: '' },
    onSubmit: async (v) => {
      const { data, error } = await supabase.rpc('bill_time', {
        p_company: ctx.companyId, p_entries: chosen.map((e) => e.id), p_date: v.date,
        p_detail: v.detail === 'entry', p_discount: v.discount || 0,
      });
      if (error) throw error;
      docId = data;
    },
  });
  if (!ok) return;
  picked.clear();
  ui.success('Draft invoice created.');
  location.href = `/pages/invoices.html?open=${docId}`;
}

/* ---------- report ---------- */

// A printable report of one project's time (Save as PDF from the print dialog): one line per entry with its value
// at the project rate, and totals. Reads the entries straight from the database, so older billed time is included.
async function openReport() {
  if (!projects.length) return ui.warn('Add a project first (Projects page).');
  const n = new Date();
  let opts = null;
  const ok = await ui.form({
    title: 'Project time report',
    submitText: 'Print',
    fields: [
      { name: 'project_id', label: 'Project', type: 'select', required: true, full: true,
        options: [{ value: '', label: 'Choose a project' }].concat(projects.map((p) => ({ value: p.id, label: `${projLabel(p)} (${custLabel(p)})` }))) },
      { name: 'from', label: 'From', type: 'date', hint: 'Leave empty for all dates.' },
      { name: 'to', label: 'To', type: 'date' },
      { name: 'status', label: 'Time', type: 'select', options: [
        { value: 'all', label: 'All time' }, { value: 'unbilled', label: 'Unbilled only' }, { value: 'billed', label: 'Billed only' }] },
      { name: 'nonbill', label: 'Include time that is not billable', type: 'checkbox' },
      { name: 'rate', label: 'Rate', type: 'number', hint: 'Leave empty to use the project rate.' },
      { name: 'uom', label: 'Unit', placeholder: 'Hours', hint: 'Heading for the quantity, e.g. Hours or Days. The quantity is the logged time in hours.' },
      { name: 'job', label: 'Show the job', type: 'checkbox' },
    ],
    values: { project_id: projFilter, from: `${n.getFullYear()}-${pad(n.getMonth() + 1)}-01`, to: todayLocal(), status: 'all', nonbill: false,
      rate: '', uom: 'Hours', job: false },
    onSubmit: async (v) => {
      if (v.from && v.to && v.to < v.from) throw new Error('The To date is before the From date.');
      if (v.rate !== null && !(v.rate >= 0)) throw new Error('The rate cannot be negative.');
      let q = supabase.from('time_entries').select('start_at, minutes, notes, billable, invoice_id, sales_documents(doc_no)')
        .eq('company_id', ctx.companyId).eq('project_id', v.project_id).not('end_at', 'is', null).order('start_at');
      if (v.from) q = q.gte('start_at', new Date(`${v.from}T00:00`).toISOString());
      if (v.to) { const d = new Date(`${v.to}T00:00`); d.setDate(d.getDate() + 1); q = q.lt('start_at', d.toISOString()); }
      if (v.status === 'unbilled') q = q.is('invoice_id', null);
      if (v.status === 'billed') q = q.not('invoice_id', 'is', null);
      if (!v.nonbill) q = q.eq('billable', true);
      const p = projects.find((x) => x.id === v.project_id);
      const [e, pr, cu, def, base] = await Promise.all([
        q.limit(5000),
        supabase.from('projects').select('*').eq('id', p.id).maybeSingle(),
        p.customer_id ? supabase.from('customers').select('*').eq('id', p.customer_id).maybeSingle() : Promise.resolve({ data: null }),
        p.customer_id ? supabase.rpc('customer_defaults', { p_customer: p.customer_id }) : Promise.resolve({ data: null }),
        supabase.from('company_currencies').select('code').eq('company_id', ctx.companyId).eq('is_base', true).maybeSingle(),
      ]);
      if (e.error) throw e.error;
      // Same currency billing would use: the customer's, else the company's base currency.
      const cur = (!def.error && def.data && def.data[0] && def.data[0].currency_code) || (base.data ? base.data.code : '');
      const c = cur ? await supabase.from('currencies').select('decimals').eq('code', cur).maybeSingle() : { data: null };
      opts = {
        project: { ...p, ...(pr.data || {}) }, customer: cu.data || null, cur, dec: c.data ? Number(c.data.decimals) : 2,
        rate: v.rate !== null ? v.rate : rateOf(p), uom: v.uom || 'Hours', from: v.from, to: v.to, printed: todayLocal(), showJob: v.job,
        scope: [{ unbilled: 'Unbilled time', billed: 'Billed time' }[v.status], v.nonbill ? 'including time not billable' : ''].filter(Boolean).join(', ')
          .replace(/^./, (ch) => ch.toUpperCase()),
        entries: e.data.map((x) => ({ date: localDate(x.start_at), notes: x.notes, minutes: x.minutes, billable: x.billable,
          invoice: x.invoice_id ? (x.sales_documents && x.sales_documents.doc_no ? x.sales_documents.doc_no : 'Draft invoice') : '' })),
      };
    },
  });
  if (ok && opts) await printTimeReport(ctx, opts);
}

/* ---------- export ---------- */

async function doExport() {
  try {
    await exportSheets(`time-${todayLocal()}.xlsx`, [{
      name: 'Time',
      rows: visible().map((e) => {
        const p = projOf(e);
        return {
          date: localDate(e.start_at), start: localTime(e.start_at), end: e.end_at ? localTime(e.end_at) : '',
          hours: e.end_at ? Number(e.minutes) / 60 : null, project: projLabel(p), customer: custLabel(p), notes: e.notes || '',
          status: STATE_TEXT[state(e)], invoice: e.sales_documents ? (e.sales_documents.doc_no || 'Draft') : '',
        };
      }),
      columns: [
        { key: 'date', header: 'Date', width: 12 }, { key: 'start', header: 'Start', width: 8 }, { key: 'end', header: 'End', width: 8 },
        { key: 'hours', header: 'Hours', width: 9 }, { key: 'project', header: 'Project', width: 30 },
        { key: 'customer', header: 'Customer', width: 30 }, { key: 'notes', header: 'Notes', width: 40 },
        { key: 'status', header: 'Status', width: 16 }, { key: 'invoice', header: 'Invoice', width: 14 },
      ],
    }]);
  } catch (e) { ui.errorFrom(e, 'Could not export.'); }
}

if (ctx) {
  document.getElementById('company-title').textContent = ctx.company.name;
  await refresh();
}
