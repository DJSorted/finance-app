import { startPage } from '../core/shell.js';
import { setupPage } from '../core/setup-page.js';

const ctx = await startPage();
if (ctx) {
  await setupPage(ctx, {
    table: 'item_groups', noun: 'Item group', plural: 'item groups', file: 'item-groups', search: true,
    hint: 'Groups sort items for searching and reports, for example by product line or brand. Unlike the category, a group does not affect the accounts and is not printed on documents.',
    defaults: { is_active: true },
    duplicateMessage: 'That group code already exists.',
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
