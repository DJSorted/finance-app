import { startPage } from '../core/shell.js';
import { setupPage } from '../core/setup-page.js';

const ctx = await startPage();
if (ctx) {
  await setupPage(ctx, {
    table: 'warehouses', noun: 'Warehouse', plural: 'warehouses', file: 'warehouses',
    hint: 'Stock is held and costed per warehouse. The default warehouse is used when a document does not name one. To change the default, tick Default on the new one.',
    defaults: { is_default: false, allow_negative_stock: false, is_active: true },
    duplicateMessage: 'That warehouse code already exists.',
    columns: () => [
      { header: 'Code', text: (r) => r.code, width: 12 },
      { header: 'Name', text: (r) => r.name, width: 28 },
      { header: 'Default', text: (r) => (r.is_default ? 'Yes' : ''), width: 10 },
      { header: 'Negative stock', text: (r) => (r.allow_negative_stock ? 'Allowed' : 'Blocked'), width: 16 },
      { header: 'Active', text: (r) => (r.is_active ? 'Yes' : 'No'), width: 8 },
    ],
    fields: () => [
      { name: 'code', label: 'Code', required: true },
      { name: 'name', label: 'Name', required: true },
      { name: 'address', label: 'Address', type: 'textarea', full: true },
      { name: 'is_default', label: 'Default warehouse', type: 'checkbox', full: true },
      { name: 'allow_negative_stock', label: 'Allow stock to go negative', type: 'checkbox', full: true,
        hint: 'Leave off unless you really need it. Blocking negative stock keeps weighted average costs reliable.' },
      { name: 'is_active', label: 'Active', type: 'checkbox' },
    ],
    beforeDelete: (row) => (row.is_default ? 'The default warehouse cannot be deleted. Make another warehouse the default first.' : ''),
    toPayload: (v) => ({
      code: v.code.toUpperCase(), name: v.name, address: v.address || null,
      is_default: v.is_default, allow_negative_stock: v.allow_negative_stock, is_active: v.is_active,
    }),
  });
}