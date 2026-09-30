import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { exportSheets } from '../core/export.js';
import { openImport } from './chart-import.js';

const ctx = await startPage();

const CONTROL_TYPES = [
  ['', 'None'], ['debtors', 'Debtors (customers)'], ['creditors', 'Creditors (suppliers)'],
  ['inventory', 'Inventory'], ['fixed_assets', 'Fixed assets'], ['accum_depreciation', 'Accumulated depreciation'],
  ['grni', 'Goods received not invoiced'], ['wip', 'Work in progress'], ['bank', 'Bank'],
  ['tax', 'Tax'], ['fx', 'Exchange gains / losses'],
];
const controlLabel = (v) => (CONTROL_TYPES.find((c) => c[0] === (v || '')) || [, ''])[1] === 'None' ? '' : (CONTROL_TYPES.find((c) => c[0] === (v || '')) || [, ''])[1];

const panel = document.getElementById('panel');
const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');

let groups = [];
let accounts = [];
let currencies = [];
let tab = 'groups';
let firstLoad = true;
const collapsedGroups = new Set();
const collapsedAccounts = new Set();

/* ---------- helpers ---------- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cmp = (a, b) => (a.sort_order - b.sort_order) || a.code.localeCompare(b.code, undefined, { numeric: true });

function childrenMap(rows) {
  const m = new Map();
  rows.forEach((r) => {
    const k = r.parent_id || 'root';
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  });
  m.forEach((list) => list.sort(cmp));
  return m;
}

function flatten(rows, collapsed, respectCollapse = true) {
  const kids = childrenMap(rows);
  const list = [];
  const walk = (key, depth) => {
    (kids.get(key) || []).forEach((r) => {
      const hasKids = kids.has(r.id);
      list.push({ row: r, depth, hasKids });
      if (hasKids && !(respectCollapse && collapsed.has(r.id))) walk(r.id, depth + 1);
    });
  };
  walk('root', 0);
  return { list, kids };
}

function descendants(rows, id) {
  const kids = childrenMap(rows);
  const out = new Set();
  const walk = (x) => (kids.get(x) || []).forEach((r) => { out.add(r.id); walk(r.id); });
  walk(id);
  return out;
}

function groupPath(id) {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const parts = [];
  let cur = byId.get(id);
  let n = 0;
  while (cur && n++ < 10) { parts.unshift(cur.name); cur = byId.get(cur.parent_id); }
  return parts.join(' › ');
}

function nextSort(rows, parentId) {
  const sibs = rows.filter((r) => (r.parent_id || null) === (parentId || null));
  return sibs.length ? Math.max(...sibs.map((r) => r.sort_order)) + 10 : 10;
}

function btn(label, cls, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `btn ${cls}`.trim();
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function tableHtml(headers, body) {
  return `<div class="table-wrap"><table class="grid"><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function actionsHtml({ add, edit, move, del }) {
  if (!ctx.canEdit) return '';
  return `<div class="row-actions">
    ${add ? '<button class="btn btn-sm" data-act="add" title="Add child">+</button>' : ''}
    ${edit ? '<button class="btn btn-sm" data-act="edit">Edit</button>' : ''}
    ${move ? '<button class="btn btn-sm" data-act="up" title="Move up">↑</button><button class="btn btn-sm" data-act="down" title="Move down">↓</button>' : ''}
    ${del ? '<button class="btn btn-sm" data-act="del">Delete</button>' : ''}
  </div>`;
}

/* ---------- data ---------- */

async function load() {
  const cid = ctx.companyId;
  const [g, a, c] = await Promise.all([
    supabase.from('account_groups').select('*').eq('company_id', cid).order('sort_order').order('code'),
    supabase.from('gl_accounts').select('*').eq('company_id', cid).order('sort_order').order('code'),
    supabase.from('company_currencies').select('code, is_base').eq('company_id', cid).order('code'),
  ]);
  for (const r of [g, a, c]) if (r.error) throw r.error;
  groups = g.data;
  accounts = a.data;
  currencies = c.data;
  if (firstLoad) {
    groups.forEach((x) => { if (x.collapsed_default && x.parent_id) collapsedGroups.add(x.id); });
    firstLoad = false;
  }
}

async function refresh() {
  try { await load(); } catch (e) { ui.errorFrom(e, 'Could not reload the chart of accounts.'); }
  render();
}

async function moveRow(table, rows, id, dir) {
  const me = rows.find((r) => r.id === id);
  const sibs = rows.filter((r) => (r.parent_id || null) === (me.parent_id || null)).sort(cmp);
  const i = sibs.findIndex((r) => r.id === id);
  const j = i + dir;
  if (j < 0 || j >= sibs.length) return;
  [sibs[i], sibs[j]] = [sibs[j], sibs[i]];
  const changes = sibs.map((r, idx) => ({ r, so: (idx + 1) * 10 })).filter((x) => x.r.sort_order !== x.so);
  const results = await Promise.all(changes.map((x) => supabase.from(table).update({ sort_order: x.so }).eq('id', x.r.id)));
  const failed = results.find((r) => r.error);
  if (failed) ui.errorFrom(failed.error);
  await refresh();
}

/* ---------- render ---------- */

function render() {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  renderToolbar();
  if (tab === 'groups') renderGroups(); else renderAccounts();
}

function renderToolbar() {
  toolbar.innerHTML = '';
  if (ctx.canEdit) {
    if (tab === 'groups') {
      const isRoot = groups.find((g) => !g.parent_id && g.class_type === 'income_statement');
      toolbar.append(btn('Add group', 'btn-primary', () => openGroupForm(null, isRoot && isRoot.id)));
    } else {
      toolbar.append(btn('Add account', 'btn-primary', () => openAccountForm(null, null)));
    }
  }
  toolbar.append(btn('Expand all', '', () => setAll(false)), btn('Collapse all', '', () => setAll(true)));
  const sp = document.createElement('span');
  sp.className = 'spacer';
  toolbar.append(sp);
  if (ctx.canEdit) {
    toolbar.append(btn('Import', '', () => openImport({
      ctx, tab, groups, accounts, currencies, controlTypes: CONTROL_TYPES, onDone: refresh,
    })));
  }
  toolbar.append(btn('Export to Excel', '', doExport));
  hint.textContent = tab === 'groups'
    ? 'Groups sit under the Income Statement or Balance Sheet class, up to 4 levels deep. They control how accounts total in reports.'
    : 'Accounts nest up to 3 levels. Only posting accounts hold transactions, and each one belongs to a group.';
}

function renderGroups() {
  const { list } = flatten(groups, collapsedGroups);
  const counts = new Map();
  accounts.forEach((a) => { if (a.group_id) counts.set(a.group_id, (counts.get(a.group_id) || 0) + 1); });

  const body = list.map(({ row: r, depth, hasKids }) => {
    const isRoot = !r.parent_id;
    const cls = [isRoot ? 'row-root' : (hasKids ? 'row-parent' : ''), r.is_active ? '' : 'inactive'].join(' ').trim();
    const caret = `<span class="tree-caret ${hasKids ? '' : 'leaf'}" data-act="toggle">${collapsedGroups.has(r.id) ? '▸' : '▾'}</span>`;
    const actions = isRoot
      ? actionsHtml({ add: true })
      : actionsHtml({ add: r.level < 5, edit: true, move: true, del: true });
    return `<tr class="${cls}" data-id="${r.id}">
      <td style="padding-left:${0.7 + depth * 1.4}rem">${caret}${esc(r.code)}</td>
      <td class="name">${esc(r.name)}</td>
      <td>${isRoot ? '' : (r.show_subtotal ? 'Yes' : 'No')}</td>
      <td>${isRoot ? '' : (r.collapsed_default ? 'Yes' : 'No')}</td>
      <td class="num">${counts.get(r.id) || ''}</td>
      <td>${actions}</td></tr>`;
  }).join('');
  panel.innerHTML = tableHtml(['Code', 'Name', 'Subtotal', 'Collapsed', 'Accounts', ''], body);
}

function renderAccounts() {
  if (!accounts.length) {
    panel.innerHTML = '<p class="muted">No accounts yet. Create your groups first, then add accounts.</p>';
    return;
  }
  const gById = new Map(groups.map((g) => [g.id, g]));
  const { list } = flatten(accounts, collapsedAccounts);
  const body = list.map(({ row: r, depth, hasKids }) => {
    const g = gById.get(r.group_id);
    const cls = [r.is_posting ? '' : 'row-parent', r.is_active ? '' : 'inactive'].join(' ').trim();
    const caret = `<span class="tree-caret ${hasKids ? '' : 'leaf'}" data-act="toggle">${collapsedAccounts.has(r.id) ? '▸' : '▾'}</span>`;
    return `<tr class="${cls}" data-id="${r.id}">
      <td style="padding-left:${0.7 + depth * 1.4}rem">${caret}${esc(r.code)}</td>
      <td class="name">${esc(r.name)}</td>
      <td>${r.is_posting ? 'Posting' : 'Header'}</td>
      <td title="${esc(g ? groupPath(g.id) : '')}">${esc(g ? g.name : '')}</td>
      <td>${r.is_posting ? (r.normal_balance === 'debit' ? 'Debit' : 'Credit') : ''}</td>
      <td>${esc(controlLabel(r.control_type))}</td>
      <td>${esc(r.currency_code || '')}</td>
      <td>${r.is_active ? 'Yes' : 'No'}</td>
      <td>${actionsHtml({ add: !r.is_posting && r.level < 3, edit: true, move: true, del: true })}</td></tr>`;
  }).join('');
  panel.innerHTML = tableHtml(['Code', 'Name', 'Type', 'Group', 'Normal', 'Control', 'Currency', 'Active', ''], body);
}

function setAll(collapse) {
  const rows = tab === 'groups' ? groups : accounts;
  const set = tab === 'groups' ? collapsedGroups : collapsedAccounts;
  set.clear();
  if (collapse) {
    const kids = childrenMap(rows);
    rows.forEach((r) => { if (kids.has(r.id) && (tab !== 'groups' || r.parent_id)) set.add(r.id); });
  }
  render();
}

/* ---------- actions ---------- */

function onPanelClick(e) {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const tr = t.closest('tr');
  if (!tr) return;
  const id = tr.dataset.id;
  const act = t.dataset.act;
  if (act === 'toggle') {
    const set = tab === 'groups' ? collapsedGroups : collapsedAccounts;
    if (set.has(id)) set.delete(id); else set.add(id);
    render();
    return;
  }
  if (!ctx.canEdit) return;
  if (tab === 'groups') groupAction(act, id); else accountAction(act, id);
}

async function groupAction(act, id) {
  const row = groups.find((g) => g.id === id);
  if (!row) return;
  if (act === 'add') return openGroupForm(null, id);
  if (act === 'edit') return openGroupForm(row);
  if (act === 'up' || act === 'down') return moveRow('account_groups', groups, id, act === 'up' ? -1 : 1);
  if (act === 'del') {
    if (groups.some((g) => g.parent_id === id)) return ui.warn('Delete or move the sub groups first.');
    if (accounts.some((a) => a.group_id === id)) return ui.warn('Move the accounts out of this group first.');
    if (!(await ui.confirmDelete('Group'))) return;
    const { error } = await supabase.from('account_groups').delete().eq('id', id);
    if (error) return ui.errorFrom(error);
    ui.deleted('Group');
    await refresh();
  }
}

async function accountAction(act, id) {
  const row = accounts.find((a) => a.id === id);
  if (!row) return;
  if (act === 'add') return openAccountForm(null, id);
  if (act === 'edit') return openAccountForm(row);
  if (act === 'up' || act === 'down') return moveRow('gl_accounts', accounts, id, act === 'up' ? -1 : 1);
  if (act === 'del') {
    if (accounts.some((a) => a.parent_id === id)) return ui.warn('Delete or move the child accounts first.');
    if (!(await ui.confirmDelete('Account'))) return;
    const { error } = await supabase.from('gl_accounts').delete().eq('id', id);
    if (error) return ui.errorFrom(error);
    ui.deleted('Account');
    await refresh();
  }
}

async function openGroupForm(row, defaultParent) {
  const isEdit = !!row;
  const bad = isEdit ? descendants(groups, row.id) : new Set();
  if (isEdit) bad.add(row.id);
  const options = flatten(groups, new Set(), false).list
    .filter((x) => x.row.level <= 4 && !bad.has(x.row.id))
    .map((x) => ({ value: x.row.id, label: '\u00A0\u00A0'.repeat(x.depth) + x.row.code + ' - ' + x.row.name }));

  const saved = await ui.form({
    title: isEdit ? 'Edit group' : 'Add group',
    fields: [
      { name: 'code', label: 'Code', required: true },
      { name: 'name', label: 'Name', required: true },
      { name: 'parent_id', label: 'Parent', type: 'select', options, required: true, full: true },
      { name: 'sort_order', label: 'Sort order', type: 'number', hint: 'Leave blank to add at the end.' },
      { name: 'show_subtotal', label: 'Show subtotal in reports', type: 'checkbox' },
      { name: 'collapsed_default', label: 'Collapsed by default', type: 'checkbox' },
      { name: 'is_active', label: 'Active', type: 'checkbox' },
    ],
    values: row || { parent_id: defaultParent, show_subtotal: true, collapsed_default: false, is_active: true },
    onSubmit: async (v) => {
      const payload = {
        code: v.code, name: v.name, parent_id: v.parent_id,
        sort_order: v.sort_order ?? nextSort(groups, v.parent_id),
        show_subtotal: v.show_subtotal, collapsed_default: v.collapsed_default, is_active: v.is_active,
      };
      const q = isEdit
        ? supabase.from('account_groups').update(payload).eq('id', row.id)
        : supabase.from('account_groups').insert({ ...payload, company_id: ctx.companyId });
      const { error } = await q;
      if (error) throw error;
    },
  });
  if (saved) {
    if (isEdit) ui.updated('Group'); else ui.created('Group');
    await refresh();
  }
}

async function openAccountForm(row, defaultParent) {
  const isEdit = !!row;
  const bad = isEdit ? descendants(accounts, row.id) : new Set();
  if (isEdit) bad.add(row.id);

  const parentOptions = [{ value: '', label: 'None (top level)' }].concat(
    flatten(accounts, new Set(), false).list
      .filter((x) => !x.row.is_posting && x.row.level <= 2 && !bad.has(x.row.id))
      .map((x) => ({ value: x.row.id, label: '\u00A0\u00A0'.repeat(x.depth) + x.row.code + ' - ' + x.row.name }))
  );
  const groupOptions = [{ value: '', label: 'Select a group' }].concat(
    flatten(groups, new Set(), false).list
      .filter((x) => x.row.level >= 2)
      .map((x) => ({ value: x.row.id, label: groupPath(x.row.id) }))
  );
  const currencyOptions = [{ value: '', label: 'Any currency' }].concat(
    currencies.map((c) => ({ value: c.code, label: c.code + (c.is_base ? ' (base)' : '') }))
  );

  const saved = await ui.form({
    title: isEdit ? 'Edit account' : 'Add account',
    fields: [
      { name: 'code', label: 'Code', required: true },
      { name: 'name', label: 'Name', required: true },
      { name: 'parent_id', label: 'Parent account', type: 'select', options: parentOptions, full: true },
      { name: 'is_posting', label: 'Posting account (can hold transactions)', type: 'checkbox', full: true },
      { name: 'group_id', label: 'Group', type: 'select', options: groupOptions, full: true, hint: 'Required for posting accounts. Decides where the account totals in reports.' },
      { name: 'normal_balance', label: 'Normal balance', type: 'select', options: [{ value: 'debit', label: 'Debit' }, { value: 'credit', label: 'Credit' }] },
      { name: 'control_type', label: 'Control account', type: 'select', options: CONTROL_TYPES.map((c) => ({ value: c[0], label: c[1] })) },
      { name: 'currency_code', label: 'Currency', type: 'select', options: currencyOptions },
      { name: 'sort_order', label: 'Sort order', type: 'number', hint: 'Leave blank to add at the end.' },
      { name: 'allow_manual_journal', label: 'Allow manual journals', type: 'checkbox' },
      { name: 'is_active', label: 'Active', type: 'checkbox' },
      { name: 'notes', label: 'Notes', type: 'textarea', full: true },
    ],
    values: row || {
      parent_id: defaultParent || '', is_posting: !!defaultParent, normal_balance: 'debit',
      allow_manual_journal: true, is_active: true,
    },
    onSubmit: async (v) => {
      if (v.is_posting && !v.group_id) throw new Error('Choose a group for a posting account.');
      const payload = {
        code: v.code, name: v.name, parent_id: v.parent_id || null, is_posting: v.is_posting,
        group_id: v.is_posting ? v.group_id : null, normal_balance: v.normal_balance,
        control_type: v.control_type || null, currency_code: v.currency_code || null,
        allow_manual_journal: v.allow_manual_journal, is_active: v.is_active,
        sort_order: v.sort_order ?? nextSort(accounts, v.parent_id || null), notes: v.notes || null,
      };
      const q = isEdit
        ? supabase.from('gl_accounts').update(payload).eq('id', row.id)
        : supabase.from('gl_accounts').insert({ ...payload, company_id: ctx.companyId });
      const { error } = await q;
      if (error) throw error;
    },
  });
  if (saved) {
    if (isEdit) ui.updated('Account'); else ui.created('Account');
    await refresh();
  }
}

async function doExport() {
  try {
    const gById = new Map(groups.map((g) => [g.id, g]));
    const aById = new Map(accounts.map((a) => [a.id, a]));
    const yn = (b) => (b ? 'Yes' : 'No');

    const groupRows = flatten(groups, new Set(), false).list.map(({ row: r }) => ({
      code: r.code, name: r.name, parent: (gById.get(r.parent_id) || {}).code || '', level: r.level,
      class: r.class_type === 'income_statement' ? 'Income Statement' : 'Balance Sheet',
      subtotal: yn(r.show_subtotal), collapsed: yn(r.collapsed_default), active: yn(r.is_active), sort: r.sort_order,
    }));
    const accountRows = flatten(accounts, new Set(), false).list.map(({ row: r }) => ({
      code: r.code, name: r.name, parent: (aById.get(r.parent_id) || {}).code || '', level: r.level,
      type: r.is_posting ? 'Posting' : 'Header', group: (gById.get(r.group_id) || {}).code || '',
      normal: r.is_posting ? r.normal_balance : '', control: r.control_type || '', currency: r.currency_code || '',
      manual: yn(r.allow_manual_journal), active: yn(r.is_active), sort: r.sort_order, notes: r.notes || '',
    }));

    await exportSheets(`chart-of-accounts-${new Date().toISOString().slice(0, 10)}.xlsx`, [
      { name: 'Groups', rows: groupRows, columns: [
        { key: 'code', header: 'Code', width: 14 }, { key: 'name', header: 'Name', width: 32 },
        { key: 'parent', header: 'Parent code', width: 14 }, { key: 'level', header: 'Level', width: 8 },
        { key: 'class', header: 'Class', width: 18 }, { key: 'subtotal', header: 'Subtotal', width: 10 },
        { key: 'collapsed', header: 'Collapsed', width: 10 }, { key: 'active', header: 'Active', width: 8 },
        { key: 'sort', header: 'Sort', width: 8 } ] },
      { name: 'Accounts', rows: accountRows, columns: [
        { key: 'code', header: 'Code', width: 14 }, { key: 'name', header: 'Name', width: 32 },
        { key: 'parent', header: 'Parent code', width: 14 }, { key: 'level', header: 'Level', width: 8 },
        { key: 'type', header: 'Type', width: 10 }, { key: 'group', header: 'Group code', width: 14 },
        { key: 'normal', header: 'Normal balance', width: 14 }, { key: 'control', header: 'Control type', width: 18 },
        { key: 'currency', header: 'Currency', width: 10 }, { key: 'manual', header: 'Manual journals', width: 16 },
        { key: 'active', header: 'Active', width: 8 }, { key: 'sort', header: 'Sort', width: 8 },
        { key: 'notes', header: 'Notes', width: 30 } ] },
    ]);
  } catch (e) {
    ui.errorFrom(e, 'Could not export.');
  }
}

/* ---------- start ---------- */

async function main() {
  document.getElementById('company-title').textContent = ctx.company.name;
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => { tab = t.dataset.tab; render(); }));
  panel.addEventListener('click', onPanelClick);
  try { await load(); } catch (e) { ui.errorFrom(e, 'Could not load the chart of accounts.'); return; }
  render();
}

if (ctx) main();