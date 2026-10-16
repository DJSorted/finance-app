import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { exportSheets } from '../core/export.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const panel = document.getElementById('panel');

const PAGE = 1000;
const EXCEL_ROW_WARNING = 300000;
const ORDER = { stock_balances: ['item_id', 'warehouse_id'] };   // tables without an id column need a fixed order to page safely

let GROUPS = [];
const checks = new Map();
let busy = false;

const num0 = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
const pad = (n) => String(n).padStart(2, '0');
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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

const formatSel = el('select');
formatSel.style.width = 'auto';
[['xlsx', 'One Excel workbook'], ['csv', 'Zip of CSV files']].forEach(([v, t]) => { const o = el('option', '', t); o.value = v; formatSel.append(o); });
const goBtn = btn('Export', 'btn-primary', run);

async function loadCatalog() {
  const { data, error } = await supabase.rpc('data_table_catalog');
  if (error) throw error;
  const map = new Map();
  data.filter((r) => r.exportable).sort((a, b) => a.sort_order - b.sort_order).forEach((r) => {
    if (!map.has(r.area_key)) map.set(r.area_key, { key: r.area_key, label: r.area, tables: [] });
    map.get(r.area_key).tables.push(r.table_name);
  });
  GROUPS = [...map.values()];
}

async function init() {
  document.getElementById('company-title').textContent = ctx.company.name;
  if (!ctx.canEdit) {
    panel.innerHTML = '<p class="muted">Only owners, admins and accountants can export the full data.</p>';
    return;
  }
  try { await loadCatalog(); } catch (e) { ui.errorFrom(e, 'Could not load the list of tables.'); return; }
  toolbar.append(el('span', 'muted', 'Format'), formatSel, goBtn);
  hint.textContent = 'Exports every record this company holds, one sheet (or CSV file) per table, with the original column names and ids. It leaves out user accounts, invitations, the access log and shared reference data. Attachment files are not included, only their records.';
  const rows = GROUPS.map((g) => `<label style="display:flex;gap:.6rem;align-items:flex-start;padding:.5rem 0;cursor:pointer">
      <input type="checkbox" data-group="${esc(g.key)}" checked style="width:auto;margin-top:.25rem">
      <span><strong>${esc(g.label)}</strong><br><span class="muted">${g.tables.map(esc).join(', ')}</span></span></label>`).join('');
  panel.innerHTML = `<div id="groups">${rows}</div><div id="status" style="margin-top:1rem"></div>`;
  panel.querySelectorAll('[data-group]').forEach((c) => checks.set(c.dataset.group, c));
}

/* ---------- reading a table ---------- */

async function fetchTable(table) {
  const col = table === 'companies' ? 'id' : 'company_id';
  const orderCols = ORDER[table] || ['id'];
  const rows = [];
  let ordered = true;
  let from = 0;
  for (;;) {
    let q = supabase.from(table).select('*').eq(col, ctx.companyId);
    if (ordered) orderCols.forEach((c) => { q = q.order(c); });
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) {
      // a table without those columns: read it unordered, from the start
      if (ordered && error.code === '42703' && !String(error.message).includes(col)) { ordered = false; from = 0; rows.length = 0; continue; }
      throw error;
    }
    rows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

const cellValue = (v) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return v;
};

function shape(rows) {
  const cols = [];
  const seen = new Set();
  rows.forEach((r) => Object.keys(r).forEach((k) => { if (!seen.has(k)) { seen.add(k); cols.push(k); } }));
  return { cols, rows: rows.map((r) => Object.fromEntries(cols.map((k) => [k, cellValue(r[k])]))) };
}

function statusOf(err) {
  if (err.code === '42703' && String(err.message).includes('company_id')) return 'Skipped: the table has no company_id column';
  if (err.code === '42P01' || err.code === 'PGRST205') return 'Skipped: table not found';
  return `Skipped: ${err.message || 'could not be read'}`;
}

/* ---------- output ---------- */

const csvCell = (v) => {
  if (v === '' || v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (cols, rows) => `\uFEFF${[cols.map(csvCell).join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n')}`;

function loadJSZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
    s.onload = () => (window.JSZip ? resolve(window.JSZip) : reject(new Error('The zip library did not start.')));
    s.onerror = () => reject(new Error('Could not load the zip library. Check your connection.'));
    document.head.append(s);
  });
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

/* ---------- run ---------- */

async function run() {
  if (busy) return;
  const tables = GROUPS.filter((g) => checks.get(g.key) && checks.get(g.key).checked).flatMap((g) => g.tables);
  if (!tables.length) return ui.warn('Tick at least one area to export.');
  busy = true;
  goBtn.disabled = true;
  const status = document.getElementById('status');
  const lines = [];
  const show = (extra) => { status.innerHTML = `<p class="muted">${[...lines, extra].filter(Boolean).map(esc).join('<br>')}</p>`; };

  const data = [];
  const contents = [];
  let total = 0;
  try {
    for (let i = 0; i < tables.length; i++) {
      const t = tables[i];
      show(`Reading ${t} (${i + 1} of ${tables.length})...`);
      try {
        const raw = await fetchTable(t);
        const s = shape(raw);
        data.push({ table: t, ...s });
        total += s.rows.length;
        contents.push({ table: t, records: s.rows.length, status: 'Exported' });
        lines.push(`${t}: ${num0(s.rows.length)} records`);
      } catch (e) {
        contents.push({ table: t, records: 0, status: statusOf(e) });
        lines.push(`${t}: ${statusOf(e)}`);
      }
    }

    if (!data.length) { show(''); return ui.warn('Nothing could be read.'); }
    if (formatSel.value === 'xlsx' && total > EXCEL_ROW_WARNING) {
      const ok = await ui.confirm({
        title: 'Large export',
        message: `This export has ${num0(total)} records. Building one Excel workbook this big can be slow or run out of memory in the browser. A zip of CSV files is safer. Continue with Excel?`,
        confirmText: 'Continue with Excel',
      });
      if (!ok) { show('Cancelled. Choose "Zip of CSV files" and export again.'); return; }
    }

    const stamp = `${ctx.company.name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${todayIso()}`;
    show('Building the file...');
    if (formatSel.value === 'xlsx') {
      const sheets = [{
        name: 'Contents', title: 'Full data export', subtitle: `${ctx.company.name}, exported ${todayIso()}`,
        rows: contents, totals: false,
        columns: [{ key: 'table', header: 'Table', width: 30 }, { key: 'records', header: 'Records', width: 14 }, { key: 'status', header: 'Status', width: 50 }],
      }];
      data.forEach((d) => sheets.push({
        name: d.table, plain: true, rows: d.rows,
        columns: (d.cols.length ? d.cols : ['id']).map((c) => ({ key: c, header: c, width: 18 })),
      }));
      await exportSheets(`full-export-${stamp}.xlsx`, sheets);
    } else {
      const JSZip = await loadJSZip();
      const zip = new JSZip();
      zip.file('contents.csv', toCsv(['table', 'records', 'status'], contents));
      data.forEach((d) => zip.file(`${d.table}.csv`, toCsv(d.cols, d.rows)));
      download(await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }), `full-export-${stamp}.zip`);
    }
    const skipped = contents.filter((c) => c.status !== 'Exported').length;
    show(`Done. ${num0(total)} records from ${data.length} tables.${skipped ? ` ${skipped} table(s) were skipped: see the list above.` : ''}`);
    ui.success('Export ready.');
  } catch (e) {
    ui.errorFrom(e, 'Could not export.');
  } finally {
    busy = false;
    goBtn.disabled = false;
  }
}

if (ctx) await init();