import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { exportSheets } from '../core/export.js';
import { esc } from '../core/attachments.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const panel = document.getElementById('panel');

const SIZE = 100;
const TABLES = {
  journals: 'Journal', sales_documents: 'Invoice / credit note', purchase_documents: 'Bill / supplier credit note',
  customer_receipts: 'Receipt', supplier_payments: 'Supplier payment', customer_refunds: 'Customer refund',
  sales_applications: 'Credit application (customers)', purchase_applications: 'Credit application (suppliers)',
  customers: 'Customer', suppliers: 'Supplier', items: 'Item', item_categories: 'Item category', warehouses: 'Warehouse',
  gl_accounts: 'Account', account_groups: 'Account group', tax_codes: 'Tax code', payment_terms: 'Payment terms',
  fiscal_years: 'Financial year', fiscal_periods: 'Financial period', companies: 'Company profile',
  company_settings: 'Company defaults', company_currencies: 'Company currency', goods_receipts: 'Goods received',
  purchase_orders: 'Purchase order', work_orders: 'Work order', boms: 'Bill of materials', stock_adjustments: 'Stock adjustment',
  stock_transfers: 'Stock transfer', bookings: 'Booking', hire_items: 'Hire item', fixed_assets: 'Fixed asset',
  asset_categories: 'Asset category', nursery_batches: 'Nursery batch', projects: 'Project', report_formats: 'Report layout',
  attachments: 'Attachment',
};
const ACTIONS = { insert: 'Created', update: 'Changed', delete: 'Deleted' };
const tname = (t) => TABLES[t] || t;

let rows = [];
let total = 0;
let page = 0;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function btn(text, cls, onClick) {
  const b = el('button', `btn ${cls}`.trim(), text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}
function option(select, value, text) { const o = el('option', '', text); o.value = value; select.append(o); }
const todayIso = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
const stamp = (s) => { const d = new Date(s); return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`; };
const show = (v) => (v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v)));
const short = (s, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const fromEl = el('input'); fromEl.type = 'date'; fromEl.style.width = 'auto'; fromEl.value = daysAgo(30);
const toEl = el('input'); toEl.type = 'date'; toEl.style.width = 'auto'; toEl.value = todayIso();
const tableSel = el('select', 'compact');
const actionSel = el('select', 'compact');
const userSel = el('select', 'compact');
const searchEl = el('input'); searchEl.type = 'search'; searchEl.placeholder = 'Search record'; searchEl.style.maxWidth = '200px';

async function init() {
  document.getElementById('company-title').textContent = ctx.company.name;
  if (!['owner', 'admin', 'accountant'].includes(ctx.role)) {
    panel.innerHTML = '<p class="muted">Only owners, admins and accountants can view the audit log.</p>';
    return;
  }
  option(tableSel, '', 'All records');
  Object.entries(TABLES).sort((a, b) => a[1].localeCompare(b[1])).forEach(([k, v]) => option(tableSel, k, v));
  option(actionSel, '', 'All actions');
  Object.entries(ACTIONS).forEach(([k, v]) => option(actionSel, k, v));
  option(userSel, '', 'All users');
  const u = await supabase.rpc('audit_log_users', { p_company: ctx.companyId });
  if (!u.error) u.data.forEach((x) => option(userSel, x.user_id, x.email));
  searchEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  toolbar.append(el('span', 'muted', 'From'), fromEl, el('span', 'muted', 'To'), toEl, tableSel, actionSel, userSel, searchEl,
    btn('Run', 'btn-primary', run), el('span', 'spacer'), btn('Export to Excel', '', doExport));
  hint.textContent = 'Every change to the main records: who made it, when, and what changed. The log cannot be edited or deleted. Click a row to see the details.';
  await run();
}

const params = (offset, limit) => ({
  p_company: ctx.companyId, p_from: fromEl.value || null, p_to: toEl.value || null, p_table: tableSel.value || null,
  p_action: actionSel.value || null, p_user: userSel.value || null, p_search: searchEl.value.trim() || null,
  p_offset: offset, p_limit: limit,
});

async function run() { page = 0; await load(); }

async function load() {
  panel.innerHTML = '<p class="muted">Loading...</p>';
  const { data, error } = await supabase.rpc('audit_log_page', params(page * SIZE, SIZE));
  if (error) { panel.innerHTML = ''; return ui.errorFrom(error, 'Could not load the audit log.'); }
  rows = data;
  total = data.length ? Number(data[0].r_total) : (page === 0 ? 0 : total);
  render();
}

function changeText(r) {
  if (r.r_action === 'insert') return 'Created';
  if (r.r_action === 'delete') return 'Deleted';
  const cols = r.r_cols || [];
  return cols.slice(0, 4).map((c) => `${c}: ${short(show(r.r_old && r.r_old[c]), 18)} → ${short(show(r.r_new && r.r_new[c]), 18)}`).join('; ')
    + (cols.length > 4 ? ` (+${cols.length - 4} more)` : '');
}

function render() {
  const first = total ? page * SIZE + 1 : 0;
  const last = Math.min(total, page * SIZE + rows.length);
  const head = el('div');
  head.style.cssText = 'display:flex;gap:.6rem;align-items:center;flex-wrap:wrap;margin-bottom:.6rem';
  const prev = btn('Previous', '', () => { page -= 1; load(); });
  const next = btn('Next', '', () => { page += 1; load(); });
  prev.disabled = page === 0;
  next.disabled = last >= total;
  head.append(el('span', 'muted', total ? `Changes ${first.toLocaleString()} to ${last.toLocaleString()} of ${total.toLocaleString()}, newest first` : 'No changes match.'),
    el('span', 'spacer'), prev, next);
  if (!rows.length) { panel.replaceChildren(head); return; }
  const body = rows.map((r, i) => `<tr class="clickable" data-i="${i}"><td>${esc(stamp(r.r_at))}</td><td>${esc(r.r_user || 'System')}</td>
    <td><span class="badge ${r.r_action === 'delete' ? 'st-error' : (r.r_action === 'insert' ? 'open' : '')}">${ACTIONS[r.r_action]}</span></td>
    <td>${esc(tname(r.r_table))}</td><td>${esc(r.r_label || '')}</td><td>${esc(changeText(r))}</td></tr>`).join('');
  const wrap = el('div', 'table-wrap');
  wrap.innerHTML = `<table class="grid"><thead><tr><th>When</th><th>User</th><th>Action</th><th>Record type</th><th>Record</th><th>What changed</th></tr></thead><tbody>${body}</tbody></table>`;
  panel.replaceChildren(head, wrap);
}

panel.addEventListener('click', async (e) => {
  const tr = e.target.closest('tr[data-i]');
  if (!tr) return;
  const r = rows[Number(tr.dataset.i)];
  if (!r) return;
  const cols = r.r_action === 'update' ? (r.r_cols || []) : Object.keys(r.r_action === 'delete' ? (r.r_old || {}) : (r.r_new || {})).sort();
  const body = cols.map((c) => `<tr><td>${esc(c)}</td><td>${esc(show(r.r_old && r.r_old[c]))}</td><td>${esc(show(r.r_new && r.r_new[c]))}</td></tr>`).join('');
  const node = el('div', 'table-wrap');
  node.innerHTML = `<p class="muted">${esc(stamp(r.r_at))} · ${esc(r.r_user || 'System')} · ${ACTIONS[r.r_action]} ${esc(tname(r.r_table))}${r.r_label ? ` ${esc(r.r_label)}` : ''}</p>
    <table class="grid"><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>${body}</tbody></table>`;
  await ui.dialog({ title: 'Change details', node, wide: true, dismissValue: 'close', buttons: [{ label: 'Close', value: 'close', className: 'btn-ghost' }] });
});

async function doExport() {
  try {
    const out = [];
    for (let off = 0; off < 20000; off += 1000) {
      const { data, error } = await supabase.rpc('audit_log_page', params(off, 1000));
      if (error) throw error;
      data.forEach((r) => out.push({
        at: stamp(r.r_at), user: r.r_user || 'System', action: ACTIONS[r.r_action], type: tname(r.r_table), record: r.r_label || '',
        change: r.r_action === 'update' ? (r.r_cols || []).map((c) => `${c}: ${show(r.r_old && r.r_old[c])} → ${show(r.r_new && r.r_new[c])}`).join('; ')
          : show(r.r_action === 'delete' ? r.r_old : r.r_new),
      }));
      if (data.length < 1000) break;
    }
    if (!out.length) return ui.warn('There is nothing to export.');
    await exportSheets(`audit-log-${fromEl.value}-to-${toEl.value}.xlsx`, [{
      name: 'Audit log', title: 'Audit log', subtitle: `${fromEl.value} to ${toEl.value}`, rows: out,
      columns: [{ key: 'at', header: 'When', width: 20 }, { key: 'user', header: 'User', width: 28 }, { key: 'action', header: 'Action', width: 10 },
        { key: 'type', header: 'Record type', width: 26 }, { key: 'record', header: 'Record', width: 30 }, { key: 'change', header: 'What changed', width: 80 }],
    }]);
  } catch (e) { ui.errorFrom(e, 'Could not export.'); }
}

if (ctx) await init();