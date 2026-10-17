import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';

const ctx = await startPage();

const hint = document.getElementById('hint');
const panel = document.getElementById('panel');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num0 = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

async function storagePaths() {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('attachments').select('storage_path')
      .eq('company_id', ctx.companyId).not('storage_path', 'is', null).order('id').range(from, from + 999);
    if (error) throw error;
    out.push(...data.map((r) => r.storage_path));
    if (data.length < 1000) break;
  }
  return out;
}

async function init() {
  document.getElementById('company-title').textContent = ctx.company.name;
  hint.textContent = 'Permanently removes this company and all of its records. Only an owner can do this.';
  if (ctx.role !== 'owner') {
    panel.innerHTML = '<p class="muted">Only an owner of this company can delete it.</p>';
    return;
  }

  const [counts, posted, files] = await Promise.all([
    Promise.resolve(supabase.rpc('data_record_counts', { p_company: ctx.companyId })).catch(() => ({ error: true })),
    supabase.from('journals').select('id', { count: 'exact', head: true }).eq('company_id', ctx.companyId).eq('status', 'posted'),
    supabase.from('attachments').select('id', { count: 'exact', head: true }).eq('company_id', ctx.companyId),
  ]);
  const total = counts.error || !counts.data ? null : counts.data.reduce((s, r) => s + Number(r.records), 0);

  const root = el('div');
  const info = el('div');
  info.innerHTML = `<h3 style="margin-top:0">${esc(ctx.company.name)}</h3>
    <p>${total === null ? 'This company holds records in many tables.' : `This company holds <strong>${num0(total)}</strong> records`}${posted.count ? `, including <strong>${num0(posted.count)}</strong> posted journals` : ''}${files.count ? ` and <strong>${num0(files.count)}</strong> attachments` : ''}.</p>
    <ul>
      <li>Everything is deleted for good: the ledger, customers, suppliers, stock, assets, documents, attachments and settings.</li>
      <li>Every user loses access to this company. Their sign-in accounts are not deleted.</li>
      <li>It cannot be undone. There is no recycle bin.</li>
    </ul>
    <p><a class="btn" href="/pages/data-export.html">Export all the data first</a></p>`;
  root.append(info);

  const card = el('div', 'card');
  card.style.borderColor = 'var(--danger)';
  card.innerHTML = `<h4 style="margin-top:0;color:var(--danger)">Delete this company</h4>
    <div class="field"><label for="dc-name">Type the company name to confirm: <strong>${esc(ctx.company.name)}</strong></label>
      <input id="dc-name" type="text" autocomplete="off"></div>
    <div class="field check"><input id="dc-ok" type="checkbox" style="width:auto"><label for="dc-ok">I understand this permanently deletes the company and all of its data.</label></div>`;
  const go = el('button', 'btn btn-danger', 'Delete company permanently');
  go.type = 'button';
  go.disabled = true;
  card.append(go);
  root.append(card);
  panel.replaceChildren(root);

  const nameIn = card.querySelector('#dc-name');
  const okIn = card.querySelector('#dc-ok');
  const sync = () => { go.disabled = !(okIn.checked && nameIn.value.trim() === ctx.company.name); };
  nameIn.addEventListener('input', sync);
  okIn.addEventListener('change', sync);

  go.addEventListener('click', async () => {
    const sure = await ui.confirm({
      title: 'Delete company',
      message: `Delete ${ctx.company.name} and everything in it?\nThis cannot be undone.`,
      confirmText: 'Delete permanently',
      danger: true,
    });
    if (!sure) return;
    go.disabled = true;
    let paths = [];
    try { paths = await storagePaths(); } catch (e) { paths = []; }
    const { error } = await supabase.rpc('delete_company', { p_company: ctx.companyId, p_confirm_name: nameIn.value.trim() });
    if (error) { go.disabled = false; return ui.errorFrom(error, 'Could not delete the company.'); }
    let failed = 0;
    for (let i = 0; i < paths.length; i += 100) {
      const { error: e2 } = await supabase.storage.from('attachments').remove(paths.slice(i, i + 100));
      if (e2) failed += 1;
    }
    ui.success('Company deleted.');
    if (failed) ui.warn('Some stored files could not be removed. They are no longer reachable from the app.');
    setTimeout(() => { location.href = '/'; }, 1200);
  });
}

if (ctx) await init();