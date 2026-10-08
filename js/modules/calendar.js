import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const yearsEl = document.getElementById('years');
const checklistEl = document.getElementById('checklist');

let years = [];
let periods = [];
let equityAccounts = [];
const expanded = new Set();
let firstLoad = true;

const today = new Date().toISOString().slice(0, 10);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function btn(label, cls, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `btn ${cls}`.trim();
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/* ---------- data ---------- */

async function load() {
  const cid = ctx.companyId;
  const [y, p, a] = await Promise.all([
    supabase.from('fiscal_years').select('*').eq('company_id', cid).order('start_date'),
    supabase.from('fiscal_periods').select('*').eq('company_id', cid).order('start_date'),
    supabase.from('gl_accounts').select('id, code, name, control_type')
      .eq('company_id', cid).in('control_type', ['retained_earnings', 'opening_balance']),
  ]);
  for (const r of [y, p, a]) if (r.error) throw r.error;
  years = y.data;
  periods = p.data;
  equityAccounts = a.data;
  if (firstLoad) {
    years.forEach((yr) => { if (today >= yr.start_date && today <= yr.end_date) expanded.add(yr.id); });
    if (!expanded.size && years.length) expanded.add(years[years.length - 1].id);
    firstLoad = false;
  }
}

async function refresh() {
  try { await load(); } catch (e) { ui.errorFrom(e, 'Could not load the financial calendar.'); }
  render();
}

/* ---------- render ---------- */

function render() {
  toolbar.replaceChildren();
  if (ctx.canEdit) toolbar.append(btn('Add financial year', 'btn-primary', addYear));
  renderYears();
  renderChecklist();
}

function renderYears() {
  if (!years.length) {
    yearsEl.innerHTML = '<div class="card" style="margin-bottom:1rem"><p class="muted">No financial year yet. Add your first one to get started.</p></div>';
    return;
  }
  const latestId = years[years.length - 1].id;
  yearsEl.innerHTML = years.map((y) => {
    const open = expanded.has(y.id);
    const del = ctx.canEdit && y.id === latestId ? '<button class="btn btn-sm" data-act="delyear">Delete year</button>' : '';
    const rows = periods.filter((p) => p.year_id === y.id).map((p) => {
      const current = today >= p.start_date && today <= p.end_date;
      const act = !ctx.canEdit ? '' : (p.status === 'open'
        ? '<button class="btn btn-sm" data-act="close">Close</button>'
        : '<button class="btn btn-sm" data-act="reopen">Reopen</button>');
      return `<tr data-period="${p.id}">
        <td class="num">${p.period_no}</td>
        <td>${esc(p.name)}${current ? ' <span class="badge">current</span>' : ''}</td>
        <td>${p.start_date}</td><td>${p.end_date}</td>
        <td><span class="badge ${p.status}">${p.status === 'open' ? 'Open' : 'Closed'}</span></td>
        <td><div class="row-actions">${act}</div></td></tr>`;
    }).join('');
    return `<div class="card" style="margin-bottom:1rem" data-year="${y.id}">
      <div class="page-head" style="margin-bottom:${open ? '.75rem' : '0'}">
        <div><span class="tree-caret" data-act="toggle">${open ? '▾' : '▸'}</span>
          <strong>${esc(y.name)}</strong> <span class="muted">${y.start_date} to ${y.end_date}</span>
          <span class="badge ${y.status}">${y.status === 'open' ? 'Open' : 'Closed'}</span></div>
        <div class="row-actions">${del}</div>
      </div>
      ${open ? `<div class="table-wrap"><table class="grid"><thead><tr>
        <th>No</th><th>Period</th><th>From</th><th>To</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>` : ''}
    </div>`;
  }).join('');
}

function renderChecklist() {
  const re = equityAccounts.find((a) => a.control_type === 'retained_earnings');
  const ob = equityAccounts.find((a) => a.control_type === 'opening_balance');
  const item = (ok, title, detail) =>
    `<p><span class="badge ${ok ? 'open' : 'closed'}">${ok ? 'Done' : 'To do'}</span> <strong>${title}</strong><br>
     <span class="muted">${detail}</span></p>`;
  checklistEl.innerHTML =
    item(years.length > 0, 'Financial calendar',
      years.length ? `${years.length} financial year(s) set up.` : 'Add your first financial year above.')
    + item(!!re, 'Retained earnings account',
      re ? `${esc(re.code)} ${esc(re.name)}`
        : 'In the <a href="/pages/chart.html">Chart of Accounts</a>, create a posting account in a Balance Sheet equity group, '
          + 'with normal balance Credit and Control account set to Retained earnings.')
    + item(!!ob, 'Opening balance equity (optional)',
      ob ? `${esc(ob.code)} ${esc(ob.name)}`
        : 'A temporary equity account for loading opening balances. Create it the same way with Control account set to Opening balance equity.');
}

/* ---------- actions ---------- */

yearsEl.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const yearId = t.closest('[data-year]').dataset.year;
  const act = t.dataset.act;
  if (act === 'toggle') {
    if (expanded.has(yearId)) expanded.delete(yearId); else expanded.add(yearId);
    renderYears();
    return;
  }
  if (!ctx.canEdit) return;
  if (act === 'delyear') return deleteYear(yearId);
  const row = t.closest('tr');
  if (row) await setStatus(row.dataset.period, act === 'close' ? 'closed' : 'open');
});

async function setStatus(id, status) {
  const p = periods.find((x) => x.id === id);
  if (!p) return;
  const closing = status === 'closed';
  const ok = await ui.confirm({
    title: closing ? 'Close period' : 'Reopen period',
    message: closing
      ? `Close ${p.name}?\nNo new transactions can be posted into a closed period.`
      : `Reopen ${p.name}?`,
    confirmText: closing ? 'Close period' : 'Reopen',
  });
  if (!ok) return;
  const { error } = await supabase.from('fiscal_periods').update({ status }).eq('id', id);
  if (error) return ui.errorFrom(error);
  ui.updated('Period');
  await refresh();
}

async function deleteYear(id) {
  if (!(await ui.confirmDelete('Financial year'))) return;
  const { error } = await supabase.rpc('delete_fiscal_year', { p_year: id });
  if (error) return ui.errorFrom(error);
  ui.deleted('Financial year');
  await refresh();
}

async function addYear() {
  const last = years[years.length - 1];
  const start = last ? addDays(last.end_date, 1) : `${new Date().getFullYear()}-01-01`;
  const saved = await ui.form({
    title: 'Add financial year',
    fields: [
      { name: 'start', label: 'Start date', type: 'date', required: true, disabled: !!last, full: true,
        hint: last ? 'A new year always starts the day after the previous one ends.'
          : 'The first day of your financial year. It must be the 1st of a month.' },
      { name: 'name', label: 'Name (optional)', full: true, hint: 'Leave blank for the default, for example Financial year 2027.' },
    ],
    values: { start },
    onSubmit: async (v) => {
      const { error } = await supabase.rpc('create_fiscal_year', {
        p_company: ctx.companyId, p_start: v.start, p_name: v.name,
      });
      if (error) throw error;
    },
  });
  if (saved) {
    ui.created('Financial year');
    await refresh();
    if (years.length) { expanded.add(years[years.length - 1].id); renderYears(); }
  }
}

/* ---------- start ---------- */

if (ctx) {
  document.getElementById('company-title').textContent = ctx.company.name;
  await refresh();
}