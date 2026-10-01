import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { exportSheets } from '../core/export.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const panel = document.getElementById('panel');

let accounts = [];
let data = [];
let base = '';
let hideZero = true;
const collapsed = new Set();

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (n) => (Math.abs(n) < 0.005 ? '' : (n < 0 ? `(${money(-n)})` : money(n)));
const plain = (n) => (Math.abs(n) < 0.005 ? '' : money(n));
const todayIso = () => new Date().toISOString().slice(0, 10);
const cmp = (a, b) => (a.sort_order - b.sort_order) || a.code.localeCompare(b.code, undefined, { numeric: true });
const ZERO = () => ({ o: 0, d: 0, c: 0, cl: 0 });

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

const fromEl = el('input');
const toEl = el('input');
fromEl.type = 'date';
toEl.type = 'date';
fromEl.style.width = toEl.style.width = 'auto';

async function init() {
  document.getElementById('company-title').textContent = ctx.company.name;
  const cid = ctx.companyId;
  const [a, fy, c] = await Promise.all([
    supabase.from('gl_accounts').select('id, parent_id, code, name, is_posting, sort_order').eq('company_id', cid),
    supabase.from('fiscal_years').select('start_date, end_date').eq('company_id', cid).order('start_date'),
    supabase.from('company_currencies').select('code').eq('company_id', cid).eq('is_base', true).maybeSingle(),
  ]);
  for (const r of [a, fy, c]) if (r.error) { ui.errorFrom(r.error, 'Could not load the report setup.'); return; }
  accounts = a.data;
  base = c.data ? c.data.code : '';
  const today = todayIso();
  const year = fy.data.find((y) => today >= y.start_date && today <= y.end_date);
  fromEl.value = year ? year.start_date : `${today.slice(0, 4)}-01-01`;
  toEl.value = today;

  const zero = el('input');
  zero.type = 'checkbox';
  zero.checked = hideZero;
  zero.style.width = 'auto';
  zero.addEventListener('change', () => { hideZero = zero.checked; render(); });
  const zl = el('label');
  zl.style.cssText = 'display:flex;align-items:center;gap:.4rem;cursor:pointer';
  zl.append(zero, document.createTextNode('Hide zero rows'));

  toolbar.append(el('span', 'muted', 'From'), fromEl, el('span', 'muted', 'To'), toEl, zl,
    btn('Run', 'btn-primary', run), btn('Expand all', '', () => { collapsed.clear(); render(); }),
    btn('Collapse all', '', collapseAll), el('span', 'spacer'), btn('Export to Excel', '', doExport));
  hint.textContent = `Amounts in ${base}. Brackets are credit balances. Income statement accounts restart at the start of the financial year.`;
  await run();
}

async function run() {
  if (!fromEl.value || !toEl.value) return ui.warn('Choose both dates.');
  const { data: res, error } = await supabase.rpc('trial_balance', { p_company: ctx.companyId, p_from: fromEl.value, p_to: toEl.value });
  if (error) return ui.errorFrom(error);
  data = res;
  render();
}

function build() {
  const amt = new Map();
  data.forEach((r) => { if (r.account_id) amt.set(r.account_id, { o: +r.opening, d: +r.debit, c: +r.credit, cl: +r.closing }); });
  const kids = new Map();
  accounts.forEach((a) => {
    const k = a.parent_id || 'root';
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k).push(a);
  });
  kids.forEach((l) => l.sort(cmp));
  const memo = new Map();
  const sumOf = (id) => {
    if (memo.has(id)) return memo.get(id);
    const t = { ...(amt.get(id) || ZERO()) };
    (kids.get(id) || []).forEach((k) => { const s = sumOf(k.id); t.o += s.o; t.d += s.d; t.c += s.c; t.cl += s.cl; });
    memo.set(id, t);
    return t;
  };
  return { kids, sumOf };
}

function isZero(t) { return [t.o, t.d, t.c, t.cl].every((x) => Math.abs(x) < 0.005); }

function flat(respectCollapse) {
  const { kids, sumOf } = build();
  const out = [];
  const walk = (key, depth) => {
    (kids.get(key) || []).forEach((a) => {
      const t = sumOf(a.id);
      if (hideZero && isZero(t)) return;
      const hasKids = kids.has(a.id);
      out.push({ a, t, depth, hasKids });
      if (hasKids && !(respectCollapse && collapsed.has(a.id))) walk(a.id, depth + 1);
    });
  };
  walk('root', 0);
  return { rows: out, kids, sumOf };
}

function render() {
  if (!data.length) { panel.innerHTML = '<p class="muted">Run the report to see balances.</p>'; return; }
  const { rows, kids, sumOf } = flat(true);
  const extra = data.find((r) => !r.account_id);
  const tot = ZERO();
  (kids.get('root') || []).forEach((a) => { const s = sumOf(a.id); tot.o += s.o; tot.d += s.d; tot.c += s.c; tot.cl += s.cl; });
  if (extra) { tot.o += +extra.opening; tot.cl += +extra.closing; }
  const balanced = Math.abs(tot.d - tot.c) < 0.005 && Math.abs(tot.o) < 0.005 && Math.abs(tot.cl) < 0.005;

  const body = rows.map(({ a, t, depth, hasKids }) => `<tr data-id="${a.id}" class="${a.is_posting ? '' : 'row-parent'}">
    <td style="padding-left:${0.7 + depth * 1.4}rem"><span class="tree-caret ${hasKids ? '' : 'leaf'}" data-act="toggle">${collapsed.has(a.id) ? '▸' : '▾'}</span>${esc(a.code)}</td>
    <td>${esc(a.name)}</td><td class="num">${signed(t.o)}</td><td class="num">${plain(t.d)}</td>
    <td class="num">${plain(t.c)}</td><td class="num">${signed(t.cl)}</td></tr>`).join('');
  const extraRow = extra ? `<tr><td></td><td>${esc(extra.name)}</td><td class="num">${signed(+extra.opening)}</td><td></td><td></td><td class="num">${signed(+extra.closing)}</td></tr>` : '';
  panel.innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr>
    <th>Code</th><th>Account</th><th style="text-align:right">Opening</th><th style="text-align:right">Debit</th>
    <th style="text-align:right">Credit</th><th style="text-align:right">Closing</th></tr></thead>
    <tbody>${body}${extraRow}
    <tr class="row-root"><td></td><td>Total</td><td class="num">${money(tot.o)}</td><td class="num">${money(tot.d)}</td>
    <td class="num">${money(tot.c)}</td><td class="num">${money(tot.cl)}</td></tr></tbody></table></div>
    <p><span class="badge ${balanced ? 'open' : ''}">${balanced ? 'Balanced' : 'Out of balance'}</span></p>`;
}

function collapseAll() {
  const { kids } = build();
  collapsed.clear();
  accounts.forEach((a) => { if (kids.has(a.id)) collapsed.add(a.id); });
  render();
}

panel.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act="toggle"]');
  if (!t) return;
  const id = t.closest('tr').dataset.id;
  if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
  render();
});

async function doExport() {
  if (!data.length) return ui.warn('Run the report first.');
  try {
    const { rows } = flat(false);
    const extra = data.find((r) => !r.account_id);
    const out = rows.map(({ a, t, depth }) => ({ code: a.code, name: '  '.repeat(depth) + a.name, o: t.o, d: t.d, c: t.c, cl: t.cl }));
    if (extra) out.push({ code: '', name: extra.name, o: +extra.opening, d: 0, c: 0, cl: +extra.closing });
    await exportSheets(`trial-balance-${fromEl.value}-to-${toEl.value}.xlsx`, [{
      name: 'Trial balance', rows: out,
      columns: [
        { key: 'code', header: 'Code', width: 14 }, { key: 'name', header: 'Account', width: 44 },
        { key: 'o', header: `Opening (${base})`, width: 16 }, { key: 'd', header: 'Debit', width: 16 },
        { key: 'c', header: 'Credit', width: 16 }, { key: 'cl', header: `Closing (${base})`, width: 16 },
      ],
    }]);
  } catch (e) { ui.errorFrom(e, 'Could not export.'); }
}

if (ctx) await init();