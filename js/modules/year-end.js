import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const panel = document.getElementById('panel');

const CAN_CLOSE = ctx ? ['owner', 'admin', 'accountant'].includes(ctx.role) : false;
const CAN_REOPEN = ctx ? ['owner', 'admin'].includes(ctx.role) : false;

let years = [];
let yearId = '';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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

const yearSel = el('select');
yearSel.style.width = 'auto';

async function loadYears() {
  const { data, error } = await supabase.from('fiscal_years')
    .select('id, code, name, start_date, end_date, status').eq('company_id', ctx.companyId).order('start_date');
  if (error) throw error;
  years = data;
  yearSel.replaceChildren();
  years.forEach((y) => {
    const o = el('option', '', `${y.name} (${y.start_date} to ${y.end_date})${y.status === 'closed' ? ' - closed' : ''}`);
    o.value = y.id;
    yearSel.append(o);
  });
  if (!years.some((y) => y.id === yearId)) {
    const firstOpen = years.find((y) => y.status === 'open');
    yearId = (firstOpen || years[years.length - 1] || {}).id || '';
  }
  yearSel.value = yearId;
}

async function init() {
  document.getElementById('company-title').textContent = ctx.company.name;
  hint.textContent = 'Closing a financial year moves the profit or loss of the year to the retained earnings account and locks the year. The closing journal is dated the last day of the year, and the income statement and cash flow ignore it, so the year\'s figures do not change. Years are closed in order. An owner or admin can reopen the latest closed year.';
  try { await loadYears(); } catch (e) { ui.errorFrom(e, 'Could not load the financial years.'); return; }
  if (!years.length) { panel.innerHTML = '<p class="muted">Create a financial year in the Financial Calendar first.</p>'; return; }
  yearSel.addEventListener('change', () => { yearId = yearSel.value; render(); });
  toolbar.append(el('span', 'muted', 'Financial year'), yearSel);
  await render();
}

async function render() {
  if (!yearId) return;
  panel.innerHTML = '<p class="muted">Loading...</p>';
  const { data: s, error } = await supabase.rpc('year_end_status', { p_year: yearId });
  if (error) { panel.innerHTML = ''; return ui.errorFrom(error, 'Could not check the financial year.'); }
  const closed = s.status === 'closed';
  const net = Number(s.net);
  const profit = -net;
  const root = el('div');

  const badge = el('p');
  badge.innerHTML = `<strong>${esc(s.name)}</strong> · ${esc(s.start_date)} to ${esc(s.end_date)} · `
    + `<span class="badge ${closed ? 'open' : ''}">${closed ? 'Closed' : 'Open'}</span>`
    + `${s.closing_journal_no ? ` <span class="muted">Closing journal ${esc(s.closing_journal_no)}</span>` : ''}`;
  root.append(badge);

  if (s.problems.length) {
    const box = el('div', 'card');
    box.innerHTML = `<h4 style="margin-top:0">Before this year can be closed</h4><ul>${s.problems.map((p) => `<li style="color:var(--danger)">${esc(p)}</li>`).join('')}</ul>`;
    root.append(box);
  }
  if (s.warnings.length) {
    const box = el('div', 'card');
    box.innerHTML = `<h4 style="margin-top:0">Check these</h4><ul>${s.warnings.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`;
    root.append(box);
  }

  const wrap = el('div', 'table-wrap');
  if (s.accounts.length) {
    const body = s.accounts.map((a) => {
      const amt = Number(a.amount);
      return `<tr><td>${esc(a.code)}</td><td>${esc(a.name)}</td><td class="num">${amt > 0 ? money(amt) : ''}</td><td class="num">${amt < 0 ? money(-amt) : ''}</td></tr>`;
    }).join('');
    wrap.innerHTML = `<table class="grid"><thead><tr><th>Code</th><th>Profit and loss account</th><th style="text-align:right">Debit</th><th style="text-align:right">Credit</th></tr></thead>
      <tbody>${body}<tr class="row-root"><td colspan="2">${profit >= 0 ? 'Net profit' : 'Net loss'} for the year (${esc(s.base)})</td>
      <td class="num">${net > 0 ? money(net) : ''}</td><td class="num">${net < 0 ? money(-net) : ''}</td></tr></tbody></table>`;
  } else {
    wrap.innerHTML = '<p class="muted">There is no profit and loss activity in this year, so no closing journal is needed. Closing the year only locks it.</p>';
  }
  root.append(wrap);

  const actions = el('div', 'toolbar');
  actions.style.marginTop = '1rem';
  if (!closed && CAN_CLOSE) {
    const b = btn('Close this year', 'btn-primary', () => closeYear(s, profit));
    b.disabled = !s.can_close;
    actions.append(b);
  }
  const lastClosed = [...years].reverse().find((y) => y.status === 'closed');
  if (closed && CAN_REOPEN && lastClosed && lastClosed.id === yearId) actions.append(btn('Reopen this year', 'btn-danger', () => reopenYear(s)));
  if (!closed && !CAN_CLOSE) actions.append(el('span', 'muted', 'Only an owner, admin or accountant can close a year.'));
  root.append(actions);
  panel.replaceChildren(root);
}

async function closeYear(s, profit) {
  const ok = await ui.confirm({
    title: `Close ${s.name}`,
    message: `Close ${s.name}?\n${s.accounts.length ? `The ${profit >= 0 ? 'profit' : 'loss'} of ${money(Math.abs(profit))} ${s.base} moves to retained earnings. ` : ''}`
      + 'All periods in the year are locked. An owner or admin can reopen it later.',
    confirmText: 'Close year',
  });
  if (!ok) return;
  const { error } = await supabase.rpc('close_fiscal_year', { p_year: yearId });
  if (error) return ui.errorFrom(error, 'Could not close the year.');
  ui.success('Financial year closed.');
  await loadYears();
  await render();
}

async function reopenYear(s) {
  const saved = await ui.form({
    title: `Reopen ${s.name}`, submitText: 'Reopen year',
    fields: [{ name: 'reason', label: 'Reason', required: true, full: true,
      hint: 'The closing journal is reversed and all periods in the year open again. Close the periods and the year again when you are done.' }],
    values: {},
    onSubmit: async (v) => {
      const { error } = await supabase.rpc('reopen_fiscal_year', { p_year: yearId, p_reason: v.reason });
      if (error) throw error;
    },
  });
  if (!saved) return;
  ui.success('Financial year reopened.');
  await loadYears();
  await render();
}

if (ctx) await init();