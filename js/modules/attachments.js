import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import {
  TABLE_LABELS, ALLOWED_EXT, MAX_BYTES, esc, fmtSize, sizeText, validateFile, validateUrl,
  uploadAttachment, addAttachmentLink, openAttachment, deleteAttachment, editAttachmentDialog, makeModal,
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
const searchEl = el('input'); searchEl.placeholder = 'Search name or description'; searchEl.style.maxWidth = '260px';

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
  if (!rows.length) { panel.innerHTML = '<p class="muted">Nothing has been attached yet. Use Add, or the attach button on a record.</p>'; return; }
  const total = list.reduce((s, r) => s + (r.url ? 0 : Number(r.size_bytes || 0)), 0);
  const body = list.map((r) => `<tr data-id="${r.id}"><td>${String(r.uploaded_at).slice(0, 10)}</td>
    <td>${esc(r.file_name)}${r.url ? ' <span class="badge">Link</span>' : ''}</td>
    <td>${esc(linkText(r))}</td><td>${esc(r.description || '')}</td><td class="num">${sizeText(r)}</td>
    <td><div class="row-actions"><button class="btn btn-sm" data-act="open">Open</button>${CAN_UPLOAD ? '<button class="btn btn-sm" data-act="edit">Edit</button>' : ''}${ctx.canEdit ? '<button class="btn btn-sm" data-act="delete">Delete</button>' : ''}</div></td></tr>`).join('');
  panel.innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr><th>Added</th><th>Name</th><th>Linked to</th><th>Description</th>
    <th style="text-align:right">Size</th><th></th></tr></thead><tbody>${body}
    <tr class="row-root"><td colspan="4">${list.length} item(s)</td><td class="num">${fmtSize(total)}</td><td></td></tr></tbody></table></div>`;
}

panel.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const row = rows.find((r) => r.id === b.closest('tr').dataset.id);
  if (!row) return;
  if (b.dataset.act === 'open') return openAttachment(row);
  if (b.dataset.act === 'edit') {
    if (await editAttachmentDialog(row)) { ui.success('Saved.'); await refresh(); }
    return;
  }
  const ok = await ui.confirm({ title: 'Delete', message: `Delete ${row.file_name}? This cannot be undone.`, confirmText: 'Delete' });
  if (!ok) return;
  try { await deleteAttachment(row); ui.success('Deleted.'); await refresh(); } catch (err) { ui.errorFrom(err, 'Could not delete.'); }
});

async function addItem() {
  const KINDS = { customers: 'Customer', suppliers: 'Supplier', items: 'Item' };
  const { box, close } = makeModal('Add a file or link');
  const field = (text, input) => { const w = el('div', 'field'); w.append(el('label', '', text), input); return w; };
  const kindSel = el('select');
  Object.entries(KINDS).forEach(([k, t]) => option(kindSel, k, t));
  const recSel = el('select');
  const typeSel = el('select');
  option(typeSel, 'file', 'Upload a file');
  option(typeSel, 'link', 'Link to a file');
  const descIn = el('input'); descIn.placeholder = 'Optional';
  const fileIn = el('input'); fileIn.type = 'file'; fileIn.accept = ALLOWED_EXT;
  const urlIn = el('input'); urlIn.type = 'url'; urlIn.placeholder = 'https://';
  const nameIn = el('input'); nameIn.placeholder = 'Optional';
  const fileField = field('File', fileIn);
  const urlField = field('Link', urlIn);
  const nameField = field('Name for the link', nameIn);
  const grid = el('div', 'form-grid');
  grid.append(field('Attach to', kindSel), field('Record', recSel), field('Type', typeSel), field('Description', descIn), fileField, urlField, nameField);
  box.append(grid, el('p', 'muted', `Files up to ${fmtSize(MAX_BYTES)}. Files for other records are added from the record's own screen.`));

  const sync = () => {
    const isFile = typeSel.value === 'file';
    fileField.style.display = isFile ? '' : 'none';
    urlField.style.display = isFile ? 'none' : '';
    nameField.style.display = isFile ? 'none' : '';
  };
  typeSel.addEventListener('change', sync);
  sync();

  async function loadRecords() {
    recSel.replaceChildren();
    const { data, error } = await supabase.from(kindSel.value).select('id, code, name').eq('company_id', ctx.companyId).order('code');
    if (error) { ui.errorFrom(error, 'Could not load the records.'); return; }
    data.forEach((d) => option(recSel, d.id, `${d.code} - ${d.name}`));
  }
  kindSel.addEventListener('change', loadRecords);
  await loadRecords();

  const actions = el('div', 'modal-actions');
  const goBtn = btn('Save', 'btn-primary', async () => {
    if (!recSel.value) return ui.warn('Choose a record.');
    const isFile = typeSel.value === 'file';
    const err = isFile ? validateFile(fileIn.files[0]) : validateUrl(urlIn.value);
    if (err) return ui.warn(err);
    goBtn.disabled = true;
    try {
      if (isFile) await uploadAttachment(ctx, kindSel.value, recSel.value, fileIn.files[0], descIn.value.trim());
      else await addAttachmentLink(ctx, kindSel.value, recSel.value, urlIn.value, nameIn.value, descIn.value.trim());
      close();
      ui.success(isFile ? 'File uploaded.' : 'Link added.');
      await refresh();
    } catch (e) { ui.errorFrom(e, 'Could not save.'); } finally { goBtn.disabled = false; }
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
  if (CAN_UPLOAD) toolbar.append(btn('Add file or link', 'btn-primary', addItem));
  hint.textContent = 'Every file and link attached to a record in this company. Uploaded files are private and open through a short-lived link. Owners, admins, accountants and clerks can edit names and descriptions; only owners, admins and accountants can delete.';
  await refresh();
}

if (ctx) await init();