import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { exportSheets } from '../core/export.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const panel = document.getElementById('panel');
const CAN_EDIT = ctx ? ctx.canEdit : false;

let items = [];
let owned = new Map();
let accounts = [];
let taxes = [];
let assets = [];
let links = [];
let base = '';
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

async function load() {
  const cid = ctx.companyId;
  const [h, o, a, t, fa, l, c] = await Promise.all([
    supabase.from('hire_items').select('*').eq('company_id', cid).order('code'),
    supabase.rpc('hire_items_owned', { p_company: cid }),
    supabase.from('gl_accounts').select('id, code, name, account_groups(class_type)').eq('company_id', cid)
      .eq('is_posting', true).eq('is_active', true).is('control_type', null).order('code'),
    supabase.from('tax_codes').select('id, code, name, applies_to').eq('company_id', cid).eq('is_active', true).order('code'),
    supabase.from('fixed_assets').select('id, asset_no, name, quantity, asset_categories(code, is_hireable)')
      .eq('company_id', cid).eq('status', 'active').order('asset_no'),
    supabase.from('hire_item_assets').select('hire_item_id, asset_id').eq('company_id', cid),
    supabase.from('company_currencies').select('code').eq('company_id', cid).eq('is_base', true).maybeSingle(),
  ]);
  for (const r of [h, o, a, t, fa, l]) if (r.error) throw r.error;
  items = h.data;
  owned = new Map(o.data.map((x) => [x.hire_item_id, Number(x.owned)]));
  accounts = a.data.filter((x) => x.account_groups && x.account_groups.class_type === 'income_statement');
  taxes = t.data.filter((x) => x.applies_to === 'sales' || x.applies_to === 'both');
  assets = fa.data.filter((x) => x.asset_categories && x.asset_categories.is_hireable && Number(x.quantity) > 0);
  links = l.data;
  base = c.data ? c.data.code : '';
}

async function refresh() {
  try { await load(); } catch (e) { ui.errorFrom(e, 'Could not load hire items.'); }
  render();
}

function render() {
  document.getElementById('company-title').textContent = ctx.company.name;
  hint.textContent = `Rates in ${base}. The customer pays the lower of days × day rate and the event rate (plus any extra days). Units available are the quantities of the linked assets, so writing off chairs in Fixed Assets lowers availability.`;
  toolbar.replaceChildren();
  if (CAN_EDIT) toolbar.append(btn('New hire item', 'btn-primary', () => openEditor(null)));
  const box = el('input');
  box.type = 'search';
  box.placeholder = 'Search';
  box.value = needle;
  box.style.maxWidth = '240px';
  box.addEventListener('input', () => { needle = box.value.trim().toLowerCase(); renderTable(); });
  toolbar.append(box, el('span', 'spacer'), btn('Export to Excel', '', doExport));
  renderTable();
}

const list = () => items.filter((x) => !needle || [x.code, x.name].some((v) => String(v || '').toLowerCase().includes(needle)));
const eventText = (x) => (x.event_rate === null ? '' : `${money(x.event_rate)} for ${x.event_days} day${x.event_days === 1 ? '' : 's'}`);

function renderTable() {
  if (!items.length) { panel.innerHTML = '<p class="muted">No hire items yet.</p>'; return; }
  const rows = list().map((x) => `<tr class="clickable ${x.is_active ? '' : 'inactive'}" data-id="${x.id}">
    <td>${esc(x.code)}</td><td>${esc(x.name)}</td><td class="num">${qtyFmt(owned.get(x.id) || 0)}</td>
    <td class="num">${money(x.day_rate)}</td><td>${esc(eventText(x))}</td><td class="num">${Number(x.min_charge) ? money(x.min_charge) : ''}</td>
    <td>${x.buffer_before_days || x.buffer_after_days ? `${x.buffer_before_days} before / ${x.buffer_after_days} after` : ''}</td>
    <td>${x.is_active ? 'Yes' : 'No'}</td></tr>`).join('');
  panel.innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr><th>Code</th><th>Name</th>
    <th style="text-align:right">Units</th><th style="text-align:right">Day rate</th><th>Event rate</th>
    <th style="text-align:right">Minimum</th><th>Buffer days</th><th>Active</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

panel.addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr || !CAN_EDIT) return;
  const x = items.find((i) => i.id === tr.dataset.id);
  if (x) openEditor(x);
});

async function doExport() {
  try {
    await exportSheets(`hire-items-${new Date().toISOString().slice(0, 10)}.xlsx`, [{
      name: 'Hire items',
      rows: list().map((x) => ({
        code: x.code, name: x.name, units: owned.get(x.id) || 0, day: Number(x.day_rate), event: x.event_rate === null ? '' : Number(x.event_rate),
        eventDays: x.event_days || '', extra: x.extra_day_rate === null ? '' : Number(x.extra_day_rate), min: Number(x.min_charge),
        replace: x.replacement_cost === null ? '' : Number(x.replacement_cost), active: x.is_active ? 'Yes' : 'No',
      })),
      columns: [
        { key: 'code', header: 'Code', width: 12 }, { key: 'name', header: 'Name', width: 30 }, { key: 'units', header: 'Units', width: 10 },
        { key: 'day', header: `Day rate (${base})`, width: 16 }, { key: 'event', header: 'Event rate', width: 14 },
        { key: 'eventDays', header: 'Event days', width: 12 }, { key: 'extra', header: 'Extra day rate', width: 14 },
        { key: 'min', header: 'Minimum', width: 12 }, { key: 'replace', header: 'Replacement cost', width: 16 }, { key: 'active', header: 'Active', width: 8 },
      ],
    }]);
  } catch (e) { ui.errorFrom(e, 'Could not export.'); }
}

/* ---------- editor ---------- */

async function openEditor(x) {
  const isEdit = !!x;
  const prevFocus = document.activeElement;
  const backdrop = el('div', 'modal-backdrop');
  const box = el('div', 'modal xwide');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.append(el('h3', 'modal-title', isEdit ? `Edit ${x.code}` : 'New hire item'));

  const field = (text, input, full, hintText) => {
    const w = el('div', `field${full ? ' full' : ''}`);
    w.append(el('label', '', text), input);
    if (hintText) w.append(el('span', 'hint', hintText));
    return w;
  };
  const inp = (type, value) => { const i = el('input'); if (type) i.type = type; if (type === 'number') i.step = 'any'; i.value = value ?? ''; return i; };
  const codeIn = inp('', x ? x.code : '');
  const nameIn = inp('', x ? x.name : '');
  const descIn = inp('', x ? x.description || '' : '');
  const revSel = el('select');
  option(revSel, '', 'Select an account');
  accounts.forEach((a) => option(revSel, a.id, `${a.code} - ${a.name}`));
  revSel.value = x ? x.revenue_account_id : '';
  const taxSel = el('select');
  option(taxSel, '', 'No tax');
  taxes.forEach((t) => option(taxSel, t.id, `${t.code} - ${t.name}`));
  taxSel.value = x ? x.tax_code_id || '' : '';
  const dayIn = inp('number', x ? x.day_rate : '');
  const evRateIn = inp('number', x && x.event_rate !== null ? x.event_rate : '');
  const evDaysIn = inp('number', x && x.event_days ? x.event_days : '');
  const extraIn = inp('number', x && x.extra_day_rate !== null ? x.extra_day_rate : '');
  const minIn = inp('number', x ? x.min_charge : 0);
  const replIn = inp('number', x && x.replacement_cost !== null ? x.replacement_cost : '');
  const bbIn = inp('number', x ? x.buffer_before_days : 0);
  const baIn = inp('number', x ? x.buffer_after_days : 0);
  const activeIn = el('input'); activeIn.type = 'checkbox'; activeIn.checked = x ? x.is_active : true; activeIn.style.width = 'auto';

  const grid = el('div', 'form-grid');
  grid.append(field('Code *', codeIn), field('Name *', nameIn), field('Description', descIn, true),
    field('Hire revenue account *', revSel, false, 'An ordinary Income Statement account.'), field('Tax code', taxSel),
    field(`Day rate (${base}) *`, dayIn), field('Minimum charge per line', minIn),
    field('Event rate', evRateIn, false, 'A cap for the whole event. Leave blank for day pricing only.'),
    field('Days the event rate covers', evDaysIn, false, 'Needed with an event rate, for example 3 for a weekend.'),
    field('Extra day rate', extraIn, false, 'Per day beyond those. Blank uses the day rate.'),
    field('Replacement cost per unit', replIn, false, 'Used later to charge lost or damaged items.'),
    field('Buffer days before', bbIn, false, 'Unavailable for this many days before it goes out.'),
    field('Buffer days after', baIn, false, 'Unavailable for this many days after it comes back.'));
  const ar = el('div', 'field check full');
  ar.append(activeIn, el('label', '', 'Active'));
  grid.append(ar);
  box.append(grid);

  box.append(el('h4', '', 'Assets that make up this hire item'));
  box.append(el('p', 'muted', 'Only assets in a category marked Hireable are listed. A pool counts as its full quantity. An asset can belong to one hire item only.'));
  const wrap = el('div', 'lines-wrap');
  const table = el('table', 'grid');
  table.innerHTML = '<thead><tr><th></th><th>Asset</th><th>Name</th><th>Category</th><th style="text-align:right">Quantity</th><th></th></tr></thead>';
  const tb = el('tbody');
  const checks = [];
  const mine = new Set(links.filter((l) => x && l.hire_item_id === x.id).map((l) => l.asset_id));
  assets.forEach((a) => {
    const other = links.find((l) => l.asset_id === a.id && (!x || l.hire_item_id !== x.id));
    const otherItem = other ? items.find((i) => i.id === other.hire_item_id) : null;
    const cb = el('input');
    cb.type = 'checkbox';
    cb.style.width = 'auto';
    cb.checked = mine.has(a.id);
    cb.disabled = !!other;
    const tr = el('tr');
    const c0 = el('td');
    c0.append(cb);
    tr.append(c0, el('td', '', a.asset_no), el('td', '', a.name), el('td', '', a.asset_categories.code),
      el('td', 'num', qtyFmt(a.quantity)), el('td', 'muted', otherItem ? `Linked to ${otherItem.code}` : ''));
    tb.append(tr);
    checks.push({ cb, a });
  });
  if (!assets.length) {
    const tr = el('tr');
    const td = el('td', 'muted', 'No hireable assets yet. Tick Hireable on an asset category, then buy or add the assets.');
    td.colSpan = 6;
    tr.append(td);
    tb.append(tr);
  }
  table.append(tb);
  wrap.append(table);
  box.append(wrap);

  const actions = el('div', 'modal-actions');
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const close = () => {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    if (prevFocus && prevFocus.focus) prevFocus.focus();
  };
  document.addEventListener('keydown', onKey);
  const saveBtn = btn('Save', 'btn-primary', () => {});
  actions.append(el('span', 'spacer'), btn('Cancel', 'btn-ghost', close), saveBtn);
  box.append(actions);
  backdrop.append(box);
  document.body.append(backdrop);

  const num = (i) => (i.value === '' ? null : Number(i.value));
  saveBtn.addEventListener('click', async () => {
    if (!codeIn.value.trim() || !nameIn.value.trim()) return ui.warn('Enter the code and the name.');
    if (!revSel.value) return ui.warn('Choose the hire revenue account.');
    if (num(dayIn) === null || num(dayIn) < 0) return ui.warn('Enter the day rate.');
    if ((num(evRateIn) === null) !== (num(evDaysIn) === null)) return ui.warn('Give both the event rate and the days it covers, or leave both blank.');
    saveBtn.disabled = true;
    try {
      const { error } = await supabase.rpc('save_hire_item', {
        p_company: ctx.companyId, p_id: x ? x.id : null, p_code: codeIn.value, p_name: nameIn.value,
        p_description: descIn.value, p_revenue: revSel.value, p_tax: taxSel.value || null,
        p_day_rate: num(dayIn), p_event_rate: num(evRateIn), p_event_days: num(evDaysIn) === null ? null : Math.round(num(evDaysIn)),
        p_extra_rate: num(extraIn), p_min_charge: num(minIn) || 0, p_replacement: num(replIn),
        p_buf_before: Math.round(num(bbIn) || 0), p_buf_after: Math.round(num(baIn) || 0), p_active: activeIn.checked,
        p_assets: checks.filter((c) => c.cb.checked && !c.cb.disabled).map((c) => c.a.id),
      });
      if (error) throw error;
      close();
      if (isEdit) ui.updated('Hire item'); else ui.created('Hire item');
      await refresh();
    } catch (e) { ui.errorFrom(e, 'Could not save the hire item.'); }
    finally { saveBtn.disabled = false; }
  });
  codeIn.focus();
}

if (ctx) await refresh();