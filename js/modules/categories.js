import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { setupPage } from '../core/setup-page.js';

const TYPES = [['stock', 'Stock (inventory)'], ['service', 'Service'], ['manufactured', 'Manufactured']];
const typeLabel = (v) => (TYPES.find((t) => t[0] === v) || [v, v])[1];

// kind: 'is' = any Income Statement posting account; otherwise the required control type
const ACC = [
  { key: 'revenue_account_id', label: 'Revenue account', kind: 'is', hint: 'Needed when the category is sold.' },
  { key: 'cogs_account_id', label: 'Cost of sales account', kind: 'is', hint: 'Needed for sold stock and manufactured items. Optional for services (cost of service).' },
  { key: 'purchases_expense_account_id', label: 'Purchases / expense account', kind: 'is', hint: 'Needed for services that are bought.' },
  { key: 'inventory_account_id', label: 'Inventory account', kind: 'inventory', hint: 'Control type Inventory. Needed for stock and manufactured items.' },
  { key: 'grni_account_id', label: 'Goods received not invoiced account', kind: 'grni', hint: 'Control type Goods received not invoiced. Needed for bought stock.' },
  { key: 'purchase_variance_account_id', label: 'Purchase price variance account', kind: 'is', hint: 'Needed for bought stock.' },
  { key: 'adjustment_account_id', label: 'Stock adjustment account', kind: 'is', hint: 'Stock counts and write-offs. Needed for stock and manufactured items.' },
  { key: 'wip_account_id', label: 'Work in progress account', kind: 'wip', hint: 'Control type Work in progress. Needed for manufactured items.' },
  { key: 'manufacturing_variance_account_id', label: 'Manufacturing variance account', kind: 'is', hint: 'Needed for manufactured items.' },
];

function missing(v) {
  const t = v.item_type;
  const stockish = t === 'stock' || t === 'manufactured';
  const need = [];
  if (v.is_sellable) { need.push('revenue_account_id'); if (stockish) need.push('cogs_account_id'); }
  if (stockish) need.push('inventory_account_id', 'adjustment_account_id');
  if (v.is_purchasable) {
    if (stockish) need.push('grni_account_id', 'purchase_variance_account_id');
    if (t === 'service') need.push('purchases_expense_account_id');
  }
  if (t === 'manufactured') need.push('wip_account_id', 'manufacturing_variance_account_id');
  return need.filter((k) => !v[k]);
}

const ctx = await startPage();
if (ctx) {
  await setupPage(ctx, {
    table: 'item_categories', noun: 'Item category', plural: 'item categories', file: 'item-categories',
    hint: 'Categories carry the GL accounts and tax codes that items inherit. Posting looks up revenue, cost, inventory and variance accounts here, so a correctly set up category automates the accounting for every item in it.',
    defaults: { item_type: 'stock', is_sellable: true, is_purchasable: true, is_active: true },
    duplicateMessage: 'That category code already exists.',

    lookups: async (c) => {
      const [a, t] = await Promise.all([
        supabase.from('gl_accounts').select('id, code, name, control_type, account_groups(class_type)')
          .eq('company_id', c.companyId).eq('is_posting', true).eq('is_active', true).order('code'),
        supabase.from('tax_codes').select('id, code, name, applies_to').eq('company_id', c.companyId).eq('is_active', true).order('code'),
      ]);
      if (a.error) throw a.error;
      if (t.error) throw t.error;
      return { accounts: a.data, taxes: t.data };
    },

    columns: (lk) => {
      const acc = (id) => { const a = lk.accounts.find((x) => x.id === id); return a ? `${a.code} ${a.name}` : ''; };
      return [
        { header: 'Code', text: (r) => r.code, width: 12 },
        { header: 'Name', text: (r) => r.name, width: 28 },
        { header: 'Type', text: (r) => typeLabel(r.item_type), width: 18 },
        { header: 'Sold / bought', text: (r) => [r.is_sellable ? 'Sold' : '', r.is_purchasable ? 'Bought' : ''].filter(Boolean).join(' & ') || '-', width: 14 },
        { header: 'Revenue account', text: (r) => acc(r.revenue_account_id), width: 28 },
        { header: 'Inventory account', text: (r) => acc(r.inventory_account_id), width: 28 },
        { header: 'Active', text: (r) => (r.is_active ? 'Yes' : 'No'), width: 8 },
      ];
    },

    fields: (lk) => {
      const pick = (kind) => [{ value: '', label: 'Not set' }].concat(
        lk.accounts
          .filter((a) => (kind === 'is' ? a.account_groups && a.account_groups.class_type === 'income_statement' : a.control_type === kind))
          .map((a) => ({ value: a.id, label: `${a.code} - ${a.name}` })));
      const tax = (side) => [{ value: '', label: 'None' }].concat(
        lk.taxes.filter((t) => t.applies_to === side || t.applies_to === 'both').map((t) => ({ value: t.id, label: `${t.code} - ${t.name}` })));
      return [
        { name: 'code', label: 'Code', required: true },
        { name: 'name', label: 'Name', required: true },
        { name: 'item_type', label: 'Type', type: 'select', required: true, full: true,
          options: TYPES.map(([value, label]) => ({ value, label })), hint: 'Cannot change once the category has items.' },
        { name: 'is_sellable', label: 'Items in this category are sold', type: 'checkbox' },
        { name: 'is_purchasable', label: 'Items in this category are bought', type: 'checkbox' },
        { name: 'sales_tax_code_id', label: 'Default sales tax code', type: 'select', options: tax('sales') },
        { name: 'purchase_tax_code_id', label: 'Default purchases tax code', type: 'select', options: tax('purchases') },
        ...ACC.map((a) => ({ name: a.key, label: a.label, type: 'select', options: pick(a.kind), full: true, hint: a.hint })),
        { name: 'is_active', label: 'Active', type: 'checkbox' },
      ];
    },

    validate: (v) => {
      const m = missing(v);
      if (m.length) throw new Error(`Still needed: ${m.map((k) => ACC.find((a) => a.key === k).label).join(', ')}.`);
    },

    toPayload: (v) => ({
      code: v.code.toUpperCase(), name: v.name, item_type: v.item_type,
      is_sellable: v.is_sellable, is_purchasable: v.is_purchasable,
      sales_tax_code_id: v.sales_tax_code_id || null, purchase_tax_code_id: v.purchase_tax_code_id || null,
      ...Object.fromEntries(ACC.map((a) => [a.key, v[a.key] || null])),
      is_active: v.is_active,
    }),
  });
}