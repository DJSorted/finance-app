import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { exportSheets } from '../core/export.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const recon = document.getElementById('recon');
const panel = document.getElementById('panel');

const CAN_EDIT = ctx ? ctx.canEdit : false;
const TYPE_LABEL = {
  acquisition: 'Acquisition', opening: 'Opening balance', depreciation: 'Depreciation',
  depreciation_reversal: 'Depreciation reversed', disposal: 'Disposal',
};
const METHOD_LABEL = { straight_line: 'Straight line', reducing_balance: 'Reducing balance', none: 'Not depreciated' };

let categories = [];
let rows = [];
let banks = [];
let base = '';
let showDisposed = false;
let needle = '';
let catFilter = '';

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

const asOfEl = el('input');
asOfEl.type = 'date';
asOfEl.style.width = 'auto';
const catSel = el('select', 'compact');

async function init() {
  document.getElementById('company-title').textContent = ctx.company.name;
  const cid = ctx.companyId;
  const [c, cu, bk] = await Promise.all([
    supabase.from('asset_categories')
      .select('id, code, name, default_tracking, method, life_months, rate_percent, residual_percent')
      .eq('company_id', cid).order('code'),
    supabase.from('company_currencies').select('code').eq('company_id', cid).eq('is_base', true).maybeSingle(),
    supabase.from('gl_accounts').select('id, code, name, currency_code').eq('company_id', cid)
      .eq('control_type', 'bank').eq('is_posting', true).eq('is_active', true).order('code'),
  ]);
  if (c.error) return ui.errorFrom(c.error, 'Could not load the asset categories.');
  if (bk.error) return ui.errorFrom(bk.error, 'Could not load the bank accounts.');
  categories = c.data;
  banks = bk.data;
  base = cu.data ? cu.data.code : '';
  asOfEl.value = todayIso();

  option(catSel, '', 'All categories');
  categories.forEach((x) => option(catSel, x.id, `${x.code} - ${x.name}`));
  catSel.addEventListener('change', () => { catFilter = catSel.value; render(); });

  const search = el('input');
  search.type = 'search';
  search.placeholder = 'Search';
  search.style.maxWidth = '220px';
  search.addEventListener('input', () => { needle = search.value.trim().toLowerCase(); render(); });

  const disp = el('input');
  disp.type = 'checkbox';
  disp.style.width = 'auto';
  disp.addEventListener('change', () => { showDisposed = disp.checked; render(); });
  const dl = el('label');
  dl.style.cssText = 'display:flex;align-items:center;gap:.4rem;cursor:pointer';
  dl.append(disp, document.createTextNode('Show disposed'));

  toolbar.append(el('span', 'muted', 'As at'), asOfEl, catSel, search, dl, btn('Run', 'btn-primary', run));
  if (CAN_EDIT) toolbar.append(btn('Add existing asset', '', openAddExisting));
  toolbar.append(el('span', 'spacer'), btn('Export to Excel', '', doExport));
  hint.textContent = `Values in ${base}. Assets bought on a supplier bill appear here when the bill is posted: choose Asset: (category) in the Item column of a bill line. Click a row for its history.`;
  await run();
}

async function run() {
  if (!asOfEl.value) return ui.warn('Choose the date.');
  const [r, rc] = await Promise.all([
    supabase.rpc('fixed_asset_register', { p_company: ctx.companyId, p_as_of: asOfEl.value }),
    supabase.rpc('fixed_asset_reconciliation', { p_company: ctx.companyId, p_as_of: asOfEl.value }),
  ]);
  if (r.error) return ui.errorFrom(r.error, 'Could not load the register.');
  rows = r.data;
  render();
  renderRecon(rc);
}

function renderRecon(rc) {
  if (rc.error) { recon.innerHTML = ''; return; }
  const x = rc.data[0];
  const ok = Math.abs(Number(x.cost_diff)) < 0.005 && Math.abs(Number(x.accum_diff)) < 0.005;
  recon.innerHTML = `<div class="card" style="display:flex;gap:1.5rem;flex-wrap:wrap;align-items:center">
    <span class="badge ${ok ? 'open' : 'st-error'}">${ok ? 'Register reconciles to the fixed asset control accounts' : 'Does not reconcile'}</span>
    <span class="muted">Cost: register ${money(x.cost_register)} · ledger ${money(x.cost_ledger)}</span>
    <span class="muted">Accumulated depreciation: register ${money(x.accum_register)} · ledger ${money(x.accum_ledger)}</span>
    ${ok ? '' : '<span class="muted">A manual journal posted with the control override to a fixed asset account explains a difference. Reverse it, or send me the figures.</span>'}
  </div>`;
}

function visible() {
  return rows.filter((r) => (showDisposed || Number(r.qty) > 0)
    && (!catFilter || r.category_id === catFilter)
    && (!needle || [r.asset_no, r.name, r.serial_no, r.category_code].some((x) => String(x || '').toLowerCase().includes(needle))));
}

function render() {
  const list = visible();
  if (!rows.length) { panel.innerHTML = '<p class="muted">No assets at this date.</p>'; return; }
  if (!list.length) { panel.innerHTML = '<p class="muted">Nothing matches.</p>'; return; }
  const tot = list.reduce((s, r) => ({ cost: s.cost + Number(r.cost), acc: s.acc + Number(r.accumulated), nbv: s.nbv + Number(r.nbv) }),
    { cost: 0, acc: 0, nbv: 0 });
  const body = list.map((r) => `<tr class="clickable" data-id="${r.asset_id}">
    <td>${esc(r.asset_no)}</td><td>${esc(r.name)}</td><td>${esc(r.category_code)}</td>
    <td>${r.tracking === 'pooled' ? 'Pooled' : 'Serialised'}</td><td>${esc(r.serial_no || '')}</td>
    <td class="num">${qtyFmt(r.qty)}</td><td>${r.in_service_date}</td>
    <td class="num">${money(r.cost)}</td><td class="num">${money(r.accumulated)}</td><td class="num">${money(r.nbv)}</td></tr>`).join('');
  panel.innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr>
    <th>No</th><th>Name</th><th>Category</th><th>Type</th><th>Serial / tag</th><th style="text-align:right">Qty</th><th>In service</th>
    <th style="text-align:right">Cost</th><th style="text-align:right">Accum. depreciation</th><th style="text-align:right">Net book value</th></tr></thead>
    <tbody>${body}<tr class="row-root"><td colspan="7">Total (${esc(base)})</td><td class="num">${money(tot.cost)}</td>
    <td class="num">${money(tot.acc)}</td><td class="num">${money(tot.nbv)}</td></tr></tbody></table></div>`;
}

panel.addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (tr) openViewer(tr.dataset.id);
});

async function doExport() {
  const list = visible();
  if (!list.length) return ui.warn('Run the register first.');
  try {
    await exportSheets(`asset-register-${asOfEl.value}.xlsx`, [{
      name: 'Asset register',
      rows: list.map((r) => ({
        no: r.asset_no, name: r.name, category: r.category_code, type: r.tracking === 'pooled' ? 'Pooled' : 'Serialised',
        serial: r.serial_no || '', qty: Number(r.qty), inService: r.in_service_date, cost: Number(r.cost),
        accumulated: Number(r.accumulated), nbv: Number(r.nbv),
      })),
      columns: [
        { key: 'no', header: 'No', width: 12 }, { key: 'name', header: 'Name', width: 34 }, { key: 'category', header: 'Category', width: 12 },
        { key: 'type', header: 'Type', width: 12 }, { key: 'serial', header: 'Serial / tag', width: 16 }, { key: 'qty', header: 'Qty', width: 10 },
        { key: 'inService', header: 'In service', width: 12 }, { key: 'cost', header: `Cost (${base})`, width: 16 },
        { key: 'accumulated', header: 'Accumulated depreciation', width: 22 }, { key: 'nbv', header: 'Net book value', width: 16 },
      ],
    }]);
  } catch (e) { ui.errorFrom(e, 'Could not export.'); }
}

/* ---------- viewer ---------- */

async function openViewer(assetId) {
  const [a, m] = await Promise.all([
    supabase.from('fixed_assets').select('*').eq('id', assetId).single(),
    supabase.from('asset_movements').select('*').eq('asset_id', assetId).order('created_at'),
  ]);
  if (a.error) return ui.errorFrom(a.error, 'Could not load the asset.');
  if (m.error) return ui.errorFrom(m.error, 'Could not load the history.');
  const x = a.data;
  const cat = categories.find((c) => c.id === x.category_id);
  const nbv = Number(x.cost) - Number(x.accumulated);

  const node = el('div');
  const info = el('p', 'muted', [
    `${cat ? `${cat.code} - ${cat.name}` : ''} · ${x.tracking === 'pooled' ? 'Pooled' : 'Serialised'}${x.serial_no ? ` · ${x.serial_no}` : ''}`,
    x.description || '',
    `Acquired ${x.acquired_date} · In service ${x.in_service_date} · Quantity ${qtyFmt(x.quantity)}`,
    `${METHOD_LABEL[x.method]}${x.method === 'straight_line' ? `, ${x.life_months} months` : ''}${x.method === 'reducing_balance' ? `, ${Number(x.rate_percent)}% a year` : ''}`
      + ` · Depreciated ${x.months_depreciated} month(s)${x.last_depreciated_end ? ` to ${x.last_depreciated_end}` : ''}`,
    `Cost ${money(x.cost)} · Accumulated ${money(x.accumulated)} · Residual ${money(x.residual)} · Net book value ${money(nbv)} ${base}`,
    x.status === 'disposed' ? 'This asset has been disposed of.' : '',
    x.notes ? `Notes: ${x.notes}` : '',
  ].filter(Boolean).join('\n'));
  info.style.whiteSpace = 'pre-line';
  node.append(info);

  const body = m.data.map((r) => `<tr><td>${r.movement_date}</td>
    <td>${esc((TYPE_LABEL[r.movement_type] || r.movement_type) + (r.disposal_type ? ` (${r.disposal_type})` : ''))}</td>
    <td>${esc(r.source_no || '')}</td><td class="num">${Number(r.qty_change) ? qtyFmt(r.qty_change) : ''}</td>
    <td class="num">${Number(r.cost_change) ? money(r.cost_change) : ''}</td>
    <td class="num">${Number(r.accum_change) ? money(r.accum_change) : ''}</td>
    <td class="num">${r.movement_type === 'disposal' && Number(r.proceeds) ? money(r.proceeds) : ''}</td>
    <td class="num">${r.movement_type === 'disposal' && r.gain_loss !== null ? (Number(r.gain_loss) < 0 ? `(${money(-r.gain_loss)})` : money(r.gain_loss)) : ''}</td></tr>`).join('');
  const t = el('div', 'table-wrap');
  t.innerHTML = `<table class="grid"><thead><tr><th>Date</th><th>Type</th><th>Document</th>
    <th style="text-align:right">Quantity</th><th style="text-align:right">Cost</th><th style="text-align:right">Accumulated</th>
    <th style="text-align:right">Proceeds</th><th style="text-align:right">Gain / (loss)</th></tr></thead>
    <tbody>${body}</tbody></table>`;
  node.append(t);

  const buttons = [{ label: 'Close', value: 'close', className: 'btn-ghost' }];
  if (CAN_EDIT) buttons.push({ label: 'Edit details', value: 'edit', className: '' });
  if (CAN_EDIT && x.status === 'active' && Number(x.quantity) > 0) {
    buttons.push({ label: 'Dispose / write off', value: 'dispose', className: 'btn-danger' });
  }
  const res = await ui.dialog({ title: `${x.asset_no} - ${x.name}`, node, buttons, dismissValue: 'close', wide: true });
  if (res === 'edit') await editDetails(x);
  if (res === 'dispose') await disposeAsset(x);
}

async function editDetails(x) {
  const saved = await ui.form({
    title: `Edit ${x.asset_no}`,
    fields: [
      { name: 'name', label: 'Name', required: true, full: true },
      { name: 'serial_no', label: 'Serial number / tag', full: true, disabled: x.tracking !== 'serialised',
        hint: x.tracking === 'serialised' ? 'Must be unique across your assets.' : 'Pooled assets have no serial number.' },
      { name: 'description', label: 'Description', type: 'textarea', full: true },
      { name: 'notes', label: 'Notes', type: 'textarea', full: true },
    ],
    values: { name: x.name, serial_no: x.serial_no || '', description: x.description || '', notes: x.notes || '' },
    onSubmit: async (v) => {
      const { error } = await supabase.rpc('update_asset_details', {
        p_asset: x.id, p_name: v.name, p_description: v.description, p_serial: v.serial_no, p_notes: v.notes,
      });
      if (error) throw error;
    },
  });
  if (saved) { ui.updated('Asset'); await run(); }
}

/* ---------- add an asset you already own ---------- */

async function openAddExisting() {
  if (!categories.length) return ui.warn('Create an asset category first.');
  const saved = await ui.form({
    title: 'Add existing asset',
    submitText: 'Add asset',
    fields: [
      { name: 'category', label: 'Category', type: 'select', required: true, full: true,
        options: [{ value: '', label: 'Select a category' }].concat(categories.map((c) => ({ value: c.id, label: `${c.code} - ${c.name}` }))) },
      { name: 'name', label: 'Name', required: true, full: true },
      { name: 'tracking', label: 'Tracking', type: 'select',
        options: [{ value: '', label: 'Category default' }, { value: 'serialised', label: 'Serialised' }, { value: 'pooled', label: 'Pooled' }] },
      { name: 'qty', label: 'Quantity', type: 'number', required: true,
        hint: 'A serialised quantity above 1 creates that many assets and splits the figures evenly.' },
      { name: 'serial', label: 'Serial number / tag', hint: 'Only for a single serialised asset.' },
      { name: 'opening_date', label: 'Opening date', type: 'date', required: true, hint: 'The date it is brought into the books. Must be in an open period.' },
      { name: 'in_service', label: 'In service since', type: 'date', required: true },
      { name: 'cost', label: `Total cost (${base})`, type: 'number', required: true },
      { name: 'accumulated', label: 'Accumulated depreciation to date', type: 'number' },
      { name: 'residual', label: 'Residual value', type: 'number', hint: 'Leave blank to use the category percentage.' },
      { name: 'months', label: 'Months already depreciated', type: 'number' },
      { name: 'through', label: 'Depreciated up to (month end)', type: 'date', hint: 'Required when accumulated depreciation is above zero.' },
      { name: 'description', label: 'Description', type: 'textarea', full: true },
      { name: 'notes', label: 'Notes', type: 'textarea', full: true },
    ],
    values: { qty: 1, opening_date: todayIso(), accumulated: 0, months: 0 },
    onSubmit: async (v) => {
      if (!(v.cost > 0)) throw new Error('Enter the cost.');
      if ((v.accumulated || 0) > v.cost) throw new Error('Accumulated depreciation cannot be more than the cost.');
      const { error } = await supabase.rpc('add_existing_asset', {
        p_company: ctx.companyId, p_category: v.category, p_name: v.name, p_description: v.description,
        p_tracking: v.tracking, p_serial: v.serial, p_qty: v.qty, p_opening_date: v.opening_date,
        p_in_service: v.in_service, p_cost: v.cost, p_accumulated: v.accumulated || 0, p_residual: v.residual,
        p_months: Math.round(v.months || 0), p_depreciated_through: v.through || null, p_notes: v.notes,
      });
      if (error) throw error;
    },
  });
  if (saved) { ui.created('Asset'); await run(); }
}

const DISPOSAL_TYPES = [
  ['sale', 'Sold'], ['scrap', 'Scrapped'], ['lost', 'Lost'], ['stolen', 'Stolen'], ['damaged', 'Damaged beyond repair'],
];

async function disposeAsset(x) {
  const bankOptions = [{ value: '', label: 'Select bank account' }].concat(
    banks.filter((b) => !b.currency_code || b.currency_code === base).map((b) => ({ value: b.id, label: `${b.code} - ${b.name}` })));
  const pooled = x.tracking === 'pooled';
  let chosen = null;
  const picked = await ui.form({
    title: `Dispose of or write off ${x.asset_no}`,
    submitText: 'Continue',
    fields: [
      { name: 'type', label: 'What happened', type: 'select', required: true, full: true,
        options: DISPOSAL_TYPES.map(([value, label]) => ({ value, label })) },
      { name: 'date', label: 'Date', type: 'date', required: true,
        hint: 'Must be in an open period. Depreciation must be up to date to the month before.' },
      { name: 'qty', label: 'Quantity', type: 'number', disabled: !pooled,
        hint: pooled ? `Up to ${qtyFmt(x.quantity)}. Cost and depreciation are removed in proportion.` : 'A serialised asset leaves as a whole.' },
      { name: 'proceeds', label: `Proceeds or recovery (${base})`, type: 'number',
        hint: 'Cash received: a sale price, scrap value or insurance payout. Leave blank if none.' },
      { name: 'bank', label: 'Received into', type: 'select', options: bankOptions, full: true, hint: 'Needed when there are proceeds.' },
      { name: 'reference', label: 'Reference' },
      { name: 'notes', label: 'Notes' },
    ],
    values: { type: 'sale', date: todayIso(), qty: Number(x.quantity) },
    onSubmit: async (v) => {
      if (!v.date) throw new Error('Enter the date.');
      if (pooled && !(v.qty > 0 && v.qty <= Number(x.quantity))) throw new Error(`The quantity must be above zero and at most ${qtyFmt(x.quantity)}.`);
      if (v.proceeds !== null && v.proceeds < 0) throw new Error('Proceeds cannot be negative.');
      if (v.proceeds > 0 && !v.bank) throw new Error('Choose the bank account the proceeds were received into.');
      chosen = v;
    },
  });
  if (!picked || !chosen) return;

  const total = Number(x.quantity);
  const q = pooled ? chosen.qty : total;
  const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const cost = q >= total ? Number(x.cost) : r2(Number(x.cost) * q / total);
  const acc = q >= total ? Number(x.accumulated) : r2(Number(x.accumulated) * q / total);
  const nbv = r2(cost - acc);
  const proceeds = chosen.proceeds || 0;
  const gl = r2(proceeds - nbv);
  const ok = await ui.confirm({
    title: 'Post disposal',
    message: `${DISPOSAL_TYPES.find((d) => d[0] === chosen.type)[1]}: ${qtyFmt(q)} of ${qtyFmt(total)}.\n`
      + `Cost removed ${money(cost)}, accumulated depreciation ${money(acc)}, net book value ${money(nbv)}.\n`
      + `Proceeds ${money(proceeds)}: ${gl >= 0 ? 'profit' : 'loss'} of ${money(Math.abs(gl))} ${base} to the disposal account.`,
    confirmText: 'Post', danger: true,
  });
  if (!ok) return;
  const { error } = await supabase.rpc('dispose_asset', {
    p_company: ctx.companyId, p_asset: x.id, p_date: chosen.date, p_type: chosen.type, p_qty: pooled ? chosen.qty : null,
    p_proceeds: proceeds, p_bank: chosen.bank || null, p_reference: chosen.reference, p_notes: chosen.notes,
  });
  if (error) return ui.errorFrom(error, 'Could not post the disposal.');
  ui.success('Disposal posted.');
  await run();
}

if (ctx) await init();