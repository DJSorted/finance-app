import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { exportSheets } from '../core/export.js';
import { openAttachmentsDialog, clipCell, clipHead, fillClips } from '../core/attachments.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const note = document.getElementById('note');
const panel = document.getElementById('panel');

const CAN_WORK = ctx ? ['owner', 'admin', 'accountant', 'clerk'].includes(ctx.role) : false;
const CAN_BOOKS = ctx ? ctx.canEdit : false;
const STATUS = { open: 'Open', completed: 'Completed', cancelled: 'Cancelled' };
const KIND = {
  material: 'Materials issued', labour: 'Labour', overhead: 'Overheads', other: 'Other costs', return: 'Materials returned',
  receipt: 'Finished goods received', write_off: 'Moved to variance',
};

let orders = [];
let items = [];
let itemMap = new Map();
let warehouses = [];
let accounts = [];
let bomItems = new Set();
let recon = null;
let base = '';
let statusFilter = 'open';
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
const todayIso = () => new Date().toISOString().slice(0, 10);
function btn(text, cls, onClick) {
  const b = el('button', `btn ${cls}`.trim(), text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}
function option(select, value, text) { const o = el('option', '', text); o.value = value; select.append(o); }
const rpcGo = async (fn, args) => { const { error } = await supabase.rpc(fn, { p_company: ctx.companyId, ...args }); if (error) throw error; };
const itemLabel = (id) => { const i = itemMap.get(id); return i ? `${i.code} - ${i.name}` : ''; };
const whOptions = () => warehouses.map((w) => ({ value: w.id, label: `${w.code} - ${w.name}` }));
const defaultWh = () => (warehouses.find((w) => w.is_default) || warehouses[0] || {}).id || '';
const acctOptions = () => [{ value: '', label: 'Select an account' }].concat(accounts.map((a) => ({ value: a.id, label: `${a.code} - ${a.name}` })));
const CREDIT_KEY = () => `wo-credit-${ctx.companyId}`;
const lastCredit = () => { try { return localStorage.getItem(CREDIT_KEY()) || ''; } catch (e) { return ''; } };
const rememberCredit = (id) => { try { localStorage.setItem(CREDIT_KEY(), id); } catch (e) { /* ignore */ } };

/* ---------- data ---------- */

async function load() {
  const cid = ctx.companyId;
  const [o, it, w, a, cu, bm, rc] = await Promise.all([
    supabase.from('work_orders').select('*').eq('company_id', cid).order('created_at', { ascending: false }).limit(1000),
    supabase.from('items').select('id, code, name, item_type, is_active, nursery_batch_id').eq('company_id', cid).order('code'),
    supabase.from('warehouses').select('id, code, name, is_default').eq('company_id', cid).eq('is_active', true).order('code'),
    supabase.from('gl_accounts').select('id, code, name, account_groups(class_type)').eq('company_id', cid)
      .eq('is_posting', true).eq('is_active', true).is('control_type', null).order('code'),
    supabase.from('company_currencies').select('code').eq('company_id', cid).eq('is_base', true).maybeSingle(),
    supabase.from('boms').select('item_id, is_active').eq('company_id', cid),
    supabase.rpc('manufacturing_reconciliation', { p_company: cid, p_as_of: todayIso() }),
  ]);
  for (const r of [o, it, w, a, bm]) if (r.error) throw r.error;
  orders = o.data;
  items = it.data;
  itemMap = new Map(items.map((x) => [x.id, x]));
  warehouses = w.data;
  accounts = a.data.filter((x) => x.account_groups && x.account_groups.class_type === 'income_statement');
  base = cu.data ? cu.data.code : '';
  bomItems = new Set(bm.data.filter((b) => b.is_active).map((b) => b.item_id));
  recon = rc.error || !rc.data || !rc.data[0] ? null : rc.data[0];
}

async function refresh() {
  try { await load(); } catch (e) { ui.errorFrom(e, 'Could not load the work orders.'); }
  render();
}
async function reopen(id) { await refresh(); await openOrder(id); }

/* ---------- list ---------- */

const visible = () => orders.filter((o) => (statusFilter === 'all' || o.status === statusFilter)
  && (!needle || [o.wo_no, o.reference, itemLabel(o.item_id)].some((v) => String(v || '').toLowerCase().includes(needle))));

function render() {
  document.getElementById('company-title').textContent = ctx.company.name;
  toolbar.replaceChildren();
  if (CAN_WORK) toolbar.append(btn('New work order', 'btn-primary', openNew));
  const sel = el('select', 'compact');
  [['open', 'Open'], ['all', 'All'], ['completed', 'Completed'], ['cancelled', 'Cancelled']].forEach(([v, l]) => option(sel, v, l));
  sel.value = statusFilter;
  sel.addEventListener('change', () => { statusFilter = sel.value; renderTable(); });
  const box = el('input');
  box.type = 'search';
  box.placeholder = 'Search';
  box.value = needle;
  box.style.maxWidth = '220px';
  box.addEventListener('input', () => { needle = box.value.trim().toLowerCase(); renderTable(); });
  toolbar.append(sel, box, el('span', 'spacer'), btn('Export to Excel', '', doExport));
  hint.textContent = `Each work order carries its own work in progress cost, in ${base}. Click an order to issue materials, add labour, receive finished goods and close it.`;
  note.innerHTML = '';
  if (recon) {
    const diff = Number(recon.difference);
    note.innerHTML = `<p><span class="badge ${Math.abs(diff) < 0.005 ? 'open' : 'st-error'}">${Math.abs(diff) < 0.005
      ? 'Production work in progress agrees to the WIP control account'
      : `Production work in progress differs from the WIP control account by ${money(diff)}`}</span>
      <span class="muted">Orders ${money(recon.subledger)} · ledger ${money(recon.ledger)}</span></p>`;
  }
  renderTable();
}

function renderTable() {
  if (!orders.length) { panel.innerHTML = '<p class="muted">No work orders yet. Click New work order to start one.</p>'; return; }
  const list = visible();
  if (!list.length) { panel.innerHTML = '<p class="muted">No work orders match.</p>'; return; }
  const today = todayIso();
  const wip = list.reduce((s, o) => s + Number(o.wip_balance), 0);
  const body = list.map((o) => {
    const late = o.status === 'open' && o.due_date && o.due_date < today;
    return `<tr class="clickable" data-id="${o.id}"><td>${esc(o.wo_no)}</td><td>${o.order_date}</td><td>${esc(itemLabel(o.item_id))}</td>
      <td class="num">${qtyFmt(o.qty_planned)}</td><td class="num">${qtyFmt(o.qty_received)}</td><td class="num">${money(o.wip_balance)}</td>
      <td>${o.due_date || ''}${late ? ' <span class="badge st-error">Overdue</span>' : ''}</td>
      <td><span class="badge ${o.status === 'open' ? 'st-update' : ''}">${STATUS[o.status]}</span></td>
      ${clipCell('work_orders', o.id)}</tr>`;
  }).join('');
  panel.innerHTML = `<p class="muted">${list.length} order(s) · work in progress ${money(wip)} ${esc(base)}</p>
    <div class="table-wrap"><table class="grid"><thead><tr><th>Order</th><th>Date</th><th>Finished item</th>
    <th style="text-align:right">Planned</th><th style="text-align:right">Received</th><th style="text-align:right">WIP cost</th><th>Due</th><th>Status</th>${clipHead}</tr></thead>
    <tbody>${body}</tbody></table></div>`;
  fillClips(ctx, panel, (id) => { const o = orders.find((x) => x.id === id); return `Attachments: ${(o && o.wo_no) || ''}`; });
}

panel.addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (tr) openOrder(tr.dataset.id);
});

async function doExport() {
  const list = visible();
  if (!list.length) return ui.warn('There is nothing to export.');
  try {
    await exportSheets(`work-orders-${todayIso()}.xlsx`, [{
      name: 'Work orders', title: 'Work orders', subtitle: `As at ${todayIso()}, amounts in ${base}`,
      rows: list.map((o) => ({
        no: o.wo_no, date: o.order_date, item: itemLabel(o.item_id), planned: Number(o.qty_planned), received: Number(o.qty_received),
        wip: Number(o.wip_balance), due: o.due_date || '', status: STATUS[o.status], ref: o.reference || '',
      })),
      columns: [
        { key: 'no', header: 'Order', width: 12 }, { key: 'date', header: 'Date', width: 12 }, { key: 'item', header: 'Finished item', width: 34 },
        { key: 'planned', header: 'Planned', width: 11, total: true }, { key: 'received', header: 'Received', width: 11, total: true },
        { key: 'wip', header: `WIP cost (${base})`, width: 16 }, { key: 'due', header: 'Due', width: 12 },
        { key: 'status', header: 'Status', width: 12 }, { key: 'ref', header: 'Reference', width: 18 },
      ],
    }]);
  } catch (e) { ui.errorFrom(e, 'Could not export.'); }
}

/* ---------- new order ---------- */

async function openNew() {
  const finished = items.filter((i) => i.item_type === 'manufactured' && !i.nursery_batch_id && i.is_active);
  if (!finished.length) return ui.warn('Create a manufactured item first (an item in a Manufactured category with work in progress accounts).');
  if (!warehouses.length) return ui.warn('Create a warehouse first.');
  const saved = await ui.form({
    title: 'New work order', submitText: 'Create order',
    fields: [
      { name: 'item', label: 'Finished item', type: 'select', required: true, full: true,
        options: [{ value: '', label: 'Select a finished item' }].concat(finished.map((i) => ({ value: i.id, label: `${i.code} - ${i.name}${bomItems.has(i.id) ? '' : ' (no bill of materials)'}` }))),
        hint: 'The components are copied from the item\'s bill of materials and scaled to the quantity. You can add more components afterwards.' },
      { name: 'qty', label: 'Quantity to make', type: 'number', required: true },
      { name: 'date', label: 'Order date', type: 'date', required: true },
      { name: 'due', label: 'Due date', type: 'date' },
      { name: 'from', label: 'Take components from', type: 'select', required: true, options: whOptions() },
      { name: 'to', label: 'Receive finished goods into', type: 'select', required: true, options: whOptions() },
      { name: 'reference', label: 'Reference' },
      { name: 'notes', label: 'Notes', full: true },
    ],
    values: { date: todayIso(), from: defaultWh(), to: defaultWh() },
    onSubmit: async (v) => {
      if (!(v.qty > 0)) throw new Error('Enter the quantity to make.');
      await rpcGo('create_work_order', {
        p_item: v.item, p_qty: v.qty, p_date: v.date, p_due: v.due || null, p_from: v.from, p_to: v.to,
        p_reference: v.reference, p_notes: v.notes,
      });
    },
  });
  if (saved) { ui.created('Work order'); await refresh(); }
}

/* ---------- order view ---------- */

async function openOrder(id) {
  const [o, l, c] = await Promise.all([
    supabase.from('work_orders').select('*').eq('id', id).single(),
    supabase.from('work_order_lines').select('*').eq('order_id', id).order('line_no'),
    supabase.from('work_order_costs').select('*').eq('order_id', id)
      .order('cost_date', { ascending: false }).order('created_at', { ascending: false }).limit(300),
  ]);
  for (const r of [o, l, c]) if (r.error) return ui.errorFrom(r.error, 'Could not load the work order.');
  const w = o.data;
  const lines = l.data;
  const open = w.status === 'open';
  const whName = (wid) => { const x = warehouses.find((y) => y.id === wid); return x ? x.code : ''; };
  const remaining = Number(w.qty_planned) - Number(w.qty_received);

  const node = el('div');
  const info = el('p', 'muted', [
    `${itemLabel(w.item_id)} · ${STATUS[w.status]}${w.reference ? ` · Ref ${w.reference}` : ''}`,
    `Ordered ${w.order_date}${w.due_date ? ` · due ${w.due_date}` : ''}${w.closed_date ? ` · closed ${w.closed_date}` : ''}`,
    `Components from ${whName(w.from_warehouse_id)} · finished goods into ${whName(w.to_warehouse_id)}`,
    `Planned ${qtyFmt(w.qty_planned)} · received ${qtyFmt(w.qty_received)}${open ? ` · still to receive ${qtyFmt(Math.max(remaining, 0))}` : ''}`,
    `Work in progress ${money(w.wip_balance)} ${base}${open && remaining > 0 && Number(w.wip_balance) > 0 ? ` · about ${money(Number(w.wip_balance) / remaining)} per unit still to make` : ''}`,
    w.notes ? `Notes: ${w.notes}` : '',
  ].filter(Boolean).join('\n'));
  info.style.whiteSpace = 'pre-line';
  node.append(info);

  node.append(el('h4', '', 'Components'));
  const t1 = el('div', 'table-wrap');
  t1.innerHTML = lines.length ? `<table class="grid"><thead><tr><th>Component</th><th style="text-align:right">Planned</th><th style="text-align:right">Issued</th>
    <th style="text-align:right">Still to issue</th><th style="text-align:right">Cost issued (${esc(base)})</th></tr></thead><tbody>${lines.map((x) => `<tr>
    <td>${esc(itemLabel(x.item_id))}</td><td class="num">${qtyFmt(x.qty_planned)}</td><td class="num">${qtyFmt(x.qty_issued)}</td>
    <td class="num">${qtyFmt(Math.max(Number(x.qty_planned) - Number(x.qty_issued), 0))}</td><td class="num">${money(x.value_issued)}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">No components. Add them with Add component.</p>';
  node.append(t1);

  node.append(el('h4', '', 'Cost history'));
  const t2 = el('div', 'table-wrap');
  t2.innerHTML = c.data.length ? `<table class="grid"><thead><tr><th>Date</th><th>Type</th><th>Description</th><th style="text-align:right">Quantity</th>
    <th style="text-align:right">Amount (${esc(base)})</th></tr></thead><tbody>${c.data.map((x) => `<tr><td>${x.cost_date}</td><td>${KIND[x.kind]}</td>
    <td>${esc(x.description || '')}</td><td class="num">${x.qty === null ? '' : qtyFmt(x.qty)}</td><td class="num">${money(x.amount)}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">No costs yet.</p>';
  node.append(t2);

  const buttons = [{ label: 'Close', value: 'close', className: 'btn-ghost' }, { label: 'Attachments', value: 'attach', className: 'btn-ghost' }];
  if (open && CAN_WORK) buttons.push({ label: 'Issue materials', value: 'issue', className: '' }, { label: 'Add component', value: 'addline', className: '' },
    { label: 'Add labour or cost', value: 'cost', className: '' });
  if (open && CAN_BOOKS) {
    if (lines.some((x) => Number(x.qty_issued) > 0)) buttons.push({ label: 'Return materials', value: 'return', className: '' });
    buttons.push({ label: 'Receive finished goods', value: 'receive', className: 'btn-primary' });
    if (!c.data.length) buttons.push({ label: 'Cancel order', value: 'cancel', className: 'btn-danger' });
    else if (Number(w.qty_received) === 0) buttons.push({ label: 'Close with no output', value: 'noout', className: 'btn-danger' });
  }
  const res = await ui.dialog({ title: `${w.wo_no}`, node, wide: true, dismissValue: 'close', buttons });
  const done = async (p) => { if (await p) await reopen(id); };
  if (res === 'attach') {
    await openAttachmentsDialog(ctx, { table: 'work_orders', recordId: w.id, title: `Attachments: ${w.wo_no}` });
    await openOrder(id);
  } else if (res === 'issue') await done(issueMaterials(w, lines));
  else if (res === 'addline') await done(addLine(w));
  else if (res === 'cost') await done(addCost(w));
  else if (res === 'return') await done(returnMaterial(w, lines));
  else if (res === 'receive') await done(receive(w));
  else if (res === 'noout') await done(closeNoOutput(w));
  else if (res === 'cancel') await done(cancelOrder(w));
}

async function issueMaterials(w, lines) {
  if (!lines.length) { ui.warn('Add components first.'); return false; }
  const fields = [{ name: 'date', label: 'Date', type: 'date', required: true, full: true,
    hint: 'Components are taken from the order\'s warehouse at their average cost. The quantities start at what is still to issue; set one to blank or zero to skip it.' }];
  const values = { date: todayIso() };
  lines.forEach((x, i) => {
    const left = Math.max(Number(x.qty_planned) - Number(x.qty_issued), 0);
    fields.push({ name: `q${i}`, label: itemLabel(x.item_id), type: 'number', hint: `Planned ${qtyFmt(x.qty_planned)}, issued ${qtyFmt(x.qty_issued)}` });
    values[`q${i}`] = left || '';
  });
  const saved = await ui.form({
    title: `Issue materials to ${w.wo_no}`, submitText: 'Issue', fields, values,
    onSubmit: async (v) => {
      const out = [];
      lines.forEach((x, i) => { const q = Number(v[`q${i}`]) || 0; if (q > 0) out.push({ line_id: x.id, qty: q }); });
      if (!out.length) throw new Error('Enter a quantity for at least one component.');
      await rpcGo('wo_issue_materials', { p_order: w.id, p_date: v.date, p_lines: out });
    },
  });
  if (saved) ui.success('Materials issued to the order.');
  return saved;
}

async function addLine(w) {
  const stock = items.filter((i) => i.item_type === 'stock' && i.is_active);
  if (!stock.length) { ui.warn('There are no stock items to use as components.'); return false; }
  const saved = await ui.form({
    title: `Add a component to ${w.wo_no}`, submitText: 'Add',
    fields: [
      { name: 'item', label: 'Component', type: 'select', required: true, full: true,
        options: [{ value: '', label: 'Select a stock item' }].concat(stock.map((i) => ({ value: i.id, label: `${i.code} - ${i.name}` }))) },
      { name: 'qty', label: 'Planned quantity', type: 'number', required: true },
    ],
    onSubmit: async (v) => { await rpcGo('wo_add_line', { p_order: w.id, p_item: v.item, p_qty: v.qty }); },
  });
  if (saved) ui.success('Component added.');
  return saved;
}

async function addCost(w) {
  if (!accounts.length) { ui.warn('There are no ordinary expense accounts to capitalise from.'); return false; }
  const saved = await ui.form({
    title: `Add a cost to ${w.wo_no}`, submitText: 'Add cost',
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
      await rpcGo('wo_add_cost', { p_order: w.id, p_date: v.date, p_kind: v.kind, p_amount: v.amount, p_credit: v.credit, p_desc: v.desc });
      rememberCredit(v.credit);
    },
  });
  if (saved) ui.success('Cost added to the order.');
  return saved;
}

async function returnMaterial(w, lines) {
  const issued = lines.filter((x) => Number(x.qty_issued) > 0);
  const saved = await ui.form({
    title: `Return materials from ${w.wo_no}`, submitText: 'Return to stock',
    fields: [
      { name: 'line', label: 'Component', type: 'select', required: true, full: true,
        options: [{ value: '', label: 'Select a component' }].concat(issued.map((x) => ({ value: x.id, label: `${itemLabel(x.item_id)} (issued ${qtyFmt(x.qty_issued)})` }))) },
      { name: 'qty', label: 'Quantity returned', type: 'number', required: true, hint: 'It goes back into the order\'s component warehouse at the cost it was issued at.' },
      { name: 'date', label: 'Date', type: 'date', required: true },
    ],
    values: { date: todayIso() },
    onSubmit: async (v) => { await rpcGo('wo_return_material', { p_order: w.id, p_line: v.line, p_date: v.date, p_qty: v.qty }); },
  });
  if (saved) ui.success('Materials returned to stock.');
  return saved;
}

async function receive(w) {
  const remaining = Math.max(Number(w.qty_planned) - Number(w.qty_received), 0);
  const saved = await ui.form({
    title: `Receive finished goods from ${w.wo_no}`, submitText: 'Receive',
    fields: [
      { name: 'qty', label: 'Quantity received', type: 'number', required: true,
        hint: `${qtyFmt(remaining)} still planned. Each unit takes its share of the work in progress cost; the receipt that completes the planned quantity takes all that is left.` },
      { name: 'date', label: 'Date', type: 'date', required: true },
      { name: 'close', label: 'Close the order after this receipt', type: 'checkbox',
        hint: 'Use this when you are receiving less than planned and nothing more will be made: the remaining cost goes into the goods received.' },
    ],
    values: { qty: remaining || '', date: todayIso(), close: false },
    onSubmit: async (v) => {
      if (!(v.qty > 0)) throw new Error('Enter the quantity received.');
      await rpcGo('wo_receive', { p_order: w.id, p_date: v.date, p_qty: v.qty, p_close: !!v.close });
    },
  });
  if (saved) ui.success('Finished goods received into stock.');
  return saved;
}

async function closeNoOutput(w) {
  const ok = await ui.confirm({
    title: 'Close with no output',
    message: `Close ${w.wo_no} with nothing produced?\nThe remaining cost of ${money(w.wip_balance)} ${base} moves from work in progress to the manufacturing variance account. Return any unused materials first.`,
    confirmText: 'Close order', danger: true,
  });
  if (!ok) return false;
  try { await rpcGo('wo_receive', { p_order: w.id, p_date: todayIso(), p_qty: 0, p_close: true }); } catch (e) { ui.errorFrom(e, 'Could not close the order.'); return false; }
  ui.success('Order closed.');
  return true;
}

async function cancelOrder(w) {
  const ok = await ui.confirm({ title: 'Cancel order', message: `Cancel ${w.wo_no}? Nothing has been booked to it.`, confirmText: 'Cancel order', danger: true });
  if (!ok) return false;
  try { await rpcGo('wo_cancel', { p_order: w.id }); } catch (e) { ui.errorFrom(e, 'Could not cancel the order.'); return false; }
  ui.success('Order cancelled.');
  return true;
}

if (ctx) await refresh();