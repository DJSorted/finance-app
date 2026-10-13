import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { setupPage } from '../core/setup-page.js';

const ctx = await startPage();
if (ctx) {
  await setupPage(ctx, {
    table: 'pos_registers', noun: 'Register', plural: 'registers', file: 'pos-registers',
    hint: 'A register is a till. It sells from one warehouse, to one walk-in customer by default, and counts its cash drawer through a Cash payment method. Create the payment methods first.',
    defaults: { is_active: true },
    duplicateMessage: 'That register code already exists.',

    lookups: async (c) => {
      const cid = c.companyId;
      const [w, cu, m, a] = await Promise.all([
        supabase.from('warehouses').select('id, code, name').eq('company_id', cid).eq('is_active', true).order('code'),
        supabase.from('customers').select('id, code, name').eq('company_id', cid).eq('is_active', true).order('code'),
        supabase.from('pos_payment_methods').select('id, code, name').eq('company_id', cid).eq('kind', 'cash').eq('is_active', true).order('code'),
        supabase.from('gl_accounts').select('id, code, name, account_groups(class_type)')
          .eq('company_id', cid).eq('is_posting', true).eq('is_active', true).is('control_type', null).order('code'),
      ]);
      for (const r of [w, cu, m, a]) if (r.error) throw r.error;
      return {
        warehouses: w.data, customers: cu.data, cashMethods: m.data,
        accounts: a.data.filter((x) => x.account_groups && x.account_groups.class_type === 'income_statement'),
      };
    },

    columns: (lk) => {
      const name = (list, id) => { const x = list.find((y) => y.id === id); return x ? `${x.code} - ${x.name}` : ''; };
      return [
        { header: 'Code', text: (r) => r.code, width: 12 },
        { header: 'Name', text: (r) => r.name, width: 24 },
        { header: 'Warehouse', text: (r) => name(lk.warehouses, r.warehouse_id), width: 24 },
        { header: 'Walk-in customer', text: (r) => name(lk.customers, r.customer_id), width: 28 },
        { header: 'Cash method', text: (r) => name(lk.cashMethods, r.cash_method_id), width: 22 },
        { header: 'Active', text: (r) => (r.is_active ? 'Yes' : 'No'), width: 8 },
      ];
    },

    fields: (lk) => [
      { name: 'code', label: 'Code', required: true },
      { name: 'name', label: 'Name', required: true },
      { name: 'warehouse_id', label: 'Sells from warehouse', type: 'select', required: true,
        options: [{ value: '', label: 'Select a warehouse' }].concat(lk.warehouses.map((x) => ({ value: x.id, label: `${x.code} - ${x.name}` }))) },
      { name: 'customer_id', label: 'Walk-in customer', type: 'select', required: true,
        options: [{ value: '', label: 'Select a customer' }].concat(lk.customers.map((x) => ({ value: x.id, label: `${x.code} - ${x.name}` }))),
        hint: 'Create one customer such as "Cash sales" for counter sales.' },
      { name: 'cash_method_id', label: 'Cash drawer method', type: 'select', full: true,
        options: [{ value: '', label: 'None (this register does not handle cash)' }].concat(lk.cashMethods.map((x) => ({ value: x.id, label: `${x.code} - ${x.name}` }))),
        hint: 'Used for the cash-up at the end of each shift.' },
      { name: 'over_short_account_id', label: 'Cash over / short account', type: 'select', full: true,
        options: [{ value: '', label: 'Select an account' }].concat(lk.accounts.map((x) => ({ value: x.id, label: `${x.code} - ${x.name}` }))),
        hint: 'An ordinary income statement account. A count that differs from the expected cash posts here. Required when a cash-up has a difference.' },
      { name: 'is_active', label: 'Active', type: 'checkbox' },
    ],

    toPayload: (v) => ({
      code: String(v.code).trim().toUpperCase(), name: v.name, warehouse_id: v.warehouse_id, customer_id: v.customer_id,
      cash_method_id: v.cash_method_id || null, over_short_account_id: v.over_short_account_id || null, is_active: v.is_active,
    }),
  });
}