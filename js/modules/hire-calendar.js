import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const panel = document.getElementById('panel');
const STATUS = { provisional: 'Provisional', confirmed: 'Confirmed', dispatched: 'Dispatched' };

let rows = [];

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const qtyFmt = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 4 });
const todayIso = () => new Date().toISOString().slice(0, 10);
function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function btn(text, cls, onClick) {
  const b = el('button', `btn ${cls}`.trim(), text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

const fromEl = el('input'); fromEl.type = 'date'; fromEl.style.width = 'auto';
const spanSel = el('select', 'compact');
[14, 21, 31, 60].forEach((n) => { const o = el('option', '', `${n} days`); o.value = String(n); spanSel.append(o); });
spanSel.value = '21';

async function init() {
  document.getElementById('company-title').textContent = ctx.company.name;
  fromEl.value = todayIso();
  toolbar.append(el('span', 'muted', 'From'), fromEl, spanSel, btn('Run', 'btn-primary', run),
    btn('Today', '', () => { fromEl.value = todayIso(); run(); }),
    btn('Back', '', () => { fromEl.value = addDays(fromEl.value, -Number(spanSel.value)); run(); }),
    btn('Forward', '', () => { fromEl.value = addDays(fromEl.value, Number(spanSel.value)); run(); }));
  hint.textContent = 'Each cell shows the units still free that day, after confirmed bookings and unexpired provisional holds (with their buffer days). Green is plenty, amber is low, red is none, solid red is overbooked. Click a cell to see who has the stock.';
  await run();
}

async function run() {
  if (!fromEl.value) return ui.warn('Choose the start date.');
  const to = addDays(fromEl.value, Number(spanSel.value) - 1);
  const { data, error } = await supabase.rpc('hire_calendar', { p_company: ctx.companyId, p_from: fromEl.value, p_to: to });
  if (error) return ui.errorFrom(error, 'Could not load the calendar.');
  rows = data;
  render();
}

function render() {
  if (!rows.length) { panel.innerHTML = '<p class="muted">No active hire items yet. Set them up under Hire Items.</p>'; return; }
  const days = [...new Set(rows.map((r) => r.day))];
  const items = [];
  const seen = new Map();
  rows.forEach((r) => {
    if (!seen.has(r.hire_item_id)) { const it = { id: r.hire_item_id, code: r.code, name: r.name, owned: Number(r.owned), cells: new Map() }; seen.set(r.hire_item_id, it); items.push(it); }
    seen.get(r.hire_item_id).cells.set(r.day, r);
  });
  const today = todayIso();
  const head = days.map((d) => {
    const dt = new Date(`${d}T00:00:00Z`);
    const wk = dt.getUTCDay();
    return `<th class="${wk === 0 || wk === 6 ? 'wknd' : ''} ${d === today ? 'today' : ''}">${d.slice(8)}<br><small>${'SMTWTFS'[wk]}</small></th>`;
  }).join('');
  const body = items.map((it) => `<tr><td class="first"><strong>${esc(it.code)}</strong> ${esc(it.name)}<br><small class="muted">${qtyFmt(it.owned)} units</small></td>
    ${days.map((d) => {
    const c = it.cells.get(d);
    const conf = Number(c.confirmed_qty);
    const held = Number(c.held_qty);
    const free = it.owned - conf - held;
    const cls = free < 0 ? 'over' : (free === 0 ? 'out' : (free <= it.owned * 0.2 ? 'low' : 'ok'));
    return `<td class="cell ${cls}" data-item="${it.id}" data-day="${d}" title="Owned ${qtyFmt(it.owned)}, booked ${qtyFmt(conf)}, on hold ${qtyFmt(held)}">${qtyFmt(free)}${held ? `<span class="held">+${qtyFmt(held)} held</span>` : ''}</td>`;
  }).join('')}</tr>`).join('');
  panel.innerHTML = `<div class="cal-wrap"><table class="cal"><thead><tr><th class="first">Hire item</th>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

panel.addEventListener('click', async (e) => {
  const td = e.target.closest('td.cell');
  if (!td) return;
  const item = rows.find((r) => r.hire_item_id === td.dataset.item);
  const day = td.dataset.day;
  const { data, error } = await supabase.from('booking_lines')
    .select('qty, bookings!inner(booking_no, event_name, venue_name, start_date, end_date, status, hold_until, customers(code, name))')
    .eq('company_id', ctx.companyId).eq('hire_item_id', td.dataset.item);
  if (error) return ui.errorFrom(error, 'Could not load the bookings.');
  const today = todayIso();
  const list = data.filter((l) => {
    const b = l.bookings;
    const live = b.status === 'confirmed' || b.status === 'dispatched' || (b.status === 'provisional' && b.hold_until >= today);
    return live && day >= addDays(b.start_date, -item.buf_before) && day <= addDays(b.end_date, item.buf_after);
  });
  const node = el('div', 'table-wrap');
  node.innerHTML = list.length
    ? `<table class="grid"><thead><tr><th>Booking</th><th>Customer</th><th>Event</th><th>Out</th><th>Back</th><th>Status</th>
      <th style="text-align:right">Quantity</th></tr></thead><tbody>${list.map((l) => `<tr><td>${esc(l.bookings.booking_no)}</td>
      <td>${esc(l.bookings.customers ? l.bookings.customers.name : '')}</td><td>${esc(l.bookings.event_name)}</td>
      <td>${l.bookings.start_date}</td><td>${l.bookings.end_date}</td>
      <td>${STATUS[l.bookings.status]}${l.bookings.status === 'provisional' ? ` (to ${l.bookings.hold_until})` : ''}</td>
      <td class="num">${qtyFmt(l.qty)}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Nothing is holding this item on that day.</p>';
  await ui.dialog({ title: `${item.code} - ${item.name} on ${day}`, node, wide: true, dismissValue: 'close',
    buttons: [{ label: 'Close', value: 'close', className: 'btn-ghost' }] });
});

if (ctx) await init();