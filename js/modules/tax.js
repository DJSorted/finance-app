import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { setupPage } from '../core/setup-page.js';

const APPLIES = [['both', 'Sales and purchases'], ['sales', 'Sales only'], ['purchases', 'Purchases only']];
const appliesLabel = (v) => (APPLIES.find((a) => a[0] === v) || [v, v])[1];

const ctx = await startPage();
if (ctx) {
  await setupPage(ctx, {
    table: 'tax_codes', noun: 'Tax code', plural: 'tax codes', file: 'tax-codes',
    hint: 'Tax codes carry the rate and the accounts tax posts to. Items, customers and suppliers will get a default tax code that flows onto transactions. '
      + 'To change a rate, add a new code and deactivate the old one. Posted transactions keep the rate they were booked with.',
    defaults: { rate: 0, applies_to: 'both', is_active: true },
    duplicateMessage: 'That tax code already exists.',

    lookups: async (c) => {
      const { data, error } = await supabase.from('gl_accounts').select('id, code, name')
        .eq('company_id', c.companyId).eq('control_type', 'tax').eq('is_posting', true).order('code');
      if (error) throw error;
      return { accounts: data };
    },

    columns: (lk) => {
      const acc = (id) => { const a = lk.accounts.find((x) => x.id === id); return a ? `${a.code} ${a.name}` : ''; };
      return [
        { header: 'Code', text: (r) => r.code, width: 12 },
        { header: 'Name', text: (r) => r.name, width: 30 },
        { header: 'Rate %', num: true, text: (r) => `${Number(r.rate)}%`, width: 10 },
        { header: 'Used on', text: (r) => appliesLabel(r.applies_to), width: 20 },
        { header: 'Sales tax account', text: (r) => acc(r.output_account_id), width: 28 },
        { header: 'Purchases tax account', text: (r) => acc(r.input_account_id), width: 28 },
        { header: 'Active', text: (r) => (r.is_active ? 'Yes' : 'No'), width: 8 },
      ];
    },

    fields: (lk) => {
      const accs = [{ value: '', label: 'None' }, ...lk.accounts.map((a) => ({ value: a.id, label: `${a.code} - ${a.name}` }))];
      const hint = lk.accounts.length
        ? 'Only posting accounts with control type Tax are listed.'
        : 'No tax accounts yet. Create posting accounts with control type Tax in the Chart of Accounts first.';
      return [
        { name: 'code', label: 'Code', required: true },
        { name: 'name', label: 'Name', required: true },
        { name: 'rate', label: 'Rate (%)', type: 'number', required: true },
        { name: 'applies_to', label: 'Used on', type: 'select', required: true, options: APPLIES.map(([value, label]) => ({ value, label })) },
        { name: 'output_account_id', label: 'Sales tax account (output)', type: 'select', options: accs, full: true, hint },
        { name: 'input_account_id', label: 'Purchases tax account (input)', type: 'select', options: accs, full: true },
        { name: 'is_active', label: 'Active', type: 'checkbox' },
      ];
    },

    validate: (v) => {
      if (!(v.rate >= 0 && v.rate <= 100)) throw new Error('The rate must be between 0 and 100.');
      if (v.rate > 0 && v.applies_to !== 'purchases' && !v.output_account_id) throw new Error('Choose the sales tax (output) account.');
      if (v.rate > 0 && v.applies_to !== 'sales' && !v.input_account_id) throw new Error('Choose the purchases tax (input) account.');
    },

    toPayload: (v) => ({
      code: v.code.toUpperCase(), name: v.name, rate: v.rate, applies_to: v.applies_to,
      output_account_id: v.output_account_id || null, input_account_id: v.input_account_id || null, is_active: v.is_active,
    }),
  });
}