import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { setupPage } from '../core/setup-page.js';
import { ui } from '../core/ui.js';
import {
  barcodeProblem, internalBarcodeMaker, linkCellHtml, showItemPreview, pickLabelItems, printLabels, isImageUrl,
} from '../core/barcode.js';

const TYPE_LABEL = { stock: 'Stock', service: 'Service', manufactured: 'Manufactured' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const qty = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 4 });
const money = (n) => Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Stock on hand per warehouse for one item
async function stockFor(ctx, itemId) {
  const base = () => supabase.from('stock_balances').select('warehouse_id, qty_on_hand, value, avg_cost')
    .eq('company_id', ctx.companyId).eq('item_id', itemId);
  let res = await supabase.from('stock_balances').select('warehouse_id, qty_on_hand, value, avg_cost, warehouses(code, name)')
    .eq('company_id', ctx.companyId).eq('item_id', itemId);
  if (res.error) res = await base();               // older schema without the warehouse link
  if (res.error) throw res.error;
  return res.data;
}

// The panel under the list for the selected item
async function itemDetail(r, lk, ctx) {
  const find = (list, id) => (id ? list.find((x) => x.id === id) : null);
  const label = (x) => (x ? `${x.code} - ${x.name}` : '');
  const cat = find(lk.categories, r.category_id);
  const taxText = (id, catId) => {
    const t = find(lk.taxes, id);
    if (t) return `${label(t)} (${Number(t.rate)}%)`;
    const ct = find(lk.taxes, catId);
    return ct ? `<span class="muted">Category: ${esc(label(ct))} (${Number(ct.rate)}%)</span>` : '<span class="muted">Category default</span>';
  };
  const acc = (id) => { const a = find(lk.incomeAccounts, id); return a ? esc(label(a)) : '<span class="muted">Category account</span>'; };

  const pic = r.link_url && isImageUrl(r.link_url)
    ? `<a href="${esc(r.link_url)}" target="_blank" rel="noopener noreferrer" title="Open the full picture"><img src="${esc(r.link_url)}" alt="${esc(r.name)}" loading="lazy" referrerpolicy="no-referrer"></a>`
    : '<div class="md-nopic">No picture<br><small>Add a picture link in Edit</small></div>';

  const f = [
    ['Barcode', r.barcode ? `<span class="mono">${esc(r.barcode)}</span>` : '<span class="muted">None</span>'],
    ['Category', esc(label(cat))],
    ['Group', esc(label(find(lk.groups, r.item_group_id))) || '<span class="muted">None</span>'],
    ['Unit', esc(label(find(lk.uoms, r.uom_id)))],
    ['Sales price', r.sales_price === null ? '<span class="muted">Not set</span>' : esc(priceFor(r, lk, false))],
    ['Incl. sales tax', r.sales_price === null ? '' : esc(priceFor(r, lk, true))],
    ['Sales tax', taxText(r.sales_tax_code_id, cat && cat.sales_tax_code_id)],
    ['Purchases tax', taxText(r.purchase_tax_code_id, null)],
    ['Revenue account', acc(r.revenue_account_id)],
    ['Cost of sales account', acc(r.cogs_account_id)],
  ];
  if (r.link_url && !isImageUrl(r.link_url)) f.push(['Link', `<a href="${esc(r.link_url)}" target="_blank" rel="noopener noreferrer">${esc(r.link_url)}</a>`]);

  let stock = '';
  if (r.item_type !== 'service') {
    try {
      const sb = (await stockFor(ctx, r.id)).filter((b) => Number(b.qty_on_hand) !== 0 || Number(b.value) !== 0);
      const tq = sb.reduce((s, b) => s + Number(b.qty_on_hand), 0);
      const tv = sb.reduce((s, b) => s + Number(b.value), 0);
      stock = `<h4>Stock on hand</h4>${sb.length ? `<table class="grid compact"><thead><tr><th>Warehouse</th><th class="num">Qty</th><th class="num">Avg cost</th><th class="num">Value</th></tr></thead><tbody>
        ${sb.map((b) => `<tr><td>${esc(b.warehouses ? label(b.warehouses) : b.warehouse_id)}</td><td class="num">${qty(b.qty_on_hand)}</td><td class="num">${money(b.avg_cost)}</td><td class="num">${money(b.value)}</td></tr>`).join('')}
        ${sb.length > 1 ? `<tr class="total"><td>Total</td><td class="num">${qty(tq)}</td><td></td><td class="num">${money(tv)}</td></tr>` : ''}</tbody></table>`
        : '<p class="muted">None in stock.</p>'}`;
    } catch (e) { stock = '<h4>Stock on hand</h4><p class="muted">Unavailable right now.</p>'; }
  }

  return `<div class="md-grid">
    <div class="md-pic">${pic}</div>
    <div class="md-main">
      <h3 class="md-title">${esc(r.code)} - ${esc(r.name)}
        <span class="badge">${esc(TYPE_LABEL[r.item_type] || r.item_type)}</span>${r.is_active ? '' : ' <span class="badge st-error">Inactive</span>'}</h3>
      <dl class="md-fields">${f.filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
      ${r.description ? `<p class="md-desc">${esc(r.description)}</p>` : ''}
    </div>
    ${stock ? `<div class="md-side">${stock}</div>` : ''}
  </div>`;
}

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
    table: 'items', noun: 'Item', plural: 'items', file: 'items', search: true, formCols: 3,
    hint: 'An item inherits its GL accounts and tax codes from its category. Revenue and cost of sales can be overridden per item. Leave the code blank to number it automatically by type.',
    defaults: { is_active: true },
    duplicateMessage: 'That item code or barcode is already used by another item.',
    detail: (r, { lk, ctx: c }) => itemDetail(r, lk, c),

    lookups: async (c) => {
      const [cat, uom, tax, acc, cur, grp] = await Promise.all([
        supabase.from('item_categories').select('id, code, name, item_type, sales_tax_code_id').eq('company_id', c.companyId).eq('is_active', true).order('code'),
        supabase.from('units_of_measure').select('id, code, name').eq('company_id', c.companyId).eq('is_active', true).order('code'),
        supabase.from('tax_codes').select('id, code, name, rate, applies_to').eq('company_id', c.companyId).eq('is_active', true).order('code'),
        supabase.from('gl_accounts').select('id, code, name, account_groups(class_type)')
          .eq('company_id', c.companyId).eq('is_posting', true).eq('is_active', true).order('code'),
        supabase.from('company_currencies').select('code, is_base').eq('company_id', c.companyId).order('code'),
        supabase.from('item_groups').select('id, code, name, is_active').eq('company_id', c.companyId).order('code'),
      ]);
      for (const r of [cat, uom, tax, acc, cur, grp]) if (r.error) throw r.error;
      return {
        categories: cat.data, uoms: uom.data, taxes: tax.data, currencies: cur.data, groups: grp.data,
        incomeAccounts: acc.data.filter((a) => a.account_groups && a.account_groups.class_type === 'income_statement'),
      };
    },

    columns: (lk) => {
      const cat = (id) => { const c = lk.categories.find((x) => x.id === id); return c ? c.code : ''; };
      const uom = (id) => { const u = lk.uoms.find((x) => x.id === id); return u ? u.code : ''; };
      const grp = (id) => { const g = lk.groups.find((x) => x.id === id); return g ? g.name : ''; };
      return [
        { header: 'Code', text: (r) => r.code, width: 14 },
        { header: 'Name', text: (r) => r.name, width: 32 },
        { header: 'Barcode', text: (r) => r.barcode || '', width: 16 },
        { header: 'Type', text: (r) => TYPE_LABEL[r.item_type] || r.item_type, width: 14 },
        { header: 'Category', text: (r) => cat(r.category_id), width: 14 },
        { header: 'Group', text: (r) => grp(r.item_group_id), width: 16 },
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
        { name: 'category_id', label: 'Category', type: 'select', required: true,
          options: [{ value: '', label: 'Select a category' }].concat(lk.categories.map((c) => ({ value: c.id, label: `${c.code} - ${c.name} (${TYPE_LABEL[c.item_type]})` }))),
          hint: lk.categories.length ? 'The category decides the item type and its accounts.' : 'No categories yet. Create an item category first.' },
        { name: 'item_group_id', label: 'Group', type: 'select',
          options: [{ value: '', label: 'No group' }].concat(lk.groups.filter((g) => g.is_active || (row && g.id === row.item_group_id))
            .map((g) => ({ value: g.id, label: `${g.code} - ${g.name}` }))),
          hint: lk.groups.length ? 'For searching and reports only. It does not affect the accounts.' : 'No groups yet. Add them under Inventory > Item Groups.' },
        { name: 'uom_id', label: 'Unit of measure', type: 'select', required: true,
          options: [{ value: '', label: 'Select a unit' }].concat(lk.uoms.map((u) => ({ value: u.id, label: `${u.code} - ${u.name}` }))) },
        { name: 'sales_price', label: 'Default sales price', type: 'number' },
        { name: 'sales_price_currency', label: 'Price currency',
          type: 'select', options: [{ value: '', label: 'Base currency' }].concat(lk.currencies.filter((c) => !c.is_base).map((c) => ({ value: c.code, label: c.code }))) },
        { name: 'sales_tax_code_id', label: 'Sales tax code', type: 'select', options: tax('sales') },
        { name: 'purchase_tax_code_id', label: 'Purchases tax code', type: 'select', options: tax('purchases') },
        { name: 'revenue_account_id', label: 'Revenue account override', type: 'select', options: accs },
        { name: 'cogs_account_id', label: 'Cost of sales account override', type: 'select', options: accs },
        { name: 'description', label: 'Description', type: 'textarea', full: true },
        { name: 'link_url', label: 'Picture or web page link', full: true, placeholder: 'https://...',
          hint: 'A link to a product photo (.jpg, .png, .webp) shows as a picture; any other link opens in a new tab.' },
        ...(row && row.barcode ? [] : [{ name: 'gen_barcode', label: 'Create an in-store barcode for me (when left blank)', type: 'checkbox' }]),
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
      if (v.link_url && !/^https?:\/\/\S+$/i.test(v.link_url)) throw new Error('The link must be a web address starting with https:// (or http://).');    },

    toPayload: (v) => ({
      code: v.code, name: v.name, description: v.description || null,
      barcode: v.barcode || null, link_url: v.link_url || null,
      category_id: v.category_id, item_group_id: v.item_group_id || null, uom_id: v.uom_id,
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
