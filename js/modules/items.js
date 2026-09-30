import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { setupPage } from '../core/setup-page.js';

const TYPE_LABEL = { stock: 'Stock', service: 'Service', manufactured: 'Manufactured' };

const ctx = await startPage();
if (ctx) {
  await setupPage(ctx, {
    table: 'items', noun: 'Item', plural: 'items', file: 'items', search: true,
    hint: 'An item inherits its GL accounts and tax codes from its category. Revenue and cost of sales can be overridden per item. Leave the code blank to number it automatically by type.',
    defaults: { is_active: true },
    duplicateMessage: 'That item code already exists.',

    lookups: async (c) => {
      const [cat, uom, tax, acc, cur] = await Promise.all([
        supabase.from('item_categories').select('id, code, name, item_type').eq('company_id', c.companyId).eq('is_active', true).order('code'),
        supabase.from('units_of_measure').select('id, code, name').eq('company_id', c.companyId).eq('is_active', true).order('code'),
        supabase.from('tax_codes').select('id, code, name, applies_to').eq('company_id', c.companyId).eq('is_active', true).order('code'),
        supabase.from('gl_accounts').select('id, code, name, account_groups(class_type)')
          .eq('company_id', c.companyId).eq('is_posting', true).eq('is_active', true).order('code'),
        supabase.from('company_currencies').select('code, is_base').eq('company_id', c.companyId).order('code'),
      ]);
      for (const r of [cat, uom, tax, acc, cur]) if (r.error) throw r.error;
      return {
        categories: cat.data, uoms: uom.data, taxes: tax.data, currencies: cur.data,
        incomeAccounts: acc.data.filter((a) => a.account_groups && a.account_groups.class_type === 'income_statement'),
      };
    },

    columns: (lk) => {
      const cat = (id) => { const c = lk.categories.find((x) => x.id === id); return c ? c.code : ''; };
      const uom = (id) => { const u = lk.uoms.find((x) => x.id === id); return u ? u.code : ''; };
      return [
        { header: 'Code', text: (r) => r.code, width: 14 },
        { header: 'Name', text: (r) => r.name, width: 32 },
        { header: 'Type', text: (r) => TYPE_LABEL[r.item_type] || r.item_type, width: 14 },
        { header: 'Category', text: (r) => cat(r.category_id), width: 14 },
        { header: 'Unit', text: (r) => uom(r.uom_id), width: 8 },
        { header: 'Sales price', num: true, text: (r) => (r.sales_price === null ? '' : `${Number(r.sales_price).toFixed(2)} ${r.sales_price_currency || ''}`.trim()), width: 16 },
        { header: 'Active', text: (r) => (r.is_active ? 'Yes' : 'No'), width: 8 },
      ];
    },

    fields: (lk) => {
      const accs = [{ value: '', label: 'Use the category account' }].concat(lk.incomeAccounts.map((a) => ({ value: a.id, label: `${a.code} - ${a.name}` })));
      const tax = (side) => [{ value: '', label: 'Use the category tax code' }].concat(
        lk.taxes.filter((t) => t.applies_to === side || t.applies_to === 'both').map((t) => ({ value: t.id, label: `${t.code} - ${t.name}` })));
      return [
        { name: 'code', label: 'Code', hint: 'Leave blank on a new item to number it automatically.' },
        { name: 'name', label: 'Name', required: true },
        { name: 'description', label: 'Description', type: 'textarea', full: true },
        { name: 'category_id', label: 'Category', type: 'select', required: true,
          options: [{ value: '', label: 'Select a category' }].concat(lk.categories.map((c) => ({ value: c.id, label: `${c.code} - ${c.name} (${TYPE_LABEL[c.item_type]})` }))),
          hint: lk.categories.length ? 'The category decides the item type and its accounts.' : 'No categories yet. Create an item category first.' },
        { name: 'uom_id', label: 'Unit of measure', type: 'select', required: true,
          options: [{ value: '', label: 'Select a unit' }].concat(lk.uoms.map((u) => ({ value: u.id, label: `${u.code} - ${u.name}` }))) },
        { name: 'sales_price', label: 'Default sales price', type: 'number' },
        { name: 'sales_price_currency', label: 'Price currency',
          type: 'select', options: [{ value: '', label: 'Base currency' }].concat(lk.currencies.filter((c) => !c.is_base).map((c) => ({ value: c.code, label: c.code }))) },
        { name: 'sales_tax_code_id', label: 'Sales tax code', type: 'select', options: tax('sales') },
        { name: 'purchase_tax_code_id', label: 'Purchases tax code', type: 'select', options: tax('purchases') },
        { name: 'revenue_account_id', label: 'Revenue account override', type: 'select', options: accs, full: true },
        { name: 'cogs_account_id', label: 'Cost of sales account override', type: 'select', options: accs, full: true },
        { name: 'is_active', label: 'Active', type: 'checkbox' },
      ];
    },

    validate: (v) => {
      if (v.sales_price !== null && v.sales_price < 0) throw new Error('The sales price cannot be negative.');
    },

    toPayload: (v) => ({
      code: v.code, name: v.name, description: v.description || null,
      category_id: v.category_id, uom_id: v.uom_id,
      sales_price: v.sales_price, sales_price_currency: v.sales_price === null ? null : (v.sales_price_currency || null),
      sales_tax_code_id: v.sales_tax_code_id || null, purchase_tax_code_id: v.purchase_tax_code_id || null,
      revenue_account_id: v.revenue_account_id || null, cogs_account_id: v.cogs_account_id || null,
      is_active: v.is_active,
    }),
  });
}