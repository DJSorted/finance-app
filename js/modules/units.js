import { startPage } from '../core/shell.js';
import { setupPage } from '../core/setup-page.js';

const ctx = await startPage();
if (ctx) {
  await setupPage(ctx, {
    table: 'units_of_measure', noun: 'Unit of measure', plural: 'units of measure', file: 'units-of-measure',
    hint: 'Units of measure say how items are counted or sold, for example each, kilogram or hour. Every item has one base unit.',
    defaults: { is_active: true },
    duplicateMessage: 'That unit code already exists.',
    columns: () => [
      { header: 'Code', text: (r) => r.code, width: 12 },
      { header: 'Name', text: (r) => r.name, width: 28 },
      { header: 'Active', text: (r) => (r.is_active ? 'Yes' : 'No'), width: 8 },
    ],
    fields: () => [
      { name: 'code', label: 'Code', required: true },
      { name: 'name', label: 'Name', required: true },
      { name: 'is_active', label: 'Active', type: 'checkbox' },
    ],
    toPayload: (v) => ({ code: v.code.toUpperCase(), name: v.name, is_active: v.is_active }),
  });
}