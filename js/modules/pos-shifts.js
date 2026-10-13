import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { exportSheets } from '../core/export.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const panel = document.getElementById('panel');

let shifts = [];
let methods = new Map();
let base = '';
let statusFilter = 'all';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (n) => (Number(n) < 0 ? `(${money(-n)})` : money(n));
const stamp = (t) => (t ? String(t).slice(0, 16).replace('T', ' ') : '');
function btn(text, cls, onClick) {
  const b = el('button', `btn ${cls}`.trim(), text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}
async function fetchAll(make) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await make().range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

async function load() {
  const cid = ctx.companyId;
  const [s, m, cu] = await Promise.all([
    supabase.from('pos_shifts').select('*, pos_registers(code, name)').eq('company_id', cid).order('opened_at', { ascending: false }).limit(300),
    supabase.from('pos_payment_methods').select('id, code, name, kind').eq('company_id', cid),
    supabase.from('company_currencies').select('code').eq('company_id', cid).eq('is_base', true).maybeSingle(),
  ]);
  for (const r of [s, m, cu]) if (r.error) throw r.error;
  shifts = s.data;
  methods = new Map(m.data.map((x) => [x.id, x]));
  base = cu.data ? cu.data.code : '';
}

async function refresh() {
  try { await load(); } catch (e) { ui.errorFrom(e, 'Could not load the shifts.'); }
  render();
}

const visible = () => shifts.filter((s) => statusFilter === 'all' || s.status === statusFilter);

function render() {
  document.getElementById('company-title').textContent = ctx.company.name;
  hint.textContent = `Every till shift with its cash-up, in ${base}. Click a shift for its takings by payment method and its sales.`;
  toolbar.replaceChildren();
  const sel = el('select', 'compact');
  [['all', 'All'], ['open', 'Open'], ['closed', 'Closed']].forEach(([v, l]) => { const o = el('option', '', l); o.value = v; sel.append(o); });
  sel.value = statusFilter;
  sel.addEventListener('change', () => { statusFilter = sel.value; renderTable(); });
  const till = el('a', 'btn', 'Open the till');
  till.href = '/pages/pos.html';
  toolbar.append(sel, el('span', 'spacer'), till, btn('Export to Excel', '', doExport));
  renderTable();
}

function renderTable() {
  if (!shifts.length) { panel.innerHTML = '<p class="muted">No shifts yet.</p>'; return; }
  const list = visible();
  if (!list.length) { panel.innerHTML = '<p class="muted">Nothing matches.</p>'; return; }
  const body = list.map((s) => `<tr class="clickable" data-id="${s.id}"><td>${esc(s.shift_no)}</td>
    <td>${esc(s.pos_registers ? s.pos_registers.code : '')}</td><td>${stamp(s.opened_at)}</td><td>${stamp(s.closed_at)}</td>
    <td class="num">${money(s.opening_float)}</td><td class="num">${s.expected_cash === null ? '' : money(s.expected_cash)}</td>
    <td class="num">${s.counted_cash === null ? '' : money(s.counted_cash)}</td>
    <td class="num">${s.cash_difference === null ? '' : signed(s.cash_difference)}</td>
    <td class="num">${s.cash_banked === null ? '' : money(s.cash_banked)}</td>
    <td><span class="badge ${s.status === 'open' ? 'st-update' : ''}">${s.status === 'open' ? 'Open' : 'Closed'}</span></td></tr>`).join('');
  panel.innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr><th>Shift</th><th>Register</th><th>Opened</th><th>Closed</th>
    <th style="text-align:right">Float</th><th style="text-align:right">Expected</th><th style="text-align:right">Counted</th>
    <th style="text-align:right">Over / (short)</th><th style="text-align:right">Banked</th><th>Status</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

panel.addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  const s = shifts.find((x) => x.id === tr.dataset.id);
  if (s) openShift(s);
});

async function openShift(s) {
  let pays;
  let sl;
  try {
    [pays, sl] = await Promise.all([
      fetchAll(() => supabase.from('pos_payments').select('method_id, amount, tendered, change_given').eq('shift_id', s.id).order('id')),
      fetchAll(() => supabase.from('pos_sales').select('id, invoice_id, total, paid, change_given, created_at').eq('shift_id', s.id).order('created_at').order('id')),
    ]);
  } catch (e) { return ui.errorFrom(e, 'Could not load the shift.'); }

  const docNo = new Map();
  const ids = [...new Set(sl.map((x) => x.invoice_id))];
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await supabase.from('sales_documents').select('id, doc_no').in('id', ids.slice(i, i + 100));
    (data || []).forEach((d) => docNo.set(d.id, d.doc_no));
  }
  const by = new Map();
  pays.forEach((p) => {
    const x = by.get(p.method_id) || { count: 0, amount: 0, change: 0 };
    x.count += 1; x.amount += Number(p.amount); x.change += Number(p.change_given);
    by.set(p.method_id, x);
  });
  const total = [...by.values()].reduce((a, x) => a + x.amount, 0);
  const sold = sl.reduce((a, x) => a + Number(x.total), 0);

  const node = el('div');
  node.append(Object.assign(el('p', 'muted'), {
    textContent: [`${s.pos_registers ? s.pos_registers.name : ''} · opened ${stamp(s.opened_at)}${s.closed_at ? ` · closed ${stamp(s.closed_at)}` : ''}`,
      `${sl.length} sale(s) · ${money(sold)} ${base} sold · opening float ${money(s.opening_float)}`,
      s.status === 'closed' && s.expected_cash !== null
        ? `Expected ${money(s.expected_cash)} · counted ${money(s.counted_cash)} · ${Number(s.cash_difference) === 0 ? 'agreed' : `difference ${signed(s.cash_difference)}`} · banked ${money(s.cash_banked)} · kept ${money(s.float_kept)}` : '',
      s.notes ? `Notes: ${s.notes}` : ''].filter(Boolean).join('\n'),
  }));
  node.firstChild.style.whiteSpace = 'pre-line';

  const t1 = el('div', 'table-wrap');
  t1.innerHTML = `<table class="grid"><thead><tr><th>Payment method</th><th style="text-align:right">Payments</th><th style="text-align:right">Amount</th><th style="text-align:right">Change given</th></tr></thead><tbody>
    ${[...by.entries()].map(([id, x]) => `<tr><td>${esc((methods.get(id) || {}).name || 'Method')}</td><td class="num">${x.count}</td><td class="num">${money(x.amount)}</td>
    <td class="num">${x.change ? money(x.change) : ''}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No payments.</td></tr>'}
    <tr class="row-root"><td>Total taken</td><td></td><td class="num">${money(total)}</td><td></td></tr></tbody></table>`;
  node.append(el('h4', '', 'Takings by payment method'), t1);

  const t2 = el('div', 'table-wrap');
  t2.innerHTML = `<table class="grid"><thead><tr><th>Time</th><th>Invoice</th><th style="text-align:right">Total</th><th style="text-align:right">Paid</th><th style="text-align:right">Change</th></tr></thead><tbody>
    ${sl.map((x) => `<tr><td>${stamp(x.created_at)}</td><td>${esc(docNo.get(x.invoice_id) || '')}</td><td class="num">${money(x.total)}</td>
    <td class="num">${money(x.paid)}</td><td class="num">${Number(x.change_given) ? money(x.change_given) : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No sales.</td></tr>'}</tbody></table>`;
  node.append(el('h4', '', 'Sales'), t2);
  await ui.dialog({ title: `Shift ${s.shift_no}`, node, wide: true, dismissValue: 'close', buttons: [{ label: 'Close', value: 'close', className: 'btn-ghost' }] });
}

async function doExport() {
  const list = visible();
  if (!list.length) return ui.warn('There is nothing to export.');
  try {
    await exportSheets(`pos-shifts-${new Date().toISOString().slice(0, 10)}.xlsx`, [{
      name: 'POS shifts', title: 'POS shifts', subtitle: `Amounts in ${base}`,
      rows: list.map((s) => ({
        shift: s.shift_no, register: s.pos_registers ? s.pos_registers.code : '', opened: stamp(s.opened_at), closed: stamp(s.closed_at),
        float: Number(s.opening_float), expected: s.expected_cash === null ? '' : Number(s.expected_cash),
        counted: s.counted_cash === null ? '' : Number(s.counted_cash), diff: s.cash_difference === null ? '' : Number(s.cash_difference),
        banked: s.cash_banked === null ? '' : Number(s.cash_banked), status: s.status,
      })),
      columns: [
        { key: 'shift', header: 'Shift', width: 12 }, { key: 'register', header: 'Register', width: 12 }, { key: 'opened', header: 'Opened', width: 18 },
        { key: 'closed', header: 'Closed', width: 18 }, { key: 'float', header: 'Opening float', width: 14, total: true },
        { key: 'expected', header: 'Expected cash', width: 14, total: true }, { key: 'counted', header: 'Counted cash', width: 14, total: true },
        { key: 'diff', header: 'Over / (short)', width: 14, total: true }, { key: 'banked', header: 'Banked', width: 14, total: true },
        { key: 'status', header: 'Status', width: 10 },
      ],
    }]);
  } catch (e) { ui.errorFrom(e, 'Could not export.'); }
}

if (ctx) await refresh();