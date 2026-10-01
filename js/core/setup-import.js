import { supabase } from './supabase.js';
import { ui } from './ui.js';
import { readWorkbook, exportSheets } from './export.js';
import { IMPORT_DEFS } from './import-defs.js';

const MAX_ROWS = 5000;
const SHOW_MAX = 300;

export const hasImport = (table) => !!IMPORT_DEFS[table];

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const norm = (k) => String(k ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

function describe(col) {
  if (col.type === 'bool') return 'Yes or No';
  if (col.type === 'enum') return `One of: ${col.values.map((v) => v[1]).join(' / ')}`;
  if (col.type === 'ref') return `Code of an existing ${col.what || 'record'}`;
  if (col.type === 'number') return 'A number';
  if (col.type === 'int') return 'A whole number';
  return 'Text';
}

/* ---------- reading cells ---------- */

function parseCell(col, raw, lk) {
  const s = String(raw ?? '').trim();
  if (col.type === 'bool') {
    if (s === '') return { v: col.default ?? false };
    const t = s.toLowerCase();
    if (['yes', 'y', 'true', '1'].includes(t)) return { v: true };
    if (['no', 'n', 'false', '0'].includes(t)) return { v: false };
    return { err: `${col.header} must be Yes or No` };
  }
  if (s === '') {
    if (col.required) return { err: `${col.header} is required` };
    return { v: col.default ?? null };
  }
  switch (col.type) {
    case 'number': {
      const n = Number(s);
      return Number.isFinite(n) ? { v: n } : { err: `${col.header} must be a number` };
    }
    case 'int': {
      const n = Number(s);
      return Number.isInteger(n) ? { v: n } : { err: `${col.header} must be a whole number` };
    }
    case 'enum': {
      const t = s.toLowerCase();
      const hit = col.values.find(([val, label]) => val.toLowerCase() === t || label.toLowerCase() === t);
      return hit ? { v: hit[0] } : { err: `${col.header} "${s}" is not allowed` };
    }
    case 'ref': {
      const by = col.by || 'code';
      const rec = (lk[col.lookup] || []).find((r) => String(r[by]).toLowerCase() === s.toLowerCase());
      return rec ? { v: rec[col.value || 'id'] } : { err: `${col.header} "${s}" not found` };
    }
    default: {
      const v = col.upper ? s.toUpperCase() : s;
      if (col.check) { const m = col.check(v); if (m) return { err: m }; }
      return { v };
    }
  }
}

function toSheetValue(col, row, lk) {
  const x = row[col.field];
  if (x === null || x === undefined) return '';
  if (col.type === 'bool') return x ? 'Yes' : 'No';
  if (col.type === 'enum') return (col.values.find((v) => v[0] === x) || [x, x])[1];
  if (col.type === 'ref') {
    const rec = (lk[col.lookup] || []).find((r) => r[col.value || 'id'] === x);
    return rec ? rec[col.by || 'code'] : '';
  }
  return x;
}

function parseSheet(rawRows, defs, existing, lk) {
  const keys = Object.keys(rawRows[0] || {});
  const mapped = new Map();
  defs.forEach((c) => {
    const k = keys.find((x) => norm(x) === norm(c.header));
    if (k) mapped.set(c, k);
  });
  const missing = defs.filter((c) => c.required && !mapped.has(c)).map((c) => c.header);
  if (missing.length) return { fatal: `The file is missing required column(s): ${missing.join(', ')}.` };

  const seen = new Map();
  const rows = [];
  rawRows.forEach((raw, i) => {
    if (Object.values(raw).every((x) => String(x ?? '').trim() === '')) return;
    const r = { line: i + 2, code: '', name: '', errors: [], values: {}, status: 'new', msg: '' };
    mapped.forEach((key, col) => {
      const res = parseCell(col, raw[key], lk);
      if (res.err) r.errors.push(res.err); else r.values[col.field] = res.v;
    });
    r.code = r.values.code || '';
    r.name = r.values.name || '';
    if (r.code) {
      if (seen.has(r.code)) r.errors.push(`Duplicate code (first used on line ${seen.get(r.code)})`);
      else seen.set(r.code, r.line);
    }
    if (existing.has(r.code)) r.status = 'update';
    if (r.errors.length) { r.status = 'error'; r.msg = r.errors.join('; '); }
    rows.push(r);
  });
  return { rows };
}

/* ---------- template ---------- */

async function downloadTemplate(cfg, defs, lk, rows) {
  const date = new Date().toISOString().slice(0, 10);
  await exportSheets(`${cfg.file || cfg.table}-import-${date}.xlsx`, [
    {
      name: cfg.plural.slice(0, 31),
      columns: defs.map((c) => ({ key: c.header, header: c.header, width: Math.max(16, c.header.length + 2) })),
      rows: rows.map((r) => Object.fromEntries(defs.map((c) => [c.header, toSheetValue(c, r, lk)]))),
    },
    {
      name: 'Help',
      columns: [
        { key: 'column', header: 'Column', width: 36 }, { key: 'required', header: 'Required', width: 10 },
        { key: 'format', header: 'Format', width: 60 },
      ],
      rows: defs.map((c) => ({ column: c.header, required: c.required ? 'Yes' : 'No', format: describe(c) })),
    },
  ]);
}

/* ---------- dialog ---------- */

export function openSetupImport({ ctx, cfg, lk, rows, onDone }) {
  const defs = IMPORT_DEFS[cfg.table];
  if (!defs) { ui.warn('Import is not available for this list.'); return; }
  const existing = new Set(rows.map((r) => String(r.code).toUpperCase()));

  const backdrop = h('div', 'modal-backdrop');
  const box = h('div', 'modal xwide');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.append(h('h3', 'modal-title', `Import ${cfg.plural}`));
  box.append(h('p', 'modal-message',
    'Upload an Excel or CSV file. Rows are matched by Code: new codes are created and existing codes are updated. Nothing is deleted.\n'
    + 'The columns in your file are the truth: a blank cell clears that value. Remove a column from the file to leave that field untouched.'));

  const fileRow = h('div', 'file-row');
  const input = h('input');
  input.type = 'file';
  input.accept = '.xlsx,.xls,.csv';
  const tpl = h('button', 'btn btn-sm', 'Download template');
  tpl.type = 'button';
  tpl.addEventListener('click', () => downloadTemplate(cfg, defs, lk, rows).catch((e) => ui.errorFrom(e, 'Could not create the template.')));
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
  const count = (s) => parsed.rows.filter((r) => r.status === s).length;

  function renderPreview() {
    result.replaceChildren();
    if (!parsed.rows.length) { result.append(h('p', 'muted', 'No rows found in that file.')); return; }
    result.append(h('h4', '', `${count('new')} new, ${count('update')} to update, ${count('error')} with errors`));

    const ordered = parsed.rows.filter((r) => r.status === 'error').concat(parsed.rows.filter((r) => r.status !== 'error'));
    const shown = ordered.slice(0, SHOW_MAX);
    const wrap = h('div', 'preview-scroll');
    const table = h('table', 'grid');
    const thead = h('thead');
    const hr = h('tr');
    ['Line', 'Code', 'Name', 'Status', 'Message'].forEach((t) => hr.append(h('th', '', t)));
    thead.append(hr);
    const tbody = h('tbody');
    shown.forEach((r) => {
      const tr = h('tr');
      [r.line, r.code, r.name].forEach((c) => tr.append(h('td', '', String(c ?? ''))));
      const st = h('td');
      st.append(h('span', `badge st-${r.status}`, { new: 'New', update: 'Update', error: 'Error' }[r.status]));
      tr.append(st, h('td', '', r.msg || ''));
      tbody.append(tr);
    });
    table.append(thead, tbody);
    wrap.append(table);
    result.append(wrap);
    if (parsed.rows.length > shown.length) result.append(h('p', 'muted', `Showing the first ${shown.length} of ${parsed.rows.length} rows (errors first).`));
    if (count('error')) result.append(h('p', '', 'Fix the errors in your file and choose it again. Nothing has been imported.'));
    go.disabled = count('error') > 0;
  }

  input.addEventListener('change', async () => {
    parsed = null;
    go.disabled = true;
    result.replaceChildren();
    const file = input.files[0];
    if (!file) return;
    try {
      const sheets = await readWorkbook(file);
      const name = Object.keys(sheets).find((n) => n.trim().toLowerCase() !== 'help');
      const raw = name ? sheets[name] : [];
      if (raw.length > MAX_ROWS) { ui.warn(`That file has more than ${MAX_ROWS} rows. Split it into smaller files.`); return; }
      if (!raw.length) { result.append(h('p', 'muted', 'No rows found in that file.')); return; }
      const res = parseSheet(raw, defs, existing, lk);
      if (res.fatal) { result.append(h('p', '', res.fatal)); return; }
      parsed = res;
      renderPreview();
    } catch (e) {
      ui.errorFrom(e, 'Could not read that file.');
    }
  });

  go.addEventListener('click', async () => {
    const ok = await ui.confirm({
      title: `Import ${cfg.plural}`,
      message: `Import ${parsed.rows.length} rows?\n${count('new')} will be created and ${count('update')} updated. Nothing is deleted.`,
      confirmText: 'Import',
    });
    if (!ok) return;
    go.disabled = true;
    try {
      const { data, error } = await supabase.rpc('import_setup_rows', {
        p_company: ctx.companyId, p_table: cfg.table, p_rows: parsed.rows.map((r) => r.values),
      });
      if (error) throw error;
      close();
      ui.success(`Import complete: ${data.created} created, ${data.updated} updated.`);
      await onDone();
    } catch (e) {
      go.disabled = false;
      ui.errorFrom(e, 'Import failed. Nothing was changed.');
    }
  });
}