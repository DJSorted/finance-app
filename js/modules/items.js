import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { setupPage } from '../core/setup-page.js';
import { ui } from '../core/ui.js';
import {
  barcodeProblem, internalBarcodeMaker, linkCellHtml, showItemPreview, pickLabelItems, printLabels,
} from '../core/barcode.js';

const TYPE_LABEL = { stock: 'Stock', service: 'Service', manufactured: 'Manufactured' };

// Sales price for a label or preview, optionally with the item's (or its category's) sales tax added
function priceFor(item, lk, inclTax) {
  if (item.sales_price === null) return '';
  let p = Number(item.sales_price);
  if (inclTax) {
    const cat = lk.categories.find((c) => c.id === item.category_id);
    const taxId = item.sales_tax_code_id || (cat && cat.sales_tax_code_id) || '';
    const tax = lk.taxes.find((t) => t.id === taxId);
    if (tax) p *= 1 + Number(tax.rate) / 100;
  }
  const base = (lk.currencies.find((c) => c.is_base) || {}).code || '';
  return `${p.toFixed(2)} ${item.sales_price_currency || base}`.trim();
}

async function createBarcodes({ rows, refresh }) {
  let result = null;
  await ui.form({
    title: 'Create barcodes', submitText: 'Create',
    fields: [
      { name: 'format', label: 'Barcode to give active items that have none', type: 'select', full: true,
        options: [{ value: 'ean', label: 'New in-store EAN-13 number (starts with 20)' }, { value: 'code', label: 'The item code, printed as Code 128' }],
        hint: 'In-store EAN-13 numbers are free, work with every scanner and never clash with a manufacturer\'s barcode. Items that already have a barcode are not changed.' },
      { name: 'services', label: 'Include service items', type: 'checkbox' },
    ],
    values: { format: 'ean', services: false },
    onSubmit: async (v) => {
      const missing = rows.filter((r) => !r.barcode && r.is_active && (v.services || r.item_type !== 'service'));
      if (!missing.length) throw new Error('Every matching item already has a barcode.');
      const next = internalBarcodeMaker(rows.map((r) => r.barcode));
      const taken = new Set(rows.map((r) => r.barcode).filter(Boolean));
      result = { done: 0, skipped: 0 };
      for (const r of missing) {
        const code = v.format === 'ean' ? next() : r.code;
        if (taken.has(code) || barcodeProblem(code)) { result.skipped += 1; continue; }
        const { error } = await supabase.from('items').update({ barcode: code }).eq('id', r.id).is('barcode', null);
        if (error && error.code === '23505') { result.skipped += 1; continue; }
        if (error) throw error;
        taken.add(code);
        result.done += 1;
      }
    },
  });
  if (result) {
    ui.success(`${result.done} barcode(s) created.${result.skipped ? ` ${result.skipped} item(s) skipped because that barcode is already in use or not valid.` : ''}`);
    await refresh();
  }
}

const ctx = await startPage();
if (ctx) {
  await setupPage(ctx, {
    table: 'items', noun: 'Item', plural: 'items', file: 'items', search: true,
    hint: 'An item inherits its GL accounts and tax codes from its category. Revenue and cost of sales can be overridden per item. Leave the code blank to number it automatically by type.',
    defaults: { is_active: true },
    duplicateMessage: 'That item code or barcode is already used by another item.',

    lookups: async (c) => {
      const [cat, uom, tax, acc, cur] = await Promise.all([
        supabase.from('item_categories').select('id, code, name, item_type, sales_tax_code_id').eq('company_id', c.companyId).eq('is_active', true).order('code'),
        supabase.from('units_of_measure').select('id, code, name').eq('company_id', c.companyId).eq('is_active', true).order('code'),
        supabase.from('tax_codes').select('id, code, name, rate, applies_to').eq('company_id', c.companyId).eq('is_active', true).order('code'),
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
        { header: 'Barcode', text: (r) => r.barcode || '', width: 16 },
        { header: 'Type', text: (r) => TYPE_LABEL[r.item_type] || r.item_type, width: 14 },
        { header: 'Category', text: (r) => cat(r.category_id), width: 14 },
        { header: 'Unit', text: (r) => uom(r.uom_id), width: 8 },
        { header: 'Sales price', num: true, text: (r) => (r.sales_price === null ? '' : `${Number(r.sales_price).toFixed(2)} ${r.sales_price_currency || ''}`.trim()), width: 16 },
        { header: 'Link', text: (r) => r.link_url || '', html: (r) => linkCellHtml(r.link_url), width: 30 },
        { header: 'Active', text: (r) => (r.is_active ? 'Yes' : 'No'), width: 8 },
      ];
    },

    fields: (lk, row) => {
      const accs = [{ value: '', label: 'Use the category account' }].concat(lk.incomeAccounts.map((a) => ({ value: a.id, label: `${a.code} - ${a.name}` })));
      const tax = (side) => [{ value: '', label: 'Use the category tax code' }].concat(
        lk.taxes.filter((t) => t.applies_to === side || t.applies_to === 'both').map((t) => ({ value: t.id, label: `${t.code} - ${t.name}` })));
      return [
        { name: 'code', label: 'Code', hint: 'Leave blank on a new item to number it automatically.' },
        { name: 'name', label: 'Name', required: true },
        { name: 'barcode', label: 'Barcode', placeholder: 'Scan or type it', noEnter: true,
          hint: 'Click here and scan the product\'s barcode, or type your own. Leave blank if the item has none.' },
        ...(row && row.barcode ? [] : [{ name: 'gen_barcode', label: 'Create an in-store barcode for me (when left blank)', type: 'checkbox' }]),
        { name: 'description', label: 'Description', type: 'textarea', full: true },
        { name: 'link_url', label: 'Picture or web page link', full: true, placeholder: 'https://...',
          hint: 'A link to a product photo (.jpg, .png, .webp) shows as a picture; any other link opens in a new tab.' },
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

    validate: (v, row, rows) => {
      if (v.sales_price !== null && v.sales_price < 0) throw new Error('The sales price cannot be negative.');
      const problem = barcodeProblem(v.barcode);
      if (problem) throw new Error(problem);
      if (!v.barcode && v.gen_barcode) v.barcode = internalBarcodeMaker(rows.map((r) => r.barcode))();
      const clash = v.barcode && rows.find((r) => r.barcode === v.barcode && (!row || r.id !== row.id));
      if (clash) throw new Error(`Barcode ${v.barcode} is already used by ${clash.code} - ${clash.name}.`);
      if (v.link_url && !/^https?:\/\/\S+$/i.test(v.link_url)) throw new Error('The link must be a web address starting with https:// (or http://).');
    },

    toPayload: (v) => ({
      code: v.code, name: v.name, description: v.description || null,
      barcode: v.barcode || null, link_url: v.link_url || null,
      category_id: v.category_id, uom_id: v.uom_id,
      sales_price: v.sales_price, sales_price_currency: v.sales_price === null ? null : (v.sales_price_currency || null),
      sales_tax_code_id: v.sales_tax_code_id || null, purchase_tax_code_id: v.purchase_tax_code_id || null,
      revenue_account_id: v.revenue_account_id || null, cogs_account_id: v.cogs_account_id || null,
      is_active: v.is_active,
    }),

    toolbarButtons: [
      { text: 'Print labels', onClick: async ({ rows, lk }) => {
        const picked = await pickLabelItems(rows);
        if (picked) await printLabels(picked, { priceText: (it, incl) => priceFor(it, lk, incl) });
      } },
      { text: 'Create barcodes', editOnly: true, onClick: createBarcodes },
    ],

    rowButtons: [
      { text: 'Preview', show: (r) => !!r.link_url, onClick: (r, { lk }) => showItemPreview(r, { price: priceFor(r, lk, false) }) },
      { text: 'Label', onClick: (r, { lk }) => printLabels([{ item: r, qty: 1 }], { priceText: (it, incl) => priceFor(it, lk, incl) }) },
    ],
  });
}
