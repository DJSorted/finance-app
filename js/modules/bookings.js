import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { exportSheets } from '../core/export.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const panel = document.getElementById('panel');

const CAN_BOOK = ctx ? ['owner', 'admin', 'accountant', 'clerk'].includes(ctx.role) : false;
const CAN_DISCOUNT = ctx ? ctx.canEdit : false;
const CAN_OVERRIDE = ctx ? ['owner', 'admin'].includes(ctx.role) : false;
const STATUS = { enquiry: 'Enquiry', provisional: 'Provisional', confirmed: 'Confirmed', dispatched: 'Dispatched', returned: 'Returned', closed: 'Closed', cancelled: 'Cancelled' };
const BADGE = { provisional: 'st-update', confirmed: 'open', cancelled: 'st-error' };
const EDITABLE = ['enquiry', 'provisional', 'confirmed'];

let bookings = [];
let customers = [];
let hireItems = [];
let hireMap = new Map();
let owned = new Map();
let base = '';
let statusFilter = 'all';
let needle = '';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyFmt = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 4 });
const roundTo = (n, d) => { const f = 10 ** d; return Math.round((n + Number.EPSILON) * f) / f; };
const todayIso = () => new Date().toISOString().slice(0, 10);
function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const spanDays = (s, e) => Math.round((new Date(`${e}T00:00:00Z`) - new Date(`${s}T00:00:00Z`)) / 86400000) + 1;
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
// Same rule as the database: the lower of the day price and the event cap, with a minimum charge
function priceFor(h, qty, days, disc) {
  if (!h || !(days >= 1) || !(qty > 0)) return 0;
  let unit = Number(h.day_rate) * days;
  if (h.event_rate !== null && h.event_days) {
    const extra = h.extra_day_rate !== null ? Number(h.extra_day_rate) : Number(h.day_rate);
    unit = Math.min(unit, Number(h.event_rate) + Math.max(days - h.event_days, 0) * extra);
  }
  return roundTo(roundTo(Math.max(unit * qty, Number(h.min_charge)), 2) * (1 - (disc || 0) / 100), 2);
}

/* ---------- data ---------- */

async function load() {
  const cid = ctx.companyId;
  const [b, c, h, o, cu] = await Promise.all([
    supabase.from('bookings').select('*, customers(code, name)').eq('company_id', cid)
      .order('start_date', { ascending: false }).limit(500),
    supabase.from('customers').select('id, code, name').eq('company_id', cid).eq('is_active', true).order('code'),
    supabase.from('hire_items').select('*').eq('company_id', cid).eq('is_active', true).order('code'),
    supabase.rpc('hire_items_owned', { p_company: cid }),
    supabase.from('company_currencies').select('code').eq('company_id', cid).eq('is_base', true).maybeSingle(),
  ]);
  for (const r of [b, c, h, o]) if (r.error) throw r.error;
  bookings = b.data;
  customers = c.data;
  hireItems = h.data;
  hireMap = new Map(hireItems.map((x) => [x.id, x]));
  owned = new Map(o.data.map((x) => [x.hire_item_id, Number(x.owned)]));
  base = cu.data ? cu.data.code : '';
}

async function refresh() {
  try { await load(); } catch (e) { ui.errorFrom(e, 'Could not load bookings.'); }
  render();
}

/* ---------- list ---------- */

const custName = (b) => (b.customers ? `${b.customers.code} - ${b.customers.name}` : '');
const holdExpired = (b) => b.status === 'provisional' && b.hold_until && b.hold_until < todayIso();

function render() {
  document.getElementById('company-title').textContent = ctx.company.name;
  hint.textContent = `Totals are hire charges excluding tax, in ${base}. Provisional bookings hold stock until their hold date, then release it automatically. Confirmed bookings are checked against availability when saved.`;
  toolbar.replaceChildren();
  if (CAN_BOOK) toolbar.append(btn('New booking', 'btn-primary', () => openEditor(null)));
  const box = el('input');
  box.type = 'search';
  box.placeholder = 'Search';
  box.value = needle;
  box.style.maxWidth = '240px';
  box.addEventListener('input', () => { needle = box.value.trim().toLowerCase(); renderTable(); });
  const sel = el('select', 'compact');
  option(sel, 'all', 'All');
  Object.entries(STATUS).forEach(([k, v]) => option(sel, k, v));
  sel.value = statusFilter;
  sel.addEventListener('change', () => { statusFilter = sel.value; renderTable(); });
  toolbar.append(box, sel, el('span', 'spacer'), btn('Export to Excel', '', doExport));
  renderTable();
}

const visible = () => bookings.filter((b) => (statusFilter === 'all' || b.status === statusFilter)
  && (!needle || [b.booking_no, b.event_name, b.venue_name, custName(b)].some((v) => String(v || '').toLowerCase().includes(needle))));

function renderTable() {
  if (!bookings.length) { panel.innerHTML = '<p class="muted">No bookings yet.</p>'; return; }
  const list = visible();
  if (!list.length) { panel.innerHTML = '<p class="muted">Nothing matches.</p>'; return; }
  const body = list.map((b) => `<tr class="clickable" data-id="${b.id}">
    <td>${esc(b.booking_no)}</td><td>${esc(b.event_name)}</td><td>${esc(custName(b))}</td><td>${esc(b.venue_name || '')}</td>
    <td>${b.start_date} to ${b.end_date}</td><td class="num">${b.hire_days}</td>
    <td><span class="badge ${BADGE[b.status] || ''}">${STATUS[b.status]}</span>
      ${b.status === 'provisional' ? ` <span class="badge ${holdExpired(b) ? 'st-error' : ''}">${holdExpired(b) ? 'Hold expired' : `Hold to ${b.hold_until}`}</span>` : ''}
      ${b.availability_override ? ' <span class="badge st-error">Override</span>' : ''}</td>
    <td class="num">${money(b.total)}</td></tr>`).join('');
  panel.innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr><th>No</th><th>Event</th><th>Customer</th><th>Venue</th>
    <th>Dates</th><th style="text-align:right">Days</th><th>Status</th><th style="text-align:right">Total</th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

panel.addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  const b = bookings.find((x) => x.id === tr.dataset.id);
  if (!b) return;
  if (EDITABLE.includes(b.status) && CAN_BOOK) openEditor(b); else openViewer(b);
});

async function doExport() {
  try {
    await exportSheets(`bookings-${todayIso()}.xlsx`, [{
      name: 'Bookings',
      rows: visible().map((b) => ({
        no: b.booking_no, event: b.event_name, customer: custName(b), venue: b.venue_name || '', from: b.start_date, to: b.end_date,
        days: b.hire_days, status: STATUS[b.status], hold: b.hold_until || '', total: Number(b.total),
      })),
      columns: [
        { key: 'no', header: 'No', width: 12 }, { key: 'event', header: 'Event', width: 28 }, { key: 'customer', header: 'Customer', width: 30 },
        { key: 'venue', header: 'Venue', width: 24 }, { key: 'from', header: 'Out', width: 12 }, { key: 'to', header: 'Back', width: 12 },
        { key: 'days', header: 'Days', width: 8 }, { key: 'status', header: 'Status', width: 12 }, { key: 'hold', header: 'Hold until', width: 12 },
        { key: 'total', header: `Total (${base})`, width: 16 },
      ],
    }]);
  } catch (e) { ui.errorFrom(e, 'Could not export.'); }
}

/* ---------- editor ---------- */

async function openEditor(existing) {
  if (!customers.length) return ui.warn('Add a customer first.');
  if (!hireItems.length) return ui.warn('Set up a hire item first (Hire Items).');
  let seed = [];
  if (existing) {
    const { data, error } = await supabase.from('booking_lines').select('*').eq('booking_id', existing.id).order('line_no');
    if (error) return ui.errorFrom(error, 'Could not load the booking lines.');
    seed = data.map((l) => ({ hire_item_id: l.hire_item_id, qty: Number(l.qty), discount_percent: Number(l.discount_percent) }));
  }
  if (!seed.length) seed.push({});

  const prevFocus = document.activeElement;
  const backdrop = el('div', 'modal-backdrop');
  const box = el('div', 'modal xwide');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.append(el('h3', 'modal-title', existing ? `Edit ${existing.booking_no}` : 'New booking'));

  const field = (text, input, full) => {
    const w = el('div', `field${full ? ' full' : ''}`);
    w.append(el('label', '', text), input);
    return w;
  };
  const inp = (type, value) => { const i = el('input'); if (type) i.type = type; i.value = value ?? ''; return i; };
  const custSel = el('select');
  option(custSel, '', 'Select a customer');
  customers.forEach((c) => option(custSel, c.id, `${c.code} - ${c.name}`));
  custSel.value = existing ? existing.customer_id : '';
  const eventIn = inp('', existing ? existing.event_name : '');
  const venueIn = inp('', existing ? existing.venue_name || '' : '');
  const addrIn = inp('', existing ? existing.venue_address || '' : '');
  const contactIn = inp('', existing ? existing.site_contact || '' : '');
  const startIn = inp('date', existing ? existing.start_date : todayIso());
  const endIn = inp('date', existing ? existing.end_date : todayIso());
  const daysIn = inp('number', existing ? existing.hire_days : 1);
  const statusSel = el('select');
  [['enquiry', 'Enquiry (reserves nothing)'], ['provisional', 'Provisional (holds stock)'], ['confirmed', 'Confirmed']]
    .forEach(([v, l]) => option(statusSel, v, l));
  statusSel.value = existing ? existing.status : 'enquiry';
  const holdIn = inp('date', existing && existing.hold_until ? existing.hold_until : addDays(todayIso(), 7));
  const notesIn = inp('', existing ? existing.notes || '' : '');
  let daysManual = !!(existing && existing.hire_days !== spanDays(existing.start_date, existing.end_date));

  const holdField = field('Hold until', holdIn);
  const head = el('div', 'form-grid');
  head.append(field('Customer *', custSel, true), field('Event name *', eventIn, true), field('Venue', venueIn),
    field('Site contact', contactIn), field('Venue address', addrIn, true),
    field('Items go out *', startIn), field('Items come back *', endIn), field('Hire days', daysIn),
    field('Status', statusSel), holdField, field('Notes', notesIn, true));
  box.append(head);

  let ovBox = null;
  let ovReason = null;
  if (CAN_OVERRIDE) {
    ovBox = el('input'); ovBox.type = 'checkbox'; ovBox.style.width = 'auto';
    ovBox.checked = !!(existing && existing.availability_override);
    const ovRow = el('div', 'field check');
    ovRow.append(ovBox, el('label', '', 'Book anyway: override availability (the booking is flagged)'));
    ovReason = inp('', existing ? existing.override_reason || '' : '');
    ovReason.placeholder = 'Reason for the override (required)';
    const ovRow2 = el('div', 'field');
    ovRow2.append(ovReason);
    const syncOv = () => { ovRow2.style.display = ovBox.checked ? '' : 'none'; };
    ovBox.addEventListener('change', syncOv);
    syncOv();
    box.append(ovRow, ovRow2);
  }

  const wrap = el('div', 'lines-wrap');
  const table = el('table', 'lines-table book-lines');
  table.innerHTML = '<thead><tr><th class="c-bitem">Hire item</th><th class="c-bown">Units</th><th class="c-bfree">Free</th>'
    + '<th class="c-bqty">Quantity</th><th class="c-bdisc">Discount %</th><th class="c-btotal">Line total</th><th class="c-bdel"></th></tr></thead>';
  const tbody = el('tbody');
  table.append(tbody);
  wrap.append(table);
  box.append(wrap);

  const rows = [];
  const totals = el('div', 'totals-bar');
  const freeMap = new Map();
  const days = () => Math.max(1, Math.round(Number(daysIn.value)) || 1);

  function recalc() {
    let total = 0;
    const demand = new Map();
    rows.forEach((r) => { if (r.itemSel.value) demand.set(r.itemSel.value, (demand.get(r.itemSel.value) || 0) + (Number(r.qty.value) || 0)); });
    rows.forEach((r) => {
      const id = r.itemSel.value;
      const h = id ? hireMap.get(id) : null;
      const lt = priceFor(h, Number(r.qty.value) || 0, days(), Number(r.disc.value) || 0);
      r.totalCell.textContent = lt ? money(lt) : '';
      total += lt;
      r.ownCell.textContent = id ? qtyFmt(owned.get(id) || 0) : '';
      const free = freeMap.get(id);
      r.freeCell.textContent = id && free !== undefined ? qtyFmt(free) : '';
      r.freeCell.classList.toggle('short', id && free !== undefined && demand.get(id) > free);
    });
    totals.innerHTML = `<span class="ok">Hire charge excl. tax (${esc(base)}): ${money(total)}</span><span class="muted">${days()} day(s)</span>`;
  }

  async function refreshFree() {
    freeMap.clear();
    if (!startIn.value || !endIn.value || endIn.value < startIn.value) { recalc(); return; }
    const ids = [...new Set(rows.map((r) => r.itemSel.value).filter(Boolean))];
    await Promise.all(ids.map(async (id) => {
      const h = hireMap.get(id);
      const { data, error } = await supabase.rpc('hire_availability', {
        p_company: ctx.companyId, p_item: id, p_from: addDays(startIn.value, -h.buffer_before_days),
        p_to: addDays(endIn.value, h.buffer_after_days), p_exclude: existing ? existing.id : null,
      });
      if (!error && data.length) freeMap.set(id, Math.min(...data.map((d) => Number(d.available))));
    }));
    recalc();
  }
  let freeTimer;
  const queueFree = () => { clearTimeout(freeTimer); freeTimer = setTimeout(refreshFree, 250); };

  function addRow(s) {
    const tr = el('tr');
    const itemSel = el('select');
    option(itemSel, '', 'Select hire item');
    hireItems.forEach((h) => option(itemSel, h.id, `${h.code} - ${h.name}`));
    itemSel.value = s.hire_item_id || '';
    const ownCell = el('td', 'num');
    const freeCell = el('td', 'num');
    const qty = inp('number', s.qty ?? 1); qty.min = '1'; qty.step = '1';
    const disc = inp('number', s.discount_percent ?? 0); disc.min = '0'; disc.max = '100'; disc.step = 'any';
    disc.disabled = !CAN_DISCOUNT;
    const totalCell = el('td', 'num');
    const del = el('button', 'btn btn-sm btn-ghost', '✕');
    del.type = 'button';
    del.title = 'Remove line';
    const td = (x) => { const c = el('td'); c.append(x); return c; };
    tr.append(td(itemSel), ownCell, freeCell, td(qty), td(disc), totalCell, td(del));
    tbody.append(tr);
    const row = { tr, itemSel, ownCell, freeCell, qty, disc, totalCell };
    itemSel.addEventListener('change', () => { recalc(); queueFree(); });
    qty.addEventListener('input', recalc);
    disc.addEventListener('input', recalc);
    del.addEventListener('click', () => {
      if (rows.length === 1) return ui.warn('A booking needs at least one line.');
      rows.splice(rows.indexOf(row), 1);
      tr.remove();
      recalc();
    });
    rows.push(row);
  }
  seed.forEach(addRow);

  const syncHold = () => { holdField.style.display = statusSel.value === 'provisional' ? '' : 'none'; };
  const syncDays = () => {
    if (!daysManual && startIn.value && endIn.value && endIn.value >= startIn.value) daysIn.value = spanDays(startIn.value, endIn.value);
    recalc();
    queueFree();
  };
  statusSel.addEventListener('change', syncHold);
  startIn.addEventListener('change', syncDays);
  endIn.addEventListener('change', syncDays);
  daysIn.addEventListener('input', () => { daysManual = true; recalc(); });
  syncHold();

  box.append(btn('Add line', '', () => { addRow({}); recalc(); }), totals);
  recalc();
  refreshFree();

  const actions = el('div', 'modal-actions');
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const close = () => {
    clearTimeout(freeTimer);
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    if (prevFocus && prevFocus.focus) prevFocus.focus();
  };
  document.addEventListener('keydown', onKey);
  if (existing) {
    actions.append(btn('Cancel booking', 'btn-danger', async () => {
      const saved = await ui.form({
        title: `Cancel ${existing.booking_no}`, submitText: 'Cancel booking',
        fields: [{ name: 'reason', label: 'Reason', required: true, full: true }], values: {},
        onSubmit: async (v) => {
          const { error } = await supabase.rpc('cancel_booking', { p_booking: existing.id, p_reason: v.reason });
          if (error) throw error;
        },
      });
      if (saved) { close(); ui.success('Booking cancelled.'); await refresh(); }
    }));
  }
  const saveBtn = btn('Save booking', 'btn-primary', () => {});
  actions.append(el('span', 'spacer'), btn('Close', 'btn-ghost', close), saveBtn);
  box.append(actions);
  backdrop.append(box);
  document.body.append(backdrop);

  saveBtn.addEventListener('click', async () => {
    if (!custSel.value) return ui.warn('Choose a customer.');
    if (!eventIn.value.trim()) return ui.warn('Enter the event name.');
    if (!startIn.value || !endIn.value || endIn.value < startIn.value) return ui.warn('Enter the dates: the items must come back on or after the day they go out.');
    const lines = [];
    for (const [i, r] of rows.entries()) {
      if (!r.itemSel.value) return ui.warn(`Line ${i + 1}: choose a hire item.`);
      if (!(Number(r.qty.value) >= 1) || Number(r.qty.value) !== Math.round(Number(r.qty.value))) return ui.warn(`Line ${i + 1}: enter a whole quantity.`);
      lines.push({ hire_item_id: r.itemSel.value, qty: Number(r.qty.value), discount_percent: Number(r.disc.value) || 0 });
    }
    const override = !!(ovBox && ovBox.checked);
    if (override && !ovReason.value.trim()) return ui.warn('Enter the reason for the override.');
    saveBtn.disabled = true;
    try {
      const { error } = await supabase.rpc('save_booking', {
        p_company: ctx.companyId, p_booking: existing ? existing.id : null, p_customer: custSel.value,
        p_event: eventIn.value, p_venue: venueIn.value, p_address: addrIn.value, p_contact: contactIn.value,
        p_start: startIn.value, p_end: endIn.value, p_days: days(), p_status: statusSel.value,
        p_hold_until: statusSel.value === 'provisional' ? holdIn.value || null : null, p_notes: notesIn.value,
        p_override: override, p_override_reason: override ? ovReason.value : null, p_lines: lines,
      });
      if (error) throw error;
      close();
      ui.saved('Booking');
      await refresh();
    } catch (e) { ui.errorFrom(e, 'Could not save the booking.'); }
    finally { saveBtn.disabled = false; }
  });
  eventIn.focus();
}

/* ---------- viewer ---------- */

async function openViewer(b) {
  const { data, error } = await supabase.from('booking_lines').select('*, hire_items(code, name)').eq('booking_id', b.id).order('line_no');
  if (error) return ui.errorFrom(error, 'Could not load the booking lines.');
  const node = el('div');
  const info = el('p', 'muted', [
    `${custName(b)} · ${STATUS[b.status]}`, `${b.event_name}${b.venue_name ? ` at ${b.venue_name}` : ''}`,
    `Out ${b.start_date} · Back ${b.end_date} · ${b.hire_days} day(s)`,
    b.venue_address || '', b.site_contact ? `Site contact: ${b.site_contact}` : '',
    b.cancel_reason ? `Cancelled: ${b.cancel_reason}` : '', b.availability_override ? `Availability override: ${b.override_reason}` : '',
  ].filter(Boolean).join('\n'));
  info.style.whiteSpace = 'pre-line';
  node.append(info);
  const body = data.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.hire_items ? `${l.hire_items.code} - ${l.hire_items.name}` : '')}</td>
    <td class="num">${qtyFmt(l.qty)}</td><td class="num">${Number(l.discount_percent) ? `${Number(l.discount_percent)}%` : ''}</td>
    <td class="num">${money(l.line_total)}</td></tr>`).join('');
  const t = el('div', 'table-wrap');
  t.innerHTML = `<table class="grid"><thead><tr><th>#</th><th>Hire item</th><th style="text-align:right">Quantity</th>
    <th style="text-align:right">Discount</th><th style="text-align:right">Total (${esc(base)})</th></tr></thead>
    <tbody>${body}<tr><td colspan="4"><strong>Total excl. tax</strong></td><td class="num"><strong>${money(b.total)}</strong></td></tr></tbody></table>`;
  node.append(t);
  await ui.dialog({ title: b.booking_no, node, wide: true, dismissValue: 'close',
    buttons: [{ label: 'Close', value: 'close', className: 'btn-ghost' }] });
}

if (ctx) await refresh();