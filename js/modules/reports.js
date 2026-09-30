import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { parse, refsOf, evaluate } from '../core/formula.js';

const ctx = await startPage();

const TYPE_LABEL = { group: 'Group total', formula: 'Formula', heading: 'Heading', spacer: 'Spacer' };
const STATEMENT_LABEL = { income_statement: 'Income statement', balance_sheet: 'Balance sheet', other: 'Other' };

const formatBar = document.getElementById('format-bar');
const hint = document.getElementById('hint');
const lineToolbar = document.getElementById('line-toolbar');
const linesEl = document.getElementById('lines');
const previewToolbar = document.getElementById('preview-toolbar');
const previewEl = document.getElementById('preview');

let formats = [];
let lines = [];
let groups = [];
let accounts = [];           // posting accounts only
let baseCode = '';
let formatId = null;
let useSample = true;
const collapsedState = new Map();

let groupById = new Map();
let childMap = new Map();
let accByGroup = new Map();

/* ---------- helpers ---------- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cmpG = (a, b) => (a.sort_order - b.sort_order) || a.code.localeCompare(b.code, undefined, { numeric: true });
const fmt = (n) => (n + 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function btn(label, cls, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `btn ${cls}`.trim();
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function groupPath(id) {
  const parts = [];
  let cur = groupById.get(id);
  let n = 0;
  while (cur && n++ < 10) { parts.unshift(cur.name); cur = groupById.get(cur.parent_id); }
  return parts.join(' › ');
}

function hash(s) {
  let x = 0;
  for (const c of String(s)) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return x;
}

function safeRefs(formula) {
  try { return refsOf(parse(formula)); } catch (e) { return new Set(); }
}

function makeCode(base, used) {
  let c = String(base).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[A-Z]/.test(c)) c = 'L' + c;
  let out = c;
  let n = 2;
  while (used.has(out)) out = `${c}_${n++}`;
  used.add(out);
  return out;
}

/* ---------- data ---------- */

async function loadBase() {
  const cid = ctx.companyId;
  const [f, g, a, c] = await Promise.all([
    supabase.from('report_formats').select('*').eq('company_id', cid).order('statement_type').order('name'),
    supabase.from('account_groups').select('*').eq('company_id', cid).order('sort_order').order('code'),
    supabase.from('gl_accounts').select('id, code, name, group_id, normal_balance').eq('company_id', cid).eq('is_posting', true).order('code'),
    supabase.from('company_currencies').select('code').eq('company_id', cid).eq('is_base', true).maybeSingle(),
  ]);
  for (const r of [f, g, a, c]) if (r.error) throw r.error;
  formats = f.data;
  groups = g.data;
  accounts = a.data;
  baseCode = c.data ? c.data.code : '';
  if (!formats.some((x) => x.id === formatId)) {
    const def = formats.find((x) => x.is_default) || formats[0];
    formatId = def ? def.id : null;
  }
}

function prepare() {
  groupById = new Map(groups.map((g) => [g.id, g]));
  childMap = new Map();
  groups.forEach((g) => {
    if (!g.parent_id) return;
    if (!childMap.has(g.parent_id)) childMap.set(g.parent_id, []);
    childMap.get(g.parent_id).push(g);
  });
  childMap.forEach((list) => list.sort(cmpG));
  accByGroup = new Map();
  accounts.forEach((a) => {
    if (!a.group_id) return;
    if (!accByGroup.has(a.group_id)) accByGroup.set(a.group_id, []);
    accByGroup.get(a.group_id).push(a);
  });
}

async function loadLines() {
  lines = [];
  if (!formatId) return;
  const { data, error } = await supabase.from('report_lines').select('*').eq('format_id', formatId)
    .order('sort_order').order('created_at');
  if (error) throw error;
  lines = data;
}

async function refreshAll() {
  try { await loadBase(); prepare(); await loadLines(); }
  catch (e) { ui.errorFrom(e, 'Could not load report layouts.'); }
  renderAll();
}

async function refreshLines() {
  try { await loadLines(); } catch (e) { ui.errorFrom(e, 'Could not load the layout lines.'); }
  renderAll();
}

async function renumber(list) {
  const changed = [];
  list.forEach((l, i) => {
    const so = (i + 1) * 1000;
    if (l.sort_order !== so) { changed.push({ id: l.id, so }); l.sort_order = so; }
  });
  const res = await Promise.all(changed.map((c) => supabase.from('report_lines').update({ sort_order: c.so }).eq('id', c.id)));
  const bad = res.find((r) => r.error);
  if (bad) throw bad.error;
}

async function sortForInsert(afterId) {
  if (!afterId) return (lines.length ? Math.max(...lines.map((l) => l.sort_order)) : 0) + 1000;
  const i = lines.findIndex((l) => l.id === afterId);
  const a = lines[i].sort_order;
  const b = lines[i + 1] ? lines[i + 1].sort_order : a + 2000;
  if (b - a >= 2) return Math.floor((a + b) / 2);
  await renumber(lines);
  return sortForInsert(afterId);
}

/* ---------- validation ---------- */

function validateLayout(list) {
  const errs = new Map();
  const seen = new Set();
  list.forEach((l) => {
    try {
      if (l.line_type === 'group' && !groupById.has(l.group_id)) throw new Error('Group not found');
      if (l.line_type === 'formula') {
        refsOf(parse(l.formula)).forEach((r) => {
          if (!seen.has(r)) throw new Error(`"${r}" is not a line above this one`);
        });
      }
    } catch (e) { errs.set(l.id, e.message); }
    if (l.code && (l.line_type === 'group' || l.line_type === 'formula')) seen.add(l.code.toUpperCase());
  });
  return errs;
}

/* ---------- render ---------- */

function renderAll() {
  renderFormatBar();
  renderLines();
  renderPreviewToolbar();
  renderPreview();
}

function renderFormatBar() {
  formatBar.replaceChildren();
  if (formats.length) {
    const sel = document.createElement('select');
    sel.className = 'compact';
    formats.forEach((f) => {
      const o = new Option(`${f.name}${f.is_default ? ' (default)' : ''}`, f.id);
      if (f.id === formatId) o.selected = true;
      sel.append(o);
    });
    sel.addEventListener('change', async () => { formatId = sel.value; await refreshLines(); });
    formatBar.append(sel);
  }
  if (ctx.canEdit) {
    formatBar.append(btn('New layout', 'btn-primary', () => openFormatForm(null)));
    if (formatId) {
      formatBar.append(
        btn('Edit layout', '', () => openFormatForm(formats.find((f) => f.id === formatId))),
        btn('Delete layout', '', deleteFormat),
      );
    }
    formatBar.append(btn('Create starter layouts', '', createStarter));
  }
  hint.textContent = 'A layout is an ordered list of lines. Group lines pull in a group total from the chart. '
    + 'Formula lines calculate from lines above them using their codes, for example GP = REV - COS.';
}

function detailText(l) {
  if (l.line_type === 'group') return groupById.has(l.group_id) ? groupPath(l.group_id) : '(group missing)';
  if (l.line_type === 'formula') return l.formula || '';
  return '';
}

function renderLines() {
  lineToolbar.replaceChildren();
  if (!formatId) {
    linesEl.innerHTML = '<p class="muted">No layouts yet. Create your groups in the chart first, then use "Create starter layouts", or add a layout yourself.</p>';
    return;
  }
  if (ctx.canEdit) lineToolbar.append(btn('Add line', 'btn-primary', () => openLineForm(null, null)));
  if (!lines.length) { linesEl.innerHTML = '<p class="muted">This layout has no lines yet.</p>'; return; }

  const errs = validateLayout(lines);
  const body = lines.map((l, i) => {
    const shows = l.line_type === 'group' ? (l.sign === -1 ? 'Credits +' : 'Debits +') : '';
    const actions = ctx.canEdit ? `<div class="row-actions">
        <button class="btn btn-sm" data-act="edit">Edit</button>
        <button class="btn btn-sm" data-act="after" title="Insert a line below">+</button>
        <button class="btn btn-sm" data-act="up" title="Move up">↑</button>
        <button class="btn btn-sm" data-act="down" title="Move down">↓</button>
        <button class="btn btn-sm" data-act="del">Delete</button></div>` : '';
    return `<tr data-id="${l.id}">
      <td class="num">${i + 1}</td>
      <td>${esc(l.code || '')}</td>
      <td>${TYPE_LABEL[l.line_type]}</td>
      <td>${esc(l.label)}</td>
      <td>${esc(detailText(l))}${errs.has(l.id) ? `<div class="err-note">${esc(errs.get(l.id))}</div>` : ''}</td>
      <td>${shows}</td>
      <td>${actions}</td></tr>`;
  }).join('');
  const heads = ['#', 'Code', 'Type', 'Label', 'Detail', 'Shows', ''];
  linesEl.innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr>${heads.map((x) => `<th>${x}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderPreviewToolbar() {
  previewToolbar.replaceChildren();
  const label = document.createElement('label');
  label.style.cssText = 'display:flex;align-items:center;gap:.4rem;cursor:pointer';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = useSample;
  cb.style.width = 'auto';
  cb.addEventListener('change', () => { useSample = cb.checked; renderPreview(); });
  label.append(cb, document.createTextNode('Use sample amounts'));
  previewToolbar.append(label, btn('Expand all', '', () => setAllPreview(false)), btn('Collapse all', '', () => setAllPreview(true)));
}

/* ---------- preview engine ---------- */

function buildRows() {
  const totals = new Map();
  const balance = (a) => {
    if (!useSample) return 0;
    const amt = (100 + (hash(a.code) % 900)) * 100;
    return a.normal_balance === 'credit' ? -amt : amt;   // ledger convention: debits positive
  };
  const totalOf = (gid) => {
    if (totals.has(gid)) return totals.get(gid);
    let t = (accByGroup.get(gid) || []).reduce((s, a) => s + balance(a), 0);
    (childMap.get(gid) || []).forEach((c) => { t += totalOf(c.id); });
    totals.set(gid, t);
    return t;
  };

  const rows = [];
  const values = {};

  function addNode(line, g, depth, levelsLeft, top) {
    const key = `${line.id}:${g.id}`;
    const kids = levelsLeft > 0 ? (childMap.get(g.id) || []) : [];
    const accs = line.show_accounts ? (accByGroup.get(g.id) || []) : [];
    const hasDetail = kids.length > 0 || accs.length > 0;
    const label = top ? line.label : g.name;
    const amount = totalOf(g.id) * line.sign;
    const defCollapsed = top ? line.start_collapsed : g.collapsed_default;
    const collapsed = hasDetail && (collapsedState.has(key) ? collapsedState.get(key) : defCollapsed);
    const style = top ? line.style : 'normal';

    if (!hasDetail || collapsed) {
      rows.push({ kind: 'group', depth, label, amount, style, key: hasDetail ? key : null, collapsed });
      return;
    }
    const showTotal = top || g.show_subtotal;
    rows.push({ kind: 'header', depth, label, amount: showTotal ? null : amount, key, collapsed: false, style: 'normal' });
    kids.forEach((k) => addNode(line, k, depth + 1, levelsLeft - 1, false));
    accs.forEach((a) => rows.push({ kind: 'account', depth: depth + 1, label: `${a.code}  ${a.name}`, amount: balance(a) * line.sign }));
    if (showTotal) rows.push({ kind: 'total', depth, label: `Total ${label}`, amount, style });
  }

  lines.forEach((l) => {
    if (l.line_type === 'heading') { rows.push({ kind: 'heading', label: l.label }); return; }
    if (l.line_type === 'spacer') { rows.push({ kind: 'spacer' }); return; }
    if (l.line_type === 'group') {
      const g = groupById.get(l.group_id);
      if (!g) { rows.push({ kind: 'error', label: l.label, msg: 'Group not found' }); return; }
      if (l.code) values[l.code.toUpperCase()] = totalOf(g.id) * l.sign;
      addNode(l, g, 0, l.detail_levels, true);
      return;
    }
    let amount = 0;
    let msg = '';
    try { amount = evaluate(parse(l.formula), values); } catch (e) { msg = e.message; }
    if (l.code) values[l.code.toUpperCase()] = amount;
    rows.push(msg ? { kind: 'error', label: l.label, msg } : { kind: 'formula', depth: 0, label: l.label, amount, style: l.style });
  });
  return rows;
}

function renderPreview() {
  if (!formatId) { previewEl.innerHTML = ''; return; }
  const rows = buildRows();
  const note = useSample
    ? 'Sample amounts are made-up numbers so you can test the layout. Real balances appear here once transactions are posted.'
    : 'No transactions are posted yet, so every amount is zero.';
  const body = rows.map((r) => {
    if (r.kind === 'spacer') return '<tr class="k-spacer"><td colspan="2"></td></tr>';
    if (r.kind === 'error') return `<tr class="k-error"><td colspan="2">${esc(r.label)}: ${esc(r.msg)}</td></tr>`;
    if (r.kind === 'heading') return `<tr class="k-heading"><td colspan="2">${esc(r.label)}</td></tr>`;
    const pad = 0.7 + (r.depth || 0) * 1.3;
    const caret = r.key
      ? `<span class="tree-caret">${r.collapsed ? '▸' : '▾'}</span>`
      : '<span class="tree-caret leaf">▾</span>';
    const cls = [`k-${r.kind}`, r.style ? `st-${r.style}` : '', r.key ? 'clickable' : ''].join(' ').trim();
    const attrs = r.key ? ` data-key="${esc(r.key)}" data-collapsed="${r.collapsed}"` : '';
    const amt = r.amount === null || r.amount === undefined ? '' : fmt(r.amount);
    return `<tr class="${cls}"${attrs}><td style="padding-left:${pad}rem">${caret}${esc(r.label)}</td><td class="amt">${amt}</td></tr>`;
  }).join('');
  previewEl.innerHTML = `<p class="muted">Amounts in ${esc(baseCode || 'base currency')}. ${note}</p>
    <div class="table-wrap"><table class="report"><tbody>${body}</tbody></table></div>`;
}

function walkKeys(line, g, levelsLeft, out) {
  const kids = levelsLeft > 0 ? (childMap.get(g.id) || []) : [];
  const accs = line.show_accounts ? (accByGroup.get(g.id) || []) : [];
  if (kids.length || accs.length) out.push(`${line.id}:${g.id}`);
  kids.forEach((k) => walkKeys(line, k, levelsLeft - 1, out));
}

function setAllPreview(collapse) {
  const keys = [];
  lines.filter((l) => l.line_type === 'group').forEach((l) => {
    const g = groupById.get(l.group_id);
    if (g) walkKeys(l, g, l.detail_levels, keys);
  });
  keys.forEach((k) => collapsedState.set(k, collapse));
  renderPreview();
}

/* ---------- line actions ---------- */

async function onLinesClick(e) {
  const t = e.target.closest('[data-act]');
  if (!t || !ctx.canEdit) return;
  const id = t.closest('tr').dataset.id;
  const row = lines.find((l) => l.id === id);
  if (!row) return;
  const act = t.dataset.act;
  if (act === 'edit') return openLineForm(row, null);
  if (act === 'after') return openLineForm(null, id);
  if (act === 'up' || act === 'down') return moveLine(id, act === 'up' ? -1 : 1);
  if (act === 'del') return deleteLine(row);
}

async function moveLine(id, dir) {
  const i = lines.findIndex((l) => l.id === id);
  const j = i + dir;
  if (j < 0 || j >= lines.length) return;
  const next = lines.slice();
  [next[i], next[j]] = [next[j], next[i]];
  const before = validateLayout(lines);
  for (const k of validateLayout(next).keys()) {
    if (!before.has(k)) return ui.warn('That move would put a formula above a line it depends on.');
  }
  try { await renumber(next); lines = next; }
  catch (e) { ui.errorFrom(e); await refreshLines(); return; }
  renderAll();
}

async function deleteLine(row) {
  if (row.code) {
    const users = lines.filter((l) => l.id !== row.id && l.line_type === 'formula' && safeRefs(l.formula).has(row.code.toUpperCase()));
    if (users.length) {
      return ui.warn(`${row.code} is used by the formula in ${users.map((u) => u.code || u.label).join(', ')}. Change that formula first.`);
    }
  }
  if (!(await ui.confirmDelete('Line'))) return;
  const { error } = await supabase.from('report_lines').delete().eq('id', row.id);
  if (error) return ui.errorFrom(error);
  ui.deleted('Line');
  await refreshLines();
}

async function openLineForm(row, insertAfterId) {
  const isEdit = !!row;
  let idx;
  if (isEdit) idx = lines.findIndex((l) => l.id === row.id);
  else if (insertAfterId) idx = lines.findIndex((l) => l.id === insertAfterId) + 1;
  else idx = lines.length;
  const above = new Set(lines.slice(0, idx)
    .filter((l) => l.code && (l.line_type === 'group' || l.line_type === 'formula'))
    .map((l) => l.code.toUpperCase()));

  const groupOptions = [{ value: '', label: 'Select a group' }].concat(
    groups.map((g) => ({ value: g.id, label: groupPath(g.id) })).sort((a, b) => a.label.localeCompare(b.label)));

  const saved = await ui.form({
    title: isEdit ? 'Edit line' : 'Add line',
    fields: [
      { name: 'line_type', label: 'Line type', type: 'select', required: true, full: true, options: [
        { value: 'group', label: 'Group total (pulls in a group from the chart)' },
        { value: 'formula', label: 'Formula (calculated from lines above)' },
        { value: 'heading', label: 'Heading (text only)' },
        { value: 'spacer', label: 'Spacer (blank row)' } ] },
      { name: 'code', label: 'Code', hint: 'Needed for group and formula lines, e.g. REV or GP.' },
      { name: 'label', label: 'Label' },
      { name: 'group_id', label: 'Group (group lines)', type: 'select', options: groupOptions, full: true },
      { name: 'formula', label: 'Formula (formula lines)', full: true, placeholder: 'REV - COS',
        hint: 'Use the codes of lines above, with + - * / and brackets.' },
      { name: 'sign', label: 'Show balances as (group lines)', type: 'select', full: true, options: [
        { value: '1', label: 'Debit balances positive (assets, expenses, cost of sales)' },
        { value: '-1', label: 'Credit balances positive (income, liabilities, equity)' } ] },
      { name: 'detail_levels', label: 'Sub group levels to show', type: 'number', hint: '0 shows the total only.' },
      { name: 'style', label: 'Style', type: 'select', options: [
        { value: 'normal', label: 'Normal' }, { value: 'subtotal', label: 'Subtotal' }, { value: 'total', label: 'Total' } ] },
      { name: 'show_accounts', label: 'List accounts under groups', type: 'checkbox' },
      { name: 'start_collapsed', label: 'Start collapsed', type: 'checkbox' },
    ],
    values: row ? { ...row, code: row.code || '', formula: row.formula || '', group_id: row.group_id || '', sign: String(row.sign) }
      : { line_type: 'group', sign: '1', detail_levels: 1, style: 'normal' },
    onSubmit: async (v) => {
      const type = v.line_type;
      let code = v.code.toUpperCase();
      if (type === 'heading' || type === 'spacer') code = '';
      if ((type === 'group' || type === 'formula') && !code) throw new Error('Code is required for group and formula lines.');
      if (code && !/^[A-Z][A-Z0-9_]*$/.test(code)) throw new Error('Code must start with a letter and use only letters, numbers and underscores.');
      if (code && lines.some((l) => (!row || l.id !== row.id) && (l.code || '').toUpperCase() === code)) throw new Error('That code is already used in this layout.');
      if (type !== 'spacer' && !v.label) throw new Error('Label is required.');
      if (type === 'group' && !v.group_id) throw new Error('Choose a group for a group line.');
      if (type === 'formula') {
        if (!v.formula) throw new Error('Enter a formula.');
        refsOf(parse(v.formula)).forEach((r) => {
          if (!above.has(r)) throw new Error(`"${r}" is not the code of a line above this one.`);
        });
      }
      if (isEdit && row.code && row.code.toUpperCase() !== code) {
        const users = lines.filter((l) => l.id !== row.id && l.line_type === 'formula' && safeRefs(l.formula).has(row.code.toUpperCase()));
        if (users.length) throw new Error(`${row.code} is used by another formula. Change that formula first.`);
      }
      const payload = {
        line_type: type, code: code || null, label: type === 'spacer' ? '' : v.label,
        group_id: type === 'group' ? v.group_id : null, formula: type === 'formula' ? v.formula : null,
        sign: Number(v.sign) === -1 ? -1 : 1,
        detail_levels: Math.min(4, Math.max(0, v.detail_levels ?? 1)),
        show_accounts: v.show_accounts, start_collapsed: v.start_collapsed, style: v.style,
      };
      const q = isEdit
        ? supabase.from('report_lines').update(payload).eq('id', row.id)
        : supabase.from('report_lines').insert({
          ...payload, company_id: ctx.companyId, format_id: formatId, sort_order: await sortForInsert(insertAfterId),
        });
      const { error } = await q;
      if (error) throw error;
    },
  });
  if (saved) {
    if (isEdit) ui.updated('Line'); else ui.created('Line');
    await refreshLines();
  }
}

/* ---------- layout actions ---------- */

async function openFormatForm(row) {
  const isEdit = !!row;
  let newId = row ? row.id : null;
  const saved = await ui.form({
    title: isEdit ? 'Edit layout' : 'New layout',
    fields: [
      { name: 'code', label: 'Code', required: true },
      { name: 'name', label: 'Name', required: true },
      { name: 'statement_type', label: 'Type', type: 'select', required: true, full: true,
        options: Object.entries(STATEMENT_LABEL).map(([value, label]) => ({ value, label })) },
      { name: 'is_default', label: 'Default layout for this type', type: 'checkbox', full: true },
      { name: 'notes', label: 'Notes', type: 'textarea', full: true },
    ],
    values: row || { statement_type: 'income_statement', is_default: false },
    onSubmit: async (v) => {
      const payload = {
        code: v.code.toUpperCase(), name: v.name, statement_type: v.statement_type,
        is_default: v.is_default, notes: v.notes || null,
      };
      const res = isEdit
        ? await supabase.from('report_formats').update(payload).eq('id', row.id).select('id').single()
        : await supabase.from('report_formats').insert({ ...payload, company_id: ctx.companyId }).select('id').single();
      if (res.error) throw res.error;
      newId = res.data.id;
    },
  });
  if (saved) {
    formatId = newId;
    if (isEdit) ui.updated('Layout'); else ui.created('Layout');
    await refreshAll();
  }
}

async function deleteFormat() {
  if (!(await ui.confirmDelete('Layout'))) return;
  const { error } = await supabase.from('report_formats').delete().eq('id', formatId);
  if (error) return ui.errorFrom(error);
  ui.deleted('Layout');
  formatId = null;
  await refreshAll();
}

function autoSign(g) {
  const ids = new Set([g.id]);
  const walk = (id) => (childMap.get(id) || []).forEach((c) => { ids.add(c.id); walk(c.id); });
  walk(g.id);
  const accs = accounts.filter((a) => ids.has(a.group_id));
  if (accs.length) return accs.filter((a) => a.normal_balance === 'credit').length > accs.length / 2 ? -1 : 1;
  return /income|revenue|sales|liabilit|equity|capital|reserve/i.test(g.name) ? -1 : 1;
}

async function createStarter() {
  const specs = [
    { type: 'income_statement', code: 'INCOME_STATEMENT', name: 'Income Statement' },
    { type: 'balance_sheet', code: 'BALANCE_SHEET', name: 'Balance Sheet' },
  ];
  let made = 0;
  try {
    for (const s of specs) {
      if (formats.some((f) => f.code === s.code)) continue;
      const root = groups.find((g) => !g.parent_id && g.class_type === s.type);
      const top = groups.filter((g) => root && g.parent_id === root.id && g.is_active).sort(cmpG);
      if (!top.length) continue;

      const hasDefault = formats.some((f) => f.statement_type === s.type && f.is_default);
      const { data: fmtRow, error } = await supabase.from('report_formats').insert({
        company_id: ctx.companyId, code: s.code, name: s.name, statement_type: s.type, is_default: !hasDefault,
      }).select('id').single();
      if (error) throw error;

      const used = new Set();
      const rows = top.map((g) => ({
        company_id: ctx.companyId, format_id: fmtRow.id, code: makeCode(g.code, used), label: g.name,
        line_type: 'group', group_id: g.id, sign: autoSign(g), detail_levels: 1, style: 'normal',
      }));
      if (s.type === 'income_statement') {
        const plus = rows.filter((r) => r.sign === -1).map((r) => r.code);
        const minus = rows.filter((r) => r.sign === 1).map((r) => r.code);
        let f = plus.join(' + ');
        minus.forEach((c) => { f += f ? ` - ${c}` : `-${c}`; });
        rows.push({
          company_id: ctx.companyId, format_id: fmtRow.id, code: makeCode('NP', used), label: 'Net Profit / (Loss)',
          line_type: 'formula', formula: f, sign: 1, detail_levels: 0, style: 'total',
        });
      }
      rows.forEach((r, i) => { r.sort_order = (i + 1) * 1000; });
      const ins = await supabase.from('report_lines').insert(rows);
      if (ins.error) throw ins.error;
      if (!formatId) formatId = fmtRow.id;
      made++;
    }
  } catch (e) { ui.errorFrom(e, 'Could not create the starter layouts.'); }

  if (!made) {
    ui.warn('Nothing to create. Add groups under the Income Statement and Balance Sheet first, or the starter layouts already exist.');
  } else {
    ui.created(made === 1 ? 'Starter layout' : 'Starter layouts');
  }
  await refreshAll();
}

/* ---------- start ---------- */

async function main() {
  document.getElementById('company-title').textContent = ctx.company.name;
  linesEl.addEventListener('click', onLinesClick);
  previewEl.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-key]');
    if (!tr) return;
    collapsedState.set(tr.dataset.key, tr.dataset.collapsed !== 'true');
    renderPreview();
  });
  await refreshAll();
}

if (ctx) main();