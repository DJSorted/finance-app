import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { exportSheets } from '../core/export.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const panel = document.getElementById('panel');

const PAGE = 1000;
const TYPE_LABEL = { stock: 'Stock', service: 'Service', manufactured: 'Manufactured' };
const METHODS = {
  cost_markup: { label: 'Cost plus markup', valueLabel: 'Markup on cost (%)' },
  target_margin: { label: 'Target margin', valueLabel: 'Margin on the selling price (%)' },
  percent_increase: { label: 'Increase or decrease by a percentage', valueLabel: 'Percentage (negative to reduce)' },
  fixed_increase: { label: 'Add or subtract an amount', valueLabel: 'Amount (negative to subtract)' },
  set_price: { label: 'Set one price', valueLabel: 'New price' },
};
const STEPS = [['0', 'No rounding'], ['0.05', '0.05'], ['0.1', '0.10'], ['0.5', '0.50'], ['1', '1.00'], ['5', '5.00'], ['10', '10.00']];
const MODES = [['nearest', 'Nearest'], ['up', 'Up'], ['down', 'Down']];

let items = [];
let categories = [];
let rules = [];
let history = [];
let base = '';
const selected = new Set();
let preview = null;
let lastParams = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (o, n) => (o && Number(o) > 0 ? `${n >= o ? '+' : ''}${(((n - o) / o) * 100).toFixed(1)}%` : '');

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
function field(text, input) { const w = el('div', 'field'); w.append(el('label', '', text), input); return w; }

const catSel = el('select'); catSel.style.maxWidth = '220px';
const typeSel = el('select'); typeSel.style.width = 'auto';
const searchEl = el('input'); searchEl.placeholder = 'Search code or name'; searchEl.style.maxWidth = '220px';
const activeChk = el('input'); activeChk.type = 'checkbox'; activeChk.checked = true; activeChk.style.width = 'auto';
const methodSel = el('select');
const valueEl = el('input'); valueEl.type = 'number'; valueEl.step = 'any';
const roundSel = el('select');
const modeSel = el('select');
const ruleSel = el('select');
const noteEl = el('input'); noteEl.placeholder = 'Optional, kept in the history';
const countEl = el('span', 'muted');
const listEl = el('div');
const histEl = el('div');
const valueField = field('Value', valueEl);
const applyBtn = btn('Apply to previewed items', 'btn-primary', applyUpdate);
const delRuleBtn = btn('Delete rule', '', deleteRule);

async function loadItems() {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('items')
      .select('id, code, name, category_id, item_type, sales_price, sales_price_currency, is_active')
      .eq('company_id', ctx.companyId).order('code').range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

async function rpcAll(fn, params) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.rpc(fn, params).range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

async function loadAll() {
  const cid = ctx.companyId;
  const [it, c, cur, r, h] = await Promise.all([
    loadItems(),
    supabase.from('item_categories').select('id, code, name').eq('company_id', cid).order('code'),
    supabase.from('company_currencies').select('code').eq('company_id', cid).eq('is_base', true).maybeSingle(),
    supabase.from('price_rules').select('*').eq('company_id', cid).order('name'),
    supabase.from('price_history')
      .select('changed_at, old_price, new_price, currency, cost_used, rule_method, rule_value, rounding, rounding_mode, note, items(code, name)')
      .eq('company_id', cid).order('changed_at', { ascending: false }).limit(300),
  ]);
  for (const x of [c, cur, r, h]) if (x.error) throw x.error;
  items = it;
  categories = c.data;
  base = cur.data ? cur.data.code : '';
  rules = r.data;
  history = h.data;
}

function fillRules() {
  const keep = ruleSel.value;
  ruleSel.replaceChildren();
  option(ruleSel, '', 'None');
  rules.forEach((r) => option(ruleSel, r.id, r.name));
  ruleSel.value = rules.some((r) => r.id === keep) ? keep : '';
  delRuleBtn.style.display = ctx.canEdit && ruleSel.value ? '' : 'none';
}

function stale() {
  if (preview) { preview = null; renderList(); }
}

function visible() {
  const q = searchEl.value.trim().toLowerCase();
  return items.filter((i) => (!catSel.value || i.category_id === catSel.value)
    && (!typeSel.value || i.item_type === typeSel.value)
    && (!activeChk.checked || i.is_active)
    && (!q || i.code.toLowerCase().includes(q) || i.name.toLowerCase().includes(q)));
}

function updateCount(shown) {
  countEl.textContent = `${selected.size} selected${shown !== undefined ? ` of ${shown} shown` : ''}`;
}

function renderList() {
  const rows = visible();
  const pm = new Map((preview || []).map((r) => [r.r_item_id, r]));
  const catName = (id) => { const c = categories.find((x) => x.id === id); return c ? c.code : ''; };
  const body = rows.map((i) => {
    const cur = i.sales_price_currency || base;
    const p = pm.get(i.id);
    let extra = '';
    if (preview) {
      if (p) {
        extra = `<td class="num">${p.r_cost === null ? '' : money(p.r_cost)}</td>
          <td class="num"><strong>${p.r_new === null ? '' : money(p.r_new)}</strong></td>
          <td class="num">${p.r_new === null ? '' : pct(Number(p.r_old), Number(p.r_new))}</td>
          <td>${p.r_reason ? `<span class="badge">${esc(p.r_reason)}</span>` : ''}</td>`;
      } else extra = '<td></td><td></td><td></td><td></td>';
    }
    return `<tr><td><input type="checkbox" data-id="${i.id}" ${selected.has(i.id) ? 'checked' : ''} style="width:auto"></td>
      <td>${esc(i.code)}</td><td>${esc(i.name)}</td><td>${esc(catName(i.category_id))}</td><td>${esc(TYPE_LABEL[i.item_type] || i.item_type)}</td>
      <td class="num">${i.sales_price === null ? '' : `${money(i.sales_price)} ${esc(cur)}`}</td>${extra}</tr>`;
  }).join('');
  const th = (t, right) => `<th${right ? ' style="text-align:right"' : ''}>${t}</th>`;
  let summary = '';
  if (preview) {
    const n = preview.filter((r) => !r.r_reason).length;
    summary = `<p><strong>${n}</strong> item(s) will change, ${preview.length - n} skipped. Nothing is saved until you press Apply.</p>`;
  }
  const ids = new Set(rows.map((r) => r.id));
  const hidden = [...selected].filter((id) => !ids.has(id)).length;
  listEl.innerHTML = `${summary}${hidden ? `<p class="muted">${hidden} selected item(s) are hidden by the filters and are still included.</p>` : ''}
    <div class="table-wrap"><table class="grid"><thead><tr><th><input type="checkbox" data-all style="width:auto"></th>${th('Code')}${th('Name')}${th('Category')}${th('Type')}${th('Current price', 1)}
    ${preview ? `${th(`Cost (${esc(base)} or price currency)`, 1)}${th('New price', 1)}${th('Change', 1)}${th('Note')}` : ''}</tr></thead>
    <tbody>${body || '<tr><td colspan="10" class="muted">No items match the filters.</td></tr>'}</tbody></table></div>`;
  applyBtn.disabled = !preview || !ctx.canEdit || !preview.some((r) => !r.r_reason);
  updateCount(rows.length);
}

function renderHistory() {
  if (!history.length) { histEl.innerHTML = '<h3>Price history</h3><p class="muted">No price updates yet.</p>'; return; }
  const body = history.map((h) => `<tr><td>${String(h.changed_at).slice(0, 16).replace('T', ' ')}</td>
    <td>${esc(h.items ? `${h.items.code} - ${h.items.name}` : '')}</td>
    <td class="num">${h.old_price === null ? '' : money(h.old_price)}</td><td class="num">${money(h.new_price)} ${esc(h.currency || '')}</td>
    <td class="num">${h.old_price === null ? '' : pct(Number(h.old_price), Number(h.new_price))}</td>
    <td>${esc((METHODS[h.rule_method] || {}).label || h.rule_method)}: ${esc(h.rule_value)}</td><td>${esc(h.note || '')}</td></tr>`).join('');
  histEl.innerHTML = `<h3>Price history</h3><div class="table-wrap"><table class="grid"><thead><tr><th>When</th><th>Item</th>
    <th style="text-align:right">Old</th><th style="text-align:right">New</th><th style="text-align:right">Change</th><th>Rule</th><th>Note</th></tr></thead>
    <tbody>${body}</tbody></table></div><p class="muted">Showing the latest ${history.length} changes.</p>`;
}

function params() {
  const v = Number(valueEl.value);
  if (valueEl.value.trim() === '' || !Number.isFinite(v)) { ui.warn('Enter the value for the rule.'); return null; }
  return { method: methodSel.value, value: v, rounding: Number(roundSel.value), mode: modeSel.value };
}

async function doPreview() {
  if (!selected.size) return ui.warn('Tick at least one item.');
  const p = params();
  if (!p) return;
  try {
    preview = await rpcAll('price_update_preview', {
      p_company: ctx.companyId, p_items: [...selected], p_method: p.method, p_value: p.value, p_rounding: p.rounding, p_mode: p.mode,
    });
  } catch (e) { preview = null; return ui.errorFrom(e, 'Could not build the preview.'); }
  lastParams = p;
  renderList();
}

async function applyUpdate() {
  if (!preview || !lastParams) return ui.warn('Press Preview first.');
  const ids = preview.filter((r) => !r.r_reason).map((r) => r.r_item_id);
  if (!ids.length) return ui.warn('No item would change.');
  const ok = await ui.confirm({
    title: 'Apply price update',
    message: `Change the sales price of ${ids.length} item(s)? The old prices are kept in the price history.`,
    confirmText: 'Apply',
  });
  if (!ok) return;
  applyBtn.disabled = true;
  try {
    const { data, error } = await supabase.rpc('apply_price_update', {
      p_company: ctx.companyId, p_items: ids, p_method: lastParams.method, p_value: lastParams.value,
      p_rounding: lastParams.rounding, p_mode: lastParams.mode, p_note: noteEl.value.trim() || null,
    });
    if (error) throw error;
    ui.success(`${data} price(s) updated.`);
    selected.clear();
    preview = null;
    noteEl.value = '';
    await loadAll();
    renderList();
    renderHistory();
  } catch (e) {
    ui.errorFrom(e, 'Could not apply the price update.');
    renderList();
  }
}

async function saveRule() {
  const p = params();
  if (!p) return;
  const saved = await ui.form({
    title: 'Save as a rule',
    fields: [{ name: 'name', label: 'Rule name', required: true, full: true, hint: `${METHODS[p.method].label}: ${p.value}` }],
    values: { name: '' },
    onSubmit: async (v) => {
      const { error } = await supabase.from('price_rules').insert({
        company_id: ctx.companyId, name: v.name.trim(), method: p.method, rule_value: p.value, rounding: p.rounding, rounding_mode: p.mode,
      });
      if (error) throw error;
    },
  });
  if (saved) {
    const { data } = await supabase.from('price_rules').select('*').eq('company_id', ctx.companyId).order('name');
    rules = data || rules;
    fillRules();
    ui.success('Rule saved.');
  }
}

async function deleteRule() {
  const r = rules.find((x) => x.id === ruleSel.value);
  if (!r) return;
  const ok = await ui.confirm({ title: 'Delete rule', message: `Delete the rule "${r.name}"?`, confirmText: 'Delete' });
  if (!ok) return;
  const { error } = await supabase.from('price_rules').delete().eq('id', r.id);
  if (error) return ui.errorFrom(error, 'Could not delete the rule.');
  rules = rules.filter((x) => x.id !== r.id);
  ruleSel.value = '';
  fillRules();
}

async function exportHistory() {
  if (!history.length) return ui.warn('There is no price history yet.');
  try {
    await exportSheets(`price-history-${new Date().toISOString().slice(0, 10)}.xlsx`, [{
      name: 'Price history', title: 'Price history', subtitle: `Latest ${history.length} changes`, totals: false,
      rows: history.map((h) => ({
        when: String(h.changed_at).slice(0, 10), code: h.items ? h.items.code : '', name: h.items ? h.items.name : '',
        old: h.old_price === null ? '' : Number(h.old_price), neu: Number(h.new_price), cur: h.currency || '',
        rule: (METHODS[h.rule_method] || {}).label || h.rule_method, value: Number(h.rule_value), note: h.note || '',
      })),
      columns: [
        { key: 'when', header: 'Date', width: 12 }, { key: 'code', header: 'Code', width: 14 }, { key: 'name', header: 'Item', width: 32 },
        { key: 'old', header: 'Old price', width: 14 }, { key: 'neu', header: 'New price', width: 14 }, { key: 'cur', header: 'Currency', width: 10 },
        { key: 'rule', header: 'Rule', width: 34 }, { key: 'value', header: 'Rule value', width: 12 }, { key: 'note', header: 'Note', width: 28 },
      ],
    }]);
  } catch (e) { ui.errorFrom(e, 'Could not export.'); }
}

async function init() {
  document.getElementById('company-title').textContent = ctx.company.name;
  try { await loadAll(); } catch (e) { ui.errorFrom(e, 'Could not load the price update setup.'); return; }

  option(catSel, '', 'All categories');
  categories.forEach((c) => option(catSel, c.id, `${c.code} - ${c.name}`));
  option(typeSel, '', 'All types');
  Object.entries(TYPE_LABEL).forEach(([k, t]) => option(typeSel, k, t));
  Object.entries(METHODS).forEach(([k, m]) => option(methodSel, k, m.label));
  STEPS.forEach(([v, t]) => option(roundSel, v, t));
  MODES.forEach(([v, t]) => option(modeSel, v, t));
  fillRules();

  const lbl = el('label');
  lbl.style.cssText = 'display:flex;align-items:center;gap:.4rem;cursor:pointer';
  lbl.append(activeChk, document.createTextNode('Active only'));
  let t;
  [catSel, typeSel, activeChk].forEach((c) => c.addEventListener('change', () => { preview = null; renderList(); }));
  searchEl.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { preview = null; renderList(); }, 250); });
  toolbar.append(catSel, typeSel, searchEl, lbl, countEl, el('span', 'spacer'),
    btn('Clear selection', '', () => { selected.clear(); preview = null; renderList(); }),
    btn('Export history', '', exportHistory));

  methodSel.addEventListener('change', () => { valueField.querySelector('label').textContent = METHODS[methodSel.value].valueLabel; stale(); });
  [valueEl, roundSel, modeSel].forEach((c) => c.addEventListener('input', stale));
  ruleSel.addEventListener('change', () => {
    const r = rules.find((x) => x.id === ruleSel.value);
    if (r) {
      methodSel.value = r.method;
      valueEl.value = r.rule_value;
      roundSel.value = String(Number(r.rounding));
      modeSel.value = r.rounding_mode;
      valueField.querySelector('label').textContent = METHODS[r.method].valueLabel;
    }
    delRuleBtn.style.display = ctx.canEdit && ruleSel.value ? '' : 'none';
    stale();
  });
  valueField.querySelector('label').textContent = METHODS[methodSel.value].valueLabel;

  listEl.addEventListener('change', (e) => {
    if (e.target.matches('[data-all]')) {
      listEl.querySelectorAll('input[data-id]').forEach((c) => {
        c.checked = e.target.checked;
        if (c.checked) selected.add(c.dataset.id); else selected.delete(c.dataset.id);
      });
    } else if (e.target.matches('input[data-id]')) {
      if (e.target.checked) selected.add(e.target.dataset.id); else selected.delete(e.target.dataset.id);
    } else return;
    if (preview) { preview = null; renderList(); } else updateCount();
  });

  const ruleGrid = el('div', 'form-grid');
  ruleGrid.append(field('Method', methodSel), valueField, field('Round to', roundSel), field('Rounding', modeSel),
    field('Saved rule', ruleSel), field('Note', noteEl));
  const ruleBtns = el('div', 'toolbar');
  ruleBtns.append(btn('Preview', 'btn-primary', doPreview));
  if (ctx.canEdit) ruleBtns.append(applyBtn, btn('Save as rule', '', saveRule), delRuleBtn);
  const head = el('h3', '', 'Rule');
  panel.append(head, ruleGrid, ruleBtns, el('h3', '', 'Items'), listEl, histEl);

  hint.textContent = `Tick the items to change, choose a rule and press Preview. Cost is the weighted average cost, so cost-based rules skip items with no stock cost. Prices stay in each item's own currency (${base} when blank). The old price is kept in the history.`;
  renderList();
  renderHistory();
}

if (ctx) await init();