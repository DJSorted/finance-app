// Import column definitions, one list per table.
// type: text (default) | number | int | bool | enum | ref
// ref columns hold the CODE of an existing record, resolved from the page's lookups.
const CODE = { header: 'Code', field: 'code', required: true, upper: true };
const NAME = { header: 'Name', field: 'name', required: true };
const ACTIVE = { header: 'Active', field: 'is_active', type: 'bool', default: true };
const text = (header, field, extra = {}) => ({ header, field, ...extra });
const ref = (header, field, lookup, what, extra = {}) => ({ header, field, type: 'ref', lookup, what, ...extra });
const EMAIL = text('Email', 'email', {
  check: (v) => (/^\S+@\S+\.\S+$/.test(v) ? '' : `Email "${v}" is not valid`),
});

const ITEM_TYPES = [['stock', 'Stock'], ['service', 'Service'], ['manufactured', 'Manufactured']];

export const IMPORT_DEFS = {
  tax_codes: [
    CODE, NAME,
    { header: 'Rate %', field: 'rate', type: 'number', required: true },
    { header: 'Used on', field: 'applies_to', type: 'enum', default: 'both',
      values: [['both', 'Sales and purchases'], ['sales', 'Sales only'], ['purchases', 'Purchases only']] },
    ref('Sales tax account', 'output_account_id', 'accounts', 'tax account'),
    ref('Purchases tax account', 'input_account_id', 'accounts', 'tax account'),
    ACTIVE,
  ],

  payment_terms: [
    CODE, NAME,
    { header: 'Counted from', field: 'basis', type: 'enum', default: 'days_from_document',
      values: [['days_from_document', 'Days after the document date'], ['days_from_month_end', 'Days after the end of the document month']] },
    { header: 'Days', field: 'days', type: 'int', default: 30 },
    ACTIVE,
  ],

  units_of_measure: [CODE, NAME, ACTIVE],

  item_categories: [
    CODE, NAME,
    { header: 'Type', field: 'item_type', type: 'enum', required: true, values: ITEM_TYPES },
    { header: 'Sold', field: 'is_sellable', type: 'bool', default: true },
    { header: 'Bought', field: 'is_purchasable', type: 'bool', default: true },
    ref('Sales tax code', 'sales_tax_code_id', 'taxes', 'tax code'),
    ref('Purchases tax code', 'purchase_tax_code_id', 'taxes', 'tax code'),
    ref('Revenue account', 'revenue_account_id', 'accounts', 'account'),
    ref('Cost of sales account', 'cogs_account_id', 'accounts', 'account'),
    ref('Purchases / expense account', 'purchases_expense_account_id', 'accounts', 'account'),
    ref('Inventory account', 'inventory_account_id', 'accounts', 'account'),
    ref('Goods received not invoiced account', 'grni_account_id', 'accounts', 'account'),
    ref('Purchase price variance account', 'purchase_variance_account_id', 'accounts', 'account'),
    ref('Stock adjustment account', 'adjustment_account_id', 'accounts', 'account'),
    ref('Work in progress account', 'wip_account_id', 'accounts', 'account'),
    ref('Manufacturing variance account', 'manufacturing_variance_account_id', 'accounts', 'account'),
    ACTIVE,
  ],

  items: [
    CODE, NAME,
    text('Description', 'description'),
    ref('Category', 'category_id', 'categories', 'item category', { required: true }),
    ref('Unit', 'uom_id', 'uoms', 'unit of measure', { required: true }),
    { header: 'Sales price', field: 'sales_price', type: 'number' },
    ref('Price currency', 'sales_price_currency', 'currencies', 'currency', { value: 'code' }),
    ref('Sales tax code', 'sales_tax_code_id', 'taxes', 'tax code'),
    ref('Purchases tax code', 'purchase_tax_code_id', 'taxes', 'tax code'),
    ref('Revenue account override', 'revenue_account_id', 'incomeAccounts', 'account'),
    ref('Cost of sales account override', 'cogs_account_id', 'incomeAccounts', 'account'),
    ACTIVE,
  ],

  warehouses: [
    CODE, NAME,
    text('Address', 'address'),
    { header: 'Default', field: 'is_default', type: 'bool', default: false },
    { header: 'Negative stock allowed', field: 'allow_negative_stock', type: 'bool', default: false },
    ACTIVE,
  ],

  customers: [
    CODE, NAME,
    text('Tax number', 'tax_number'), text('Contact person', 'contact_name'), EMAIL, text('Phone', 'phone'),
    text('Address', 'address'), text('Country', 'country'),
    ref('Currency', 'currency_code', 'currencies', 'currency', { value: 'code' }),
    ref('Payment terms', 'payment_terms_id', 'terms', 'payment term'),
    ref('Tax code', 'tax_code_id', 'taxes', 'tax code'),
    ref('Debtors control account', 'control_account_id', 'accounts', 'debtors account'),
    { header: 'Credit limit', field: 'credit_limit', type: 'number' },
    text('Notes', 'notes'),
    ACTIVE,
  ],

  suppliers: [
    CODE, NAME,
    text('Tax number', 'tax_number'), text('Contact person', 'contact_name'), EMAIL, text('Phone', 'phone'),
    text('Address', 'address'), text('Country', 'country'),
    ref('Currency', 'currency_code', 'currencies', 'currency', { value: 'code' }),
    ref('Payment terms', 'payment_terms_id', 'terms', 'payment term'),
    ref('Tax code', 'tax_code_id', 'taxes', 'tax code'),
    ref('Creditors control account', 'control_account_id', 'accounts', 'creditors account'),
    text('Notes', 'notes'),
    ACTIVE,
  ],
};