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
  bookings: 'Booking', nursery_batches: 'Nursery batch', work_orders: 'Work order',
};

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function fmtSize(n) {
  n = Number(n) || 0;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}
// What to show in a size column: links have no size
export const sizeText = (row) => (row.url ? 'Link' : fmtSize(row.size_bytes));

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

export function validateUrl(u) {
  const s = String(u || '').trim();
  if (!s) return 'Enter the link.';
  if (s.length > 2000) return 'The link is too long.';
  let url;
  try { url = new URL(s); } catch (e) { return 'That does not look like a web address. It should start with https://'; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'Only http and https links are allowed.';
  return '';
}

/* ---------- paperclip on list rows ---------- */

// Per table: record id -> attachment rows. Ids that were fetched and had nothing map to [].
const clipCache = new Map();
const clipCtx = new Map();
const CLIP_COLS = 'id, record_id, file_name, url, storage_path, uploaded_at';

const tableCache = (table) => {
  if (!clipCache.has(table)) clipCache.set(table, new Map());
  return clipCache.get(table);
};

async function fetchClips(ctx, table, ids) {
  const cache = tableCache(table);
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const { data, error } = await supabase.from('attachments').select(CLIP_COLS)
      .eq('company_id', ctx.companyId).eq('table_name', table).in('record_id', chunk).order('uploaded_at', { ascending: false });
    if (error) throw error;
    chunk.forEach((id) => cache.set(id, []));
    data.forEach((r) => cache.get(r.record_id).push(r));
  }
}

function paintClip(td) {
  const rows = (clipCache.get(td.dataset.clipTable) || new Map()).get(td.dataset.clip) || [];
  if (!rows.length) { td.replaceChildren(); return; }
  const b = el('button', 'btn btn-sm clip-btn', rows.length > 1 ? `📎 ${rows.length}` : '📎');
  b.type = 'button';
  b.dataset.clipOpen = '1';
  b.title = rows.length > 1 ? `${rows.length} attachments:\n${rows.map((r) => r.file_name).join('\n')}` : `Open ${rows[0].file_name}`;
  b.setAttribute('aria-label', b.title);
  td.replaceChildren(b);
}

// Empty cell for a list row. Call fillClips(ctx, container) after the table is in the page.
export const clipCell = (table, recordId) => `<td class="clip" data-clip-table="${esc(table)}" data-clip="${esc(recordId)}"></td>`;
export const clipHead = '<th class="clip" aria-label="Attachments"></th>';

// Fills the clip cells in a container. One attachment opens straight away; more opens the attachments dialog.
export async function fillClips(ctx, container, titleFor) {
  const cells = [...container.querySelectorAll('td[data-clip]')];
  const byTable = new Map();
  cells.forEach((td) => {
    const t = td.dataset.clipTable;
    clipCtx.set(t, ctx);
    if (!tableCache(t).has(td.dataset.clip)) {
      if (!byTable.has(t)) byTable.set(t, new Set());
      byTable.get(t).add(td.dataset.clip);
    }
  });
  if (!container._clipBound) {
    container._clipBound = true;
    container.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-clip-open]');
      if (!b) return;
      e.stopPropagation();
      const td = b.closest('td[data-clip]');
      const table = td.dataset.clipTable;
      const rows = tableCache(table).get(td.dataset.clip) || [];
      if (rows.length === 1) return openAttachment(rows[0]);
      await openAttachmentsDialog(ctx, { table, recordId: td.dataset.clip, title: container._clipTitle ? container._clipTitle(td.dataset.clip) : undefined });
    }, true);
  }
  container._clipTitle = titleFor;
  try {
    for (const [t, ids] of byTable) await fetchClips(ctx, t, [...ids]);
  } catch (e) { return; } // the paperclip is a convenience; the list still works without it
  cells.forEach((td) => { if (td.isConnected) paintClip(td); });
}

// After attachments for a record change, refetch them and repaint any clip cell on screen
async function clipChanged(table, recordId) {
  const cache = clipCache.get(table);
  if (!cache) return;
  cache.delete(recordId);
  const ctx = clipCtx.get(table);
  const cells = [...document.querySelectorAll('td[data-clip]')].filter((td) => td.dataset.clipTable === table && td.dataset.clip === recordId);
  if (!ctx || !cells.length) return;
  try { await fetchClips(ctx, table, [recordId]); } catch (e) { return; }
  cells.forEach(paintClip);
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
  clipChanged(table, recordId);
}

// A link to a file kept somewhere else (Drive, Dropbox, a supplier's site)
export async function addAttachmentLink(ctx, table, recordId, url, name, description) {
  const err = validateUrl(url);
  if (err) throw new Error(err);
  const clean = new URL(String(url).trim());
  const { error } = await supabase.from('attachments').insert({
    company_id: ctx.companyId, table_name: table, record_id: recordId,
    file_name: String(name || '').trim() || clean.hostname, storage_path: null, url: clean.href,
    mime_type: null, size_bytes: null, description: description || null, uploaded_by: ctx.session.user.id,
  });
  if (error) throw error;
}

export async function openAttachment(row) {
  if (row.url) {
    const err = validateUrl(row.url);
    if (err) { ui.warn(err); return; }
    window.open(row.url, '_blank', 'noopener,noreferrer');
    return;
  }
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
  if (row.storage_path) {
    const rm = await supabase.storage.from('attachments').remove([row.storage_path]);
    if (rm.error) throw rm.error;
  }
  const { data, error } = await supabase.from('attachments').delete().eq('id', row.id).select('id');
  if (error) throw error;
  if (!data || !data.length) throw new Error('You do not have permission to delete this.');
}

// Change the name and description of an attachment, and the web address if it is a link
export async function updateAttachment(row, { name, description, url }) {
  const fileName = String(name || '').trim();
  if (!fileName) throw new Error('Enter a name.');
  if (fileName.length > 200) throw new Error('The name is too long.');
  const patch = { file_name: fileName, description: String(description || '').trim() || null };
  if (row.url) {
    const err = validateUrl(url);
    if (err) throw new Error(err);
    patch.url = new URL(String(url).trim()).href;
  }
  const { data, error } = await supabase.from('attachments').update(patch).eq('id', row.id).select('id');
  if (error) throw error;
  if (!data || !data.length) throw new Error('You do not have permission to edit this.');
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

// Edit dialog shared by the attach dialog and the attachments page. Resolves true when something was saved.
export function editAttachmentDialog(row) {
  return new Promise((resolve) => {
    const { box, close: closeModal } = makeModal(`Edit ${row.url ? 'link' : 'file details'}`);
    let saved = false;
    const close = () => { closeModal(); resolve(saved); };
    const field = (text, input, full) => { const w = el('div', `field${full ? ' full' : ''}`); w.append(el('label', '', text), input); return w; };
    const nameIn = el('input'); nameIn.value = row.file_name || '';
    const descIn = el('input'); descIn.value = row.description || '';
    const urlIn = el('input'); urlIn.type = 'url'; urlIn.value = row.url || '';
    const grid = el('div', 'form-grid');
    grid.append(field('Name', nameIn, true), field('Description', descIn, true));
    if (row.url) grid.append(field('Link', urlIn, true));
    box.append(grid);
    if (!row.url) box.append(el('p', 'muted', 'This changes the name shown in the system. The stored file itself is not changed.'));
    const actions = el('div', 'modal-actions');
    const saveBtn = btn('Save', 'btn-primary', async () => {
      saveBtn.disabled = true;
      try {
        await updateAttachment(row, { name: nameIn.value, description: descIn.value, url: urlIn.value });
        saved = true;
        close();
      } catch (e) { ui.errorFrom(e, 'Could not save the changes.'); } finally { saveBtn.disabled = false; }
    });
    actions.append(el('span', 'spacer'), btn('Cancel', 'btn-ghost', close), saveBtn);
    box.append(actions);
    nameIn.focus();
  });
}

// The attach button on any record screen calls this: openAttachmentsDialog(ctx, { table: 'fixed_assets', recordId, title })
// Resolves when the dialog is closed.
export function openAttachmentsDialog(ctx, { table, recordId, title }) {
  return new Promise((resolve) => {
    const { box, close: closeModal } = makeModal(title || `Attachments: ${TABLE_LABELS[table] || table}`, 'modal wide');
    const close = () => { closeModal(); clipChanged(table, recordId); resolve(); };
    const canUpload = ['owner', 'admin', 'accountant', 'clerk'].includes(ctx.role);
    const listEl = el('div');
    box.append(listEl);

    async function refresh() {
      const { data, error } = await supabase.from('attachments').select('*')
        .eq('company_id', ctx.companyId).eq('table_name', table).eq('record_id', recordId).order('uploaded_at', { ascending: false });
      if (error) { listEl.textContent = 'Could not load the attachments.'; return; }
      if (!data.length) { listEl.innerHTML = '<p class="muted">Nothing attached yet.</p>'; return; }
      listEl.innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr><th>Name</th><th>Description</th><th>Size</th><th>Added</th><th></th></tr></thead><tbody>${
        data.map((r) => `<tr data-id="${r.id}"><td>${esc(r.file_name)}${r.url ? ' <span class="badge">Link</span>' : ''}</td><td>${esc(r.description || '')}</td>
          <td>${r.url ? '' : fmtSize(r.size_bytes)}</td><td>${String(r.uploaded_at).slice(0, 10)}</td>
          <td><div class="row-actions"><button class="btn btn-sm" data-act="open">Open</button>${canUpload ? '<button class="btn btn-sm" data-act="edit">Edit</button>' : ''}${ctx.canEdit ? '<button class="btn btn-sm" data-act="delete">Delete</button>' : ''}</div></td></tr>`).join('')
      }</tbody></table></div>`;
      listEl._rows = data;
    }
    listEl.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const row = (listEl._rows || []).find((r) => r.id === b.closest('tr').dataset.id);
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
      const fileRow = el('div', 'toolbar');
      fileRow.style.marginTop = '1rem';
      fileRow.append(fileIn, descIn, upBtn);

      const urlIn = el('input'); urlIn.type = 'url'; urlIn.placeholder = 'https://link to the file';
      const nameIn = el('input'); nameIn.placeholder = 'Name (optional)';
      const linkBtn = btn('Add link', '', async () => {
        const err = validateUrl(urlIn.value);
        if (err) return ui.warn(err);
        linkBtn.disabled = true;
        try {
          await addAttachmentLink(ctx, table, recordId, urlIn.value, nameIn.value, descIn.value.trim());
          urlIn.value = ''; nameIn.value = ''; descIn.value = '';
          ui.success('Link added.');
          await refresh();
        } catch (e) { ui.errorFrom(e, 'Could not add the link.'); } finally { linkBtn.disabled = false; }
      });
      const linkRow = el('div', 'toolbar');
      linkRow.append(urlIn, nameIn, linkBtn);
      box.append(fileRow, linkRow, el('p', 'muted', `Upload a PDF, image, Word, Excel, CSV or text file up to ${fmtSize(MAX_BYTES)}, or add a link to a file kept elsewhere. The description applies to either.`));
    }
    const actions = el('div', 'modal-actions');
    actions.append(el('span', 'spacer'), btn('Close', 'btn-ghost', close));
    box.append(actions);
    refresh();
  });
}