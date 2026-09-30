import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { setupPage } from '../core/setup-page.js';

const ctx = await startPage();
if (ctx) {
  await setupPage(ctx, {
    table: 'suppliers', noun: 'Supplier', plural: 'suppliers', file: 'suppliers', search: true,
    hint: 'Anything left blank falls back to the company default. Leave the code blank on a new supplier to number it automatically.',
    defaults: { is_active: true },
    duplicateMessage: 'That supplier code already exists.',

    lookups: async (c) => {
      const cid = c.companyId;
      const [cur, terms, tax, acc] = await Promise.all([
        supabase.from('company_currencies').select('code, is_base').eq('company_id', cid).order('code'),
        supabase.from('payment_terms').select('id, code, name').eq('company_id', cid).eq('is_active', true).order('code'),
        supabase.from('tax_codes').select('id, code, name, applies_to').eq('company_id', cid).eq('is_active', true).order('code'),
        supabase.from('gl_accounts').select('id, code, name').eq('company_id', cid).eq('control_type', 'creditors').eq('is_posting', true).order('code'),
      ]);
      for (const r of [cur, terms, tax, acc]) if (r.error) throw r.error;
      return {
        currencies: cur.data, terms: terms.data, accounts: acc.data,
        taxes: tax.data.filter((t) => t.applies_to === 'purchases' || t.applies_to === 'both'),
      };
    },

    columns: (lk) => {
      const base = (lk.currencies.find((c) => c.is_base) || {}).code || '';
      const term = (id) => { const t = lk.terms.find((x) => x.id === id); return t ? t.code : ''; };
      return [
        { header: 'Code', text: (r) => r.code, width: 14 },
        { header: 'Name', text: (r) => r.name, width: 32 },
        { header: 'Currency', text: (r) => r.currency_code || base, width: 10 },
        { header: 'Terms', text: (r) => term(r.payment_terms_id), width: 12 },
        { header: 'Email', text: (r) => r.email || '', width: 28 },
        { header: 'Phone', text: (r) => r.phone || '', width: 16 },
        { header: 'Active', text: (r) => (r.is_active ? 'Yes' : 'No'), width: 8 },
      ];
    },

    fields: (lk) => {
      const base = (lk.currencies.find((c) => c.is_base) || {}).code || '';
      return [
        { name: 'code', label: 'Code' },
        { name: 'name', label: 'Name', required: true },
        { name: 'tax_number', label: 'Tax / registration number' },
        { name: 'contact_name', label: 'Contact person' },
        { name: 'email', label: 'Email', type: 'email' },
        { name: 'phone', label: 'Phone' },
        { name: 'address', label: 'Address', type: 'textarea', full: true },
        { name: 'country', label: 'Country' },
        { name: 'currency_code', label: 'Currency', type: 'select',
          options: [{ value: '', label: `Base currency (${base})` }].concat(lk.currencies.filter((c) => !c.is_base).map((c) => ({ value: c.code, label: c.code }))) },
        { name: 'payment_terms_id', label: 'Payment terms', type: 'select',
          options: [{ value: '', label: 'Company default' }].concat(lk.terms.map((t) => ({ value: t.id, label: `${t.code} - ${t.name}` }))) },
        { name: 'tax_code_id', label: 'Tax code', type: 'select',
          options: [{ value: '', label: 'Company default' }].concat(lk.taxes.map((t) => ({ value: t.id, label: `${t.code} - ${t.name}` }))) },
        { name: 'control_account_id', label: 'Creditors control account', type: 'select', full: true,
          options: [{ value: '', label: 'Company default' }].concat(lk.accounts.map((a) => ({ value: a.id, label: `${a.code} - ${a.name}` }))),
          hint: 'Only posting accounts with control type Creditors are listed.' },
        { name: 'notes', label: 'Notes', type: 'textarea', full: true },
        { name: 'is_active', label: 'Active', type: 'checkbox' },
      ];
    },

    validate: (v) => {
      if (v.email && !/^\S+@\S+\.\S+$/.test(v.email)) throw new Error('Enter a valid email address.');
    },

    toPayload: (v) => ({
      code: v.code, name: v.name, tax_number: v.tax_number || null, contact_name: v.contact_name || null,
      email: v.email || null, phone: v.phone || null, address: v.address || null, country: v.country || null,
      currency_code: v.currency_code || null, payment_terms_id: v.payment_terms_id || null,
      tax_code_id: v.tax_code_id || null, control_account_id: v.control_account_id || null,
      notes: v.notes || null, is_active: v.is_active,
    }),
  });
}