import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { setupPage } from '../core/setup-page.js';

const STATUS = { open: 'Open', on_hold: 'On hold', closed: 'Closed' };

const ctx = await startPage();
if (ctx) {
  await setupPage(ctx, {
    table: 'projects', noun: 'Project', plural: 'projects', file: 'projects', search: true,
    hint: 'A project or job reports the profit of one piece of work. Leave the code blank to number it automatically (PRJ-0001). A project can belong to a customer or be internal. Pick it on invoices, credit notes and manual journals (and bills), then read its profit in Project Report. A closed project accepts no new postings.',
    defaults: { status: 'open' },
    duplicateMessage: 'That project code already exists.',
    toolbarLinks: [{ text: 'Project report', href: '/pages/project-report.html' }],
    rowLinks: [{ text: 'Report', href: (r) => `/pages/project-report.html?project=${r.id}` }],

    lookups: async (c) => {
      const [cu, it] = await Promise.all([
        supabase.from('customers').select('id, code, name').eq('company_id', c.companyId).eq('is_active', true).order('code'),
        supabase.from('items').select('id, code, name').eq('company_id', c.companyId).eq('is_active', true).eq('item_type', 'service').order('code'),
      ]);
      if (cu.error) throw cu.error;
      if (it.error) throw it.error;
      return { customers: cu.data, items: it.data };
    },

    columns: (lk) => {
      const cust = (id) => { const x = lk.customers.find((y) => y.id === id); return x ? `${x.code} - ${x.name}` : ''; };
      const num = (n) => (n === null || n === undefined ? '' : Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
      return [
        { header: 'Code', text: (r) => r.code, width: 12 },
        { header: 'Name', text: (r) => r.name, width: 32 },
        { header: 'Customer', text: (r) => cust(r.customer_id), width: 30 },
        { header: 'Status', text: (r) => STATUS[r.status] || r.status, width: 10 },
        { header: 'Start', text: (r) => r.start_date || '', width: 12 },
        { header: 'End', text: (r) => r.end_date || '', width: 12 },
        { header: 'Budget income', num: true, text: (r) => num(r.budget_income), width: 16 },
        { header: 'Budget cost', num: true, text: (r) => num(r.budget_cost), width: 16 },
        { header: 'Hourly rate', num: true, text: (r) => num(r.hourly_rate), width: 14 },
      ];
    },

    fields: (lk) => [
      { name: 'code', label: 'Code', hint: 'Leave blank on a new project to number it automatically.' },
      { name: 'name', label: 'Name', required: true },
      { name: 'customer_id', label: 'Customer', type: 'select', full: true,
        options: [{ value: '', label: 'No customer (internal project)' }].concat(lk.customers.map((c) => ({ value: c.id, label: `${c.code} - ${c.name}` }))) },
      { name: 'status', label: 'Status', type: 'select', options: Object.entries(STATUS).map(([value, label]) => ({ value, label })),
        hint: 'A closed project rejects new postings. Reversals still work.' },
      { name: 'start_date', label: 'Start date', type: 'date' },
      { name: 'end_date', label: 'End date', type: 'date' },
      { name: 'budget_income', label: 'Budget income', type: 'number', hint: 'Optional. Shown against actual in Project Report.' },
      { name: 'budget_cost', label: 'Budget cost', type: 'number' },
      { name: 'time_item_id', label: 'Bill time as', type: 'select',
        options: [{ value: '', label: 'Not billed by the hour' }].concat(lk.items.map((i) => ({ value: i.id, label: `${i.code} - ${i.name}` }))),
        hint: 'The service item time on this project is invoiced as (Time page).' },
      { name: 'hourly_rate', label: 'Hourly rate', type: 'number',
        hint: "In the customer's invoice currency. Blank uses the item's sales price." },
      { name: 'notes', label: 'Notes', type: 'textarea', full: true },
    ],

    validate: (v) => {
      if (v.budget_income !== null && v.budget_income < 0) throw new Error('The budget cannot be negative.');
      if (v.budget_cost !== null && v.budget_cost < 0) throw new Error('The budget cannot be negative.');
      if (v.hourly_rate !== null && v.hourly_rate < 0) throw new Error('The hourly rate cannot be negative.');
    },

    toPayload: (v) => ({
      code: String(v.code || '').trim(), name: v.name, customer_id: v.customer_id || null, status: v.status || 'open',
      start_date: v.start_date || null, end_date: v.end_date || null,
      budget_income: v.budget_income === '' ? null : v.budget_income, budget_cost: v.budget_cost === '' ? null : v.budget_cost,
      time_item_id: v.time_item_id || null, hourly_rate: v.hourly_rate === '' ? null : v.hourly_rate,
      notes: v.notes || null,
    }),
  });
}