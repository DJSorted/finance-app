import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';

const ctx = await startPage();

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function main() {
  document.getElementById('company-title').textContent = ctx.company.name;
  const cid = ctx.companyId;
  const [s, acc, tax, terms] = await Promise.all([
    supabase.from('company_settings').select('*').eq('company_id', cid).maybeSingle(),
    supabase.from('gl_accounts').select('id, code, name, control_type').eq('company_id', cid).eq('is_posting', true).in('control_type', ['debtors', 'creditors']).order('code'),
    supabase.from('tax_codes').select('id, code, name, applies_to').eq('company_id', cid).eq('is_active', true).order('code'),
    supabase.from('payment_terms').select('id, code, name').eq('company_id', cid).eq('is_active', true).order('code'),
  ]);
  for (const r of [s, acc, tax, terms]) if (r.error) { ui.errorFrom(r.error, 'Could not load the company defaults.'); return; }
  if (!s.data) { ui.warn('Company defaults have not been created for this company yet.'); return; }

  const accOpts = (type) => acc.data.filter((a) => a.control_type === type).map((a) => [a.id, `${a.code} - ${a.name}`]);
  const taxOpts = (side) => tax.data.filter((t) => t.applies_to === side || t.applies_to === 'both').map((t) => [t.id, `${t.code} - ${t.name}`]);
  const termOpts = terms.data.map((t) => [t.id, `${t.code} - ${t.name}`]);

  const fields = [
    { key: 'debtors_account_id', label: 'Debtors control account', options: accOpts('debtors'),
      hint: 'A posting account with control type Debtors, created in the Chart of Accounts.' },
    { key: 'creditors_account_id', label: 'Creditors control account', options: accOpts('creditors'),
      hint: 'A posting account with control type Creditors.' },
    { key: 'default_sales_tax_code_id', label: 'Default sales tax code', options: taxOpts('sales') },
    { key: 'default_purchase_tax_code_id', label: 'Default purchases tax code', options: taxOpts('purchases') },
    { key: 'customer_payment_terms_id', label: 'Default customer payment terms', options: termOpts },
    { key: 'supplier_payment_terms_id', label: 'Default supplier payment terms', options: termOpts },
  ];

  const body = fields.map((f) => `<div class="field"><label for="${f.key}">${esc(f.label)}</label>
    <select id="${f.key}"${ctx.canEdit ? '' : ' disabled'}>
      <option value="">Not set</option>${f.options.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}
    </select>${f.hint ? `<span class="hint">${esc(f.hint)}</span>` : ''}</div>`).join('');
  const panel = document.getElementById('panel');
  panel.innerHTML = `<div class="card" style="max-width:640px">${body}
    ${ctx.canEdit ? '<button class="btn btn-primary" id="save" type="button">Save</button>' : ''}</div>`;
  fields.forEach((f) => { document.getElementById(f.key).value = s.data[f.key] || ''; });

  const save = document.getElementById('save');
  if (save) {
    save.addEventListener('click', async () => {
      save.disabled = true;
      const payload = Object.fromEntries(fields.map((f) => [f.key, document.getElementById(f.key).value || null]));
      const { error } = await supabase.from('company_settings').update(payload).eq('company_id', cid);
      save.disabled = false;
      if (error) return ui.errorFrom(error);
      ui.saved('Company defaults');
    });
  }
}

if (ctx) main();