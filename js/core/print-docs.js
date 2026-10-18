import { supabase } from './supabase.js';
import { ui } from './ui.js';
import { logoUrl } from './logo.js';

/* Printable documents: invoices and credit notes, purchase orders and statements of account.
   Each opens the browser print dialog (choose "Save as PDF" to keep a copy). Company and party details
   are printed from whichever of the usual address, contact and tax number columns exist and are filled in. */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n, d = 2) => Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const qty = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 4 });
const signed = (n, d = 2) => (Math.abs(n) < 0.00005 ? '' : (n < 0 ? `(${money(-n, d)})` : money(n, d)));
const nl = (s) => esc(s).replace(/\n/g, '<br>');

const ADDRESS = ['address', 'address1', 'address_line1', 'address_line_1', 'address2', 'address_line2', 'address_line_2', 'street',
  'suburb', 'city', 'state', 'province', 'postal_code', 'postcode', 'zip', 'country'];
const CONTACT = ['email', 'phone', 'mobile', 'website'];
const TAX_IDS = ['tax_number', 'vat_number', 'vat_no', 'tax_no', 'registration_number', 'company_registration', 'reg_no'];
const FOOTER_KEYS = ['print_footer', 'document_footer', 'bank_details'];

function detailHtml(row) {
  if (!row) return '';
  const out = [];
  const has = (k) => typeof row[k] === 'string' && row[k].trim();
  ADDRESS.forEach((k) => { if (has(k)) out.push(nl(row[k].trim())); });
  CONTACT.forEach((k) => { if (has(k)) out.push(esc(row[k].trim())); });
  TAX_IDS.forEach((k) => {
    if (has(k)) out.push(`${k.includes('vat') ? 'VAT no' : (k.includes('reg') ? 'Reg no' : 'Tax no')}: ${esc(row[k].trim())}`);
  });
  return out.join('<br>');
}

/* ---------- settings (Document Settings page) ---------- */

export const DEFAULT_SETTINGS = {
  template: 'blue', accent: '#1f5fbf', greeting: '', closing: '', footer_text: '',
  extra1_label: '', extra2_label: '', show_project_default: false,
};

// Falls back to the defaults when the settings tables are missing or unreadable, so printing never breaks.
async function loadSettings(companyId) {
  const [s, b] = await Promise.all([
    supabase.from('document_settings').select('*').eq('company_id', companyId).maybeSingle(),
    supabase.from('document_bank_details').select('*').eq('company_id', companyId).order('sort_order').order('created_at'),
  ]);
  return { settings: { ...DEFAULT_SETTINGS, ...(s.error ? {} : (s.data || {})) }, banks: b.error ? [] : (b.data || []) };
}

function bankFor(banks, cur) {
  return banks.find((b) => b.currency_code === cur) || banks.find((b) => !b.currency_code) || null;
}

const accentOf = (s) => (/^#[0-9a-f]{6}$/i.test(s.accent || '') ? s.accent : DEFAULT_SETTINGS.accent);

function templateCss(s) {
  const a = accentOf(s);
  if (s.template === 'classic') return '';
  if (s.template === 'modern') {
    return `.head{background:${a};color:#fff;padding:14px 16px;border-radius:4px}.head .muted{color:rgba(255,255,255,.85)}
      table.lines th{background:${a};color:#fff;border-bottom-color:${a}}h2{color:${a}}
      table.tot tr.grand td{border-top-color:${a};color:${a}}`;
  }
  return `h1,h2{color:${a}}table.lines th{background:${a}1a;color:${a};border-bottom:2px solid ${a}}
    table.tot tr.grand td{border-top-color:${a}}.parties>div{border-color:${a}55}`;
}

function docHtml(title, body, s = DEFAULT_SETTINGS) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
      @page{size:A4;margin:14mm}
      body{font:12px/1.45 Arial,sans-serif;color:#111;margin:0}
      .head{display:flex;justify-content:space-between;align-items:flex-start;gap:24px}
      .co img{max-height:64px;max-width:220px;display:block;margin-bottom:6px}
      h1{font-size:22px;margin:0 0 6px}
      h2{font-size:14px;margin:18px 0 4px}
      .muted{color:#555}
      .meta td{padding:1px 0}
      .parties{display:flex;gap:24px;margin-top:18px}
      .parties>div{flex:1;border:1px solid #ccc;border-radius:4px;padding:8px 10px}
      table.lines{width:100%;border-collapse:collapse;margin-top:14px}
      table.lines th{background:#f0f0f0;text-align:left;padding:6px 8px;border-bottom:1px solid #999}
      table.lines td{padding:6px 8px;border-bottom:1px solid #ddd;vertical-align:top}
      table.lines tr.strong td{font-weight:bold;background:#f7f7f7}
      .n{text-align:right;white-space:nowrap}
      table.tot{margin-left:auto;width:52%;border-collapse:collapse;margin-top:10px}
      table.tot td{padding:4px 8px}
      table.tot tr.grand td{font-weight:bold;font-size:13px;border-top:2px solid #111}
      .note{margin-top:12px}
      .bank{margin-top:14px;border:1px solid #ccc;border-radius:4px;padding:8px 10px;width:48%;box-sizing:border-box;break-inside:avoid}
      .paid{display:inline-block;margin-top:10px;padding:4px 10px;border:2px solid #1a7f37;color:#1a7f37;border-radius:4px;font-weight:bold;letter-spacing:.05em}
      .foot{margin-top:26px;border-top:1px solid #ccc;padding-top:8px;color:#444;font-size:11px}
      .sign{display:flex;gap:40px;margin-top:48px}.sign div{flex:1;border-top:1px solid #000;padding-top:4px}
      ${templateCss(s)}
      </style></head><body>${body}</body></html>`;
}

// Asks for the extra field values (and whether to show the project) before printing.
// Resolves null when cancelled.
async function askExtras(s, withProject) {
  const labels = [s.extra1_label, s.extra2_label].map((x) => (x || '').trim());
  if (!labels[0] && !labels[1] && !withProject) return { extras: [], project: false };
  const node = document.createElement('div');
  node.className = 'form-grid';
  const inputs = labels.map((l) => {
    if (!l) return null;
    const w = document.createElement('div');
    w.className = 'field full';
    const lab = document.createElement('label');
    lab.textContent = l;
    const i = document.createElement('input');
    w.append(lab, i);
    node.append(w);
    return i;
  });
  let proj = null;
  if (withProject) {
    const w = document.createElement('div');
    w.className = 'field check';
    proj = document.createElement('input');
    proj.type = 'checkbox';
    proj.style.width = 'auto';
    proj.checked = !!s.show_project_default;
    const lab = document.createElement('label');
    lab.textContent = 'Show the project';
    w.append(proj, lab);
    node.append(w);
  }
  const res = await ui.dialog({ title: 'Print', node, dismissValue: false,
    buttons: [{ label: 'Cancel', value: false, className: 'btn-ghost' }, { label: 'Print', value: true, className: 'btn-primary' }] });
  if (!res) return null;
  return {
    extras: labels.map((l, i) => [l, inputs[i] ? inputs[i].value.trim() : '']).filter(([l, v]) => l && v),
    project: proj ? proj.checked : false,
  };
}

const greetingHtml = (s, name) => (s.greeting && s.greeting.trim()
  ? `<div class="note">${nl(s.greeting.trim().replace(/\{name\}/g, name || ''))}</div>` : '');
const closingHtml = (s) => (s.closing && s.closing.trim() ? `<div class="note">${nl(s.closing.trim())}</div>` : '');
const bankHtml = (bank) => (bank ? `<div class="bank"><strong>${esc(bank.label)}</strong><br>${nl(bank.details)}</div>` : '');

export function printHtml(title, body, settings) {
  return new Promise((resolve) => {
    const f = document.createElement('iframe');
    f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    document.body.append(f);
    const w = f.contentWindow;
    const d = w.document;
    d.open();
    d.write(docHtml(title, body, settings));
    d.close();
    const go = async () => {
      await Promise.all([...d.images].map((i) => (i.complete ? null : new Promise((r) => { i.onload = r; i.onerror = r; }))));
      w.focus();
      w.print();
      setTimeout(() => { f.remove(); resolve(); }, 1500);
    };
    setTimeout(go, 100);
  });
}

async function loadCompany(ctx) {
  const [c, b] = await Promise.all([
    supabase.from('companies').select('*').eq('id', ctx.companyId).maybeSingle(),
    supabase.from('company_currencies').select('code').eq('company_id', ctx.companyId).eq('is_base', true).maybeSingle(),
  ]);
  return { row: c.data || ctx.company, base: b.data ? b.data.code : '' };
}

async function decimalsOf(code) {
  const { data } = await supabase.from('currencies').select('decimals').eq('code', code).maybeSingle();
  return data ? Number(data.decimals) : 2;
}

function header(company, title, meta) {
  const logo = logoUrl(company);
  return `<div class="head"><div class="co">${logo ? `<img src="${esc(logo)}" alt="">` : ''}<strong>${esc(company.name)}</strong>
    <div class="muted">${detailHtml(company)}</div></div>
    <div style="text-align:right"><h1>${esc(title)}</h1><table class="meta" style="margin-left:auto">${meta.filter((m) => m[1]).map(([k, v]) =>
    `<tr><td class="muted" style="padding-right:10px;text-align:right">${esc(k)}</td><td style="text-align:right"><strong>${esc(v)}</strong></td></tr>`).join('')}</table></div></div>`;
}

function footer(company, s = DEFAULT_SETTINGS) {
  const custom = s.footer_text && s.footer_text.trim() ? [s.footer_text] : [];
  const parts = custom.concat(FOOTER_KEYS.map((k) => company[k])).filter((x) => typeof x === 'string' && x.trim());
  return parts.length ? `<div class="foot">${parts.map(nl).join('<br><br>')}</div>` : '';
}

/* ---------- invoice and credit note ---------- */

// outstanding: amount still owed on a posted invoice (null when unknown, e.g. a draft); paid = gross - outstanding.
function salesBody({ company, base, d, lines, dec, customer, termsName, s, bank, extras = [], projectText = '', outstanding = null }) {
  const isInv = d.doc_type === 'invoice';
  const hasTax = Number(d.tax_total) > 0;
  const title = `${hasTax ? 'Tax ' : ''}${isInv ? 'invoice' : 'credit note'}`.replace(/^./, (c) => c.toUpperCase());

  const rows = lines.map((x, i) => `<tr><td>${i + 1}</td>
      <td>${esc(x.description)}${x.items && x.items.code ? `<div class="muted">${esc(x.items.code)}</div>` : ''}</td>
      <td class="n">${qty(x.quantity)}</td><td class="n">${money(x.unit_price, dec)}</td>
      ${hasTax ? `<td class="n">${Number(x.tax_rate) ? `${Number(x.tax_rate)}%` : ''}</td>` : ''}
      <td class="n">${money(x.net_amount, dec)}</td></tr>`).join('');

  const byRate = new Map();
  lines.forEach((x) => {
    if (!(Number(x.tax_amount) > 0)) return;
    const k = Number(x.tax_rate);
    const t = byRate.get(k) || { net: 0, tax: 0 };
    t.net += Number(x.net_amount);
    t.tax += Number(x.tax_amount);
    byRate.set(k, t);
  });
  const taxRows = [...byRate.entries()].map(([rate, t]) =>
    `<tr><td class="muted">Tax at ${rate}% on ${money(t.net, dec)}</td><td class="n">${money(t.tax, dec)}</td></tr>`).join('');

  const foreign = base && d.currency_code !== base;
  const rateNote = foreign
    ? `<div class="note muted">Amounts are in ${esc(d.currency_code)}. Exchange rate: 1 ${esc(d.currency_code)} = ${Number(d.fx_rate).toFixed(4)} ${esc(base)}.${hasTax ? ` Tax in ${esc(base)}: ${money(Number(d.tax_total) * Number(d.fx_rate), 2)}.` : ''}</div>`
    : '';

  const cur = esc(d.currency_code);
  const gross = Number(d.gross_total);
  const tracked = isInv && outstanding !== null;
  const owed = tracked ? Math.max(0, Math.min(gross, outstanding)) : gross;
  const paidAmt = tracked ? gross - owed : 0;
  const isPaid = tracked && owed < 0.005;
  let payRows;
  if (!isInv) payRows = `<tr class="grand"><td>Total credited (${cur})</td><td class="n">${money(gross, dec)}</td></tr>`;
  else if (!tracked || paidAmt < 0.005) payRows = `<tr class="grand"><td>Total due (${cur})</td><td class="n">${money(gross, dec)}</td></tr>`;
  else {
    payRows = `<tr class="grand"><td>Total (${cur})</td><td class="n">${money(gross, dec)}</td></tr>
      <tr><td class="muted">Paid and credited</td><td class="n">(${money(paidAmt, dec)})</td></tr>
      <tr class="grand"><td>Balance due (${cur})</td><td class="n">${money(owed, dec)}</td></tr>`;
  }

  const body = `${header(company, title, [
    [`${isInv ? 'Invoice' : 'Credit note'} no`, d.doc_no], ['Date', d.doc_date], isInv ? ['Due date', d.due_date] : ['', ''],
    ['Reference', d.reference], ['Payment terms', termsName], ['Project', projectText], ...extras,
  ])}
      <div class="parties"><div><div class="muted">${isInv ? 'Bill to' : 'Credit to'}</div><strong>${esc(customer.name || '')}</strong>
        <div>${detailHtml(customer)}</div></div></div>
      ${greetingHtml(s, customer.name)}
      <table class="lines"><thead><tr><th>#</th><th>Description</th><th class="n">Quantity</th><th class="n">Price</th>
        ${hasTax ? '<th class="n">Tax</th>' : ''}<th class="n">Amount</th></tr></thead><tbody>${rows}</tbody></table>
      <table class="tot"><tr><td class="muted">Subtotal</td><td class="n">${money(d.net_total, dec)}</td></tr>${taxRows}
        ${hasTax ? `<tr><td class="muted">Total tax</td><td class="n">${money(d.tax_total, dec)}</td></tr>` : ''}
        ${payRows}</table>
      ${isPaid ? '<div style="text-align:right"><span class="paid">PAID</span></div>' : ''}
      ${rateNote}${d.notes ? `<div class="note"><strong>Notes</strong><br>${nl(d.notes)}</div>` : ''}
      ${closingHtml(s)}${isInv && !isPaid ? bankHtml(bank) : ''}${footer(company, s)}`;
  return { title, body };
}

// Full HTML of a made-up invoice, for the preview on the Document Settings page.
export async function sampleDocumentHtml(ctx, settings, banks = []) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const co = await loadCompany(ctx);
  const cur = co.base || 'ZAR';
  const lines = [
    { description: 'Consulting services', items: { code: 'SVC-01' }, quantity: 10, unit_price: 850, tax_rate: 15, net_amount: 8500, tax_amount: 1275 },
    { description: 'Widget, large', items: { code: 'WID-L' }, quantity: 4, unit_price: 312.5, tax_rate: 15, net_amount: 1250, tax_amount: 187.5 },
  ];
  const d = {
    doc_type: 'invoice', doc_no: 'INV-0001', doc_date: new Date().toISOString().slice(0, 10), due_date: '', reference: 'PO 12345',
    currency_code: cur, fx_rate: 1, net_total: 9750, tax_total: 1462.5, gross_total: 11212.5, notes: '',
  };
  const extras = [s.extra1_label, s.extra2_label].filter((x) => x && x.trim()).map((l) => [l.trim(), '(entered when printing)']);
  const { title, body } = salesBody({
    company: co.row, base: co.base, d, lines, dec: 2, customer: { name: 'Sample Customer (Pty) Ltd', address: '1 Example Street\nCape Town' },
    termsName: '30 days', s, bank: bankFor(banks, cur), extras, projectText: s.show_project_default ? 'PRJ-01 - Sample project' : '',
  });
  return docHtml(title, body, s);
}

export async function printSalesDocument(ctx, d) {
  try {
    const [l, cust, co, dec, terms, cfg] = await Promise.all([
      supabase.from('sales_document_lines').select('*, items(code)').eq('document_id', d.id).order('line_no'),
      supabase.from('customers').select('*').eq('id', d.customer_id).maybeSingle(),
      loadCompany(ctx),
      decimalsOf(d.currency_code),
      d.payment_terms_id ? supabase.from('payment_terms').select('name').eq('id', d.payment_terms_id).maybeSingle() : Promise.resolve({ data: null }),
      loadSettings(ctx.companyId),
    ]);
    if (l.error) throw l.error;
    const s = cfg.settings;
    const projectIds = [...new Set(l.data.map((x) => x.project_id).filter(Boolean))];
    const ask = await askExtras(s, projectIds.length > 0);
    if (!ask) return;
    let projectText = '';
    if (ask.project && projectIds.length) {
      const p = await supabase.from('projects').select('code, name').in('id', projectIds);
      if (!p.error) projectText = p.data.map((x) => `${x.code} - ${x.name}`).join(', ');
    }
    // Posted invoices: what is still owed today, after receipts and credit notes applied to it.
    let outstanding = null;
    if (d.doc_type === 'invoice' && d.status === 'posted') {
      const n = new Date();
      const today = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
      const oi = await supabase.rpc('sales_open_items', { p_company: ctx.companyId, p_customer: d.customer_id, p_as_of: today });
      if (!oi.error) {
        const row = (oi.data || []).find((i) => i.doc_id === d.id && i.doc_kind === 'invoice');
        outstanding = row ? Number(row.outstanding) : 0;
      }
    }
    const { title, body } = salesBody({
      company: co.row, base: co.base, d, lines: l.data, dec, customer: cust.data || {}, termsName: terms.data ? terms.data.name : '',
      s, bank: bankFor(cfg.banks, d.currency_code), extras: ask.extras, projectText, outstanding,
    });
    await printHtml(`${title} ${d.doc_no}`, body, s);
  } catch (e) { ui.errorFrom(e, 'Could not prepare the document for printing.'); }
}

/* ---------- purchase order ---------- */

export async function printPurchaseOrder(ctx, o) {
  try {
    const [l, sup, co, dec, cfg] = await Promise.all([
      supabase.from('purchase_order_lines').select('*, items(code, name)').eq('order_id', o.id).order('line_no'),
      supabase.from('suppliers').select('*').eq('id', o.supplier_id).maybeSingle(),
      loadCompany(ctx),
      decimalsOf(o.currency_code),
      loadSettings(ctx.companyId),
    ]);
    if (l.error) throw l.error;
    const s = cfg.settings;
    const ask = await askExtras(s, false);
    if (!ask) return;
    const supplier = sup.data || {};
    const rows = l.data.map((x, i) => `<tr><td>${i + 1}</td>
      <td>${esc(x.description)}${x.items && x.items.code ? `<div class="muted">${esc(x.items.code)}</div>` : ''}</td>
      <td class="n">${qty(x.qty_ordered)}</td><td class="n">${money(x.unit_price, dec)}</td><td class="n">${money(x.line_total, dec)}</td></tr>`).join('');
    const wh = o.warehouses ? `${o.warehouses.code} - ${o.warehouses.name}` : '';
    const body = `${header(co.row, 'Purchase order', [
      ['Order no', o.po_no], ['Date', o.order_date], ['Expected delivery', o.expected_date], ['Reference', o.reference], ...ask.extras,
    ])}
      <div class="parties"><div><div class="muted">Supplier</div><strong>${esc(supplier.name || '')}</strong><div>${detailHtml(supplier)}</div></div>
        <div><div class="muted">Deliver to</div><strong>${esc(wh)}</strong><div>${detailHtml(co.row)}</div></div></div>
      ${greetingHtml(s, supplier.name)}
      <table class="lines"><thead><tr><th>#</th><th>Description</th><th class="n">Quantity</th><th class="n">Unit price</th><th class="n">Total</th></tr></thead>
        <tbody>${rows}</tbody></table>
      <table class="tot"><tr class="grand"><td>Order total (${esc(o.currency_code)})</td><td class="n">${money(o.total, dec)}</td></tr></table>
      ${o.notes ? `<div class="note"><strong>Notes</strong><br>${nl(o.notes)}</div>` : ''}
      <div class="note muted">Please quote the order number on your delivery note and invoice.</div>${closingHtml(s)}${footer(co.row, s)}`;
    await printHtml(`Purchase order ${o.po_no || ''}`, body, s);
  } catch (e) { ui.errorFrom(e, 'Could not prepare the document for printing.'); }
}

/* ---------- statement of account ---------- */
// opts: { title, partyTable, partyId, from, to, base, headers: { debit, credit, balance },
//         blocks: [{ cur, dec, opening, closing, lines: [{ date, type, no, ref, debit, credit, balance }] }],
//         openItems: [{ type, no, date, due, cur, outstanding, base }] }

export async function printStatement(ctx, opts) {
  try {
    const [p, co, cfg] = await Promise.all([
      supabase.from(opts.partyTable).select('*').eq('id', opts.partyId).maybeSingle(),
      loadCompany(ctx),
      loadSettings(ctx.companyId),
    ]);
    const s = cfg.settings;
    const party = p.data || {};
    const h = opts.headers || { debit: 'Debit', credit: 'Credit', balance: 'Balance' };

    const blocks = opts.blocks.map((b) => `<h2>${esc(b.cur)}</h2>
      <table class="lines"><thead><tr><th>Date</th><th>Type</th><th>No</th><th>Reference</th><th class="n">${esc(h.debit)}</th><th class="n">${esc(h.credit)}</th><th class="n">${esc(h.balance)}</th></tr></thead><tbody>
      <tr class="strong"><td colspan="6">Opening balance at ${esc(opts.from)}</td><td class="n">${signed(b.opening, b.dec) || '0.00'}</td></tr>
      ${b.lines.map((r) => `<tr><td>${esc(r.date)}</td><td>${esc(r.type)}</td><td>${esc(r.no)}</td><td>${esc(r.ref)}</td>
        <td class="n">${r.debit ? money(r.debit, b.dec) : ''}</td><td class="n">${r.credit ? money(r.credit, b.dec) : ''}</td><td class="n">${signed(r.balance, b.dec) || '0.00'}</td></tr>`).join('')}
      <tr class="strong"><td colspan="6">Balance at ${esc(opts.to)} (${esc(b.cur)})</td><td class="n">${signed(b.closing, b.dec) || '0.00'}</td></tr></tbody></table>`).join('');

    const items = opts.openItems.length ? `<h2>Open items at ${esc(opts.to)}</h2>
      <table class="lines"><thead><tr><th>Type</th><th>No</th><th>Date</th><th>Due</th><th>Cur</th><th class="n">Outstanding</th></tr></thead><tbody>
      ${opts.openItems.map((i) => `<tr><td>${esc(i.type)}</td><td>${esc(i.no)}</td><td>${esc(i.date)}</td><td>${esc(i.due || '')}</td>
        <td>${esc(i.cur)}</td><td class="n">${signed(i.outstanding, 2)}</td></tr>`).join('')}</tbody></table>` : '';

    const due = opts.blocks.filter((b) => Math.abs(b.closing) >= 0.005).map((b) => `${signed(b.closing, b.dec)} ${esc(b.cur)}`).join(' &nbsp;·&nbsp; ');
    const body = `${header(co.row, opts.title || 'Statement of account', [['Statement date', opts.to], ['Period from', opts.from]])}
      <div class="parties"><div><div class="muted">Account</div><strong>${esc(party.name || '')}</strong>
        ${party.code ? `<div class="muted">${esc(party.code)}</div>` : ''}<div>${detailHtml(party)}</div></div>
        <div><div class="muted">Balance</div><div style="font-size:16px"><strong>${due || '0.00'}</strong></div>
        <div class="muted">Brackets are credit balances.</div></div></div>
      ${greetingHtml(s, party.name)}${blocks || '<p class="muted">No activity in this period.</p>'}${items}${closingHtml(s)}${opts.partyTable === 'customers' ? bankHtml(bankFor(cfg.banks, opts.base)) : ''}${footer(co.row, s)}`;
    await printHtml(`${opts.title || 'Statement'} ${party.code || ''}`, body, s);
  } catch (e) { ui.errorFrom(e, 'Could not prepare the statement for printing.'); }
}
