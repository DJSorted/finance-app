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

  let reval = { rows: [], done: null, error: '' };
  if (!closed) reval = await loadReval();
  if (!closed) root.append(revalCard(s, reval));

  const actions = el('div', 'toolbar');
  actions.style.marginTop = '1rem';
  if (!closed && CAN_CLOSE) {
    const b = btn('Close this year', 'btn-primary', () => closeYear(s, profit, reval));
    b.disabled = !s.can_close;
    actions.append(b);
  }
  const lastClosed = [...years].reverse().find((y) => y.status === 'closed');
  if (closed && CAN_REOPEN && lastClosed && lastClosed.id === yearId) actions.append(btn('Reopen this year', 'btn-danger', () => reopenYear(s)));
  if (!closed && !CAN_CLOSE) actions.append(el('span', 'muted', 'Only an owner, admin or accountant can close a year.'));
  root.append(actions);
  panel.replaceChildren(root);
}

async function loadReval() {
  const out = { rows: [], done: null, error: '' };
  const j = await supabase.from('journals').select('journal_no, journal_date')
    .eq('company_id', ctx.companyId).eq('source_type', 'fx_revaluation').eq('source_id', yearId).eq('status', 'posted').limit(1);
  if (!j.error && j.data && j.data.length) out.done = j.data[0];
  const { data, error } = await supabase.rpc('fx_revaluation_preview', { p_year: yearId });
  if (error) out.error = error.message || 'Could not work out the revaluation.';
  else out.rows = data;
  return out;
}

function revalCard(s, reval) {
  const card = el('div', 'card');
  card.style.marginTop = '1rem';
  card.append(el('h4', '', 'Foreign currency revaluation'));
  card.lastChild.style.marginTop = '0';
  if (reval.done) {
    card.append(el('p', 'muted', `Revalued on journal ${reval.done.journal_no}, reversed the next day. Any difference listed below arose after that.`));
  }
  if (reval.error) {
    card.append(el('p', '', reval.error));
    card.lastChild.style.color = 'var(--danger)';
    return card;
  }
  if (!reval.rows.length) {
    card.append(el('p', 'muted', 'No foreign currency debtors, creditors or bank balances need revaluing at the year-end rate.'));
    return card;
  }
  const total = reval.rows.reduce((t, r) => t + Number(r.r_diff), 0);
  const body = reval.rows.map((r) => `<tr><td>${esc(r.r_account)}</td><td>${esc(r.r_party || '')}</td><td>${esc(r.r_currency)}</td>
    <td class="num">${money(r.r_trx)}</td><td class="num">${money(r.r_booked)}</td><td class="num">${Number(r.r_rate).toFixed(6)}</td>
    <td class="num">${money(r.r_revalued)}</td><td class="num">${money(r.r_diff)}</td></tr>`).join('');
  const wrap = el('div', 'table-wrap');
  wrap.innerHTML = `<table class="grid"><thead><tr><th>Account</th><th>Customer / supplier</th><th>Cur</th>
    <th style="text-align:right">Foreign balance</th><th style="text-align:right">Booked (${esc(s.base)})</th><th style="text-align:right">Closing rate</th>
    <th style="text-align:right">Revalued (${esc(s.base)})</th><th style="text-align:right">Difference</th></tr></thead>
    <tbody>${body}<tr class="row-root"><td colspan="7">Unrealised exchange ${total >= 0 ? 'gain' : 'loss'}</td><td class="num">${money(Math.abs(total))}</td></tr></tbody></table>`;
  card.append(wrap);
  card.append(el('p', 'muted', 'Posted before the year is closed. It goes to the exchange gains / losses account and reverses on the first day of the next year, so realised differences stay correct when the balances are settled.'));
  if (CAN_CLOSE) {
    const b = btn('Post revaluation', '', () => postReval(s, total));
    card.append(b);
  }
  return card;
}

async function postReval(s, total) {
  const ok = await ui.confirm({
    title: 'Post revaluation',
    message: `Post an unrealised exchange ${total >= 0 ? 'gain' : 'loss'} of ${money(Math.abs(total))} ${s.base} dated ${s.end_date}?\nIt reverses automatically on the next day. It can only be run once per year.`,
    confirmText: 'Post',
  });
  if (!ok) return;
  const { error } = await supabase.rpc('fx_revalue_year', { p_year: yearId });
  if (error) return ui.errorFrom(error, 'Could not post the revaluation.');
  ui.success('Revaluation posted.');
  await render();
}

async function closeYear(s, profit, reval) {
  if (reval && reval.rows.length && !reval.done) {
    const go = await ui.confirm({
      title: 'Foreign currency not revalued',
      message: 'Foreign currency balances have not been revalued at the year-end rate. Close the year anyway? After closing, the revaluation can no longer be posted into this year.',
      confirmText: 'Close anyway',
    });
    if (!go) return;
  }
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