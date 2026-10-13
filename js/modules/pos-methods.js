import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { setupPage } from '../core/setup-page.js';

const KIND = { cash: 'Cash', card: 'Card', eft: 'EFT', voucher: 'Voucher', other: 'Other' };

const ctx = await startPage();
if (ctx) {
  await setupPage(ctx, {
    table: 'pos_payment_methods', noun: 'Payment method', plural: 'payment methods', file: 'pos-payment-methods',
    hint: 'The ways a till can take payment. Each points at a posting account with control type Bank in the Chart of Accounts: the cash drawer, a card clearing account, an EFT account. Cash is the only type that gives change.',
    orderBy: ['sort_order', 'code'],
    defaults: { is_active: true, kind: 'cash', sort_order: 0 },
    duplicateMessage: 'That payment method code already exists.',

    lookups: async (c) => {
      const { data, error } = await supabase.from('gl_accounts').select('id, code, name')
        .eq('company_id', c.companyId).eq('control_type', 'bank').eq('is_posting', true).eq('is_active', true).order('code');
      if (error) throw error;
      return { accounts: data };
    },

    columns: (lk) => {
      const acc = (id) => { const a = lk.accounts.find((x) => x.id === id); return a ? `${a.code} - ${a.name}` : ''; };
      return [
        { header: 'Code', text: (r) => r.code, width: 12 },
        { header: 'Name', text: (r) => r.name, width: 28 },
        { header: 'Type', text: (r) => KIND[r.kind] || r.kind, width: 12 },
        { header: 'Account', text: (r) => acc(r.account_id), width: 34 },
        { header: 'Order', num: true, text: (r) => String(r.sort_order), width: 8 },
        { header: 'Active', text: (r) => (r.is_active ? 'Yes' : 'No'), width: 8 },
      ];
    },

    fields: (lk) => [
      { name: 'code', label: 'Code', required: true },
      { name: 'name', label: 'Name', required: true },
      { name: 'kind', label: 'Type', type: 'select', required: true,
        options: Object.entries(KIND).map(([value, label]) => ({ value, label })),
        hint: 'Cash gives tendered amount and change. Card, EFT, voucher and other take the exact amount.' },
      { name: 'account_id', label: 'Account', type: 'select', required: true,
        options: [{ value: '', label: 'Select an account' }].concat(lk.accounts.map((a) => ({ value: a.id, label: `${a.code} - ${a.name}` }))),
        hint: lk.accounts.length ? 'Receipts for this method are posted to this account.' : 'No bank-type accounts yet. Create posting accounts with control type Bank first.' },
      { name: 'sort_order', label: 'Order on the till', type: 'number' },
      { name: 'is_active', label: 'Active', type: 'checkbox' },
    ],

    toPayload: (v) => ({
      code: String(v.code).trim().toUpperCase(), name: v.name, kind: v.kind, account_id: v.account_id,
      sort_order: v.sort_order === null || v.sort_order === '' ? 0 : Math.round(v.sort_order), is_active: v.is_active,
    }),
  });
}