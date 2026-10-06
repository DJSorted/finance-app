import { supabase } from '../core/supabase.js';
import { ui } from '../core/ui.js';
import { readWorkbook, exportSheets } from '../core/export.js';

const MAX_ROWS = 5000;
const SHOW_MAX = 300;

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/* ---------- parsing helpers ---------- */

const normKey = (k) => String(k).toLowerCase().replace(/[^a-z]/g, '');
function normRow(raw) {
  const o = {};
  Object.keys(raw).forEach((k) => { o[normKey(k)] = String(raw[k] ?? '').trim(); });
  return o;
}
function get(o, ...keys) {
  for (const k of keys) if (o[k]) return o[k];
  return '';
}
// '' -> null (keep current / use default), true/false, or undefined when invalid
function parseBool(v) {
  const s = v.toLowerCase();
  if (s === '') return null;
  if (['yes', 'y', 'true', '1'].includes(s)) return true;
  if (['no', 'n', 'false', '0'].includes(s)) return false;
  return undefined;
}
function parseSort(v) {
  if (v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : undefined;
}

/* ---------- validation ---------- */

function validateGroups(rawRows, db) {
  const dbByCode = new Map(db.map((g) => [g.code, g]));
  const roots = new Set(db.filter((g) => !g.parent_id).map((g) => g.code));
  const rows = [];
  const firstLine = new Map();

  rawRows.forEach((raw, i) => {
    const o = normRow(raw);
    const r = {
      idx: i, line: i + 2, code: get(o, 'code'), name: get(o, 'name'),
      parent: get(o, 'parentcode', 'parent'), errors: [], status: 'new', level: NaN, msg: '',
    };
    if (!r.code && !r.name && !r.parent) return;
    if (roots.has(r.code)) { r.status = 'skip'; r.msg = 'Class row, managed by the system'; rows.push(r); return; }

    if (!r.code) r.errors.push('Code is required');
    if (!r.name) r.errors.push('Name is required');
    if (!r.parent) r.errors.push('Parent code is required');
    if (r.code) {
      if (firstLine.has(r.code)) r.errors.push(`Duplicate code (first used on line ${firstLine.get(r.code)})`);
      else firstLine.set(r.code, r.line);
    }
    r.vals = {
      show_subtotal: parseBool(get(o, 'subtotal', 'showsubtotal')),
      collapsed_default: parseBool(get(o, 'collapsed', 'collapseddefault')),
      is_active: parseBool(get(o, 'active')),
      sort_order: parseSort(get(o, 'sort', 'sortorder')),
    };
    if (r.vals.show_subtotal === undefined) r.errors.push('Subtotal must be Yes or No');
    if (r.vals.collapsed_default === undefined) r.errors.push('Collapsed must be Yes or No');
    if (r.vals.is_active === undefined) r.errors.push('Active must be Yes or No');
    if (r.vals.sort_order === undefined) r.errors.push('Sort must be a whole number');
    rows.push(r);
  });

  const live = rows.filter((r) => r.status !== 'skip');
  const fileByCode = new Map();
  live.forEach((r) => { if (r.code && !fileByCode.has(r.code)) fileByCode.set(r.code, r); });

  const levelOf = (code, stack) => {
    if (roots.has(code)) return 1;
    const f = fileByCode.get(code);
    if (f) {
      if (stack.has(code)) return NaN;
      stack.add(code);
      return levelOf(f.parent, stack) + 1;
    }
    const d = dbByCode.get(code);
    return d ? d.level : NaN;
  };

  live.forEach((r) => {
    if (r.parent) {
      const known = roots.has(r.parent) || fileByCode.has(r.parent) || dbByCode.has(r.parent);
      if (!known) r.errors.push(`Parent "${r.parent}" not found`);
      else if (r.code) {
        const lvl = levelOf(r.code, new Set());
        if (Number.isNaN(lvl)) r.errors.push('Parent chain is invalid (loop or unknown ancestor)');
        else { r.level = lvl; if (lvl > 5) r.errors.push('Too deep: groups allow 4 levels below the class'); }
      }
    }
    if (r.code && dbByCode.has(r.code)) r.status = 'update';
    if (r.errors.length) { r.status = 'error'; r.msg = r.errors.join('; '); return; }
    r.payload = {
      code: r.code, name: r.name, parent_code: r.parent,
      show_subtotal: r.vals.show_subtotal, collapsed_default: r.vals.collapsed_default,
      is_active: r.vals.is_active,
      sort_order: r.vals.sort_order ?? (r.status === 'new' ? (r.idx + 1) * 10 : null),
    };
  });
  return rows;
}

function validateAccounts(rawRows, db, groupLevels, currencyCodes, controlLookup) {
  const dbByCode = new Map(db.map((a) => [a.code, a]));
  const rows = [];
  const firstLine = new Map();

  rawRows.forEach((raw, i) => {
    const o = normRow(raw);
    const r = {
      idx: i, line: i + 2, code: get(o, 'code'), name: get(o, 'name'), parent: get(o, 'parentcode', 'parent'),
      group: get(o, 'groupcode', 'group'), errors: [], status: 'new', level: NaN, msg: '',
    };
    if (!r.code && !r.name && !r.parent && !r.group) return;

    if (!r.code) r.errors.push('Code is required');
    if (!r.name) r.errors.push('Name is required');
    if (r.code) {
      if (firstLine.has(r.code)) r.errors.push(`Duplicate code (first used on line ${firstLine.get(r.code)})`);
      else firstLine.set(r.code, r.line);
    }

    const t = get(o, 'type').toLowerCase();
    if (t === '') r.isPosting = !!r.group;
    else if (t === 'posting') r.isPosting = true;
    else if (t === 'header') r.isPosting = false;
    else { r.isPosting = !!r.group; r.errors.push('Type must be Posting or Header'); }
    r.type = r.isPosting ? 'Posting' : 'Header';

    const nb = get(o, 'normalbalance', 'normal').toLowerCase();
    if (nb && nb !== 'debit' && nb !== 'credit') r.errors.push('Normal balance must be Debit or Credit');

    const cRaw = get(o, 'controltype', 'control');
    let control = '';
    if (cRaw && cRaw.toLowerCase() !== 'none') {
      control = controlLookup.get(cRaw.toLowerCase());
      if (!control) { r.errors.push(`Unknown control type "${cRaw}"`); control = ''; }
    }

    const cur = get(o, 'currency').toUpperCase();
    if (cur && !currencyCodes.has(cur)) r.errors.push(`Currency ${cur} is not enabled for this company`);

    r.vals = {
      manual: parseBool(get(o, 'manualjournals', 'manual', 'allowmanualjournals')),
      active: parseBool(get(o, 'active')),
      sort: parseSort(get(o, 'sort', 'sortorder')),
    };
    if (r.vals.manual === undefined) r.errors.push('Manual journals must be Yes or No');
    if (r.vals.active === undefined) r.errors.push('Active must be Yes or No');
    if (r.vals.sort === undefined) r.errors.push('Sort must be a whole number');

    r.extra = { normal_balance: nb || 'debit', control_type: control, currency_code: cur, notes: get(o, 'notes') };
    rows.push(r);
  });

  const fileByCode = new Map();
  rows.forEach((r) => { if (r.code && !fileByCode.has(r.code)) fileByCode.set(r.code, r); });

  const levelOf = (code, stack) => {
    const f = fileByCode.get(code);
    if (f) {
      if (stack.has(code)) return NaN;
      stack.add(code);
      return f.parent ? levelOf(f.parent, stack) + 1 : 1;
    }
    const d = dbByCode.get(code);
    return d ? d.level : NaN;
  };

  rows.forEach((r) => {
    if (r.parent) {
      const inFile = fileByCode.get(r.parent);
      const inDb = dbByCode.get(r.parent);
      if (!inFile && !inDb) r.errors.push(`Parent account "${r.parent}" not found`);
      else {
        const parentIsPosting = inFile ? inFile.isPosting : inDb.is_posting;
        if (parentIsPosting) r.errors.push(`Parent "${r.parent}" is a posting account`);
      }
    }
    if (r.code) {
      const lvl = levelOf(r.code, new Set());
      if (Number.isNaN(lvl)) { if (r.parent) r.errors.push('Parent chain is invalid (loop or unknown ancestor)'); }
      else { r.level = lvl; if (lvl > 3) r.errors.push('Too deep: accounts nest at most 3 levels'); }
    }
    if (r.isPosting) {
      if (!r.group) r.errors.push('Group code is required for a posting account');
      else {
        const gl = groupLevels.get(r.group);
        if (gl === undefined || Number.isNaN(gl)) r.errors.push(`Group "${r.group}" not found`);
        else if (gl < 2) r.errors.push('Use a group below the class');
      }
    }
    if (r.code && dbByCode.has(r.code)) r.status = 'update';
    if (r.errors.length) { r.status = 'error'; r.msg = r.errors.join('; '); return; }
    r.payload = {
      code: r.code, name: r.name, parent_code: r.parent, is_posting: r.isPosting,
      group_code: r.isPosting ? r.group : '', ...r.extra,
      allow_manual_journal: r.vals.manual, is_active: r.vals.active,
      sort_order: r.vals.sort ?? (r.status === 'new' ? (r.idx + 1) * 10 : null),
    };
  });
  return rows;
}

/* ---------- template ---------- */

export async function downloadTemplate() {
  await exportSheets('chart-import-template.xlsx', [
    { name: 'Groups', plain: true, columns: [
      { key: 'code', header: 'Code', width: 14 }, { key: 'name', header: 'Name', width: 30 },
      { key: 'parent', header: 'Parent code', width: 14 }, { key: 'subtotal', header: 'Subtotal', width: 10 },
      { key: 'collapsed', header: 'Collapsed', width: 10 }, { key: 'active', header: 'Active', width: 8 },
      { key: 'sort', header: 'Sort', width: 8 } ],
      rows: [
        { code: 'REV', name: 'Revenue', parent: 'IS', subtotal: 'Yes', collapsed: 'No', active: 'Yes', sort: 10 },
        { code: 'SAL', name: 'Sales', parent: 'REV', subtotal: 'Yes', collapsed: 'No', active: 'Yes', sort: 10 },
        { code: 'COS', name: 'Cost of Sales', parent: 'IS', subtotal: 'Yes', collapsed: 'No', active: 'Yes', sort: 20 },
        { code: 'AST', name: 'Assets', parent: 'BS', subtotal: 'Yes', collapsed: 'No', active: 'Yes', sort: 10 },
        { code: 'CUR', name: 'Current Assets', parent: 'AST', subtotal: 'Yes', collapsed: 'No', active: 'Yes', sort: 10 },
      ] },
    { name: 'Accounts', plain: true, columns: [
      { key: 'code', header: 'Code', width: 14 }, { key: 'name', header: 'Name', width: 30 },
      { key: 'parent', header: 'Parent code', width: 14 }, { key: 'type', header: 'Type', width: 10 },
      { key: 'group', header: 'Group code', width: 14 }, { key: 'normal', header: 'Normal balance', width: 14 },
      { key: 'control', header: 'Control type', width: 18 }, { key: 'currency', header: 'Currency', width: 10 },
      { key: 'manual', header: 'Manual journals', width: 16 }, { key: 'active', header: 'Active', width: 8 },
      { key: 'sort', header: 'Sort', width: 8 }, { key: 'notes', header: 'Notes', width: 30 } ],
      rows: [
        { code: '1000', name: 'Assets', parent: '', type: 'Header', group: '', normal: '', control: '', currency: '', manual: 'Yes', active: 'Yes', sort: 10, notes: '' },
        { code: '1010', name: 'Bank', parent: '1000', type: 'Posting', group: 'CUR', normal: 'debit', control: 'bank', currency: '', manual: 'Yes', active: 'Yes', sort: 10, notes: '' },
        { code: '4000', name: 'Sales', parent: '', type: 'Posting', group: 'SAL', normal: 'credit', control: '', currency: '', manual: 'No', active: 'Yes', sort: 20, notes: '' },
      ] },
  ]);
}

/* ---------- dialog ---------- */

export function openImport({ ctx, tab, groups, accounts, currencies, controlTypes, onDone }) {
  const backdrop = h('div', 'modal-backdrop');
  const box = h('div', 'modal xwide');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.append(h('h3', 'modal-title', 'Import chart of accounts'));
  box.append(h('p', 'modal-message',
    'Upload an Excel file with Groups and Accounts sheets (same layout as the export), or a CSV for the current tab '
    + `(${tab === 'groups' ? 'Groups' : 'Accounts'}).\nRows are matched by Code: new codes are created and existing codes are updated. Nothing is deleted.`));

  const fileRow = h('div', 'file-row');
  const input = h('input');
  input.type = 'file';
  input.accept = '.xlsx,.xls,.csv';
  const tpl = h('button', 'btn btn-sm', 'Download template');
  tpl.type = 'button';
  tpl.addEventListener('click', () => downloadTemplate().catch((e) => ui.errorFrom(e, 'Could not create the template.')));
  fileRow.append(input, tpl);

  const result = h('div', 'import-block');
  const actions = h('div', 'modal-actions');
  const cancel = h('button', 'btn btn-ghost', 'Cancel');
  cancel.type = 'button';
  const go = h('button', 'btn btn-primary', 'Import');
  go.type = 'button';
  go.disabled = true;
  actions.append(cancel, go);
  box.append(fileRow, result, actions);
  backdrop.append(box);
  document.body.append(backdrop);

  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const close = () => { document.removeEventListener('keydown', onKey); backdrop.remove(); };
  document.addEventListener('keydown', onKey);
  cancel.addEventListener('click', close);

  let parsed = null;

  const lookup = new Map();
  controlTypes.forEach(([k, label]) => { if (k) { lookup.set(k.toLowerCase(), k); lookup.set(label.toLowerCase(), k); } });
  const currencyCodes = new Set(currencies.map((c) => c.code));

  function count(rows, s) { return rows.filter((r) => r.status === s).length; }
  function summary(rows) {
    return `${count(rows, 'new')} new, ${count(rows, 'update')} to update, ${count(rows, 'skip')} skipped, ${count(rows, 'error')} with errors`;
  }

  function previewTable(title, rows, withAccountCols) {
    if (!rows.length) return;
    result.append(h('h4', '', `${title}: ${summary(rows)}`));
    const errorsFirst = rows.filter((r) => r.status === 'error').concat(rows.filter((r) => r.status !== 'error'));
    const shown = errorsFirst.slice(0, SHOW_MAX);
    const wrap = h('div', 'preview-scroll');
    const table = h('table', 'grid');
    const head = h('tr');
    ['Line', 'Code', 'Name', 'Parent'].concat(withAccountCols ? ['Type', 'Group'] : [], ['Status', 'Message'])
      .forEach((t) => head.append(h('th', '', t)));
    const thead = h('thead');
    thead.append(head);
    const tbody = h('tbody');
    shown.forEach((r) => {
      const tr = h('tr');
      const cells = [r.line, r.code, r.name, r.parent].concat(withAccountCols ? [r.type || '', r.group || ''] : []);
      cells.forEach((c) => tr.append(h('td', '', String(c ?? ''))));
      const st = h('td');
      st.append(h('span', `badge st-${r.status}`, { new: 'New', update: 'Update', skip: 'Skipped', error: 'Error' }[r.status]));
      tr.append(st, h('td', '', r.msg || ''));
      tbody.append(tr);
    });
    table.append(thead, tbody);
    wrap.append(table);
    result.append(wrap);
    if (rows.length > shown.length) result.append(h('p', 'muted', `Showing the first ${shown.length} of ${rows.length} rows (errors first).`));
  }

  function renderPreview() {
    result.replaceChildren();
    const all = parsed.groups.concat(parsed.accounts);
    if (!all.length) { result.append(h('p', 'muted', 'No rows found in that file.')); return; }
    previewTable('Groups', parsed.groups, false);
    previewTable('Accounts', parsed.accounts, true);
    const errors = count(all, 'error');
    const todo = count(all, 'new') + count(all, 'update');
    if (errors) result.append(h('p', '', 'Fix the errors in your file and choose it again. Nothing has been imported.'));
    go.disabled = errors > 0 || todo === 0;
  }

  input.addEventListener('change', async () => {
    parsed = null;
    go.disabled = true;
    result.replaceChildren();
    const file = input.files[0];
    if (!file) return;
    try {
      const sheets = await readWorkbook(file);
      const names = Object.keys(sheets);
      const find = (n) => names.find((x) => x.trim().toLowerCase() === n);
      const gs = find('groups');
      const as = find('accounts');
      let gRaw = [];
      let aRaw = [];
      if (gs || as) { gRaw = gs ? sheets[gs] : []; aRaw = as ? sheets[as] : []; }
      else if (tab === 'groups') gRaw = sheets[names[0]] || [];
      else aRaw = sheets[names[0]] || [];
      if (gRaw.length > MAX_ROWS || aRaw.length > MAX_ROWS) {
        ui.warn(`That file has more than ${MAX_ROWS} rows per sheet. Split it into smaller files.`);
        return;
      }
      const g = validateGroups(gRaw, groups);
      const groupLevels = new Map(groups.map((x) => [x.code, x.level]));
      g.forEach((r) => { if (r.status === 'new' || r.status === 'update') groupLevels.set(r.code, r.level); });
      const a = validateAccounts(aRaw, accounts, groupLevels, currencyCodes, lookup);
      parsed = { groups: g, accounts: a };
      renderPreview();
    } catch (e) {
      ui.errorFrom(e, 'Could not read that file.');
    }
  });

  go.addEventListener('click', async () => {
    const byLevel = (x, y) => (x.level - y.level) || (x.idx - y.idx);
    const gRows = parsed.groups.filter((r) => r.payload).sort(byLevel);
    const aRows = parsed.accounts.filter((r) => r.payload).sort(byLevel);
    const ok = await ui.confirm({
      title: 'Import chart of accounts',
      message: `Import ${gRows.length} groups and ${aRows.length} accounts?\nRows with an existing code are updated. Nothing is deleted.`,
      confirmText: 'Import',
    });
    if (!ok) return;
    go.disabled = true;
    try {
      const { data, error } = await supabase.rpc('import_chart', {
        p_company: ctx.companyId,
        p_groups: gRows.map((r) => r.payload),
        p_accounts: aRows.map((r) => r.payload),
      });
      if (error) throw error;
      close();
      ui.success(`Import complete: ${data.groups_created} groups and ${data.accounts_created} accounts created, `
        + `${data.groups_updated + data.accounts_updated} updated.`);
      await onDone();
    } catch (e) {
      go.disabled = false;
      ui.errorFrom(e, 'Import failed. Nothing was changed.');
    }
  });
}