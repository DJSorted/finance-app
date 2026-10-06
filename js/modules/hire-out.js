import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { exportSheets } from '../core/export.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const panel = document.getElementById('panel');

let tab = 'item';
let position = [];
let outNow = [];
let needle = '';
let onlyOverdue = false;

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

async function load() {
  const cid = ctx.companyId;
  const [p, o] = await Promise.all([
    supabase.rpc('hire_stock_position', { p_company: cid }),
    supabase.rpc('hire_out_now', { p_company: cid }),
  ]);
  if (p.error) throw p.error;
  if (o.error) throw o.error;
  position = p.data;
  outNow = o.data;
}

async function refresh() {
  try { await load(); } catch (e) { ui.errorFrom(e, 'Could not load the hire position.'); }
  render();
}

function render() {
  document.getElementById('company-title').textContent = ctx.company.name;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  toolbar.replaceChildren();
  toolbar.append(btn('Refresh', '', refresh));
  if (tab === 'out') {
    const box = el('input');
    box.type = 'search';
    box.placeholder = 'Search booking, customer, venue, item';
    box.value = needle;
    box.style.maxWidth = '280px';
    box.addEventListener('input', () => { needle = box.value.trim().toLowerCase(); renderOut(); });
    const od = el('input'); od.type = 'checkbox'; od.checked = onlyOverdue; od.style.width = 'auto';
    od.addEventListener('change', () => { onlyOverdue = od.checked; renderOut(); });
    const lbl = el('label');
    lbl.style.cssText = 'display:flex;align-items:center;gap:.4rem;cursor:pointer';
    lbl.append(od, document.createTextNode('Overdue only'));
    toolbar.append(box, lbl);
  }
  toolbar.append(el('span', 'spacer'), btn('Export to Excel', '', doExport));
  if (tab === 'item') renderItems(); else renderOut();
}

function renderItems() {
  hint.textContent = 'Where every hire unit is right now: in the warehouse, out at venues, in repair, or missing. Units in repair or missing are off availability until you resolve them in the Repair Queue.';
  if (!position.length) { panel.innerHTML = '<p class="muted">No active hire items yet.</p>'; return; }
  const body = position.map((r) => `<tr>
    <td>${esc(r.code)}</td><td>${esc(r.name)}</td><td class="num">${qtyFmt(r.owned)}</td>
    <td class="num"><strong>${qtyFmt(r.on_hand)}</strong></td><td class="num">${qtyFmt(r.at_venue)}</td>
    <td class="num">${Number(r.in_repair) ? qtyFmt(r.in_repair) : ''}</td><td class="num">${Number(r.missing) ? qtyFmt(r.missing) : ''}</td></tr>`).join('');
  panel.innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr><th>Code</th><th>Hire item</th>
    <th style="text-align:right">Owned</th><th style="text-align:right">On hand</th><th style="text-align:right">At venues</th>
    <th style="text-align:right">In repair</th><th style="text-align:right">Missing</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

const outList = () => outNow.filter((r) => (!onlyOverdue || r.days_overdue > 0)
  && (!needle || [r.booking_no, r.customer, r.event_name, r.venue_name, r.item_code, r.item_name]
    .some((v) => String(v || '').toLowerCase().includes(needle))));

function renderOut() {
  hint.textContent = 'Everything currently dispatched and not yet checked in, by booking and venue. Overdue means the booking\'s back date has passed. Overdue items keep blocking availability until they are checked in.';
  const list = outList();
  if (!outNow.length) { panel.innerHTML = '<p class="muted">Nothing is out at a venue right now.</p>'; return; }
  if (!list.length) { panel.innerHTML = '<p class="muted">Nothing matches.</p>'; return; }
  const body = list.map((r) => `<tr>
    <td>${esc(r.booking_no)}</td><td>${esc(r.customer)}</td><td>${esc(r.event_name)}</td>
    <td>${esc(r.venue_name || '')}</td><td>${esc(r.site_contact || '')}</td><td>${esc(r.item_code)} - ${esc(r.item_name)}</td>
    <td class="num">${qtyFmt(r.qty_out)}</td><td>${r.end_date}</td>
    <td>${r.days_overdue > 0 ? `<span class="badge st-error">${r.days_overdue} day(s) overdue</span>` : ''}</td></tr>`).join('');
  panel.innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr><th>Booking</th><th>Customer</th><th>Event</th>
    <th>Venue</th><th>Site contact</th><th>Hire item</th><th style="text-align:right">Qty out</th><th>Due back</th><th>Status</th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

async function doExport() {
  try {
    if (tab === 'item') {
      if (!position.length) return ui.warn('There is nothing to export.');
      await exportSheets(`hire-position-${todayIso()}.xlsx`, [{
        name: 'By hire item', title: 'Hire stock position', subtitle: `As at ${todayIso()}`, totals: false,
        rows: position.map((r) => ({ code: r.code, name: r.name, owned: Number(r.owned), onHand: Number(r.on_hand),
          atVenue: Number(r.at_venue), repair: Number(r.in_repair), missing: Number(r.missing) })),
        columns: [
          { key: 'code', header: 'Code', width: 12 }, { key: 'name', header: 'Hire item', width: 32 }, { key: 'owned', header: 'Owned', width: 10 },
          { key: 'onHand', header: 'On hand', width: 10 }, { key: 'atVenue', header: 'At venues', width: 10 },
          { key: 'repair', header: 'In repair', width: 10 }, { key: 'missing', header: 'Missing', width: 10 },
        ],
      }]);
    } else {
      const list = outList();
      if (!list.length) return ui.warn('There is nothing to export.');
      await exportSheets(`hire-out-${todayIso()}.xlsx`, [{
        name: 'Out at venues', title: 'Items out on hire', subtitle: `As at ${todayIso()}`, totals: false,
        rows: list.map((r) => ({ booking: r.booking_no, customer: r.customer, event: r.event_name, venue: r.venue_name || '',
          contact: r.site_contact || '', item: `${r.item_code} - ${r.item_name}`, qty: Number(r.qty_out), due: r.end_date, overdue: r.days_overdue })),
        columns: [
          { key: 'booking', header: 'Booking', width: 12 }, { key: 'customer', header: 'Customer', width: 28 }, { key: 'event', header: 'Event', width: 26 },
          { key: 'venue', header: 'Venue', width: 24 }, { key: 'contact', header: 'Site contact', width: 20 }, { key: 'item', header: 'Hire item', width: 30 },
          { key: 'qty', header: 'Qty out', width: 10 }, { key: 'due', header: 'Due back', width: 12 }, { key: 'overdue', header: 'Days overdue', width: 12 },
        ],
        styleCell: (row, col) => (col.key === 'overdue' && row.overdue > 0 ? { fill: 'FEE2E2', color: '991B1B', bold: true } : null),
      }]);
    }
  } catch (e) { ui.errorFrom(e, 'Could not export.'); }
}

if (ctx) {
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => { tab = t.dataset.tab; render(); }));
  await refresh();
}