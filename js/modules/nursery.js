import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { exportSheets } from '../core/export.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const note = document.getElementById('note');
const panel = document.getElementById('panel');

const CAN_WORK = ctx ? ['owner', 'admin', 'accountant', 'clerk'].includes(ctx.role) : false;
const CAN_BOOKS = ctx ? ctx.canEdit : false;
const STATUS = { growing: 'Growing', partly_released: 'Partly released', closed: 'Closed', written_off: 'Written off' };
const ACTIVE = ['growing', 'partly_released'];
const KIND = { material: 'Materials', labour: 'Labour', overhead: 'Overheads', other: 'Other costs', release: 'Released to stock', write_off: 'Written off' };
const STAGES = ['Germinated', 'Pricked out', 'Potted on', 'Hardened off', 'Ready to sell'];

let tab = 'batches';
let batches = [];
let batchMap = new Map();
let items = [];
let itemMap = new Map();
let warehouses = [];
let accounts = [];
let recon = null;
let base = '';
let statusFilter = 'active';
let varietyFilter = '';
let needle = '';
let showEmpty = false;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
function ageText(sown) {
  const days = Math.max(0, Math.round((Date.now() - new Date(`${sown}T00:00:00Z`)) / 86400000));
  if (days < 60) return `${days} d`;
  const months = days / 30.4375;
  if (months < 24) return `${Math.floor(months)} mo`;
  return `${(days / 365.25).toFixed(1)} yr`;
}
const perPlant = (b) => (Number(b.qty_alive) > 0 ? Number(b.wip_balance) / Number(b.qty_alive) : 0);
const varietyOf = (b) => itemMap.get(b.item_id);

/* ---------- data ---------- */

async function load() {
  const cid = ctx.companyId;
  const [b, it, w, a, cu, rc] = await Promise.all([
    supabase.from('nursery_batches').select('*').eq('company_id', cid).order('sown_date', { ascending: false }).limit(1000),
    supabase.from('items').select('id, code, name, item_type, sales_price, is_active, nursery_batch_id, stock_balances(warehouse_id, qty_on_hand, value)')
      .eq('company_id', cid).order('code'),
    supabase.from('warehouses').select('id, code, name, is_default').eq('company_id', cid).eq('is_active', true).order('code'),
    supabase.from('gl_accounts').select('id, code, name, account_groups(class_type)').eq('company_id', cid)
      .eq('is_posting', true).eq('is_active', true).is('control_type', null).order('code'),
    supabase.from('company_currencies').select('code').eq('company_id', cid).eq('is_base', true).maybeSingle(),
    supabase.rpc('nursery_reconciliation', { p_company: cid, p_as_of: todayIso() }),
  ]);
  for (const r of [b, it, w, a]) if (r.error) throw r.error;
  batches = b.data;
  batchMap = new Map(batches.map((x) => [x.id, x]));
  items = it.data;
  itemMap = new Map(items.map((x) => [x.id, x]));
  warehouses = w.data;
  accounts = a.data.filter((x) => x.account_groups && x.account_groups.class_type === 'income_statement');
  base = cu.data ? cu.data.code : '';
  recon = rc.error || !rc.data || !rc.data[0] ? null : rc.data[0];
}

async function refresh() {
  try { await load(); } catch (e) { ui.errorFrom(e, 'Could not load the nursery.'); }
  render();
}

async function reopen(id) {
  await refresh();
  const nb = batchMap.get(id);
  if (nb) await openBatch(nb);
}

/* ---------- page ---------- */

function render() {
  document.getElementById('company-title').textContent = ctx.company.name;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  toolbar.replaceChildren();
  if (tab === 'batches') {
    if (CAN_WORK) toolbar.append(btn('New batch', 'btn-primary', openNewBatch));
    if (CAN_BOOKS) toolbar.append(btn('Allocate overhead', '', openAllocate));
    const sel = el('select', 'compact');
    [['active', 'Growing'], ['all', 'All'], ['closed', 'Closed'], ['written_off', 'Written off']].forEach(([v, l]) => option(sel, v, l));
    sel.value = statusFilter;
    sel.addEventListener('change', () => { statusFilter = sel.value; renderBatches(); });
    toolbar.append(sel);
  } else {
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = showEmpty;
    cb.style.width = 'auto';
    cb.addEventListener('change', () => { showEmpty = cb.checked; renderStock(); });
    const l = el('label');
    l.style.cssText = 'display:flex;align-items:center;gap:.4rem;cursor:pointer';
    l.append(cb, document.createTextNode('Show batches with none in stock'));
    toolbar.append(l);
  }
  const vsel = el('select', 'compact');
  vsel.style.maxWidth = '220px';
  option(vsel, '', 'All varieties');
  items.filter((i) => i.item_type === 'manufactured' && !i.nursery_batch_id).forEach((i) => option(vsel, i.id, `${i.code} - ${i.name}`));
  vsel.value = varietyFilter;
  vsel.addEventListener('change', () => { varietyFilter = vsel.value; if (tab === 'batches') renderBatches(); else renderStock(); });
  const box = el('input');
  box.type = 'search';
  box.placeholder = 'Search';
  box.value = needle;
  box.style.maxWidth = '200px';
  box.addEventListener('input', () => { needle = box.value.trim().toLowerCase(); if (tab === 'batches') renderBatches(); else renderStock(); });
  toolbar.append(vsel, box, el('span', 'spacer'), btn('Export to Excel', '', doExport));

  hint.textContent = tab === 'batches'
    ? `Each batch carries its own work in progress cost, in ${base}. Click a batch to add costs, record losses and release plants to stock.`
    : 'Plants released to stock, one stock item per batch, so each keeps its own cost and age. Sell the oldest batches first by choosing that batch\'s item on the invoice.';
  note.innerHTML = '';
  if (recon) {
    const diff = Number(recon.difference);
    note.innerHTML = `<p><span class="badge ${Math.abs(diff) < 0.005 ? 'open' : 'st-error'}">${Math.abs(diff) < 0.005
      ? 'Batch work in progress agrees to the WIP control account'
      : `Batch work in progress differs from the WIP control account by ${money(diff)}`}</span>
      <span class="muted">Batches ${money(recon.subledger)} · ledger ${money(recon.ledger)}</span></p>`;
  }
  if (tab === 'batches') renderBatches(); else renderStock();
}

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => { tab = t.dataset.tab; render(); }));

/* ---------- batches tab ---------- */

const visibleBatches = () => batches.filter((b) => (statusFilter === 'all' || (statusFilter === 'active' ? ACTIVE.includes(b.status) : b.status === statusFilter))
  && (!varietyFilter || b.item_id === varietyFilter)
  && (!needle || [b.batch_no, b.name, b.location, b.stage, (varietyOf(b) || {}).name].some((v) => String(v || '').toLowerCase().includes(needle))));

function renderBatches() {
  if (!batches.length) { panel.innerHTML = '<p class="muted">No batches yet. Click New batch to start one.</p>'; return; }
  const list = visibleBatches();
  if (!list.length) { panel.innerHTML = '<p class="muted">No batches match.</p>'; return; }
  const today = todayIso();
  const alive = list.reduce((s, b) => s + Number(b.qty_alive), 0);
  const wip = list.reduce((s, b) => s + Number(b.wip_balance), 0);
  const body = list.map((b) => {
    const v = varietyOf(b);
    const ready = ACTIVE.includes(b.status) && b.expected_ready && b.expected_ready <= today;
    return `<tr class="clickable" data-id="${b.id}"><td>${esc(b.batch_no)}</td><td>${esc(b.name)}</td><td>${esc(v ? v.name : '')}</td>
      <td>${b.sown_date}</td><td>${ageText(b.sown_date)}</td><td class="num">${qtyFmt(b.qty_start)}</td><td class="num">${qtyFmt(b.qty_alive)}</td>
      <td class="num">${qtyFmt(b.qty_released)}</td><td class="num">${qtyFmt(b.qty_lost)}</td>
      <td class="num">${money(b.wip_balance)}</td><td class="num">${Number(b.qty_alive) > 0 ? money(perPlant(b)) : ''}</td>
      <td>${esc(b.stage || '')}</td><td>${b.expected_ready || ''}${ready ? ' <span class="badge open">Ready</span>' : ''}</td>
      <td><span class="badge ${b.status === 'written_off' ? 'st-error' : (b.status === 'closed' ? '' : 'st-update')}">${STATUS[b.status]}</span></td></tr>`;
  }).join('');
  panel.innerHTML = `<p class="muted">${list.length} batch(es) · ${qtyFmt(alive)} plants still growing · work in progress ${money(wip)} ${esc(base)}</p>
    <div class="table-wrap"><table class="grid"><thead><tr><th>Batch</th><th>Name</th><th>Variety</th><th>Sown</th><th>Age</th>
    <th style="text-align:right">Started</th><th style="text-align:right">Growing</th><th style="text-align:right">Released</th>
    <th style="text-align:right">Lost</th><th style="text-align:right">WIP cost</th><th style="text-align:right">Cost per plant</th>
    <th>Stage</th><th>Expected ready</th><th>Status</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

panel.addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  const b = batchMap.get(tr.dataset.id);
  if (b) openBatch(b);
});

/* ---------- plant stock tab ---------- */

function stockRows() {
  const out = [];
  items.filter((i) => i.nursery_batch_id).forEach((i) => {
    const b = batchMap.get(i.nursery_batch_id);
    if (!b) return;
    const sb = i.stock_balances || [];
    const qty = sb.reduce((s, x) => s + Number(x.qty_on_hand), 0);
    const value = sb.reduce((s, x) => s + Number(x.value), 0);
    out.push({ item: i, batch: b, variety: varietyOf(b), qty, value, cost: qty > 0 ? value / qty : 0, price: i.sales_price === null ? null : Number(i.sales_price) });
  });
  return out.filter((r) => (showEmpty || r.qty > 0) && (!varietyFilter || r.batch.item_id === varietyFilter)
    && (!needle || [r.item.code, r.item.name, r.batch.batch_no, r.batch.name].some((v) => String(v || '').toLowerCase().includes(needle))))
    .sort((a, b) => a.batch.sown_date.localeCompare(b.batch.sown_date));
}

function renderStock() {
  const rows = stockRows();
  if (!rows.length) { panel.innerHTML = '<p class="muted">No plants from batches are in stock. Release plants from a batch to put them in stock.</p>'; return; }
  const qty = rows.reduce((s, r) => s + r.qty, 0);
  const val = rows.reduce((s, r) => s + r.value, 0);
  const body = rows.map((r) => {
    const margin = r.price && r.cost > 0 ? ((r.price - r.cost) / r.price) * 100 : null;
    return `<tr><td>${esc(r.item.code)}</td><td>${esc(r.variety ? r.variety.name : '')}</td><td>${esc(r.batch.name)}</td>
      <td>${r.batch.sown_date}</td><td>${ageText(r.batch.sown_date)}</td><td class="num">${qtyFmt(r.qty)}</td>
      <td class="num">${Number(r.batch.qty_alive) > 0 ? qtyFmt(r.batch.qty_alive) : ''}</td>
      <td class="num">${r.qty > 0 ? money(r.cost) : ''}</td><td class="num">${money(r.value)}</td>
      <td class="num">${r.price === null ? '' : money(r.price)}</td><td class="num">${margin === null ? '' : `${margin.toFixed(0)}%`}</td></tr>`;
  }).join('');
  panel.innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr><th>Stock item</th><th>Variety</th><th>Batch</th><th>Sown</th><th>Age</th>
    <th style="text-align:right">In stock</th><th style="text-align:right">Still growing</th><th style="text-align:right">Cost per plant</th>
    <th style="text-align:right">Stock value (${esc(base)})</th><th style="text-align:right">Sales price</th><th style="text-align:right">Margin</th></tr></thead>
    <tbody>${body}<tr class="row-root"><td colspan="5">Total</td><td class="num">${qtyFmt(qty)}</td><td></td><td></td>
    <td class="num">${money(val)}</td><td colspan="2"></td></tr></tbody></table></div>`;
}

/* ---------- export ---------- */

async function doExport() {
  try {
    if (tab === 'batches') {
      const list = visibleBatches();
      if (!list.length) return ui.warn('There is nothing to export.');
      await exportSheets(`nursery-batches-${todayIso()}.xlsx`, [{
        name: 'Batches', title: 'Nursery batches', subtitle: `As at ${todayIso()}, amounts in ${base}`,
        rows: list.map((b) => ({
          batch: b.batch_no, name: b.name, variety: (varietyOf(b) || {}).name || '', sown: b.sown_date, age: ageText(b.sown_date),
          started: Number(b.qty_start), growing: Number(b.qty_alive), released: Number(b.qty_released), lost: Number(b.qty_lost),
          wip: Number(b.wip_balance), per: Number(b.qty_alive) > 0 ? perPlant(b) : '', stage: b.stage || '', ready: b.expected_ready || '', status: STATUS[b.status],
        })),
        columns: [
          { key: 'batch', header: 'Batch', width: 12 }, { key: 'name', header: 'Name', width: 26 }, { key: 'variety', header: 'Variety', width: 26 },
          { key: 'sown', header: 'Sown', width: 12 }, { key: 'age', header: 'Age', width: 9 },
          { key: 'started', header: 'Started', width: 10, total: true }, { key: 'growing', header: 'Growing', width: 10, total: true },
          { key: 'released', header: 'Released', width: 10, total: true }, { key: 'lost', header: 'Lost', width: 9, total: true },
          { key: 'wip', header: `WIP cost (${base})`, width: 16 }, { key: 'per', header: 'Cost per plant', width: 14, total: false },
          { key: 'stage', header: 'Stage', width: 16 }, { key: 'ready', header: 'Expected ready', width: 14 }, { key: 'status', header: 'Status', width: 14 },
        ],
      }]);
    } else {
      const rows = stockRows();
      if (!rows.length) return ui.warn('There is nothing to export.');
      await exportSheets(`plant-stock-${todayIso()}.xlsx`, [{
        name: 'Plant stock', title: 'Plant stock by batch', subtitle: `As at ${todayIso()}, amounts in ${base}`,
        rows: rows.map((r) => ({
          code: r.item.code, variety: r.variety ? r.variety.name : '', batch: r.batch.name, sown: r.batch.sown_date, age: ageText(r.batch.sown_date),
          qty: r.qty, growing: Number(r.batch.qty_alive), cost: r.qty > 0 ? r.cost : '', value: r.value, price: r.price === null ? '' : r.price,
          margin: r.price && r.cost > 0 ? ((r.price - r.cost) / r.price) * 100 : '',
        })),
        columns: [
          { key: 'code', header: 'Stock item', width: 22 }, { key: 'variety', header: 'Variety', width: 26 }, { key: 'batch', header: 'Batch', width: 22 },
          { key: 'sown', header: 'Sown', width: 12 }, { key: 'age', header: 'Age', width: 9 },
          { key: 'qty', header: 'In stock', width: 11, total: true }, { key: 'growing', header: 'Still growing', width: 13, total: true },
          { key: 'cost', header: 'Cost per plant', width: 14, total: false }, { key: 'value', header: `Stock value (${base})`, width: 18 },
          { key: 'price', header: 'Sales price', width: 12, total: false }, { key: 'margin', header: 'Margin %', width: 11, format: '0', total: false },
        ],
      }]);
    }
  } catch (e) { ui.errorFrom(e, 'Could not export.'); }
}

/* ---------- new batch ---------- */

async function openNewBatch() {
  const varieties = items.filter((i) => i.item_type === 'manufactured' && !i.nursery_batch_id && i.is_active);
  if (!varieties.length) {
    return ui.warn('Create a plant item first: an item in a Manufactured category (with a work in progress account) for each variety.');
  }
  const saved = await ui.form({
    title: 'New batch', submitText: 'Create batch',
    fields: [
      { name: 'name', label: 'Batch name', required: true, full: true, hint: 'For example "Rose Apr-26".' },
      { name: 'item', label: 'Variety', type: 'select', required: true, full: true,
        options: [{ value: '', label: 'Select a variety' }].concat(varieties.map((i) => ({ value: i.id, label: `${i.code} - ${i.name}` }))) },
      { name: 'sown', label: 'Sown on', type: 'date', required: true },
      { name: 'qty', label: 'Number of plants', type: 'number', required: true },
      { name: 'expected', label: 'Expected ready', type: 'date' },
      { name: 'location', label: 'Location (bed, tunnel)' },
      { name: 'notes', label: 'Notes', full: true },
    ],
    values: { sown: todayIso() },
    onSubmit: async (v) => {
      if (!(v.qty >= 1) || v.qty !== Math.round(v.qty)) throw new Error('Enter the number of plants as a whole number.');
      const { error } = await supabase.rpc('create_nursery_batch', {
        p_company: ctx.companyId, p_name: v.name, p_item: v.item, p_sown: v.sown, p_qty: v.qty,
        p_expected: v.expected || null, p_location: v.location, p_notes: v.notes,
      });
      if (error) throw error;
    },
  });
  if (saved) { ui.created('Batch'); await refresh(); }
}

/* ---------- batch view ---------- */

async function openBatch(b) {
  const [cs, ev] = await Promise.all([
    supabase.from('nursery_costs').select('*, items(code, name)').eq('batch_id', b.id)
      .order('cost_date', { ascending: false }).order('created_at', { ascending: false }).limit(300),
    supabase.from('nursery_events').select('*').eq('batch_id', b.id).order('event_date', { ascending: false }).order('created_at', { ascending: false }),
  ]);
  for (const r of [cs, ev]) if (r.error) return ui.errorFrom(r.error, 'Could not load the batch.');
  const v = varietyOf(b);
  const bi = b.batch_item_id ? itemMap.get(b.batch_item_id) : null;
  const sums = {};
  cs.data.forEach((c) => { sums[c.kind] = (sums[c.kind] || 0) + Number(c.amount); });
  const active = ACTIVE.includes(b.status);

  const node = el('div');
  const info = el('p', 'muted', [
    `${v ? `${v.code} - ${v.name}` : ''} · ${STATUS[b.status]}`,
    `Sown ${b.sown_date} (${ageText(b.sown_date)})${b.expected_ready ? ` · expected ready ${b.expected_ready}` : ''}${b.location ? ` · ${b.location}` : ''}`,
    `Stage: ${b.stage || '-'}`,
    `Started ${qtyFmt(b.qty_start)} · growing ${qtyFmt(b.qty_alive)} · lost ${qtyFmt(b.qty_lost)} · released ${qtyFmt(b.qty_released)}`,
    `Work in progress ${money(b.wip_balance)} ${base}${Number(b.qty_alive) > 0 ? ` · ${money(perPlant(b))} per growing plant` : ''}`,
    bi ? `Stock item for released plants: ${bi.code}` : '', b.notes ? `Notes: ${b.notes}` : '',
  ].filter(Boolean).join('\n'));
  info.style.whiteSpace = 'pre-line';
  node.append(info);

  node.append(el('h4', '', 'Cost summary'));
  const sum = el('div', 'table-wrap');
  sum.innerHTML = `<table class="grid"><tbody>${Object.keys(KIND).filter((k) => sums[k] !== undefined).map((k) =>
    `<tr><td>${KIND[k]}</td><td class="num">${money(sums[k])}</td></tr>`).join('')}
    <tr class="row-root"><td>Work in progress now</td><td class="num">${money(b.wip_balance)}</td></tr></tbody></table>`;
  node.append(sum);

  node.append(el('h4', '', 'Cost history'));
  const t1 = el('div', 'table-wrap');
  t1.innerHTML = cs.data.length
    ? `<table class="grid"><thead><tr><th>Date</th><th>Type</th><th>Description</th><th style="text-align:right">Quantity</th>
      <th style="text-align:right">Amount (${esc(base)})</th></tr></thead><tbody>${cs.data.map((c) => `<tr><td>${c.cost_date}</td><td>${KIND[c.kind]}</td>
      <td>${esc(c.description || '')}${c.items ? ` <span class="muted">${esc(c.items.code)}</span>` : ''}</td>
      <td class="num">${c.qty === null ? '' : qtyFmt(c.qty)}</td><td class="num">${money(c.amount)}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">No costs yet.</p>';
  node.append(t1);

  node.append(el('h4', '', 'Stages, losses and releases'));
  const t2 = el('div', 'table-wrap');
  const EV = { stage: 'Stage', loss: 'Loss', release: 'Released', write_off: 'Written off' };
  t2.innerHTML = `<table class="grid"><thead><tr><th>Date</th><th>Event</th><th style="text-align:right">Plants</th><th style="text-align:right">Cost</th><th>Note</th></tr></thead><tbody>
    ${ev.data.map((e) => `<tr><td>${e.event_date}</td><td>${EV[e.kind]}</td><td class="num">${Number(e.qty) ? qtyFmt(e.qty) : ''}</td>
    <td class="num">${Number(e.value) ? money(e.value) : ''}</td><td>${esc(e.note || '')}</td></tr>`).join('')}</tbody></table>`;
  node.append(t2);

  const buttons = [{ label: 'Close', value: 'close', className: 'btn-ghost' }];
  if (active && CAN_WORK) buttons.push({ label: 'Add materials', value: 'material', className: '' }, { label: 'Add labour or cost', value: 'cost', className: '' },
    { label: 'Record loss', value: 'loss', className: '' }, { label: 'Set stage', value: 'stage', className: '' });
  if (active && CAN_BOOKS) buttons.push({ label: 'Release to stock', value: 'release', className: 'btn-primary' }, { label: 'Write off', value: 'writeoff', className: 'btn-danger' });
  const res = await ui.dialog({ title: `${b.batch_no} - ${b.name}`, node, wide: true, dismissValue: 'close', buttons });
  const done = async (p) => { if (await p) await reopen(b.id); };
  if (res === 'material') await done(addMaterial(b));
  else if (res === 'cost') await done(addCost(b));
  else if (res === 'loss') await done(recordLoss(b));
  else if (res === 'stage') await done(setStage(b));
  else if (res === 'release') await done(release(b));
  else if (res === 'writeoff') await done(writeOff(b));
}

const rpcGo = async (fn, args) => { const { error } = await supabase.rpc(fn, { p_company: ctx.companyId, ...args }); if (error) throw error; };
const whOptions = () => warehouses.map((w) => ({ value: w.id, label: `${w.code} - ${w.name}` }));
const defaultWh = () => (warehouses.find((w) => w.is_default) || warehouses[0] || {}).id || '';
const acctOptions = () => [{ value: '', label: 'Select an account' }].concat(accounts.map((a) => ({ value: a.id, label: `${a.code} - ${a.name}` })));
const CREDIT_KEY = () => `nursery-credit-${ctx.companyId}`;
const lastCredit = () => { try { return localStorage.getItem(CREDIT_KEY()) || ''; } catch (e) { return ''; } };
const rememberCredit = (id) => { try { localStorage.setItem(CREDIT_KEY(), id); } catch (e) { /* ignore */ } };

async function addMaterial(b) {
  const mats = items.filter((i) => i.item_type !== 'service' && !i.nursery_batch_id && i.is_active);
  if (!mats.length) { ui.warn('There are no stock items to use as materials.'); return false; }
  const saved = await ui.form({
    title: `Materials for ${b.batch_no}`, submitText: 'Issue to batch',
    fields: [
      { name: 'item', label: 'Material', type: 'select', required: true, full: true,
        options: [{ value: '', label: 'Select a stock item' }].concat(mats.map((i) => ({ value: i.id, label: `${i.code} - ${i.name}` }))) },
      { name: 'wh', label: 'From warehouse', type: 'select', required: true, options: whOptions() },
      { name: 'qty', label: 'Quantity used', type: 'number', required: true },
      { name: 'date', label: 'Date', type: 'date', required: true },
      { name: 'notes', label: 'Notes', full: true, hint: 'Taken from stock at its average cost: it debits the batch work in progress and credits inventory.' },
    ],
    values: { wh: defaultWh(), date: todayIso() },
    onSubmit: async (v) => { await rpcGo('nursery_add_material', { p_batch: b.id, p_date: v.date, p_item: v.item, p_wh: v.wh, p_qty: v.qty, p_notes: v.notes }); },
  });
  if (saved) ui.success('Materials issued to the batch.');
  return saved;
}

async function addCost(b) {
  if (!accounts.length) { ui.warn('There are no ordinary expense accounts to capitalise from.'); return false; }
  const saved = await ui.form({
    title: `Add a cost to ${b.batch_no}`, submitText: 'Add cost',
    fields: [
      { name: 'kind', label: 'Type', type: 'select', required: true,
        options: [{ value: 'labour', label: 'Labour' }, { value: 'overhead', label: 'Overhead' }, { value: 'other', label: 'Other' }] },
      { name: 'amount', label: `Amount (${base})`, type: 'number', required: true },
      { name: 'date', label: 'Date', type: 'date', required: true },
      { name: 'credit', label: 'Capitalise from account', type: 'select', required: true, full: true, options: acctOptions(),
        hint: 'The expense account the cost was posted to (for example Wages). It is credited, so profit is not counted twice.' },
      { name: 'desc', label: 'Description', full: true },
    ],
    values: { kind: 'labour', date: todayIso(), credit: lastCredit() },
    onSubmit: async (v) => {
      await rpcGo('nursery_add_cost', { p_batch: b.id, p_date: v.date, p_kind: v.kind, p_amount: v.amount, p_credit: v.credit, p_desc: v.desc });
      rememberCredit(v.credit);
    },
  });
  if (saved) ui.success('Cost added to the batch.');
  return saved;
}

async function recordLoss(b) {
  const saved = await ui.form({
    title: `Record a loss on ${b.batch_no}`, submitText: 'Record loss',
    fields: [
      { name: 'qty', label: 'Plants lost', type: 'number', required: true, hint: `Up to ${qtyFmt(Number(b.qty_alive) - 1)}. Their cost stays in the batch, so each surviving plant carries more.` },
      { name: 'date', label: 'Date', type: 'date', required: true },
      { name: 'reason', label: 'Reason', full: true },
    ],
    values: { date: todayIso() },
    onSubmit: async (v) => { await rpcGo('nursery_record_loss', { p_batch: b.id, p_date: v.date, p_qty: v.qty, p_reason: v.reason }); },
  });
  if (saved) ui.updated('Batch');
  return saved;
}

async function setStage(b) {
  const saved = await ui.form({
    title: `Stage for ${b.batch_no}`, submitText: 'Save stage',
    fields: [
      { name: 'stage', label: 'Stage', type: 'select', full: true,
        options: [{ value: '', label: 'Choose a stage' }].concat(STAGES.map((s) => ({ value: s, label: s })), [{ value: '__other', label: 'Other (type below)' }]) },
      { name: 'custom', label: 'Other stage', full: true },
      { name: 'date', label: 'Date', type: 'date', required: true },
      { name: 'note', label: 'Note', full: true },
    ],
    values: { date: todayIso(), stage: STAGES.includes(b.stage) ? b.stage : '' },
    onSubmit: async (v) => {
      const stage = v.stage === '__other' || !v.stage ? (v.custom || '').trim() : v.stage;
      if (!stage) throw new Error('Choose or type the stage.');
      await rpcGo('nursery_set_stage', { p_batch: b.id, p_date: v.date, p_stage: stage, p_note: v.note });
    },
  });
  if (saved) ui.updated('Batch');
  return saved;
}

async function release(b) {
  if (!warehouses.length) { ui.warn('Create a warehouse for the plants first.'); return false; }
  const v = varietyOf(b);
  const bi = b.batch_item_id ? itemMap.get(b.batch_item_id) : null;
  const saved = await ui.form({
    title: `Release ${b.batch_no} to stock`, submitText: 'Release',
    fields: [
      { name: 'qty', label: 'Plants to release', type: 'number', required: true,
        hint: `Up to ${qtyFmt(b.qty_alive)}. They leave work in progress at ${money(perPlant(b))} ${base} each, the batch's cost per plant now.` },
      { name: 'date', label: 'Date', type: 'date', required: true },
      { name: 'wh', label: 'Into warehouse', type: 'select', required: true, options: whOptions() },
      { name: 'price', label: `Sales price (${base})`, type: 'number',
        hint: bi ? `Updates the price of ${bi.code}. Leave as is to keep it.` : 'A stock item for this batch is created, and its price starts from here.' },
    ],
    values: { qty: Number(b.qty_alive), date: todayIso(), wh: defaultWh(), price: bi && bi.sales_price !== null ? Number(bi.sales_price) : (v && v.sales_price !== null ? Number(v.sales_price) : '') },
    onSubmit: async (f) => {
      if (!(f.qty >= 1) || f.qty !== Math.round(f.qty)) throw new Error('Enter a whole number of plants.');
      await rpcGo('nursery_release', { p_batch: b.id, p_date: f.date, p_qty: f.qty, p_wh: f.wh, p_price: f.price === '' || f.price === null ? null : f.price });
    },
  });
  if (saved) ui.success('Plants released to stock at the batch cost.');
  return saved;
}

async function writeOff(b) {
  if (!accounts.length) { ui.warn('There are no ordinary expense accounts to book the loss to.'); return false; }
  const saved = await ui.form({
    title: `Write off ${b.batch_no}`, submitText: 'Write off',
    fields: [
      { name: 'loss', label: 'Loss account', type: 'select', required: true, full: true, options: acctOptions(),
        hint: `The remaining cost of ${money(b.wip_balance)} ${base} is moved from work in progress to this account, and the ${qtyFmt(b.qty_alive)} remaining plants are written off.` },
      { name: 'date', label: 'Date', type: 'date', required: true },
      { name: 'reason', label: 'Reason', full: true },
    ],
    values: { date: todayIso() },
    onSubmit: async (v) => { await rpcGo('nursery_write_off', { p_batch: b.id, p_date: v.date, p_loss: v.loss, p_reason: v.reason }); },
  });
  if (saved) ui.updated('Batch');
  return saved;
}

/* ---------- allocate a shared overhead ---------- */

async function openAllocate() {
  const growing = batches.filter((b) => ACTIVE.includes(b.status));
  if (!growing.length) return ui.warn('There are no growing batches to allocate to.');
  if (!accounts.length) return ui.warn('There are no ordinary expense accounts to capitalise from.');

  const prevFocus = document.activeElement;
  const backdrop = el('div', 'modal-backdrop');
  const box = el('div', 'modal xwide');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.append(el('h3', 'modal-title', 'Allocate a shared overhead'));
  box.append(el('p', 'muted', 'Share one cost (for example greenhouse running costs) across the growing batches you choose. It posts one journal: debit each batch\'s work in progress, credit the expense account it was posted to.'));
  const field = (text, input, full) => { const w = el('div', `field${full ? ' full' : ''}`); w.append(el('label', '', text), input); return w; };
  const amount = el('input'); amount.type = 'number'; amount.step = 'any';
  const date = el('input'); date.type = 'date'; date.value = todayIso();
  const basis = el('select'); option(basis, 'plants', 'By plants still growing'); option(basis, 'equal', 'Equally per batch');
  const acc = el('select'); acctOptions().forEach((o) => option(acc, o.value, o.label)); acc.value = lastCredit();
  const desc = el('input'); desc.placeholder = 'For example Greenhouse costs, October';
  const head = el('div', 'form-grid');
  head.append(field(`Amount (${base})`, amount), field('Date', date), field('Share', basis), field('Capitalise from account', acc, true), field('Description', desc, true));
  box.append(head);

  const wrap = el('div', 'lines-wrap');
  const table = el('table', 'lines-table');
  table.style.minWidth = '560px';
  table.innerHTML = '<thead><tr><th></th><th>Batch</th><th>Name</th><th style="text-align:right">Growing</th><th style="text-align:right">Share</th></tr></thead>';
  const tb = el('tbody');
  const rows = growing.map((b) => {
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = true; cb.style.width = 'auto';
    const share = el('td', 'num');
    const tr = el('tr');
    const c0 = el('td'); c0.append(cb);
    tr.append(c0, el('td', '', b.batch_no), el('td', '', b.name), el('td', 'num', qtyFmt(b.qty_alive)), share);
    tb.append(tr);
    cb.addEventListener('change', recalc);
    return { b, cb, share };
  });
  table.append(tb);
  wrap.append(table);
  box.append(wrap);

  function recalc() {
    const chosen = rows.filter((r) => r.cb.checked);
    const total = chosen.reduce((s, r) => s + Number(r.b.qty_alive), 0);
    const amt = Number(amount.value) || 0;
    rows.forEach((r) => {
      if (!r.cb.checked || !amt) { r.share.textContent = ''; return; }
      const s = basis.value === 'plants' ? (total ? (amt * Number(r.b.qty_alive)) / total : 0) : amt / chosen.length;
      r.share.textContent = money(s);
    });
  }
  amount.addEventListener('input', recalc);
  basis.addEventListener('change', recalc);

  const actions = el('div', 'modal-actions');
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const close = () => { document.removeEventListener('keydown', onKey); backdrop.remove(); if (prevFocus && prevFocus.focus) prevFocus.focus(); };
  document.addEventListener('keydown', onKey);
  const go = btn('Allocate', 'btn-primary', () => {});
  actions.append(el('span', 'spacer'), btn('Cancel', 'btn-ghost', close), go);
  box.append(actions);
  backdrop.append(box);
  document.body.append(backdrop);

  go.addEventListener('click', async () => {
    const chosen = rows.filter((r) => r.cb.checked).map((r) => r.b.id);
    if (!chosen.length) return ui.warn('Choose at least one batch.');
    if (!(Number(amount.value) > 0)) return ui.warn('Enter the amount.');
    if (!date.value) return ui.warn('Enter the date.');
    if (!acc.value) return ui.warn('Choose the account to capitalise from.');
    go.disabled = true;
    try {
      await rpcGo('nursery_allocate_overhead', {
        p_date: date.value, p_amount: Number(amount.value), p_credit: acc.value, p_desc: desc.value, p_basis: basis.value, p_batches: chosen,
      });
      rememberCredit(acc.value);
      close();
      ui.success(`Overhead allocated across ${chosen.length} batch(es).`);
      await refresh();
    } catch (e) { ui.errorFrom(e, 'Could not allocate the overhead.'); go.disabled = false; }
  });
}

if (ctx) await refresh();