import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { exportSheets } from '../core/export.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const panel = document.getElementById('panel');
const STATUS = { provisional: 'Provisional', confirmed: 'Confirmed', dispatched: 'Dispatched' };
const KIND = { repair: 'In repair', missing: 'Missing' };
const DOW = 'SMTWTFS';

let rows = [];
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
const itemSel = el('select', 'compact');
itemSel.style.maxWidth = '240px';
const search = el('input');
search.type = 'search';
search.placeholder = 'Search hire items';
search.style.maxWidth = '200px';

async function init() {
  document.getElementById('company-title').textContent = ctx.company.name;
  fromEl.value = todayIso();
  itemSel.addEventListener('change', () => { itemFilter = itemSel.value; render(); });
  search.addEventListener('input', () => { needle = search.value.trim().toLowerCase(); render(); });
  toolbar.append(el('span', 'muted', 'From'), fromEl, spanSel, itemSel, search, btn('Run', 'btn-primary', run),
    btn('Today', '', () => { fromEl.value = todayIso(); run(); }),
    btn('Back', '', () => { fromEl.value = addDays(fromEl.value, -Number(spanSel.value)); run(); }),
    btn('Forward', '', () => { fromEl.value = addDays(fromEl.value, Number(spanSel.value)); run(); }),
    el('span', 'spacer'), btn('Export to Excel', '', doExport));
  hint.textContent = 'Each cell shows the units still free that day, after confirmed bookings, items still out at venues, unexpired provisional holds (with buffer days) and units out of service. Green is plenty, amber is low, red is none, solid red is overbooked. Click a cell to see why.';
  await run();
}

async function run() {
  if (!fromEl.value) return ui.warn('Choose the start date.');
  const to = addDays(fromEl.value, Number(spanSel.value) - 1);
  const { data, error } = await supabase.rpc('hire_calendar', { p_company: ctx.companyId, p_from: fromEl.value, p_to: to });
  if (error) return ui.errorFrom(error, 'Could not load the calendar.');
  rows = data;
  fillItems();
  render();
}

function fillItems() {
  const keep = itemSel.value;
  itemSel.replaceChildren();
  const all = el('option', '', 'All hire items');
  all.value = '';
  itemSel.append(all);
  const seen = new Set();
  rows.forEach((r) => {
    if (seen.has(r.hire_item_id)) return;
    seen.add(r.hire_item_id);
    const o = el('option', '', `${r.code} - ${r.name}`);
    o.value = r.hire_item_id;
    itemSel.append(o);
  });
  itemSel.value = seen.has(keep) ? keep : '';
  itemFilter = itemSel.value;
}

function grid() {
  const days = [...new Set(rows.map((r) => r.day))];
  const map = new Map();
  rows.forEach((r) => {
    if (!map.has(r.hire_item_id)) map.set(r.hire_item_id, { id: r.hire_item_id, code: r.code, name: r.name, owned: Number(r.owned), cells: new Map() });
    map.get(r.hire_item_id).cells.set(r.day, r);
  });
  const items = [...map.values()].filter((it) => (!itemFilter || it.id === itemFilter)
    && (!needle || `${it.code} ${it.name}`.toLowerCase().includes(needle)));
  return { days, items };
}

function cellInfo(it, d) {
  const c = it.cells.get(d);
  const conf = Number(c.confirmed_qty);
  const held = Number(c.held_qty);
  const una = Number(c.unavail_qty);
  const free = it.owned - conf - held - una;
  const cls = free < 0 ? 'over' : (free === 0 ? 'out' : (free <= it.owned * 0.2 ? 'low' : 'ok'));
  return { conf, held, una, free, cls };
}

function render() {
  if (!rows.length) { panel.innerHTML = '<p class="muted">No active hire items yet. Set them up under Hire Items.</p>'; return; }
  const { days, items } = grid();
  if (!items.length) { panel.innerHTML = '<p class="muted">No hire items match the filter.</p>'; return; }
  const today = todayIso();
  const head = days.map((d) => {
    const wk = new Date(`${d}T00:00:00Z`).getUTCDay();
    return `<th class="${wk === 0 || wk === 6 ? 'wknd' : ''} ${d === today ? 'today' : ''}">${d.slice(8)}<br><small>${DOW[wk]}</small></th>`;
  }).join('');
  const body = items.map((it) => `<tr><td class="first"><strong>${esc(it.code)}</strong> ${esc(it.name)}<br><small class="muted">${qtyFmt(it.owned)} units</small></td>
    ${days.map((d) => {
    const c = cellInfo(it, d);
    return `<td class="cell ${c.cls}" data-item="${it.id}" data-day="${d}" title="Owned ${qtyFmt(it.owned)}, booked or out ${qtyFmt(c.conf)}, on hold ${qtyFmt(c.held)}, out of service ${qtyFmt(c.una)}">${qtyFmt(c.free)}${c.held ? `<span class="held">+${qtyFmt(c.held)} held</span>` : ''}${c.una ? `<span class="una">−${qtyFmt(c.una)} out of service</span>` : ''}</td>`;
  }).join('')}</tr>`).join('');
  panel.innerHTML = `<div class="cal-wrap"><table class="cal"><thead><tr><th class="first">Hire item</th>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

async function doExport() {
  const { days, items } = grid();
  if (!items.length) return ui.warn('There is nothing to export for these filters.');
  const COLOURS = {
    ok: { fill: 'D1FAE5' }, low: { fill: 'FEF3C7' }, out: { fill: 'FEE2E2' }, over: { fill: 'DC2626', color: 'FFFFFF', bold: true },
  };
  const columns = [
    { key: 'item', header: 'Hire item', width: 34 }, { key: 'units', header: 'Units', width: 9 },
    ...days.map((d) => ({ key: `d${d}`, header: `${d.slice(5)} ${DOW[new Date(`${d}T00:00:00Z`).getUTCDay()]}`, width: 8 })),
  ];
  const out = items.map((it) => {
    const row = { item: `${it.code} - ${it.name}`, units: it.owned, _cls: {} };
    days.forEach((d) => { const c = cellInfo(it, d); row[`d${d}`] = c.free; row._cls[`d${d}`] = c.cls; });
    return row;
  });
  try {
    await exportSheets(`hire-availability-${days[0]}-to-${days[days.length - 1]}.xlsx`, [{
      name: 'Availability', title: 'Hire availability',
      subtitle: `Free units per day, ${days[0]} to ${days[days.length - 1]}. Red means none free, solid red means overbooked.`,
      totals: false, rows: out, columns,
      styleCell: (row, col) => (row._cls && row._cls[col.key] ? COLOURS[row._cls[col.key]] : null),
    }]);
  } catch (e) { ui.errorFrom(e, 'Could not export.'); }
}

panel.addEventListener('click', async (e) => {
  const td = e.target.closest('td.cell');
  if (!td) return;
  const item = rows.find((r) => r.hire_item_id === td.dataset.item);
  const day = td.dataset.day;
  const today = todayIso();
  const [bl, un] = await Promise.all([
    supabase.from('booking_lines')
      .select('qty, qty_good, qty_damaged, qty_missing, bookings!inner(booking_no, event_name, venue_name, start_date, end_date, status, hold_until, customers(code, name))')
      .eq('company_id', ctx.companyId).eq('hire_item_id', td.dataset.item),
    supabase.from('hire_unavailable').select('kind, qty_open, logged_on, expected_back, notes, bookings(booking_no)')
      .eq('company_id', ctx.companyId).eq('hire_item_id', td.dataset.item).eq('status', 'open'),
  ]);
  if (bl.error) return ui.errorFrom(bl.error, 'Could not load the bookings.');
  if (un.error) return ui.errorFrom(un.error, 'Could not load the out-of-service units.');

  const list = bl.data.map((l) => {
    const b = l.bookings;
    const out = b.status === 'dispatched';
    const qty = out ? Math.max(Number(l.qty) - Number(l.qty_good) - Number(l.qty_damaged) - Number(l.qty_missing), 0) : Number(l.qty);
    const end = out ? (b.end_date > today ? b.end_date : today) : b.end_date;
    const live = b.status === 'confirmed' || out || (b.status === 'provisional' && b.hold_until >= today);
    return { l, b, qty, live: live && qty > 0 && day >= addDays(b.start_date, -item.buf_before) && day <= addDays(end, item.buf_after) };
  }).filter((x) => x.live);
  const down = un.data.filter((u) => day >= u.logged_on && (!u.expected_back || u.expected_back < today || day < u.expected_back));

  const node = el('div');
  const t1 = el('div', 'table-wrap');
  t1.innerHTML = list.length
    ? `<table class="grid"><thead><tr><th>Booking</th><th>Customer</th><th>Event</th><th>Out</th><th>Back</th><th>Status</th>
      <th style="text-align:right">Quantity</th></tr></thead><tbody>${list.map(({ b, qty }) => `<tr><td>${esc(b.booking_no)}</td>
      <td>${esc(b.customers ? b.customers.name : '')}</td><td>${esc(b.event_name)}</td>
      <td>${b.start_date}</td><td>${b.end_date}${b.status === 'dispatched' && b.end_date < today ? ' <span class="badge st-error">Overdue</span>' : ''}</td>
      <td>${STATUS[b.status]}${b.status === 'provisional' ? ` (to ${b.hold_until})` : ''}</td>
      <td class="num">${qtyFmt(qty)}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">No bookings are holding this item on that day.</p>';
  node.append(t1);
  if (down.length) {
    node.append(el('h4', '', 'Out of service'));
    const t2 = el('div', 'table-wrap');
    t2.innerHTML = `<table class="grid"><thead><tr><th>Reason</th><th style="text-align:right">Units</th><th>Since</th><th>Expected back</th><th>Booking</th><th>Notes</th></tr></thead><tbody>
      ${down.map((u) => `<tr><td>${KIND[u.kind]}</td><td class="num">${qtyFmt(u.qty_open)}</td><td>${u.logged_on}</td><td>${u.expected_back || ''}</td>
      <td>${esc(u.bookings ? u.bookings.booking_no : '')}</td><td>${esc(u.notes || '')}</td></tr>`).join('')}</tbody></table>`;
    node.append(t2);
  }
  await ui.dialog({ title: `${item.code} - ${item.name} on ${day}`, node, wide: true, dismissValue: 'close',
    buttons: [{ label: 'Close', value: 'close', className: 'btn-ghost' }] });
});

if (ctx) await init();