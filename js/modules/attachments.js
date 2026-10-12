import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import {
  TABLE_LABELS, ALLOWED_EXT, MAX_BYTES, esc, fmtSize, validateFile, uploadAttachment, openAttachment, deleteAttachment, makeModal,
} from '../core/attachments.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const panel = document.getElementById('panel');

const PAGE = 1000;
const LABEL_COLUMNS = { customers: 'code, name', suppliers: 'code, name', items: 'code, name', journals: 'journal_no' };
const CAN_UPLOAD = ctx ? ['owner', 'admin', 'accountant', 'clerk'].includes(ctx.role) : false;

let rows = [];
let labels = new Map();

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

const tableSel = el('select'); tableSel.style.width = 'auto';
const searchEl = el('input'); searchEl.placeholder = 'Search file or description'; searchEl.style.maxWidth = '260px';

async function load() {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('attachments').select('*').eq('company_id', ctx.companyId)
      .order('uploaded_at', { ascending: false }).order('id').range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  rows = out;

  labels = new Map();
  const byTable = new Map();
  rows.forEach((r) => { if (!byTable.has(r.table_name)) byTable.set(r.table_name, new Set()); byTable.get(r.table_name).add(r.record_id); });
  for (const [t, set] of byTable) {
    if (!LABEL_COLUMNS[t]) continue;
    const ids = [...set];
    for (let i = 0; i < ids.length; i += 100) {
      const { data } = await supabase.from(t).select(`id, ${LABEL_COLUMNS[t]}`).in('id', ids.slice(i, i + 100));
      (data || []).forEach((d) => labels.set(`${t}:${d.id}`, t === 'journals' ? (d.journal_no || 'Draft journal') : `${d.code} - ${d.name}`));
    }
  }
}

function linkText(r) {
  const kind = TABLE_LABELS[r.table_name] || r.table_name;
  const name = labels.get(`${r.table_name}:${r.record_id}`);
  return name ? `${kind}: ${name}` : `${kind} (${String(r.record_id).slice(0, 8)})`;
}

function fillTableFilter() {
  const keep = tableSel.value;
  tableSel.replaceChildren();
  option(tableSel, '', 'All records');
  [...new Set(rows.map((r) => r.table_name))].sort().forEach((t) => option(tableSel, t, TABLE_LABELS[t] || t));
  tableSel.value = [...tableSel.options].some((o) => o.value === keep) ? keep : '';
}

function render() {
  const q = searchEl.value.trim().toLowerCase();
  const list = rows.filter((r) => (!tableSel.value || r.table_name === tableSel.value)
    && (!q || r.file_name.toLowerCase().includes(q) || (r.description || '').toLowerCase().includes(q)));
  if (!rows.length) { panel.innerHTML = '<p class="muted">No files have been attached yet. Use Add file, or the attach button on a record.</p>'; return; }
  const total = list.reduce((s, r) => s + Number(r.size_bytes || 0), 0);
  const body = list.map((r) => `<tr data-id="${r.id}"><td>${String(r.uploaded_at).slice(0, 10)}</td><td>${esc(r.file_name)}</td>
    <td>${esc(linkText(r))}</td><td>${esc(r.description || '')}</td><td class="num">${fmtSize(r.size_bytes)}</td>
    <td><div class="row-actions"><button class="btn btn-sm" data-act="open">Open</button>${ctx.canEdit ? '<button class="btn btn-sm" data-act="delete">Delete</button>' : ''}</div></td></tr>`).join('');
  panel.innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr><th>Added</th><th>File</th><th>Linked to</th><th>Description</th>
    <th style="text-align:right">Size</th><th></th></tr></thead><tbody>${body}
    <tr class="row-root"><td colspan="4">${list.length} file(s)</td><td class="num">${fmtSize(total)}</td><td></td></tr></tbody></table></div>`;
}

panel.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const row = rows.find((r) => r.id === b.closest('tr').dataset.id);
  if (!row) return;
  if (b.dataset.act === 'open') return openAttachment(row);
  const ok = await ui.confirm({ title: 'Delete file', message: `Delete ${row.file_name}? This cannot be undone.`, confirmText: 'Delete' });
  if (!ok) return;
  try { await deleteAttachment(row); ui.success('File deleted.'); await refresh(); } catch (err) { ui.errorFrom(err, 'Could not delete the file.'); }
});

async function addFile() {
  const KINDS = { customers: 'Customer', suppliers: 'Supplier', items: 'Item' };
  const { box, close } = makeModal('Add a file');
  const field = (text, input) => { const w = el('div', 'field'); w.append(el('label', '', text), input); return w; };
  const kindSel = el('select');
  Object.entries(KINDS).forEach(([k, t]) => option(kindSel, k, t));
  const recSel = el('select');
  const descIn = el('input'); descIn.placeholder = 'Optional';
  const fileIn = el('input'); fileIn.type = 'file'; fileIn.accept = ALLOWED_EXT;
  const grid = el('div', 'form-grid');
  grid.append(field('Attach to', kindSel), field('Record', recSel), field('Description', descIn), field('File', fileIn));
  box.append(grid, el('p', 'muted', `Up to ${fmtSize(MAX_BYTES)}. Files for other records are added from the record's own screen.`));

  async function loadRecords() {
    recSel.replaceChildren();
    const { data, error } = await supabase.from(kindSel.value).select('id, code, name').eq('company_id', ctx.companyId).order('code');
    if (error) { ui.errorFrom(error, 'Could not load the records.'); return; }
    data.forEach((d) => option(recSel, d.id, `${d.code} - ${d.name}`));
  }
  kindSel.addEventListener('change', loadRecords);
  await loadRecords();

  const actions = el('div', 'modal-actions');
  const goBtn = btn('Upload', 'btn-primary', async () => {
    if (!recSel.value) return ui.warn('Choose a record.');
    const file = fileIn.files[0];
    const err = validateFile(file);
    if (err) return ui.warn(err);
    goBtn.disabled = true;
    try {
      await uploadAttachment(ctx, kindSel.value, recSel.value, file, descIn.value.trim());
      close();
      ui.success('File uploaded.');
      await refresh();
    } catch (e) { ui.errorFrom(e, 'Could not upload the file.'); } finally { goBtn.disabled = false; }
  });
  actions.append(el('span', 'spacer'), btn('Cancel', 'btn-ghost', close), goBtn);
  box.append(actions);
}

async function refresh() {
  try { await load(); } catch (e) { ui.errorFrom(e, 'Could not load the attachments.'); return; }
  fillTableFilter();
  render();
}

async function init() {
  document.getElementById('company-title').textContent = ctx.company.name;
  tableSel.addEventListener('change', render);
  let t;
  searchEl.addEventListener('input', () => { clearTimeout(t); t = setTimeout(render, 250); });
  toolbar.append(tableSel, searchEl, btn('Refresh', '', refresh), el('span', 'spacer'));
  if (CAN_UPLOAD) toolbar.append(btn('Add file', 'btn-primary', addFile));
  hint.textContent = 'Every file attached to a record in this company. Files are private and open through a short-lived link. Only owners, admins and accountants can delete.';
  await refresh();
}

if (ctx) await init();