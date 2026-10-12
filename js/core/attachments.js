import { supabase } from './supabase.js';
import { ui } from './ui.js';

export const MAX_BYTES = 10 * 1024 * 1024;
export const ALLOWED_EXT = '.pdf,.png,.jpg,.jpeg,.webp,.gif,.doc,.docx,.xls,.xlsx,.csv,.txt';
const EXT_MIME = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv', txt: 'text/plain',
};
const ALLOWED_MIME = new Set(Object.values(EXT_MIME));

export const TABLE_LABELS = {
  journals: 'Journal', sales_documents: 'Invoice / credit note', customer_receipts: 'Receipt', customers: 'Customer',
  purchase_documents: 'Bill / supplier credit note', supplier_payments: 'Supplier payment', suppliers: 'Supplier',
  purchase_orders: 'Purchase order', goods_receipts: 'Goods received', items: 'Item', fixed_assets: 'Fixed asset',
  bookings: 'Booking', nursery_batches: 'Nursery batch',
};

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function fmtSize(n) {
  n = Number(n) || 0;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

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

function mimeOf(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return EXT_MIME[ext] || file.type || '';
}

export function validateFile(file) {
  if (!file) return 'Choose a file.';
  if (file.size > MAX_BYTES) return `The file is ${fmtSize(file.size)}. The limit is ${fmtSize(MAX_BYTES)}.`;
  if (!file.size) return 'The file is empty.';
  if (!ALLOWED_MIME.has(mimeOf(file))) return 'That file type is not allowed. Use PDF, images, Word, Excel, CSV or text files.';
  return '';
}

// Files are stored under <company id>/..., which is what the storage policies check
export async function uploadAttachment(ctx, table, recordId, file, description) {
  const err = validateFile(file);
  if (err) throw new Error(err);
  const mime = mimeOf(file);
  const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, '_');
  const path = `${ctx.companyId}/${table}/${recordId}/${crypto.randomUUID()}-${safe}`;
  const up = await supabase.storage.from('attachments').upload(path, file, { contentType: mime, upsert: false });
  if (up.error) throw up.error;
  const { error } = await supabase.from('attachments').insert({
    company_id: ctx.companyId, table_name: table, record_id: recordId, file_name: file.name, storage_path: path,
    mime_type: mime, size_bytes: file.size, description: description || null, uploaded_by: ctx.session.user.id,
  });
  if (error) {
    await supabase.storage.from('attachments').remove([path]);
    throw error;
  }
}

export async function openAttachment(row) {
  const w = window.open('about:blank', '_blank');
  const { data, error } = await supabase.storage.from('attachments').createSignedUrl(row.storage_path, 120);
  if (error || !data) {
    if (w) w.close();
    ui.errorFrom(error || new Error('No link'), 'Could not open the file.');
    return;
  }
  if (w) { w.opener = null; w.location.href = data.signedUrl; } else { location.href = data.signedUrl; }
}

export async function deleteAttachment(row) {
  const rm = await supabase.storage.from('attachments').remove([row.storage_path]);
  if (rm.error) throw rm.error;
  const { data, error } = await supabase.from('attachments').delete().eq('id', row.id).select('id');
  if (error) throw error;
  if (!data || !data.length) throw new Error('You do not have permission to delete this file.');
}

export function makeModal(title, cls = 'modal') {
  const prev = document.activeElement;
  const backdrop = el('div', 'modal-backdrop');
  const box = el('div', cls);
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.append(el('h3', 'modal-title', title));
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const close = () => {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    if (prev && prev.focus) prev.focus();
  };
  document.addEventListener('keydown', onKey);
  backdrop.append(box);
  document.body.append(backdrop);
  return { box, close };
}

// The attach button on any record screen calls this: openAttachmentsDialog(ctx, { table: 'bills', recordId, title })
export async function openAttachmentsDialog(ctx, { table, recordId, title }) {
  const { box, close } = makeModal(title || `Attachments: ${TABLE_LABELS[table] || table}`, 'modal wide');
  const canUpload = ['owner', 'admin', 'accountant', 'clerk'].includes(ctx.role);
  const listEl = el('div');
  box.append(listEl);

  async function refresh() {
    const { data, error } = await supabase.from('attachments').select('*')
      .eq('company_id', ctx.companyId).eq('table_name', table).eq('record_id', recordId).order('uploaded_at', { ascending: false });
    if (error) { listEl.textContent = 'Could not load the attachments.'; return; }
    if (!data.length) { listEl.innerHTML = '<p class="muted">No files attached yet.</p>'; return; }
    listEl.innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr><th>File</th><th>Description</th><th>Size</th><th>Added</th><th></th></tr></thead><tbody>${
      data.map((r) => `<tr data-id="${r.id}"><td>${esc(r.file_name)}</td><td>${esc(r.description || '')}</td>
        <td>${fmtSize(r.size_bytes)}</td><td>${String(r.uploaded_at).slice(0, 10)}</td>
        <td><div class="row-actions"><button class="btn btn-sm" data-act="open">Open</button>${ctx.canEdit ? '<button class="btn btn-sm" data-act="delete">Delete</button>' : ''}</div></td></tr>`).join('')
    }</tbody></table></div>`;
    listEl._rows = data;
  }
  listEl.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const row = (listEl._rows || []).find((r) => r.id === b.closest('tr').dataset.id);
    if (!row) return;
    if (b.dataset.act === 'open') return openAttachment(row);
    const ok = await ui.confirm({ title: 'Delete file', message: `Delete ${row.file_name}? This cannot be undone.`, confirmText: 'Delete' });
    if (!ok) return;
    try { await deleteAttachment(row); ui.success('File deleted.'); await refresh(); } catch (err) { ui.errorFrom(err, 'Could not delete the file.'); }
  });

  if (canUpload) {
    const fileIn = el('input'); fileIn.type = 'file'; fileIn.accept = ALLOWED_EXT;
    const descIn = el('input'); descIn.placeholder = 'Description (optional)';
    const upBtn = btn('Upload', 'btn-primary', async () => {
      const file = fileIn.files[0];
      const err = validateFile(file);
      if (err) return ui.warn(err);
      upBtn.disabled = true;
      try {
        await uploadAttachment(ctx, table, recordId, file, descIn.value.trim());
        fileIn.value = ''; descIn.value = '';
        ui.success('File uploaded.');
        await refresh();
      } catch (e) { ui.errorFrom(e, 'Could not upload the file.'); } finally { upBtn.disabled = false; }
    });
    const row = el('div', 'toolbar');
    row.style.marginTop = '1rem';
    row.append(fileIn, descIn, upBtn);
    box.append(row, el('p', 'muted', `PDF, images, Word, Excel, CSV or text, up to ${fmtSize(MAX_BYTES)}.`));
  }
  const actions = el('div', 'modal-actions');
  actions.append(el('span', 'spacer'), btn('Close', 'btn-ghost', close));
  box.append(actions);
  await refresh();
}