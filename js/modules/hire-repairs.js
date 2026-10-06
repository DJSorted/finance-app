import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { exportSheets } from '../core/export.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const panel = document.getElementById('panel');

const CAN_ACT = ctx ? ['owner', 'admin', 'accountant', 'clerk'].includes(ctx.role) : false;
const CAN_WRITE_OFF = ctx ? ctx.canEdit : false;
const KIND = { repair: 'In repair', missing: 'Missing' };
const ACTION = { back_in_service: 'Back in service', recovered: 'Recovered', written_off: 'Written off' };

let rows = [];
let items = [];
let statusFilter = 'open';
let kindFilter = '';
let itemFilter = '';
let needle = '';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const qtyFmt = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 4 });
const todayIso = () => new Date().toISOString().slice(0, 10);
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

async function load() {
  const cid = ctx.companyId;
  const [u, h] = await Promise.all([
    supabase.from('hire_unavailable').select('*, hire_items(code, name), bookings(booking_no, event_name)')
      .eq('company_id', cid).order('logged_on', { ascending: false }).limit(1000),
    supabase.from('hire_items').select('id, code, name').eq('company_id', cid).order('code'),
  ]);
  if (u.error) throw u.error;
  if (h.error) throw h.error;
  rows = u.data;
  items = h.data;
}

async function refresh() {
  try { await load(); } catch (e) { ui.errorFrom(e, 'Could not load the repair queue.'); }
  render();
}

function render() {
  document.getElementById('company-title').textContent = ctx.company.name;
  hint.textContent = 'Damaged and missing units logged at check-in. They are off availability until resolved. To write units off, first dispose of them in Fixed Assets (Dispose / write off on the pool), then mark them written off here so they are not counted twice.';
  toolbar.replaceChildren();
  const sel = el('select', 'compact');
  [['open', 'Open'], ['closed', 'Closed'], ['all', 'All']].forEach(([v, l]) => option(sel, v, l));
  sel.value = statusFilter;
  sel.addEventListener('change', () => { statusFilter = sel.value; renderTable(); });
  const kind = el('select', 'compact');
  option(kind, '', 'All reasons');
  Object.entries(KIND).forEach(([k, v]) => option(kind, k, v));
  kind.value = kindFilter;
  kind.addEventListener('change', () => { kindFilter = kind.value; renderTable(); });
  const it = el('select', 'compact');
  it.style.maxWidth = '220px';
  option(it, '', 'All hire items');
  items.forEach((x) => option(it, x.id, `${x.code} - ${x.name}`));
  it.value = itemFilter;
  it.addEventListener('change', () => { itemFilter = it.value; renderTable(); });
  const box = el('input');
  box.type = 'search';
  box.placeholder = 'Search';
  box.value = needle;
  box.style.maxWidth = '200px';
  box.addEventListener('input', () => { needle = box.value.trim().toLowerCase(); renderTable(); });
  toolbar.append(sel, kind, it, box, el('span', 'spacer'), btn('Export to Excel', '', doExport));
  renderTable();
}

const visible = () => rows.filter((r) => (statusFilter === 'all' || r.status === statusFilter)
  && (!kindFilter || r.kind === kindFilter) && (!itemFilter || r.hire_item_id === itemFilter)
  && (!needle || [r.hire_items && r.hire_items.code, r.hire_items && r.hire_items.name, r.bookings && r.bookings.booking_no, r.notes]
    .some((v) => String(v || '').toLowerCase().includes(needle))));

function actionButtons(r) {
  if (r.status !== 'open' || !CAN_ACT) return '';
  const b = [];
  b.push(r.kind === 'repair' ? '<button class="btn btn-sm" data-act="back_in_service">Back in service</button>'
    : '<button class="btn btn-sm" data-act="recovered">Recovered</button>');
  if (CAN_WRITE_OFF) b.push('<button class="btn btn-sm" data-act="written_off">Write off</button>');
  return `<div class="row-actions">${b.join('')}</div>`;
}

function renderTable() {
  const list = visible();
  if (!rows.length) { panel.innerHTML = '<p class="muted">Nothing has been logged yet. Damaged and missing items from check-ins appear here.</p>'; return; }
  if (!list.length) { panel.innerHTML = '<p class="muted">Nothing matches.</p>'; return; }
  const today = todayIso();
  const body = list.map((r) => `<tr class="clickable" data-id="${r.id}">
    <td>${r.logged_on}</td><td>${esc(r.hire_items ? `${r.hire_items.code} - ${r.hire_items.name}` : '')}</td>
    <td>${KIND[r.kind]}</td><td>${esc(r.bookings ? r.bookings.booking_no : '')}</td>
    <td class="num">${qtyFmt(r.qty)}</td><td class="num">${qtyFmt(r.qty_open)}</td>
    <td>${r.expected_back || ''}${r.status === 'open' && r.expected_back && r.expected_back < today ? ' <span class="badge st-error">Overdue</span>' : ''}</td>
    <td>${esc(r.notes || '')}</td>
    <td><span class="badge ${r.status === 'open' ? 'st-update' : 'open'}">${r.status === 'open' ? 'Open' : 'Closed'}</span></td>
    <td>${actionButtons(r)}</td></tr>`).join('');
  panel.innerHTML = `<p class="muted">${list.length} of ${rows.length} entries</p><div class="table-wrap"><table class="grid"><thead><tr>
    <th>Logged</th><th>Hire item</th><th>Reason</th><th>Booking</th><th style="text-align:right">Units</th>
    <th style="text-align:right">Still open</th><th>Expected back</th><th>Notes</th><th>Status</th><th></th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

panel.addEventListener('click', async (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  const r = rows.find((x) => x.id === tr.dataset.id);
  if (!r) return;
  const t = e.target.closest('[data-act]');
  if (t) { e.stopPropagation(); await resolve(r, t.dataset.act); return; }
  await showHistory(r);
});

async function resolve(r, action) {
  const writeOff = action === 'written_off';
  const saved = await ui.form({
    title: `${ACTION[action]}: ${r.hire_items ? r.hire_items.code : ''}`,
    submitText: ACTION[action],
    fields: [
      { name: 'qty', label: 'Units', type: 'number', required: true, full: true,
        hint: writeOff ? `Up to ${qtyFmt(r.qty_open)}. Only after you have disposed of these units in Fixed Assets, which lowers the pool. This closes the entry so they are not counted twice.`
          : `Up to ${qtyFmt(r.qty_open)}.` },
      { name: 'date', label: 'Date', type: 'date', required: true },
      { name: 'notes', label: 'Notes', full: true },
    ],
    values: { qty: Number(r.qty_open), date: todayIso() },
    onSubmit: async (v) => {
      const { error } = await supabase.rpc('resolve_unavailable', {
        p_id: r.id, p_action: action, p_qty: v.qty, p_date: v.date, p_notes: v.notes,
      });
      if (error) throw error;
    },
  });
  if (saved) { ui.updated('Repair queue'); await refresh(); }
}

async function showHistory(r) {
  const { data, error } = await supabase.from('hire_unavailable_events').select('*').eq('unavailable_id', r.id).order('created_at');
  if (error) return ui.errorFrom(error, 'Could not load the history.');
  const node = el('div', 'table-wrap');
  node.innerHTML = data.length
    ? `<table class="grid"><thead><tr><th>Date</th><th>Action</th><th style="text-align:right">Units</th><th>Notes</th></tr></thead><tbody>
      ${data.map((x) => `<tr><td>${x.event_date}</td><td>${ACTION[x.action]}</td><td class="num">${qtyFmt(x.qty)}</td><td>${esc(x.notes || '')}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Nothing has been resolved on this entry yet.</p>';
  await ui.dialog({
    title: `${r.hire_items ? r.hire_items.code : ''} ${KIND[r.kind]}, logged ${r.logged_on}`, node, wide: true, dismissValue: 'close',
    buttons: [{ label: 'Close', value: 'close', className: 'btn-ghost' }],
  });
}

async function doExport() {
  const list = visible();
  if (!list.length) return ui.warn('There is nothing to export.');
  try {
    await exportSheets(`repair-queue-${todayIso()}.xlsx`, [{
      name: 'Repair queue', title: 'Hire repair queue',
      rows: list.map((r) => ({
        logged: r.logged_on, item: r.hire_items ? `${r.hire_items.code} - ${r.hire_items.name}` : '', reason: KIND[r.kind],
        booking: r.bookings ? r.bookings.booking_no : '', units: Number(r.qty), open: Number(r.qty_open),
        expected: r.expected_back || '', notes: r.notes || '', status: r.status,
      })),
      columns: [
        { key: 'logged', header: 'Logged', width: 12 }, { key: 'item', header: 'Hire item', width: 32 }, { key: 'reason', header: 'Reason', width: 12 },
        { key: 'booking', header: 'Booking', width: 12 }, { key: 'units', header: 'Units', width: 10 }, { key: 'open', header: 'Still open', width: 10 },
        { key: 'expected', header: 'Expected back', width: 14 }, { key: 'notes', header: 'Notes', width: 32 }, { key: 'status', header: 'Status', width: 10 },
      ],
    }]);
  } catch (e) { ui.errorFrom(e, 'Could not export.'); }
}

if (ctx) await refresh();