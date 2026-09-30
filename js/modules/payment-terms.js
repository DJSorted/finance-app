import { startPage } from '../core/shell.js';
import { setupPage } from '../core/setup-page.js';

const BASES = [
  ['days_from_document', 'Days after the document date'],
  ['days_from_month_end', 'Days after the end of the document month'],
];
const termsText = (r) => {
  if (r.basis === 'days_from_document') return r.days === 0 ? 'Due on the document date' : `${r.days} days after the document date`;
  return r.days === 0 ? 'Due at the end of the month' : `${r.days} days after the end of the month`;
};

const ctx = await startPage();
if (ctx) {
  await setupPage(ctx, {
    table: 'payment_terms', noun: 'Payment term', plural: 'payment terms', file: 'payment-terms',
    hint: 'Payment terms work out the due date of invoices and bills. Customers and suppliers get a default term that flows onto their documents.',
    defaults: { basis: 'days_from_document', days: 30, is_active: true },
    duplicateMessage: 'That payment term code already exists.',
    columns: () => [
      { header: 'Code', text: (r) => r.code, width: 14 },
      { header: 'Name', text: (r) => r.name, width: 32 },
      { header: 'Due date rule', text: termsText, width: 36 },
      { header: 'Active', text: (r) => (r.is_active ? 'Yes' : 'No'), width: 8 },
    ],
    fields: () => [
      { name: 'code', label: 'Code', required: true },
      { name: 'name', label: 'Name', required: true },
      { name: 'basis', label: 'Counted from', type: 'select', required: true, full: true, options: BASES.map(([value, label]) => ({ value, label })) },
      { name: 'days', label: 'Days', type: 'number', required: true },
      { name: 'is_active', label: 'Active', type: 'checkbox' },
    ],
    validate: (v) => {
      if (!Number.isInteger(v.days) || v.days < 0 || v.days > 365) throw new Error('Days must be a whole number from 0 to 365.');
    },
    toPayload: (v) => ({ code: v.code.toUpperCase(), name: v.name, basis: v.basis, days: v.days, is_active: v.is_active }),
  });
}