import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const panel = document.getElementById('panel');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// order on the page, label, and where a click goes (the list page is filtered to the record's number or code)
const KINDS = [
  ['customer', 'Customers', (r) => `/pages/customer-statement.html?customer=${r.id}`],
  ['supplier', 'Suppliers', (r) => `/pages/supplier-statement.html?supplier=${r.id}`],
  ['invoice', 'Invoices', 'invoices.html'], ['credit_note', 'Credit notes', 'credit-notes.html'], ['receipt', 'Receipts', 'receipts.html'],
  ['bill', 'Bills', 'bills.html'], ['supplier_credit_note', 'Supplier credit notes', 'supplier-credit-notes.html'],
  ['payment', 'Supplier payments', 'payments.html'], ['purchase_order', 'Purchase orders', 'purchase-orders.html'],
  ['goods_received', 'Goods received', 'goods-received.html'], ['item', 'Items', 'items.html'],
  ['booking', 'Hire bookings', 'bookings.html'], ['hire_item', 'Hire items', 'hire-items.html'],
  ['asset', 'Fixed assets', 'fixed-assets.html'], ['nursery_batch', 'Nursery batches', 'nursery.html'],
  ['journal', 'Journals', 'journals.html'], ['project', 'Projects', 'projects.html'], ['work_order', 'Work orders', 'work-orders.html'],
];
const PER = 8;

const input = document.createElement('input');
input.type = 'search';
input.placeholder = 'Search numbers, names, references, notes, amounts, dates';
input.style.minWidth = '320px';
input.value = new URLSearchParams(location.search).get('q') || '';
let timer;

function hrefOf(kind, r) {
  const def = KINDS.find((k) => k[0] === kind);
  if (!def) return '#';
  if (typeof def[2] === 'function') return def[2](r);
  return `/pages/${def[2]}?q=${encodeURIComponent(r.r_ref || r.r_title)}`;
}

function rowHtml(kind, r) {
  const amt = r.r_amount !== null && r.r_amount !== undefined ? `<span class="muted"> · ${money(r.r_amount)}${r.r_currency ? ` ${esc(r.r_currency)}` : ''}</span>` : '';
  return `<li style="padding:.35rem 0;border-bottom:1px solid var(--border,#2a2f3a)"><a href="${esc(hrefOf(kind, { id: r.r_id, r_ref: r.r_ref, r_title: r.r_title }))}"><strong>${esc(r.r_title)}</strong></a>
    ${r.r_sub ? `<div class="muted">${esc(r.r_sub)}${amt}</div>` : (amt ? `<div>${amt}</div>` : '')}</li>`;
}

async function run() {
  const q = input.value.trim();
  history.replaceState(null, '', q ? `?q=${encodeURIComponent(q)}` : location.pathname);
  if (q.length < 2) { panel.innerHTML = '<p class="muted">Type at least two characters. Every word you type has to appear somewhere in the record.</p>'; return; }
  panel.innerHTML = '<p class="muted">Searching...</p>';
  const { data, error } = await supabase.rpc('global_search', { p_company: ctx.companyId, p_query: q, p_limit: PER, p_kind: null });
  if (error) { panel.innerHTML = ''; return ui.errorFrom(error, 'The search failed.'); }
  if (!data.length) { panel.innerHTML = `<p class="muted">Nothing found for "${esc(q)}".</p>`; return; }
  const by = new Map();
  data.forEach((r) => { if (!by.has(r.r_kind)) by.set(r.r_kind, []); by.get(r.r_kind).push(r); });
  const root = document.createElement('div');
  KINDS.filter((k) => by.has(k[0])).forEach(([kind, label]) => {
    const list = by.get(kind);
    const card = document.createElement('div');
    card.className = 'card';
    card.style.marginBottom = '1rem';
    card.innerHTML = `<h4 style="margin-top:0">${esc(label)}</h4><ul style="list-style:none;padding:0;margin:0">${list.map((r) => rowHtml(kind, r)).join('')}</ul>`;
    if (list.length >= PER) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'btn btn-sm';
      more.textContent = 'Show more';
      more.style.marginTop = '.6rem';
      more.addEventListener('click', async () => {
        more.disabled = true;
        const res = await supabase.rpc('global_search', { p_company: ctx.companyId, p_query: q, p_limit: 50, p_kind: kind });
        if (res.error) { more.disabled = false; return ui.errorFrom(res.error, 'The search failed.'); }
        card.querySelector('ul').innerHTML = res.data.map((r) => rowHtml(kind, r)).join('');
        more.remove();
      });
      card.append(more);
    }
    root.append(card);
  });
  panel.replaceChildren(root);
}

async function init() {
  document.getElementById('company-title').textContent = ctx.company.name;
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 350); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(timer); run(); } });
  toolbar.append(input);
  hint.textContent = 'Searches customers, suppliers, items, invoices, credit notes, receipts, bills, payments, purchase orders, goods received, hire bookings and items, assets, nursery batches, journals, projects and work orders at once. Every word has to be found somewhere in the record, in any order. Click a result to open it.';
  input.focus();
  await run();
}

if (ctx) await init();