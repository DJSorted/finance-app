import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { logoUrl } from '../core/logo.js';

const ctx = await startPage();

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const FIELDS = [
  { key: 'name', label: 'Company name', required: true, full: true, hint: 'Shown in the menu and on documents.' },
  { key: 'legal_name', label: 'Legal / registered name' },
  { key: 'registration_number', label: 'Registration number' },
  { key: 'tax_number', label: 'Tax / VAT number' },
  { key: 'email', label: 'Email', type: 'email' },
  { key: 'phone', label: 'Phone' },
  { key: 'website', label: 'Website' },
  { key: 'country', label: 'Country' },
  { key: 'address', label: 'Address', type: 'textarea', full: true },
];

async function changeBase(current) {
  const { data: list, error } = await supabase.from('currencies').select('code, name').order('code');
  if (error) return ui.errorFrom(error, 'Could not load currencies.');
  let chosen = null;
  const picked = await ui.form({
    title: 'Change base currency',
    fields: [{
      name: 'code', label: 'New base currency', type: 'select', required: true, full: true,
      options: list.map((c) => ({ value: c.code, label: `${c.code} - ${c.name}` })),
      hint: 'Only possible before any transaction is posted. Enabled currencies, exchange rates and rate rules are kept.',
    }],
    values: { code: current },
    onSubmit: async (v) => {
      if (v.code === current) throw new Error('That is already the base currency.');
      chosen = v.code;
    },
  });
  if (!picked || !chosen) return;
  const ok = await ui.confirm({
    title: 'Change base currency',
    message: `Change the base currency from ${current} to ${chosen}?\nThis is only allowed while no transactions exist, and it cannot be changed again after the first posting.`,
    confirmText: 'Change', danger: true,
  });
  if (!ok) return;
  const { error: e2 } = await supabase.rpc('change_base_currency', { p_company: ctx.companyId, p_code: chosen });
  if (e2) return ui.errorFrom(e2);
  ui.updated('Base currency');
  setTimeout(() => location.reload(), 700);
}

async function main() {
  document.getElementById('company-title').textContent = ctx.company.name;
  const cid = ctx.companyId;
  const canEdit = ['owner', 'admin'].includes(ctx.role);
  const isOwner = ctx.role === 'owner';

  const [co, cur] = await Promise.all([
    supabase.from('companies').select('*').eq('id', cid).single(),
    supabase.from('company_currencies').select('code, currencies(name)').eq('company_id', cid).eq('is_base', true).maybeSingle(),
  ]);
  for (const r of [co, cur]) if (r.error) { ui.errorFrom(r.error, 'Could not load the company profile.'); return; }

  const baseCode = cur.data ? cur.data.code : '';
  const base = cur.data ? `${cur.data.code} - ${(cur.data.currencies || {}).name || ''}` : '';
  const fieldHtml = FIELDS.map((f) => {
    const input = f.type === 'textarea'
      ? `<textarea id="f_${f.key}" rows="3"${canEdit ? '' : ' disabled'}></textarea>`
      : `<input id="f_${f.key}" type="${f.type || 'text'}"${canEdit ? '' : ' disabled'}>`;
    return `<div class="field${f.full ? ' full' : ''}"><label for="f_${f.key}">${esc(f.label)}${f.required ? ' *' : ''}</label>${input}${f.hint ? `<span class="hint">${esc(f.hint)}</span>` : ''}</div>`;
  }).join('');

    const logoHtml = `<div class="field full"><label>Logo</label>
    <div style="display:flex;align-items:center;gap:1rem;flex-wrap:wrap">
      <div id="logo-preview" style="min-width:120px;min-height:48px;display:flex;align-items:center"></div>
      ${canEdit ? '<input id="logo-file" type="file" accept="image/png,image/jpeg,image/webp" style="width:auto"><button class="btn btn-sm" id="logo-remove" type="button">Remove logo</button>' : ''}
    </div>
    <span class="hint">PNG, JPEG or WebP, up to 1 MB. Shown in the menu and later on documents. Anyone with the image link can view it.</span></div>`;

  document.getElementById('panel').innerHTML = `<div class="card" style="max-width:760px">
    <div class="form-grid">${logoHtml}${fieldHtml}
      <div class="field full"><label>Base currency</label>
        <div style="display:flex;gap:.5rem"><input value="${esc(base)}" disabled>
          ${isOwner ? '<button class="btn" id="chg-base" type="button">Change</button>' : ''}</div>
        <span class="hint">Can be changed by the owner until the first transaction is posted.</span></div>
    </div>
    ${canEdit ? '<button class="btn btn-primary" id="save" type="button">Save</button>'
      : '<p class="muted">Only owners and admins can edit the company profile.</p>'}
  </div>`;
  FIELDS.forEach((f) => { document.getElementById(`f_${f.key}`).value = co.data[f.key] || ''; });

    const LOGO_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
  const preview = document.getElementById('logo-preview');
  const currentUrl = logoUrl(co.data);
  if (currentUrl) {
    const img = document.createElement('img');
    img.src = currentUrl;
    img.alt = 'Company logo';
    img.style.cssText = 'max-height:64px;max-width:220px';
    preview.append(img);
  } else {
    const none = document.createElement('span');
    none.className = 'muted';
    none.textContent = 'No logo yet';
    preview.append(none);
  }

  async function setLogo(path) {
    const { data: upd, error } = await supabase.from('companies')
      .update({ logo_path: path, logo_updated_at: new Date().toISOString() }).eq('id', cid).select('id');
    if (error) throw error;
    if (!upd || !upd.length) throw new Error('You do not have permission to change the logo.');
  }

  const fileIn = document.getElementById('logo-file');
  if (fileIn) {
    fileIn.addEventListener('change', async () => {
      const f = fileIn.files[0];
      if (!f) return;
      if (!LOGO_TYPES[f.type]) { fileIn.value = ''; return ui.warn('Use a PNG, JPEG or WebP image.'); }
      if (f.size > 1048576) { fileIn.value = ''; return ui.warn('The logo must be 1 MB or smaller.'); }
      const path = `${cid}/logo-${Date.now()}.${LOGO_TYPES[f.type]}`;
      const up = await supabase.storage.from('logos').upload(path, f, { contentType: f.type });
      if (up.error) { fileIn.value = ''; return ui.errorFrom(up.error, 'Could not upload the logo.'); }
      try {
        await setLogo(path);
      } catch (e) {
        await supabase.storage.from('logos').remove([path]);
        fileIn.value = '';
        return ui.errorFrom(e, 'Could not save the logo.');
      }
      if (co.data.logo_path) await supabase.storage.from('logos').remove([co.data.logo_path]);
      ui.saved('Logo');
      setTimeout(() => location.reload(), 600);
    });

    document.getElementById('logo-remove').addEventListener('click', async () => {
      if (!co.data.logo_path) return ui.warn('There is no logo to remove.');
      if (!(await ui.confirmDelete('Logo'))) return;
      try { await setLogo(null); } catch (e) { return ui.errorFrom(e); }
      await supabase.storage.from('logos').remove([co.data.logo_path]);
      ui.deleted('Logo');
      setTimeout(() => location.reload(), 600);
    });
  }

  const chg = document.getElementById('chg-base');
  if (chg) chg.addEventListener('click', () => changeBase(baseCode));

  const save = document.getElementById('save');
  if (!save) return;
  save.addEventListener('click', async () => {
    const v = Object.fromEntries(FIELDS.map((f) => [f.key, document.getElementById(`f_${f.key}`).value.trim()]));
    if (!v.name) return ui.warn('Company name is required.');
    if (v.email && !/^\S+@\S+\.\S+$/.test(v.email)) return ui.warn('Enter a valid email address.');
    save.disabled = true;
    const payload = Object.fromEntries(FIELDS.map((f) => [f.key, f.key === 'name' ? v.name : (v[f.key] || null)]));
    const { error } = await supabase.from('companies').update(payload).eq('id', cid);
    save.disabled = false;
    if (error) return ui.errorFrom(error);
    ui.saved('Company profile');
    setTimeout(() => location.reload(), 700);
  });
}

if (ctx) main();