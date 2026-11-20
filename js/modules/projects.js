import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { setupPage } from '../core/setup-page.js';

const STATUS = { open: 'Open', on_hold: 'On hold', closed: 'Closed' };

// Reads every page of a query (PostgREST returns at most 1000 rows per request).
async function selectAll(build) {
  const out = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await build().range(f, f + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

// Hours = all finished time logged on the project. Invoiced = posted invoices less posted credit notes,
// net of tax, converted to the base currency at each document's rate.
async function projectTotals(cid) {
  const [te, sl, cur] = await Promise.all([
    selectAll(() => supabase.from('time_entries').select('project_id, minutes').eq('company_id', cid).not('end_at', 'is', null).order('id')),
    selectAll(() => supabase.from('sales_document_lines')
      .select('project_id, net_amount, sales_documents!inner(company_id, doc_type, status, currency_code, fx_rate)')
      .eq('sales_documents.company_id', cid).eq('sales_documents.status', 'posted').not('project_id', 'is', null).order('id')),
    supabase.from('company_currencies').select('code').eq('company_id', cid).eq('is_base', true).maybeSingle(),
  ]);
  if (cur.error) throw cur.error;
  const base = cur.data ? cur.data.code : '';
  const hours = new Map();
  const invoiced = new Map();
  te.forEach((e) => hours.set(e.project_id, (hours.get(e.project_id) || 0) + Number(e.minutes) / 60));
  sl.forEach((l) => {
    const d = l.sales_documents;
    const rate = d.currency_code === base ? 1 : Number(d.fx_rate);
    const sign = d.doc_type === 'credit_note' ? -1 : 1;
    invoiced.set(l.project_id, (invoiced.get(l.project_id) || 0) + sign * Number(l.net_amount) * rate);
  });
  return { hours, invoiced, base };
}

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
      const [cu, it, totals] = await Promise.all([
        supabase.from('customers').select('id, code, name').eq('company_id', c.companyId).eq('is_active', true).order('code'),
        supabase.from('items').select('id, code, name').eq('company_id', c.companyId).eq('is_active', true).eq('item_type', 'service').order('code'),
        projectTotals(c.companyId),
      ]);
      if (cu.error) throw cu.error;
      if (it.error) throw it.error;
      return { customers: cu.data, items: it.data, totals };
    },

    columns: (lk) => {
      const cust = (id) => { const x = lk.customers.find((y) => y.id === id); return x ? `${x.code} - ${x.name}` : ''; };
      const num = (n) => (n === null || n === undefined ? '' : Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
      return [
        { header: 'Code', text: (r) => r.code, width: 12 },
        { header: 'Name', text: (r) => r.name, width: 32 },
        { header: 'Job', text: (r) => r.job || '', width: 20 },
        { header: 'Customer', text: (r) => cust(r.customer_id), width: 30 },
        { header: 'Status', text: (r) => STATUS[r.status] || r.status, width: 10 },
        { header: 'Start', text: (r) => r.start_date || '', width: 12 },
        { header: 'End', text: (r) => r.end_date || '', width: 12 },
        { header: 'Budget income', num: true, text: (r) => num(r.budget_income), width: 16 },
        { header: 'Budget cost', num: true, text: (r) => num(r.budget_cost), width: 16 },
        { header: 'Hourly rate', num: true, text: (r) => num(r.hourly_rate), width: 14 },
        { header: 'Total hours', num: true, text: (r) => num(lk.totals.hours.get(r.id)), width: 12 },
        { header: `Invoiced${lk.totals.base ? ` (${lk.totals.base})` : ''}`, num: true, text: (r) => num(lk.totals.invoiced.get(r.id)), width: 16 },
      ];
    },

    fields: (lk) => [
      { name: 'code', label: 'Code', hint: 'Leave blank on a new project to number it automatically.' },
      { name: 'name', label: 'Name', required: true },
      { name: 'job', label: 'Job', full: true, hint: 'Printed on invoices when "Show the job" is ticked in the print dialog.' },
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
      code: String(v.code || '').trim(), name: v.name, job: String(v.job || '').trim() || null, customer_id: v.customer_id || null, status: v.status || 'open',
      start_date: v.start_date || null, end_date: v.end_date || null,
      budget_income: v.budget_income === '' ? null : v.budget_income, budget_cost: v.budget_cost === '' ? null : v.budget_cost,
      time_item_id: v.time_item_id || null, hourly_rate: v.hourly_rate === '' ? null : v.hourly_rate,
      notes: v.notes || null,
    }),
  });
}