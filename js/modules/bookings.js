import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { exportSheets } from '../core/export.js';
import { logoUrl } from '../core/logo.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const panel = document.getElementById('panel');

const CAN_BOOK = ctx ? ['owner', 'admin', 'accountant', 'clerk'].includes(ctx.role) : false;
const CAN_DISCOUNT = ctx ? ctx.canEdit : false;
const CAN_OVERRIDE = ctx ? ['owner', 'admin'].includes(ctx.role) : false;
const CAN_CLOSE = ctx ? ctx.canEdit : false;
const STATUS = { enquiry: 'Enquiry', provisional: 'Provisional', confirmed: 'Confirmed', dispatched: 'Dispatched', returned: 'Returned', closed: 'Closed', cancelled: 'Cancelled' };
const BADGE = { provisional: 'st-update', confirmed: 'open', cancelled: 'st-error' };
const EDITABLE = ['enquiry', 'provisional', 'confirmed'];

let bookings = [];
let customers = [];
let hireItems = [];
let hireMap = new Map();
let owned = new Map();
let lineMap = new Map();
let base = '';
let statusFilter = 'all';
let needle = '';
let custFilter = '';
let itemFilter = '';
let fromFilter = '';
let toFilter = '';

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

/* ---------- printing (picking list and delivery note) ---------- */

function printHtml(title, body) {
  const f = document.createElement('iframe');
  f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.append(f);
  const w = f.contentWindow;
  const d = w.document;
  d.open();
  d.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    body{font:13px/1.45 Arial,sans-serif;color:#111;margin:24px}
    h1{font-size:20px;margin:0 0 4px} h2{font-size:15px;margin:18px 0 6px}
    table{width:100%;border-collapse:collapse;margin-top:10px}
    th,td{border:1px solid #888;padding:6px 8px;text-align:left} th{background:#eee}
    td.n,th.n{text-align:right} .meta{color:#444;margin:2px 0}
    .sign{display:flex;gap:40px;margin-top:56px} .sign div{flex:1;border-top:1px solid #000;padding-top:4px}
    img{max-height:60px}</style></head><body>${body}</body></html>`);
  w.onload = () => {
    w.focus();
    w.print();
    setTimeout(() => f.remove(), 2000);
  };
  d.close();
}

const custName = (b) => (b.customers ? `${b.customers.code} - ${b.customers.name}` : '');

function noteHtml({ title, no, b, rows, picking }) {
  const logo = logoUrl(ctx.company);
  const head = `<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px">
    <div>${logo ? `<img src="${esc(logo)}" alt=""><br>` : ''}<strong>${esc(ctx.company.name)}</strong></div>
    <div style="text-align:right"><h1>${esc(title)}</h1>${no ? `<div class="meta">${esc(no)}</div>` : ''}<div class="meta">${todayIso()}</div></div></div>`;
  const info = `<h2>${esc(b.event_name)}</h2>
    <div class="meta">Booking ${esc(b.booking_no)} · ${esc(custName(b))}</div>
    <div class="meta">Venue: ${esc([b.venue_name, b.venue_address].filter(Boolean).join(', '))}</div>
    ${b.site_contact ? `<div class="meta">Site contact: ${esc(b.site_contact)}</div>` : ''}
    <div class="meta">Out ${esc(b.start_date)} · Back ${esc(b.end_date)}</div>`;
  const table = `<table><thead><tr><th>Item</th><th class="n">Quantity</th>${picking ? '<th>Picked</th>' : ''}</tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${esc(r.label)}</td><td class="n">${qtyFmt(r.qty)}</td>${picking ? '<td></td>' : ''}</tr>`).join('')}</tbody></table>`;
  const sign = picking ? '' : '<div class="sign"><div>Delivered by (name and signature)</div><div>Received by (name, signature and date)</div></div>';
  return head + info + table + sign;
}

/* ---------- data ---------- */

async function load() {
  const cid = ctx.companyId;
  const [b, c, h, o, cu] = await Promise.all([
    supabase.from('bookings').select('*, customers(code, name), booking_lines(hire_item_id, qty, qty_dispatched)').eq('company_id', cid)
      .order('start_date', { ascending: false }).limit(500),
    supabase.from('customers').select('id, code, name').eq('company_id', cid).eq('is_active', true).order('code'),
    supabase.from('hire_items').select('*').eq('company_id', cid).eq('is_active', true).order('code'),
    supabase.rpc('hire_items_owned', { p_company: cid }),
    supabase.from('company_currencies').select('code').eq('company_id', cid).eq('is_base', true).maybeSingle(),
  ]);
  for (const r of [b, c, h, o]) if (r.error) throw r.error;
  bookings = b.data.map((x) => ({
    ...x, undispatched: (x.booking_lines || []).some((l) => Number(l.qty) > Number(l.qty_dispatched)),
  }));
  lineMap = new Map(b.data.map((x) => [x.id, new Set((x.booking_lines || []).map((l) => l.hire_item_id))]));
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

const holdExpired = (b) => b.status === 'provisional' && b.hold_until && b.hold_until < todayIso();
const overdue = (b) => b.status === 'dispatched' && b.end_date < todayIso();

function render() {
  document.getElementById('company-title').textContent = ctx.company.name;
  hint.textContent = `Totals are hire charges excluding tax, in ${base}. Provisional bookings hold stock until their hold date, then release it automatically. Use the buttons on a row to dispatch, check in a return or close.`;
  toolbar.replaceChildren();
  if (CAN_BOOK) toolbar.append(btn('New booking', 'btn-primary', () => openEditor(null)));
  const box = el('input');
  box.type = 'search';
  box.placeholder = 'Search number, event, venue';
  box.value = needle;
  box.style.maxWidth = '220px';
  box.addEventListener('input', () => { needle = box.value.trim().toLowerCase(); renderTable(); });
  const sel = el('select', 'compact');
  option(sel, 'all', 'All statuses');
  Object.entries(STATUS).forEach(([k, v]) => option(sel, k, v));
  sel.value = statusFilter;
  sel.addEventListener('change', () => { statusFilter = sel.value; renderTable(); });
  const custSel = el('select', 'compact');
  custSel.style.maxWidth = '200px';
  option(custSel, '', 'All customers');
  customers.forEach((c) => option(custSel, c.id, `${c.code} - ${c.name}`));
  custSel.value = custFilter;
  custSel.addEventListener('change', () => { custFilter = custSel.value; renderTable(); });
  const itemSel = el('select', 'compact');
  itemSel.style.maxWidth = '200px';
  option(itemSel, '', 'All hire items');
  hireItems.forEach((h) => option(itemSel, h.id, `${h.code} - ${h.name}`));
  itemSel.value = itemFilter;
  itemSel.addEventListener('change', () => { itemFilter = itemSel.value; renderTable(); });
  const from = el('input'); from.type = 'date'; from.value = fromFilter; from.style.width = 'auto';
  const to = el('input'); to.type = 'date'; to.value = toFilter; to.style.width = 'auto';
  from.addEventListener('change', () => { fromFilter = from.value; renderTable(); });
  to.addEventListener('change', () => { toFilter = to.value; renderTable(); });
  const clear = btn('Clear filters', 'btn-ghost', () => {
    needle = ''; statusFilter = 'all'; custFilter = ''; itemFilter = ''; fromFilter = ''; toFilter = '';
    render();
  });
  toolbar.append(box, sel, custSel, itemSel, el('span', 'muted', 'Dates'), from, el('span', 'muted', 'to'), to, clear,
    el('span', 'spacer'), btn('Export to Excel', '', doExport));
  renderTable();
}

const visible = () => bookings.filter((b) => (statusFilter === 'all' || b.status === statusFilter)
  && (!custFilter || b.customer_id === custFilter)
  && (!itemFilter || (lineMap.get(b.id) || new Set()).has(itemFilter))
  && (!fromFilter || b.end_date >= fromFilter)
  && (!toFilter || b.start_date <= toFilter)
  && (!needle || [b.booking_no, b.event_name, b.venue_name, custName(b)].some((v) => String(v || '').toLowerCase().includes(needle))));

function rowActions(b) {
  const out = [];
  if (CAN_BOOK && (b.status === 'confirmed' || (b.status === 'dispatched' && b.undispatched))) {
    out.push('<button class="btn btn-sm" data-act="dispatch">Dispatch</button>');
  }
  if (CAN_BOOK && b.status === 'dispatched') out.push('<button class="btn btn-sm" data-act="return">Check in</button>');
  if (CAN_CLOSE && b.status === 'returned') out.push('<button class="btn btn-sm" data-act="close">Close</button>');
  out.push('<button class="btn btn-sm" data-act="view">View</button>');
  return `<div class="row-actions">${out.join('')}</div>`;
}

function renderTable() {
  if (!bookings.length) { panel.innerHTML = '<p class="muted">No bookings yet.</p>'; return; }
  const list = visible();
  if (!list.length) { panel.innerHTML = '<p class="muted">No bookings match these filters.</p>'; return; }
  const body = list.map((b) => `<tr class="clickable" data-id="${b.id}">
    <td>${esc(b.booking_no)}</td><td>${esc(b.event_name)}</td><td>${esc(custName(b))}</td><td>${esc(b.venue_name || '')}</td>
    <td>${b.start_date} to ${b.end_date}</td><td class="num">${b.hire_days}</td>
    <td><span class="badge ${BADGE[b.status] || ''}">${STATUS[b.status]}</span>
      ${overdue(b) ? ' <span class="badge st-error">Overdue</span>' : ''}
      ${b.status === 'provisional' ? ` <span class="badge ${holdExpired(b) ? 'st-error' : ''}">${holdExpired(b) ? 'Hold expired' : `Hold to ${b.hold_until}`}</span>` : ''}
      ${b.availability_override ? ' <span class="badge st-error">Override</span>' : ''}</td>
    <td class="num">${money(b.total)}</td><td>${rowActions(b)}</td></tr>`).join('');
  panel.innerHTML = `<p class="muted">${list.length} of ${bookings.length} bookings</p>
    <div class="table-wrap"><table class="grid"><thead><tr><th>No</th><th>Event</th><th>Customer</th><th>Venue</th>
    <th>Dates</th><th style="text-align:right">Days</th><th>Status</th><th style="text-align:right">Total</th><th></th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

panel.addEventListener('click', async (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  const b = bookings.find((x) => x.id === tr.dataset.id);
  if (!b) return;
  const t = e.target.closest('[data-act]');
  if (t) {
    e.stopPropagation();
    const a = t.dataset.act;
    if (a === 'dispatch') openDispatch(b);
    else if (a === 'return') openReturn(b);
    else if (a === 'view') openViewer(b);
    else if (a === 'close') await closeBooking(b);
    return;
  }
  if (EDITABLE.includes(b.status) && CAN_BOOK) openEditor(b); else openViewer(b);
});

async function doExport() {
  try {
    await exportSheets(`bookings-${todayIso()}.xlsx`, [{
      name: 'Bookings', title: 'Hire bookings',
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

async function closeBooking(b) {
  const ok = await ui.confirm({
    title: `Close ${b.booking_no}`,
    message: 'Close this booking? Check that it has been invoiced and that any damaged or missing items are dealt with.',
    confirmText: 'Close booking',
  });
  if (!ok) return;
  const { error } = await supabase.rpc('close_booking', { p_booking: b.id });
  if (error) return ui.errorFrom(error);
  ui.updated('Booking');
  await refresh();
}

/* ---------- dispatch ---------- */

async function openDispatch(b) {
  const { data: lines, error } = await supabase.from('booking_lines').select('*, hire_items(code, name)')
    .eq('booking_id', b.id).order('line_no');
  if (error) return ui.errorFrom(error, 'Could not load the booking lines.');
  const todo = lines.filter((l) => Number(l.qty) > Number(l.qty_dispatched));
  if (!todo.length) return ui.warn('Everything on this booking has already been dispatched.');

  const prevFocus = document.activeElement;
  const backdrop = el('div', 'modal-backdrop');
  const box = el('div', 'modal xwide');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.append(el('h3', 'modal-title', `Dispatch ${b.booking_no}`));
  const info = el('p', 'muted', `${custName(b)} · ${b.event_name}${b.venue_name ? ` at ${b.venue_name}` : ''}\nOut ${b.start_date} · Back ${b.end_date}`);
  info.style.whiteSpace = 'pre-line';
  box.append(info);

  const field = (text, input, full) => {
    const w = el('div', `field${full ? ' full' : ''}`);
    w.append(el('label', '', text), input);
    return w;
  };
  const inp = (type, value) => { const i = el('input'); if (type) i.type = type; i.value = value ?? ''; return i; };
  const dateIn = inp('date', todayIso());
  const vehIn = inp('', '');
  const drvIn = inp('', '');
  const notesIn = inp('', '');
  const head = el('div', 'form-grid');
  head.append(field('Dispatch date *', dateIn), field('Vehicle', vehIn), field('Driver', drvIn), field('Notes', notesIn));
  box.append(head);

  const wrap = el('div', 'lines-wrap');
  const table = el('table', 'lines-table');
  table.style.minWidth = '560px';
  table.innerHTML = '<thead><tr><th>Hire item</th><th style="text-align:right">Booked</th><th style="text-align:right">Already out</th><th>Dispatch now</th></tr></thead>';
  const tb = el('tbody');
  const rows = todo.map((l) => {
    const left = Number(l.qty) - Number(l.qty_dispatched);
    const tr = el('tr');
    const q = inp('number', left);
    q.min = '0'; q.max = String(left); q.step = '1';
    q.addEventListener('input', () => { if (Number(q.value) > left) q.value = String(left); });
    const c4 = el('td');
    c4.append(q);
    tr.append(el('td', '', `${l.hire_items.code} - ${l.hire_items.name}`), el('td', 'num', qtyFmt(l.qty)),
      el('td', 'num', qtyFmt(l.qty_dispatched)), c4);
    tb.append(tr);
    return { l, q };
  });
  table.append(tb);
  wrap.append(table);
  box.append(wrap);

  const collect = () => {
    const out = [];
    rows.forEach(({ l, q }) => {
      const n = Number(q.value);
      if (n > 0) {
        if (n !== Math.round(n)) throw new Error('Enter whole quantities.');
        out.push({ booking_line_id: l.id, qty: n, label: `${l.hire_items.code} - ${l.hire_items.name}` });
      }
    });
    if (!out.length) throw new Error('Enter a quantity on at least one line.');
    return out;
  };

  const actions = el('div', 'modal-actions');
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const close = () => {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    if (prevFocus && prevFocus.focus) prevFocus.focus();
  };
  document.addEventListener('keydown', onKey);
  const goBtn = btn('Dispatch', 'btn-primary', () => {});
  actions.append(el('span', 'spacer'), btn('Cancel', 'btn-ghost', close),
    btn('Print picking list', '', () => {
      try { printHtml('Picking list', noteHtml({ title: 'Picking list', no: b.booking_no, b, rows: collect(), picking: true })); }
      catch (e) { ui.warn(e.message); }
    }), goBtn);
  box.append(actions);
  backdrop.append(box);
  document.body.append(backdrop);

  goBtn.addEventListener('click', async () => {
    let lines2;
    try { lines2 = collect(); } catch (e) { return ui.warn(e.message); }
    if (!dateIn.value) return ui.warn('Enter the dispatch date.');
    goBtn.disabled = true;
    try {
      const { data, error: e2 } = await supabase.rpc('dispatch_booking', {
        p_company: ctx.companyId, p_booking: b.id, p_date: dateIn.value, p_vehicle: vehIn.value, p_driver: drvIn.value,
        p_notes: notesIn.value, p_lines: lines2.map((x) => ({ booking_line_id: x.booking_line_id, qty: x.qty })),
      });
      if (e2) throw e2;
      const d = await supabase.from('hire_dispatches').select('dispatch_no').eq('id', data).maybeSingle();
      const no = d.data ? d.data.dispatch_no : '';
      close();
      ui.success(`Dispatched${no ? ` as ${no}` : ''}.`);
      await refresh();
      const print = await ui.confirm({ title: 'Delivery note', message: 'Print the delivery note now?', confirmText: 'Print' });
      if (print) printHtml('Delivery note', noteHtml({ title: 'Delivery note', no, b, rows: lines2, picking: false }));
    } catch (e) { ui.errorFrom(e, 'Could not dispatch.'); }
    finally { goBtn.disabled = false; }
  });
}

/* ---------- return check-in ---------- */

async function openReturn(b) {
  const { data: lines, error } = await supabase.from('booking_lines').select('*, hire_items(code, name)')
    .eq('booking_id', b.id).order('line_no');
  if (error) return ui.errorFrom(error, 'Could not load the booking lines.');
  const out = lines.map((l) => ({ l, left: Number(l.qty_dispatched) - Number(l.qty_good) - Number(l.qty_damaged) - Number(l.qty_missing) }))
    .filter((x) => x.left > 0);
  if (!out.length) return ui.warn('Nothing is still out on this booking.');

  const prevFocus = document.activeElement;
  const backdrop = el('div', 'modal-backdrop');
  const box = el('div', 'modal xwide');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.append(el('h3', 'modal-title', `Check in ${b.booking_no}`));
  const info = el('p', 'muted', `${custName(b)} · ${b.event_name}${b.venue_name ? ` at ${b.venue_name}` : ''}\nDamaged and missing units are taken off availability until you resolve them in the Repair Queue.`);
  info.style.whiteSpace = 'pre-line';
  box.append(info);

  const field = (text, input, full) => {
    const w = el('div', `field${full ? ' full' : ''}`);
    w.append(el('label', '', text), input);
    return w;
  };
  const inp = (type, value) => { const i = el('input'); if (type) i.type = type; i.value = value ?? ''; return i; };
  const dateIn = inp('date', todayIso());
  const notesIn = inp('', '');
  const head = el('div', 'form-grid');
  head.append(field('Return date *', dateIn), field('Notes', notesIn));
  box.append(head);

  const wrap = el('div', 'lines-wrap');
  const table = el('table', 'lines-table');
  table.style.minWidth = '780px';
  table.innerHTML = '<thead><tr><th>Hire item</th><th style="text-align:right">Still out</th><th>Good</th><th>Damaged</th><th>Missing</th>'
    + '<th>Repair expected back</th><th>Damage note</th></tr></thead>';
  const tb = el('tbody');
  const rows = out.map(({ l, left }) => {
    const tr = el('tr');
    const num = (v) => { const i = inp('number', v); i.min = '0'; i.step = '1'; return i; };
    const g = num(left); const d = num(0); const m = num(0);
    const exp = inp('date', '');
    const note = inp('', '');
    const td = (x) => { const c = el('td'); c.append(x); return c; };
    tr.append(el('td', '', `${l.hire_items.code} - ${l.hire_items.name}`), el('td', 'num', qtyFmt(left)), td(g), td(d), td(m), td(exp), td(note));
    tb.append(tr);
    return { l, left, g, d, m, exp, note };
  });
  table.append(tb);
  wrap.append(table);
  box.append(wrap);

  const actions = el('div', 'modal-actions');
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const close = () => {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    if (prevFocus && prevFocus.focus) prevFocus.focus();
  };
  document.addEventListener('keydown', onKey);
  const goBtn = btn('Check in', 'btn-primary', () => {});
  actions.append(el('span', 'spacer'), btn('Cancel', 'btn-ghost', close), goBtn);
  box.append(actions);
  backdrop.append(box);
  document.body.append(backdrop);

  goBtn.addEventListener('click', async () => {
    const payload = [];
    let dmg = 0;
    let mis = 0;
    for (const r of rows) {
      const g = Number(r.g.value) || 0;
      const d = Number(r.d.value) || 0;
      const m = Number(r.m.value) || 0;
      if (g < 0 || d < 0 || m < 0 || g !== Math.round(g) || d !== Math.round(d) || m !== Math.round(m)) return ui.warn('Enter whole quantities of zero or more.');
      if (g + d + m > r.left) return ui.warn(`${r.l.hire_items.code}: only ${qtyFmt(r.left)} is still out.`);
      if (g + d + m === 0) continue;
      dmg += d;
      mis += m;
      payload.push({ booking_line_id: r.l.id, good: g, damaged: d, missing: m, expected_back: r.exp.value || null, note: r.note.value });
    }
    if (!payload.length) return ui.warn('Enter what came back on at least one line.');
    if (!dateIn.value) return ui.warn('Enter the return date.');
    goBtn.disabled = true;
    try {
      const { error: e2 } = await supabase.rpc('return_booking', {
        p_company: ctx.companyId, p_booking: b.id, p_date: dateIn.value, p_notes: notesIn.value, p_lines: payload,
      });
      if (e2) throw e2;
      close();
      ui.success('Return checked in.');
      if (dmg || mis) {
        await ui.alert({
          title: 'Damaged or missing items',
          message: `${dmg ? `${dmg} damaged unit(s) are in the Repair Queue. ` : ''}${mis ? `${mis} missing unit(s) are in the Repair Queue. ` : ''}\n`
            + 'Add any charges to the customer\'s invoice by hand. If you write units off, dispose of them in Fixed Assets first, then mark them written off in the Repair Queue.',
        });
      }
      await refresh();
    } catch (e) { ui.errorFrom(e, 'Could not check in the return.'); }
    finally { goBtn.disabled = false; }
  });
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
  const [l, dsp, rtn] = await Promise.all([
    supabase.from('booking_lines').select('*, hire_items(code, name)').eq('booking_id', b.id).order('line_no'),
    supabase.from('hire_dispatches').select('id, dispatch_no, dispatch_date, vehicle, driver, notes, hire_dispatch_lines(qty, hire_items(code, name))')
      .eq('booking_id', b.id).order('dispatch_date'),
    supabase.from('hire_returns').select('id, return_no, return_date, notes, hire_return_lines(qty_good, qty_damaged, qty_missing, hire_items(code, name))')
      .eq('booking_id', b.id).order('return_date'),
  ]);
  for (const r of [l, dsp, rtn]) if (r.error) return ui.errorFrom(r.error, 'Could not load the booking.');

  const node = el('div');
  const info = el('p', 'muted', [
    `${custName(b)} · ${STATUS[b.status]}`, `${b.event_name}${b.venue_name ? ` at ${b.venue_name}` : ''}`,
    `Out ${b.start_date} · Back ${b.end_date} · ${b.hire_days} day(s)`,
    b.venue_address || '', b.site_contact ? `Site contact: ${b.site_contact}` : '',
    b.cancel_reason ? `Cancelled: ${b.cancel_reason}` : '', b.availability_override ? `Availability override: ${b.override_reason}` : '',
  ].filter(Boolean).join('\n'));
  info.style.whiteSpace = 'pre-line';
  node.append(info);

  const body = l.data.map((x, i) => `<tr><td>${i + 1}</td><td>${esc(x.hire_items ? `${x.hire_items.code} - ${x.hire_items.name}` : '')}</td>
    <td class="num">${qtyFmt(x.qty)}</td><td class="num">${Number(x.discount_percent) ? `${Number(x.discount_percent)}%` : ''}</td>
    <td class="num">${money(x.line_total)}</td><td class="num">${qtyFmt(x.qty_dispatched)}</td>
    <td class="num">${qtyFmt(x.qty_good)}</td><td class="num">${qtyFmt(x.qty_damaged)}</td><td class="num">${qtyFmt(x.qty_missing)}</td></tr>`).join('');
  const t = el('div', 'table-wrap');
  t.innerHTML = `<table class="grid"><thead><tr><th>#</th><th>Hire item</th><th style="text-align:right">Booked</th>
    <th style="text-align:right">Discount</th><th style="text-align:right">Total (${esc(base)})</th>
    <th style="text-align:right">Dispatched</th><th style="text-align:right">Back good</th>
    <th style="text-align:right">Damaged</th><th style="text-align:right">Missing</th></tr></thead>
    <tbody>${body}<tr><td colspan="4"><strong>Total excl. tax</strong></td><td class="num"><strong>${money(b.total)}</strong></td><td colspan="4"></td></tr></tbody></table>`;
  node.append(t);

  if (dsp.data.length) {
    node.append(el('h4', '', 'Dispatches'));
    const box = el('div', 'table-wrap');
    box.innerHTML = `<table class="grid"><thead><tr><th>Delivery note</th><th>Date</th><th>Vehicle / driver</th><th>Items</th><th></th></tr></thead><tbody>
      ${dsp.data.map((d) => `<tr><td>${esc(d.dispatch_no)}</td><td>${d.dispatch_date}</td>
        <td>${esc([d.vehicle, d.driver].filter(Boolean).join(' / '))}</td>
        <td>${d.hire_dispatch_lines.map((x) => `${qtyFmt(x.qty)} × ${esc(x.hire_items.code)}`).join(', ')}</td>
        <td><button class="btn btn-sm" data-print="${d.id}">Print</button></td></tr>`).join('')}</tbody></table>`;
    node.append(box);
    box.querySelectorAll('[data-print]').forEach((p) => p.addEventListener('click', () => {
      const d = dsp.data.find((x) => x.id === p.dataset.print);
      printHtml('Delivery note', noteHtml({
        title: 'Delivery note', no: d.dispatch_no, b,
        rows: d.hire_dispatch_lines.map((x) => ({ label: `${x.hire_items.code} - ${x.hire_items.name}`, qty: x.qty })), picking: false,
      }));
    }));
  }
  if (rtn.data.length) {
    node.append(el('h4', '', 'Returns'));
    const box = el('div', 'table-wrap');
    box.innerHTML = `<table class="grid"><thead><tr><th>Return</th><th>Date</th><th>Items</th><th>Notes</th></tr></thead><tbody>
      ${rtn.data.map((r) => `<tr><td>${esc(r.return_no)}</td><td>${r.return_date}</td>
        <td>${r.hire_return_lines.map((x) => `${esc(x.hire_items.code)}: ${qtyFmt(x.qty_good)} good${Number(x.qty_damaged) ? `, ${qtyFmt(x.qty_damaged)} damaged` : ''}${Number(x.qty_missing) ? `, ${qtyFmt(x.qty_missing)} missing` : ''}`).join('; ')}</td>
        <td>${esc(r.notes || '')}</td></tr>`).join('')}</tbody></table>`;
    node.append(box);
  }

  const buttons = [{ label: 'Close', value: 'close', className: 'btn-ghost' }];
  if (CAN_BOOK && (b.status === 'confirmed' || (b.status === 'dispatched' && b.undispatched))) buttons.push({ label: 'Dispatch', value: 'dispatch', className: '' });
  if (CAN_BOOK && b.status === 'dispatched') buttons.push({ label: 'Check in return', value: 'return', className: 'btn-primary' });
  if (CAN_CLOSE && b.status === 'returned') buttons.push({ label: 'Close booking', value: 'closebk', className: 'btn-primary' });
  const res = await ui.dialog({ title: b.booking_no, node, wide: true, dismissValue: 'close', buttons });
  if (res === 'dispatch') await openDispatch(b);
  else if (res === 'return') await openReturn(b);
  else if (res === 'closebk') await closeBooking(b);
}

if (ctx) await refresh();