import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { exportSheets } from '../core/export.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const cards = document.getElementById('cards');
const panel = document.getElementById('panel');

let rows = [];
let size = null;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num0 = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
function fmtBytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}
function btn(text, cls, onClick) {
  const b = el('button', `btn ${cls}`.trim(), text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

async function load() {
  const [c, s] = await Promise.all([
    supabase.rpc('data_record_counts', { p_company: ctx.companyId }),
    supabase.rpc('database_size_bytes'),
  ]);
  if (c.error) throw c.error;
  rows = c.data.map((r) => ({ area: r.area, label: r.label, records: Number(r.records) }));
  size = s.error || s.data === null ? null : Number(s.data);
}

async function refresh() {
  try { await load(); } catch (e) { ui.errorFrom(e, 'Could not count the records.'); return; }
  render();
}

function render() {
  document.getElementById('company-title').textContent = ctx.company.name;
  toolbar.replaceChildren(btn('Refresh', '', refresh), el('span', 'spacer'), btn('Export to Excel', '', doExport));
  hint.textContent = 'How many records this company holds, by area. Counts include everything you can see for this company, posted and draft. The database size covers every company in this project.';

  const total = rows.reduce((s, r) => s + r.records, 0);
  const areas = new Map();
  rows.forEach((r) => areas.set(r.area, (areas.get(r.area) || 0) + r.records));
  const ranked = [...areas.entries()].sort((a, b) => b[1] - a[1]);
  const biggest = [...rows].sort((a, b) => b.records - a.records)[0];

  cards.innerHTML = `<div class="dash-grid">
    <div class="tile"><div class="tile-label">Records in this company</div><div class="tile-value">${num0(total)}</div>
      <div class="tile-sub">across ${rows.length} kinds of record</div></div>
    <div class="tile"><div class="tile-label">Database size</div><div class="tile-value">${size === null ? 'n/a' : fmtBytes(size)}</div>
      <div class="tile-sub">whole project, all companies</div></div>
    <div class="tile"><div class="tile-label">Busiest area</div><div class="tile-value" style="font-size:1.2rem">${ranked.length ? esc(ranked[0][0]) : '-'}</div>
      <div class="tile-sub">${ranked.length ? `${num0(ranked[0][1])} records` : ''}</div></div>
    <div class="tile"><div class="tile-label">Largest table</div><div class="tile-value" style="font-size:1.2rem">${biggest ? esc(biggest.label) : '-'}</div>
      <div class="tile-sub">${biggest ? `${num0(biggest.records)} records` : ''}</div></div></div>`;

  if (!rows.length) { panel.innerHTML = '<p class="muted">No data found.</p>'; return; }
  const max = Math.max(1, ...rows.map((r) => r.records));
  const body = ranked.map(([area, sub]) => {
    const list = rows.filter((r) => r.area === area).sort((a, b) => b.records - a.records);
    return `<tr class="row-parent"><td colspan="2"><strong>${esc(area)}</strong></td><td class="num"><strong>${num0(sub)}</strong></td>
      <td class="num">${total ? ((sub / total) * 100).toFixed(1) : '0.0'}%</td></tr>
      ${list.map((r) => `<tr><td style="padding-left:1.4rem">${esc(r.label)}</td>
        <td style="width:30%"><div class="bar-track"><span style="width:${(r.records / max) * 100}%"></span></div></td>
        <td class="num">${num0(r.records)}</td><td></td></tr>`).join('')}`;
  }).join('');
  panel.innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr><th>Area and record</th><th></th>
    <th style="text-align:right">Records</th><th style="text-align:right">Share</th></tr></thead><tbody>${body}
    <tr class="row-root"><td colspan="2">Total</td><td class="num">${num0(total)}</td><td></td></tr></tbody></table></div>`;
}

async function doExport() {
  if (!rows.length) return ui.warn('There is nothing to export.');
  try {
    await exportSheets(`data-records-${new Date().toISOString().slice(0, 10)}.xlsx`, [{
      name: 'Records', title: 'Records held',
      subtitle: size === null ? '' : `Database size ${fmtBytes(size)} (whole project)`,
      rows: [...rows].sort((a, b) => a.area.localeCompare(b.area) || b.records - a.records)
        .map((r) => ({ area: r.area, label: r.label, records: r.records })),
      columns: [{ key: 'area', header: 'Area', width: 18 }, { key: 'label', header: 'Record', width: 36 }, { key: 'records', header: 'Records', width: 14 }],
    }]);
  } catch (e) { ui.errorFrom(e, 'Could not export.'); }
}

if (ctx) await refresh();