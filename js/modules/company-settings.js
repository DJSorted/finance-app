import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';

const ctx = await startPage();

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function main() {
  document.getElementById('company-title').textContent = ctx.company.name;
  const cid = ctx.companyId;
  const [s, acc, tax, terms, inc] = await Promise.all([
    supabase.from('company_settings').select('*').eq('company_id', cid).maybeSingle(),
    supabase.from('gl_accounts').select('id, code, name, control_type').eq('company_id', cid).eq('is_posting', true).in('control_type', ['debtors', 'creditors']).order('code'),
    supabase.from('tax_codes').select('id, code, name, applies_to').eq('company_id', cid).eq('is_active', true).order('code'),
    supabase.from('payment_terms').select('id, code, name').eq('company_id', cid).eq('is_active', true).order('code'),
    supabase.from('gl_accounts').select('id, code, name, control_type, account_groups(class_type)').eq('company_id', cid).eq('is_posting', true).eq('is_active', true).order('code'),
  ]);
  for (const r of [s, acc, tax, terms, inc]) if (r.error) { ui.errorFrom(r.error, 'Could not load the company defaults.'); return; }
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
    { key: 'interest_account_id', label: 'Interest income account',
      options: inc.data.filter((a) => !a.control_type && a.account_groups && a.account_groups.class_type === 'income_statement').map((a) => [a.id, `${a.code} - ${a.name}`]),
      hint: 'Interest charged on overdue customer invoices is posted here.' },
    { key: 'interest_tax_code_id', label: 'Tax code on interest', options: taxOpts('sales'),
      hint: 'Interest is usually exempt. Not set means no tax on interest.' },
  ];

  const body = fields.map((f) => `<div class="field"><label for="${f.key}">${esc(f.label)}</label>
    <select id="${f.key}"${ctx.canEdit ? '' : ' disabled'}>
      <option value="">Not set</option>${f.options.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}
    </select>${f.hint ? `<span class="hint">${esc(f.hint)}</span>` : ''}</div>`).join('');
  const receiving = `<div class="field check"><input id="require_po_for_receiving" type="checkbox"${ctx.canEdit ? '' : ' disabled'}>
    <label for="require_po_for_receiving">Goods can only be received against an approved purchase order</label></div>`;
  const dis = ctx.canEdit ? '' : ' disabled';
  const interest = `<div class="field"><label for="interest_rate">Interest on overdue accounts (% a year)</label>
    <input id="interest_rate" type="number" min="0" step="0.01"${dis}>
    <span class="hint">The default for customers set to the company rate. Leave blank to charge no interest by default.</span></div>
    <div class="field"><label for="interest_grace_days">Interest grace days</label>
    <input id="interest_grace_days" type="number" min="0" step="1"${dis}>
    <span class="hint">Interest starts this many days after the due date.</span></div>`;
  const panel = document.getElementById('panel');
  panel.innerHTML = `<div class="card" style="max-width:640px">${body}${interest}${receiving}
    ${ctx.canEdit ? '<button class="btn btn-primary" id="save" type="button">Save</button>' : ''}</div>`;
  fields.forEach((f) => { document.getElementById(f.key).value = s.data[f.key] || ''; });
  document.getElementById('require_po_for_receiving').checked = !!s.data.require_po_for_receiving;
  document.getElementById('interest_rate').value = s.data.interest_rate ?? '';
  document.getElementById('interest_grace_days').value = s.data.interest_grace_days ?? 0;

  const save = document.getElementById('save');
  if (save) {
    save.addEventListener('click', async () => {
      const rate = document.getElementById('interest_rate').value;
      const grace = document.getElementById('interest_grace_days').value;
      if (rate !== '' && !(Number(rate) >= 0)) return ui.warn('The interest rate cannot be negative.');
      if (grace !== '' && !(Number.isInteger(Number(grace)) && Number(grace) >= 0)) return ui.warn('Grace days must be a whole number, zero or more.');
      save.disabled = true;
      const payload = Object.fromEntries(fields.map((f) => [f.key, document.getElementById(f.key).value || null]));
      payload.require_po_for_receiving = document.getElementById('require_po_for_receiving').checked;
      payload.interest_rate = rate === '' ? null : Number(rate);
      payload.interest_grace_days = grace === '' ? 0 : Number(grace);
      const { error } = await supabase.from('company_settings').update(payload).eq('company_id', cid);
      save.disabled = false;
      if (error) return ui.errorFrom(error);
      ui.saved('Company defaults');
    });
  }
}

if (ctx) main();