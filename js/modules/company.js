import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';

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

async function main() {
  document.getElementById('company-title').textContent = ctx.company.name;
  const cid = ctx.companyId;
  const canEdit = ['owner', 'admin'].includes(ctx.role);

  const [co, cur] = await Promise.all([
    supabase.from('companies').select('*').eq('id', cid).single(),
    supabase.from('company_currencies').select('code, currencies(name)').eq('company_id', cid).eq('is_base', true).maybeSingle(),
  ]);
  for (const r of [co, cur]) if (r.error) { ui.errorFrom(r.error, 'Could not load the company profile.'); return; }

  const base = cur.data ? `${cur.data.code} - ${(cur.data.currencies || {}).name || ''}` : '';
  const fieldHtml = FIELDS.map((f) => {
    const input = f.type === 'textarea'
      ? `<textarea id="f_${f.key}" rows="3"${canEdit ? '' : ' disabled'}></textarea>`
      : `<input id="f_${f.key}" type="${f.type || 'text'}"${canEdit ? '' : ' disabled'}>`;
    return `<div class="field${f.full ? ' full' : ''}"><label for="f_${f.key}">${esc(f.label)}${f.required ? ' *' : ''}</label>${input}${f.hint ? `<span class="hint">${esc(f.hint)}</span>` : ''}</div>`;
  }).join('');

  document.getElementById('panel').innerHTML = `<div class="card" style="max-width:760px">
    <div class="form-grid">${fieldHtml}
      <div class="field full"><label>Base currency</label><input value="${esc(base)}" disabled>
        <span class="hint">Fixed once transactions are posted.</span></div>
    </div>
    ${canEdit ? '<button class="btn btn-primary" id="save" type="button">Save</button>'
      : '<p class="muted">Only owners and admins can edit the company profile.</p>'}
  </div>`;
  FIELDS.forEach((f) => { document.getElementById(`f_${f.key}`).value = co.data[f.key] || ''; });

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
    setTimeout(() => location.reload(), 700);   // the new name appears in the menu
  });
}

if (ctx) main();