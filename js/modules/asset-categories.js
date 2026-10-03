import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { setupPage } from '../core/setup-page.js';

const METHODS = [
  ['straight_line', 'Straight line'], ['reducing_balance', 'Reducing balance'], ['none', 'Not depreciated (for example land)'],
];
const TRACKING = [
  ['serialised', 'Serialised (each item has its own record)'], ['pooled', 'Pooled (one record for a quantity)'],
];
const label = (list, v) => (list.find((x) => x[0] === v) || [v, v])[1];

const ctx = await startPage();
if (ctx) {
  await setupPage(ctx, {
    table: 'asset_categories', noun: 'Asset category', plural: 'asset categories', file: 'asset-categories',
    hint: 'A category holds the accounts and depreciation defaults for a kind of asset. Assets copy these defaults when they are created, so changing a category does not change assets that already exist. '
      + 'Create the four accounts first in the Chart of Accounts: asset at cost and accumulated depreciation (control types Fixed assets and Accumulated depreciation), then depreciation expense and profit / loss on disposal.',
    defaults: { default_tracking: 'serialised', method: 'straight_line', life_months: 60, residual_percent: 0, is_hireable: false, is_active: true },
    duplicateMessage: 'That category code already exists.',

    lookups: async (c) => {
      const { data, error } = await supabase.from('gl_accounts')
        .select('id, code, name, control_type, account_groups(class_type)')
        .eq('company_id', c.companyId).eq('is_posting', true).eq('is_active', true).order('code');
      if (error) throw error;
      return { accounts: data };
    },

    columns: (lk) => {
      const acc = (id) => { const a = lk.accounts.find((x) => x.id === id); return a ? `${a.code} ${a.name}` : ''; };
      return [
        { header: 'Code', text: (r) => r.code, width: 12 },
        { header: 'Name', text: (r) => r.name, width: 28 },
        { header: 'Tracking', text: (r) => (r.default_tracking === 'pooled' ? 'Pooled' : 'Serialised'), width: 12 },
        { header: 'Depreciation', text: (r) => (r.method === 'straight_line' ? `Straight line, ${r.life_months} months`
          : (r.method === 'reducing_balance' ? `Reducing balance, ${Number(r.rate_percent)}% a year` : 'None')), width: 30 },
        { header: 'Asset account', text: (r) => acc(r.asset_account_id), width: 28 },
        { header: 'Hireable', text: (r) => (r.is_hireable ? 'Yes' : ''), width: 10 },
        { header: 'Active', text: (r) => (r.is_active ? 'Yes' : 'No'), width: 8 },
      ];
    },

    fields: (lk) => {
      const pick = (kind) => [{ value: '', label: 'Select an account' }].concat(
        lk.accounts
          .filter((a) => (kind === 'is'
            ? (a.account_groups && a.account_groups.class_type === 'income_statement' && !a.control_type)
            : a.control_type === kind))
          .map((a) => ({ value: a.id, label: `${a.code} - ${a.name}` })));
      return [
        { name: 'code', label: 'Code', required: true },
        { name: 'name', label: 'Name', required: true },
        { name: 'default_tracking', label: 'Tracking', type: 'select', required: true, full: true,
          options: TRACKING.map(([value, l]) => ({ value, label: l })),
          hint: 'Tents are usually serialised; chairs are usually pooled.' },
        { name: 'method', label: 'Depreciation method', type: 'select', required: true,
          options: METHODS.map(([value, l]) => ({ value, label: l })) },
        { name: 'life_months', label: 'Useful life (months)', type: 'number', hint: 'Straight line only.' },
        { name: 'rate_percent', label: 'Rate (% a year)', type: 'number', hint: 'Reducing balance only.' },
        { name: 'residual_percent', label: 'Residual value (% of cost)', type: 'number' },
        { name: 'asset_account_id', label: 'Asset account (at cost)', type: 'select', options: pick('fixed_assets'), required: true, full: true,
          hint: 'Control type Fixed assets.' },
        { name: 'accum_account_id', label: 'Accumulated depreciation account', type: 'select', options: pick('accum_depreciation'), required: true, full: true,
          hint: 'Control type Accumulated depreciation.' },
        { name: 'expense_account_id', label: 'Depreciation expense account', type: 'select', options: pick('is'), required: true, full: true },
        { name: 'disposal_account_id', label: 'Profit / loss on disposal account', type: 'select', options: pick('is'), required: true, full: true },
        { name: 'is_hireable', label: 'Hireable (used by the hire module)', type: 'checkbox' },
        { name: 'is_active', label: 'Active', type: 'checkbox' },
      ];
    },

    validate: (v) => {
      if (v.method === 'straight_line' && !(v.life_months >= 1)) throw new Error('Enter the useful life in months for straight line depreciation.');
      if (v.method === 'reducing_balance' && !(v.rate_percent > 0 && v.rate_percent <= 100)) throw new Error('Enter the yearly rate (above 0 and up to 100) for reducing balance.');
      if (!(v.residual_percent >= 0 && v.residual_percent <= 100)) throw new Error('The residual value must be between 0 and 100 percent.');
    },

    toPayload: (v) => ({
      code: v.code.toUpperCase(), name: v.name, default_tracking: v.default_tracking, method: v.method,
      life_months: v.life_months ? Math.round(v.life_months) : null, rate_percent: v.rate_percent || null,
      residual_percent: v.residual_percent ?? 0,
      asset_account_id: v.asset_account_id, accum_account_id: v.accum_account_id,
      expense_account_id: v.expense_account_id, disposal_account_id: v.disposal_account_id,
      is_hireable: v.is_hireable, is_active: v.is_active,
    }),
  });
}