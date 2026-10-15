import { supabase } from './supabase.js';
import { parse, evaluate } from './formula.js';

const cmp = (a, b) => (a.sort_order - b.sort_order) || a.code.localeCompare(b.code, undefined, { numeric: true });

// Loads the account groups, posting accounts and report layouts of one statement type for a company
export async function loadLayout(companyId, statementType) {
  const [g, a, f] = await Promise.all([
    supabase.from('account_groups').select('id, parent_id, code, name, level, show_subtotal, collapsed_default, sort_order').eq('company_id', companyId),
    supabase.from('gl_accounts').select('id, code, name, group_id, normal_balance, control_type, sort_order').eq('company_id', companyId).eq('is_posting', true),
    supabase.from('report_formats').select('id, code, name, is_default').eq('company_id', companyId).eq('statement_type', statementType).order('code'),
  ]);
  for (const r of [g, a, f]) if (r.error) throw r.error;
  const groups = g.data;
  const groupById = new Map(groups.map((x) => [x.id, x]));
  const childMap = new Map();
  groups.forEach((x) => { if (x.parent_id) { if (!childMap.has(x.parent_id)) childMap.set(x.parent_id, []); childMap.get(x.parent_id).push(x); } });
  childMap.forEach((l) => l.sort(cmp));
  const accByGroup = new Map();
  a.data.forEach((x) => { if (x.group_id) { if (!accByGroup.has(x.group_id)) accByGroup.set(x.group_id, []); accByGroup.get(x.group_id).push(x); } });
  accByGroup.forEach((l) => l.sort(cmp));
  const def = f.data.find((x) => x.is_default) || f.data[0];
  return { groups, accounts: a.data, formats: f.data, groupById, childMap, accByGroup, defaultFormatId: def ? def.id : '' };
}

export async function loadLayoutLines(formatId) {
  if (!formatId) return [];
  const { data, error } = await supabase.from('report_lines').select('*').eq('format_id', formatId).order('sort_order');
  if (error) throw error;
  return data;
}

// Builds the report rows for one or more sets of balances.
// opts: balOf(account, setIndex) -> debit minus credit; showAll, hideZero, forceOpen, collapsed (Map of key -> boolean)
export function buildLayoutRows(L, lines, setCount, opts) {
  const { balOf, showAll = false, hideZero = true, forceOpen = false, collapsed: collapsedState = new Map() } = opts;
  const idx = Array.from({ length: setCount }, (_, i) => i);
  const memo = idx.map(() => new Map());
  const totalOf = (gid, i) => {
    if (memo[i].has(gid)) return memo[i].get(gid);
    let t = (L.accByGroup.get(gid) || []).reduce((s, a) => s + balOf(a, i), 0);
    (L.childMap.get(gid) || []).forEach((c) => { t += totalOf(c.id, i); });
    memo[i].set(gid, t);
    return t;
  };
  const isZero = (a) => idx.every((i) => Math.abs(balOf(a, i)) < 0.005);
  const rows = [];
  const values = idx.map(() => ({}));

  function addNode(line, g, depth, levelsLeft, top) {
    const key = `${line.id}:${g.id}`;
    const kids = levelsLeft > 0 ? (L.childMap.get(g.id) || []) : [];
    const accs = (line.show_accounts || showAll) ? (L.accByGroup.get(g.id) || []).filter((a) => !hideZero || !isZero(a)) : [];
    const hasDetail = kids.length > 0 || accs.length > 0;
    const label = top ? line.label : g.name;
    const amts = idx.map((i) => totalOf(g.id, i) * line.sign);
    const defCollapsed = top ? line.start_collapsed : g.collapsed_default;
    const isCollapsed = hasDetail && !forceOpen && (collapsedState.has(key) ? collapsedState.get(key) : defCollapsed);
    const style = top ? line.style : 'normal';
    if (!hasDetail || isCollapsed) {
      rows.push({ kind: 'group', depth, label, amts, style, key: hasDetail ? key : null, collapsed: isCollapsed });
      return;
    }
    const showTotal = top || g.show_subtotal;
    rows.push({ kind: 'header', depth, label, amts: showTotal ? null : amts, key, collapsed: false, style: 'normal' });
    kids.forEach((k) => addNode(line, k, depth + 1, levelsLeft - 1, false));
    accs.forEach((a) => rows.push({
      kind: 'account', depth: depth + 1, label: `${a.code}  ${a.name}`, amts: idx.map((i) => balOf(a, i) * line.sign), acc: a,
    }));
    if (showTotal) rows.push({ kind: 'total', depth, label: `Total ${label}`, amts, style });
  }

  lines.forEach((l) => {
    if (l.line_type === 'heading') { rows.push({ kind: 'heading', label: l.label }); return; }
    if (l.line_type === 'spacer') { rows.push({ kind: 'spacer' }); return; }
    if (l.line_type === 'group') {
      const g = L.groupById.get(l.group_id);
      if (!g) { rows.push({ kind: 'error', label: l.label, msg: 'Group not found' }); return; }
      if (l.code) idx.forEach((i) => { values[i][l.code.toUpperCase()] = totalOf(g.id, i) * l.sign; });
      addNode(l, g, 0, showAll ? 4 : l.detail_levels, true);
      return;
    }
    let amts = [];
    let msg = '';
    try { const ast = parse(l.formula); amts = idx.map((i) => evaluate(ast, values[i])); } catch (e) { msg = e.message; }
    if (!msg && l.code) idx.forEach((i) => { values[i][l.code.toUpperCase()] = amts[i]; });
    rows.push(msg ? { kind: 'error', label: l.label, msg } : { kind: 'formula', depth: 0, label: l.label, amts, style: l.style });
  });
  return rows;
}