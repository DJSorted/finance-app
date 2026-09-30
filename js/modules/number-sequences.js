import { startPage } from '../core/shell.js';
import { setupPage } from '../core/setup-page.js';

const DOC_TYPES = {
  sales_invoice: 'Sales invoice', sales_credit_note: 'Sales credit note', customer_receipt: 'Customer receipt',
  supplier_bill: 'Supplier bill', supplier_credit_note: 'Supplier credit note', supplier_payment: 'Supplier payment',
  purchase_order: 'Purchase order', goods_received: 'Goods received note', journal: 'Journal',
  stock_adjustment: 'Stock adjustment', stock_transfer: 'Stock transfer', work_order: 'Work order',
  fixed_asset: 'Fixed asset', customer: 'Customer code', supplier: 'Supplier code', item: 'Item code',
};
const docLabel = (t) => DOC_TYPES[t] || t;
const nextRef = (r) => r.prefix + String(r.next_number).padStart(r.padding, '0');

const ctx = await startPage();
if (ctx) {
  await setupPage(ctx, {
    table: 'number_sequences', noun: 'Number sequence', plural: 'number sequences', file: 'number-sequences',
    hint: 'Each document type has its own numbering. Numbers are issued automatically when a document is created and never repeat. You can raise the next number (for example when migrating) but not lower it.',
    orderBy: ['doc_type'], canAdd: false, canDelete: false,
    columns: () => [
      { header: 'Document', text: (r) => docLabel(r.doc_type), width: 26 },
      { header: 'Prefix', text: (r) => r.prefix, width: 12 },
      { header: 'Next number', num: true, text: (r) => String(r.next_number), width: 14 },
      { header: 'Digits', num: true, text: (r) => String(r.padding), width: 10 },
      { header: 'Next reference', text: nextRef, width: 20 },
    ],
    toForm: (r) => ({ doc_label: docLabel(r.doc_type) }),
    fields: () => [
      { name: 'doc_label', label: 'Document', disabled: true, full: true },
      { name: 'prefix', label: 'Prefix', hint: 'For example INV-. May be blank.' },
      { name: 'padding', label: 'Digits', type: 'number', required: true },
      { name: 'next_number', label: 'Next number', type: 'number', required: true, hint: 'Can be raised, never lowered.' },
    ],
    validate: (v, row) => {
      if (!Number.isInteger(v.padding) || v.padding < 1 || v.padding > 12) throw new Error('Digits must be a whole number from 1 to 12.');
      if (!Number.isInteger(v.next_number) || v.next_number < 1) throw new Error('The next number must be a whole number of 1 or more.');
      if (v.next_number < row.next_number) throw new Error('The next number cannot be lower than the current one, so numbers are never duplicated.');
    },
    toPayload: (v) => ({ prefix: v.prefix, next_number: v.next_number, padding: v.padding }),
  });
}