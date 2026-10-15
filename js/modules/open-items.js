import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { exportSheets } from '../core/export.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const note = document.getElementById('note');
const panel = document.getElementById('panel');

const CAN_BOOKS = ctx ? ctx.canEdit : false;
const BUCKETS = [['0-30', 'Up to 30 days', (d) => d <= 30], ['31-60', '31 to 60 days', (d) => d > 30 && d <= 60],
  ['61-90', '61 to 90 days', (d) => d > 60 && d <= 90], ['90+', 'Over 90 days', (d) => d > 90]];

let lines = [];
let writeoffs = [];
let accounts = [];
let others = [];
let recon = null;
let base = '';
let supFilter = '';
let ageFilter = '';
let needle = '';
const selected = new Set();

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
async function rpcAll(fn, params) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.rpc(fn, params).range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

const supSel = el('select', 'compact'); supSel.style.maxWidth = '240px';
const ageSel = el('select', 'compact');
const searchEl = el('input'); searchEl.type = 'search'; searchEl.placeholder = 'Search'; searchEl.style.maxWidth = '200px';

/* ---------- data ---------- */

async function loadOthers() {
  const cid = ctx.companyId;
  const today = todayIso();
  const count = (table, f) => Promise.resolve(f(supabase.from(table).select('id', { count: 'exact', head: true }).eq('company_id', cid)))
    .then((r) => (r.error ? null : r.count)).catch(() => null);
  const [dInv, dCn, dBill, dScn, dJrn, wo, shifts, ret, so, po] = await Promise.all([
    count('sales_documents', (q) => q.eq('status', 'draft').eq('doc_type', 'invoice')),
    count('sales_documents', (q) => q.eq('status', 'draft').eq('doc_type', 'credit_note')),
    count('purchase_documents', (q) => q.eq('status', 'draft').eq('doc_type', 'bill')),
    count('purchase_documents', (q) => q.eq('status', 'draft').eq('doc_type', 'credit_note')),
    count('journals', (q) => q.eq('status', 'draft')),
    count('work_orders', (q) => q.eq('status', 'open')),
    count('pos_shifts', (q) => q.eq('status', 'open')),
    Promise.resolve(supabase.from('bookings').select('id, sales_documents!sales_documents_booking_id_fkey(id)')
      .eq('company_id', cid).in('status', ['returned', 'closed']).limit(500)).then((r) => (r.error ? null : r.data)).catch(() => null),
    rpcAll('sales_open_items', { p_company: cid, p_as_of: today }).catch(() => null),
    rpcAll('purchase_open_items', { p_company: cid, p_as_of: today }).catch(() => null),
  ]);
  const out = [];
  const add = (label, n, href, amount) => { if (n) out.push({ label, n, href, amount }); };
  add('Draft invoices', dInv, '/pages/invoices.html');
  add('Draft credit notes', dCn, '/pages/credit-notes.html');
  add('Draft supplier bills', dBill, '/pages/bills.html');
  add('Draft supplier credit notes', dScn, '/pages/supplier-credit-notes.html');
  add('Draft journals', dJrn, '/pages/journals.html');
  if (ret) add('Returned hire bookings not invoiced', ret.filter((b) => !(b.sales_documents || []).length).length, '/pages/bookings.html');
  add('Open work orders', wo, '/pages/work-orders.html');
  add('Open POS shifts', shifts, '/pages/pos-shifts.html');
  const by = (rows, kind) => { const x = rows.filter((r) => r.doc_kind === kind); return { n: x.length, amt: x.reduce((s, r) => s + Math.abs(Number(r.base_outstanding)), 0) }; };
  if (so) {
    [['receipt', 'Customer receipts left on account'], ['credit_note', 'Customer credit notes not applied'], ['journal', 'Customer journal items not matched']]
      .forEach(([k, l]) => { const x = by(so, k); add(l, x.n, '/pages/debtors-ageing.html', x.amt); });
  }
  if (po) {
    [['payment', 'Supplier payments left on account'], ['credit_note', 'Supplier credit notes not applied'], ['journal', 'Supplier journal items not matched']]
      .forEach(([k, l]) => { const x = by(po, k); add(l, x.n, '/pages/creditors-ageing.html', x.amt); });
  }
  others = out;
}

async function load() {
  const cid = ctx.companyId;
  const [rc, w, a, cu] = await Promise.all([
    supabase.rpc('grni_reconciliation', { p_company: cid }),
    supabase.from('grni_writeoffs').select('*').eq('company_id', cid).order('created_at', { ascending: false }).limit(100),
    supabase.from('gl_accounts').select('id, code, name, account_groups(class_type)').eq('company_id', cid)
      .eq('is_posting', true).eq('is_active', true).is('control_type', null).order('code'),
    supabase.from('company_currencies').select('code').eq('company_id', cid).eq('is_base', true).maybeSingle(),
  ]);
  for (const r of [w, a]) if (r.error) throw r.error;
  recon = rc.error || !rc.data || !rc.data[0] ? null : rc.data[0];
  writeoffs = w.data;
  accounts = a.data.filter((x) => x.account_groups && x.account_groups.class_type === 'income_statement');
  base = cu.data ? cu.data.code : '';
  lines = await rpcAll('grni_open_lines', { p_company: cid, p_as_of: todayIso() });
  await loadOthers();
}

async function refresh() {
  try { await load(); } catch (e) { ui.errorFrom(e, 'Could not load the open items.'); }
  selected.clear();
  fillSuppliers();
  render();
}

function fillSuppliers() {
  const keep = supSel.value;
  supSel.replaceChildren();
  option(supSel, '', 'All suppliers');
  const seen = new Map();
  lines.forEach((l) => seen.set(l.supplier_id, `${l.supplier_code} - ${l.supplier_name}`));
  [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1])).forEach(([id, t]) => option(supSel, id, t));
  supSel.value = seen.has(keep) ? keep : '';
  supFilter = supSel.value;
}

const visible = () => lines.filter((l) => (!supFilter || l.supplier_id === supFilter)
  && (!ageFilter || BUCKETS.find((b) => b[0] === ageFilter)[2](l.age_days))
  && (!needle || [l.grn_no, l.supplier_name, l.supplier_ref, l.item_code, l.item_name].some((v) => String(v || '').toLowerCase().includes(needle))));

/* ---------- render ---------- */

function render() {
  document.getElementById('company-title').textContent = ctx.company.name;
  toolbar.replaceChildren();
  BUCKETS.forEach(([v, l]) => { if (![...ageSel.options].some((o) => o.value === v)) { /* built once below */ } });
  if (!ageSel.options.length) { option(ageSel, '', 'All ages'); BUCKETS.forEach(([v, l]) => option(ageSel, v, l)); }
  toolbar.append(supSel, ageSel, searchEl, btn('Refresh', '', refresh), el('span', 'spacer'));
  if (CAN_BOOKS) toolbar.append(btn('Write off selected', '', () => openWriteoff([...selected])));
  toolbar.append(btn('Export to Excel', '', doExport));
  hint.textContent = `Goods received not yet fully invoiced, in ${base}: the current position, aged from the receipt date. When the invoice arrives, bill it from Bills with Add from goods received. When no invoice is coming, write the line off.`;

  note.innerHTML = '';
  if (recon) {
    const diff = Number(recon.difference);
    note.innerHTML = `<p><span class="badge ${Math.abs(diff) < 0.005 ? 'open' : 'st-error'}">${Math.abs(diff) < 0.005
      ? 'Goods received not invoiced agrees to the GRNI control account'
      : `Goods received not invoiced differs from the GRNI control account by ${money(diff)}`}</span>
      <span class="muted">Receipts ${money(recon.subledger)} · ledger ${money(recon.ledger)}</span></p>`;
  }

  const list = visible();
  const total = list.reduce((s, l) => s + Number(l.open_base), 0);
  const bucketRows = BUCKETS.map(([k, label, f]) => {
    const x = lines.filter((l) => f(l.age_days));
    return `<tr><td>${esc(label)}</td><td class="num">${x.length}</td><td class="num">${money(x.reduce((s, l) => s + Number(l.open_base), 0))}</td></tr>`;
  }).join('');
  const rows = list.map((l) => `<tr data-id="${l.line_id}"><td><input type="checkbox" data-sel ${selected.has(l.line_id) ? 'checked' : ''} style="width:auto"></td>
    <td>${esc(l.grn_no)}</td><td>${l.receipt_date}</td><td>${esc(l.supplier_name)}</td><td>${esc(l.supplier_ref || '')}</td>
    <td>${esc(l.item_code)} <span class="muted">${esc(l.item_name)}</span></td>
    <td class="num">${qtyFmt(l.qty)}</td><td class="num">${qtyFmt(l.qty_billed)}</td>
    <td class="num">${l.currency_code === base ? '' : `${money(l.open_trx)} ${esc(l.currency_code)}`}</td>
    <td class="num">${money(l.open_base)}</td><td class="num">${l.age_days}</td>
    <td><div class="row-actions"><a class="btn btn-sm" href="/pages/bills.html">Bill</a>${CAN_BOOKS ? '<button class="btn btn-sm" data-act="writeoff">Write off</button>' : ''}</div></td></tr>`).join('');

  const wrows = writeoffs.map((w) => `<tr data-w="${w.id}"><td>${w.writeoff_date}</td><td>${esc(w.grn_no || '')}</td><td>${esc(w.supplier_name || '')}</td>
    <td>${esc(w.item_code || '')}</td><td class="num">${money(w.value_base)}</td><td>${esc(w.reason)}</td>
    <td><span class="badge ${w.status === 'posted' ? 'open' : ''}">${w.status === 'posted' ? 'Written off' : `Reversed ${w.reversed_on}`}</span></td>
    <td>${CAN_BOOKS && w.status === 'posted' ? '<button class="btn btn-sm" data-act="reverse">Reverse</button>' : ''}</td></tr>`).join('');

  const orows = others.map((o) => `<tr><td><a href="${o.href}">${esc(o.label)}</a></td><td class="num">${o.n}</td><td class="num">${o.amount === undefined ? '' : money(o.amount)}</td></tr>`).join('');
  const th = (t, right) => `<th${right ? ' style="text-align:right"' : ''}>${t}</th>`;

  panel.innerHTML = `<h3 style="margin-top:0">Goods received not invoiced</h3>
    <div class="table-wrap"><table class="grid"><thead><tr>${th('Age')}${th('Lines', 1)}${th(`Value (${esc(base)})`, 1)}</tr></thead><tbody>${bucketRows}
      <tr class="row-root"><td>Total</td><td class="num">${lines.length}</td><td class="num">${money(lines.reduce((s, l) => s + Number(l.open_base), 0))}</td></tr></tbody></table></div>
    <div class="table-wrap" style="margin-top:1rem"><table class="grid"><thead><tr><th><input type="checkbox" data-all style="width:auto"></th>${th('Receipt')}${th('Date')}${th('Supplier')}${th('Supplier ref')}${th('Item')}
      ${th('Received', 1)}${th('Billed', 1)}${th('Original', 1)}${th(`Open (${esc(base)})`, 1)}${th('Days', 1)}<th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="12" class="muted">Nothing is waiting to be invoiced.</td></tr>'}
      ${rows ? `<tr class="row-root"><td colspan="9">${list.length} line(s) shown</td><td class="num">${money(total)}</td><td colspan="2"></td></tr>` : ''}</tbody></table></div>
    <h3 style="margin-top:1.5rem">Recent write-offs</h3>
    ${writeoffs.length ? `<div class="table-wrap"><table class="grid"><thead><tr>${th('Date')}${th('Receipt')}${th('Supplier')}${th('Item')}${th(`Value (${esc(base)})`, 1)}${th('Reason')}${th('Status')}<th></th></tr></thead><tbody>${wrows}</tbody></table></div>` : '<p class="muted">No write-offs yet.</p>'}
    <h3 style="margin-top:1.5rem">Other open items</h3>
    ${others.length ? `<div class="table-wrap"><table class="grid"><thead><tr>${th('Item')}${th('Count', 1)}${th(`Amount (${esc(base)})`, 1)}</tr></thead><tbody>${orows}</tbody></table></div>` : '<p class="muted">Nothing else needs attention.</p>'}`;
}

/* ---------- actions ---------- */

supSel.addEventListener('change', () => { supFilter = supSel.value; render(); });
ageSel.addEventListener('change', () => { ageFilter = ageSel.value; render(); });
let timer;
searchEl.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { needle = searchEl.value.trim().toLowerCase(); render(); }, 250); });

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
  }
});

panel.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const tr = b.closest('tr');
  if (b.dataset.act === 'writeoff') await openWriteoff([tr.dataset.id]);
  else if (b.dataset.act === 'reverse') await reverseWriteoff(tr.dataset.w);
});

async function openWriteoff(ids) {
  if (!ids.length) return ui.warn('Tick at least one line.');
  const chosen = lines.filter((l) => ids.includes(l.line_id));
  const total = chosen.reduce((s, l) => s + Number(l.open_base), 0);
  const saved = await ui.form({
    title: ids.length === 1 ? `Write off ${chosen[0] ? chosen[0].grn_no : 'line'}` : `Write off ${ids.length} lines`, submitText: 'Write off',
    fields: [
      { name: 'date', label: 'Date', type: 'date', required: true, hint: 'Must fall in an open period, and not before the receipt date.' },
      { name: 'credit', label: 'Credit account', type: 'select', full: true,
        options: [{ value: '', label: 'Each item\'s purchase price variance account' }].concat(accounts.map((a) => ({ value: a.id, label: `${a.code} - ${a.name}` }))),
        hint: `${money(total)} ${base} is cleared from goods received not invoiced. The stock stays at its received cost and the credit goes to this profit and loss account. If the goods were never kept, also make a stock adjustment.` },
      { name: 'reason', label: 'Reason', required: true, full: true },
    ],
    values: { date: todayIso() },
    onSubmit: async (v) => {
      const { error } = await supabase.rpc('grni_writeoff', {
        p_company: ctx.companyId, p_lines: ids, p_date: v.date, p_credit: v.credit || null, p_reason: v.reason,
      });
      if (error) throw error;
    },
  });
  if (saved) { ui.success('Written off.'); await refresh(); }
}

async function reverseWriteoff(id) {
  const saved = await ui.form({
    title: 'Reverse write-off', submitText: 'Reverse',
    fields: [{ name: 'date', label: 'Reversal date', type: 'date', required: true, full: true, hint: 'Must fall in an open period. The goods received line becomes open again.' }],
    values: { date: todayIso() },
    onSubmit: async (v) => {
      const { error } = await supabase.rpc('grni_writeoff_reverse', { p_writeoff: id, p_date: v.date });
      if (error) throw error;
    },
  });
  if (saved) { ui.success('Write-off reversed.'); await refresh(); }
}

async function doExport() {
  const list = visible();
  if (!list.length) return ui.warn('There is nothing to export.');
  try {
    await exportSheets(`goods-received-not-invoiced-${todayIso()}.xlsx`, [{
      name: 'GRNI', title: 'Goods received not invoiced', subtitle: `Current position, aged to ${todayIso()}, amounts in ${base}`,
      rows: list.map((l) => ({
        grn: l.grn_no, date: l.receipt_date, supplier: l.supplier_name, sref: l.supplier_ref || '', item: l.item_code, name: l.item_name,
        cur: l.currency_code, qty: Number(l.qty), billed: Number(l.qty_billed), openTrx: Number(l.open_trx), openBase: Number(l.open_base), days: l.age_days,
      })),
      columns: [
        { key: 'grn', header: 'Receipt', width: 14 }, { key: 'date', header: 'Date', width: 12 }, { key: 'supplier', header: 'Supplier', width: 28 },
        { key: 'sref', header: 'Supplier ref', width: 16 }, { key: 'item', header: 'Item', width: 14 }, { key: 'name', header: 'Name', width: 28 },
        { key: 'cur', header: 'Currency', width: 10 }, { key: 'qty', header: 'Received', width: 11, total: false }, { key: 'billed', header: 'Billed', width: 11, total: false },
        { key: 'openTrx', header: 'Open (original)', width: 16, total: false }, { key: 'openBase', header: `Open (${base})`, width: 16, total: true },
        { key: 'days', header: 'Days', width: 8, total: false },
      ],
    }]);
  } catch (e) { ui.errorFrom(e, 'Could not export.'); }
}

if (ctx) await refresh();