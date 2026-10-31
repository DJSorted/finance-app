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

// A delivery address: the address and phone numbers only (no email, website or tax numbers).
function addressHtml(row) {
  if (!row) return '';
  const has = (k) => typeof row[k] === 'string' && row[k].trim();
  return ADDRESS.concat(['phone', 'mobile']).filter(has).map((k) => nl(row[k].trim())).join('<br>');
}

/* ---------- settings (Document Settings page) ---------- */

export const DEFAULT_SETTINGS = {
  template: 'blue', accent: '#1f5fbf', greeting: '', closing: '', footer_text: '',
  extra1_label: '', extra2_label: '', show_project_default: false, show_job_default: false,
};

// Layouts offered on Document Settings and in the print dialog.
export const TEMPLATES = [
  ['blue', 'Blue (clean, blue headings and table)'],
  ['modern', 'Modern (blue header band)'],
  ['classic', 'Classic (black and grey)'],
  ['djsorted', 'DJ Sorted (logo right, Bill to / From, blue table)'],
];

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

// DJ Sorted look (as the dj-sorted invoice PDF): big title with the number in blue, logo top right, Bill to / From
// columns, solid blue table header with banded rows, blue total, payment details and contact side by side.
// The generic rules also give purchase orders, receipts and statements the same feel.
const DJ_CSS = `body{color:#1e1e1e}
  h1{font-size:28px}h2{color:#2f81f7}
  .head{border-bottom:1px solid #d2d2d2;padding-bottom:12px}
  table.lines th{background:#2f81f7;color:#fff;border-bottom:0;font-size:11px}
  table.lines tbody tr:nth-child(even) td{background:#f9fafc}
  table.lines td{border-bottom:0;padding:7px 8px 9px}
  table.tot tr.grand td{border-top:1px solid #d2d2d2;color:#2f81f7}
  .parties>div{border:0;padding:0}
  .parties .muted:first-child,.dj-lbl{font-size:10px;font-weight:bold;letter-spacing:.06em;text-transform:uppercase;color:#828282}
  .dj-top{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;padding-bottom:14px;border-bottom:1px solid #d2d2d2}
  .dj-top h1{font-size:34px;margin:0}
  .dj-no{color:#2f81f7;font-weight:bold;font-size:14px;margin-top:2px}
  .dj-logo img{max-height:90px;max-width:200px;display:block;border-radius:8px}
  .dj-logo strong{font-size:22px}
  .dj-cols{display:flex;gap:24px;margin-top:16px}
  .dj-cols>div{flex:1}
  .dj-cols>div+div{flex:0 0 42%}
  .dj-name{font-weight:bold;font-size:14px;margin:3px 0 2px}
  .dj-sub{color:#505050}
  .dj-meta{margin-top:8px;border-collapse:collapse}.dj-meta td{padding:1px 14px 1px 0}.dj-meta td:first-child{color:#828282}
  .dj-meta td+td{font-weight:bold}
  .dj-banner{margin-top:16px;background:#f5f7ff;border-left:4px solid #2f81f7;padding:8px 10px;font-weight:bold;font-size:13px}
  .dj-job{margin-top:14px;padding-top:10px;border-top:1px solid #d2d2d2}
  .dj-item{font-weight:bold}
  .dj-total td{font-size:15px}
  .dj-bottom{display:flex;gap:24px;margin-top:18px;padding-top:10px;border-top:1px solid #d2d2d2;font-size:11px;color:#505050;break-inside:avoid}
  .dj-bottom>div{flex:1}.dj-bottom strong{color:#1e1e1e}
  .dj-end{text-align:center;font-style:italic;color:#9a9a9a}`;

const accentOf = (s) => (/^#[0-9a-f]{6}$/i.test(s.accent || '') ? s.accent : DEFAULT_SETTINGS.accent);

function templateCss(s) {
  const a = accentOf(s);
  if (s.template === 'classic') return '';
  if (s.template === 'djsorted') return DJ_CSS;
  if (s.template === 'modern') {
    return `.head{background:${a};color:#fff;padding:14px 16px;border-radius:4px}.head .muted{color:rgba(255,255,255,.85)}
      table.lines th{background:${a};color:#fff;border-bottom-color:${a}}h2{color:${a}}
      table.tot tr.grand td{border-top-color:${a};color:${a}}`;
  }
  return `h1,h2{color:${a}}table.lines th{background:${a}1a;color:${a};border-bottom:2px solid ${a}}
    table.tot tr.grand td{border-top-color:${a}}.parties>div{border-color:${a}55}`;
}

// extraCss: added after the print styles (the shared link page uses it for the on-screen layout).
function docHtml(title, body, s = DEFAULT_SETTINGS, extraCss = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
      @page{size:A4;margin:14mm}
      body{font:12px/1.45 Arial,sans-serif;color:#111;margin:0}
      *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
      .page{display:flex;flex-direction:column;min-height:calc(297mm - 28mm - 4px)}
      .end{margin-top:auto}
      .closing{margin-top:18px;text-align:center}
      .head{display:flex;justify-content:space-between;align-items:flex-start;gap:24px}
      .co img{max-height:64px;max-width:220px;display:block;margin-bottom:6px;border-radius:10px}
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
      table.lines tr.sub td{border-bottom:0;padding-top:0;color:#555;font-size:11px}
      table.lines tr.sub td.txt{padding-left:18px}
      .n,table.lines th.n{text-align:right;white-space:nowrap}
      table.tot{margin-left:auto;width:52%;border-collapse:collapse;margin-top:10px}
      table.tot td{padding:4px 8px}
      table.tot tr.grand td{font-weight:bold;font-size:13px;border-top:2px solid #111}
      .note{margin-top:12px}
      .bank{margin-top:14px;border:1px solid #ccc;border-radius:4px;padding:8px 10px;width:48%;box-sizing:border-box;break-inside:avoid}
      .paid{display:inline-block;margin-top:10px;padding:4px 10px;border:2px solid #1a7f37;color:#1a7f37;border-radius:4px;font-weight:bold;letter-spacing:.05em}
      .paid.void{border-color:#b42318;color:#b42318}
      .amount{font-size:18px;font-weight:bold;margin-top:4px}
      .foot{margin-top:26px;border-top:1px solid #ccc;padding-top:8px;color:#444;font-size:11px}
      .sign{display:flex;gap:40px;margin-top:48px}.sign div{flex:1;border-top:1px solid #000;padding-top:4px}
      ${templateCss(s)}
      ${extraCss}
      </style></head><body><div class="page">${body}</div></body></html>`;
}

// Asks for the layout, the extra field values and whether to show the project and its job before printing or
// sharing. Resolves { extras, project, job, template }, or null when cancelled.
async function askExtras(s, withProject, action = 'Print', withJob = false) {
  const labels = [s.extra1_label, s.extra2_label].map((x) => (x || '').trim());
  const node = document.createElement('div');
  node.className = 'form-grid';
  const lw = document.createElement('div');
  lw.className = 'field full';
  const ll = document.createElement('label');
  ll.textContent = 'Layout';
  const layout = document.createElement('select');
  TEMPLATES.forEach(([v, l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; layout.append(o); });
  layout.value = TEMPLATES.some(([v]) => v === s.template) ? s.template : DEFAULT_SETTINGS.template;
  lw.append(ll, layout);
  node.append(lw);
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
  let job = null;
  if (withJob) {
    const w = document.createElement('div');
    w.className = 'field check';
    job = document.createElement('input');
    job.type = 'checkbox';
    job.style.width = 'auto';
    job.checked = !!s.show_job_default;
    const lab = document.createElement('label');
    lab.textContent = 'Show the job';
    w.append(job, lab);
    node.append(w);
  }
  const res = await ui.dialog({ title: action, node, dismissValue: false,
    buttons: [{ label: 'Cancel', value: false, className: 'btn-ghost' }, { label: action, value: true, className: 'btn-primary' }] });
  if (!res) return null;
  return {
    extras: labels.map((l, i) => [l, inputs[i] ? inputs[i].value.trim() : '']).filter(([l, v]) => l && v),
    project: proj ? proj.checked : false,
    job: job ? job.checked : false,
    template: layout.value,
  };
}

const greetingHtml = (s, name) => (s.greeting && s.greeting.trim()
  ? `<div class="note">${nl(s.greeting.trim().replace(/\{name\}/g, name || ''))}</div>` : '');
const closingHtml = (s) => (s.closing && s.closing.trim() ? `<div class="closing">${nl(s.closing.trim())}</div>` : '');
// The footer and the closing (thank you) note, pushed to the bottom of the page with the note centred last.
const endHtml = (company, s) => `<div class="end">${footer(company, s)}${closingHtml(s)}</div>`;
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

// A line's name and the grey text under it: the item name over the item's description. The line's own text
// is only used when the item has no description (or there is no item). Lines without an item print their text.
function lineParts(x) {
  const it = x.items || {};
  const own = String(x.description || '').trim();
  const name = String(it.name || '').trim() || own;
  const sub = String(it.description || '').trim() || (own !== name ? own : '');
  return { name, sub: sub && sub !== name ? sub : '' };
}
function lineText(x) {
  const { name, sub } = lineParts(x);
  return `${esc(name)}${sub ? `<div class="muted" style="font-size:10.5px">${nl(sub)}</div>` : ''}`;
}

// outstanding: amount still owed on a posted invoice (null when unknown, e.g. a draft); paid = gross - outstanding.
function salesBody({ company, base, d, lines, dec, customer, termsName, s, bank, extras = [], projectText = '', jobText = '', outstanding = null }) {
  const isInv = d.doc_type === 'invoice';
  const hasTax = Number(d.tax_total) > 0;
  const title = `${hasTax ? 'Tax ' : ''}${isInv ? 'invoice' : 'credit note'}`.replace(/^./, (c) => c.toUpperCase());

  const rows = lines.map((x, i) => `<tr><td>${i + 1}</td>
      <td>${lineText(x)}</td>
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

  if (s.template === 'djsorted') {
    return { title, body: djSalesBody({ company, d, lines, dec, customer, termsName, s, bank, extras, projectText, jobText,
      title, isInv, hasTax, taxRows, payRows, isPaid, rateNote }) };
  }

  const body = `${header(company, title, [
    [`${isInv ? 'Invoice' : 'Credit note'} no`, d.doc_no], ['Date', d.doc_date], isInv ? ['Due date', d.due_date] : ['', ''],
    ['Reference', d.reference], ['Payment terms', termsName], ['Project', projectText], ['Job', jobText], ...extras,
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
      ${isInv && !isPaid ? bankHtml(bank) : ''}${endHtml(company, s)}`;
  return { title, body };
}

// The DJ Sorted layout of an invoice or credit note (see DJ_CSS).
function djSalesBody({ company, d, lines, dec, customer, termsName, s, bank, extras, projectText, jobText,
  title, isInv, hasTax, taxRows, payRows, isPaid, rateNote }) {
  const has = (row, k) => row && typeof row[k] === 'string' && row[k].trim();
  const pick = (row, keys) => keys.filter((k) => has(row, k)).map((k) => nl(row[k].trim())).join('<br>');
  const logo = logoUrl(company);
  const rows = lines.map((x, i) => {
    const { name, sub } = lineParts(x);
    return `<tr><td class="muted" style="text-align:center;width:18px">${i + 1}</td>
      <td><div class="dj-item">${esc(name)}</div>${sub ? `<div class="muted" style="font-size:10.5px">${nl(sub)}</div>` : ''}</td>
      <td class="n">${qty(x.quantity)}</td><td class="n">${money(x.unit_price, dec)}</td>
      ${hasTax ? `<td class="n">${Number(x.tax_rate) ? `${Number(x.tax_rate)}%` : ''}</td>` : ''}
      <td class="n"><strong>${money(x.net_amount, dec)}</strong></td></tr>`;
  }).join('');
  // Description: the project name(s) without their codes ("PRJ-0003 - Website" prints as "Website").
  const description = projectText.split(', ').map((p) => p.replace(/^\S+ - /, '')).filter(Boolean).join(', ');
  const meta = [['Date', d.doc_date], isInv ? ['Due', d.due_date] : ['', ''],
    ['Reference', d.reference], ['Terms', termsName], ...extras].filter(([k, v]) => k && v);
  // Highlighted above the items, as dj-sorted does: the project (description), then the notes.
  const banner = [description, d.notes].filter((x) => x && String(x).trim()).join('\n');
  const contact = pick(company, CONTACT);
  const bankBlock = isInv && !isPaid && bank ? `<div><strong>${esc(bank.label || 'Payment details')}</strong><br>${nl(bank.details)}</div>` : '<div></div>';
  const custom = s.footer_text && s.footer_text.trim() ? [s.footer_text] : [];
  const foot = custom.concat(FOOTER_KEYS.map((k) => company[k])).filter((x) => typeof x === 'string' && x.trim());
  return `<div class="dj-top"><div><h1>${esc(title)}</h1><div class="dj-no">${esc(d.doc_no || '')}</div></div>
      <div class="dj-logo">${logo ? `<img src="${esc(logo)}" alt="">` : `<strong>${esc(company.name || '')}</strong>`}</div></div>
    <div class="dj-cols">
      <div><div class="dj-lbl">${isInv ? 'Bill to' : 'Credit to'}</div><div class="dj-name">${esc(customer.name || '')}</div>
        <div class="dj-sub">${detailHtml(customer)}</div>
        ${jobText ? `<div class="dj-job"><div class="dj-lbl">Job</div><div class="dj-name">${esc(jobText)}</div></div>` : ''}</div>
      <div><div class="dj-lbl">From</div><div class="dj-name">${esc(company.name || '')}</div>
        <div class="dj-sub">${[pick(company, ADDRESS), pick(company, TAX_IDS)].filter(Boolean).join('<br>')}</div>
        <table class="dj-meta">${meta.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table></div>
    </div>
    ${banner ? `<div class="dj-banner">${nl(banner)}</div>` : ''}
    ${greetingHtml(s, customer.name)}
    <table class="lines"><thead><tr><th>#</th><th>Item</th><th class="n">Qty</th><th class="n">Rate</th>
      ${hasTax ? '<th class="n">Tax</th>' : ''}<th class="n">Total</th></tr></thead><tbody>${rows}</tbody></table>
    <table class="tot">${hasTax ? `<tr><td class="muted">Subtotal</td><td class="n">${money(d.net_total, dec)}</td></tr>${taxRows}` : ''}
      ${payRows.replace(/class="grand"/g, 'class="grand dj-total"')}</table>
    ${isPaid ? '<div style="text-align:right"><span class="paid">PAID</span></div>' : ''}
    ${rateNote}
    <div class="end">
      <div class="dj-bottom">${bankBlock}<div>${contact ? `<strong>Contact</strong><br>${contact}` : ''}</div></div>
      ${foot.length ? `<div class="foot">${foot.map(nl).join('<br><br>')}</div>` : ''}
      ${s.closing && s.closing.trim() ? `<div class="closing dj-end">${nl(s.closing.trim())}</div>` : ''}
    </div>`;
}

// Full HTML of a made-up invoice, for the preview on the Document Settings page.
export async function sampleDocumentHtml(ctx, settings, banks = []) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const co = await loadCompany(ctx);
  const cur = co.base || 'ZAR';
  const lines = [
    { description: 'Consulting services', items: { code: 'SVC-01', name: 'Consulting services', description: 'Strategy workshop and follow-up report' },
      quantity: 10, unit_price: 850, tax_rate: 15, net_amount: 8500, tax_amount: 1275 },
    { description: 'Widget, large', items: { code: 'WID-L', name: 'Widget, large', description: '' }, quantity: 4, unit_price: 312.5, tax_rate: 15, net_amount: 1250, tax_amount: 187.5 },
  ];
  const d = {
    doc_type: 'invoice', doc_no: 'INV-0001', doc_date: new Date().toISOString().slice(0, 10), due_date: '', reference: 'PO 12345',
    currency_code: cur, fx_rate: 1, net_total: 9750, tax_total: 1462.5, gross_total: 11212.5, notes: '',
  };
  const extras = [s.extra1_label, s.extra2_label].filter((x) => x && x.trim()).map((l) => [l.trim(), '(entered when printing)']);
  const { title, body } = salesBody({
    company: co.row, base: co.base, d, lines, dec: 2, customer: { name: 'Sample Customer (Pty) Ltd', address: '1 Example Street\nCape Town' },
    termsName: '30 days', s, bank: bankFor(banks, cur), extras, projectText: s.show_project_default ? 'PRJ-01 - Sample project' : '',
    jobText: s.show_job_default ? 'Sample job' : '',
  });
  return docHtml(title, body, s);
}

export async function printSalesDocument(ctx, d) {
  try {
    const [l, cust, co, dec, terms, cfg] = await Promise.all([
      supabase.from('sales_document_lines').select('*, items(code, name, description)').eq('document_id', d.id).order('line_no'),
      supabase.from('customers').select('*').eq('id', d.customer_id).maybeSingle(),
      loadCompany(ctx),
      decimalsOf(d.currency_code),
      d.payment_terms_id ? supabase.from('payment_terms').select('name').eq('id', d.payment_terms_id).maybeSingle() : Promise.resolve({ data: null }),
      loadSettings(ctx.companyId),
    ]);
    if (l.error) throw l.error;
    const projectIds = [...new Set(l.data.map((x) => x.project_id).filter(Boolean))];
    // select('*') so printing still works before sql/036 adds projects.job
    const p = projectIds.length ? await supabase.from('projects').select('*').in('id', projectIds) : { data: [] };
    const projects = p.error ? [] : p.data;
    const jobs = [...new Set(projects.map((x) => String(x.job || '').trim()).filter(Boolean))];
    const ask = await askExtras(cfg.settings, projectIds.length > 0, 'Print', jobs.length > 0);
    if (!ask) return;
    const s = { ...cfg.settings, template: ask.template };
    const projectText = ask.project ? projects.map((x) => `${x.code} - ${x.name}`).join(', ') : '';
    const jobText = ask.job ? jobs.join(', ') : '';
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
      s, bank: bankFor(cfg.banks, d.currency_code), extras: ask.extras, projectText, jobText, outstanding,
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
    const ask = await askExtras(cfg.settings, false);
    if (!ask) return;
    const s = { ...cfg.settings, template: ask.template };
    const supplier = sup.data || {};
    const rows = l.data.map((x, i) => `<tr><td>${i + 1}</td>
      <td>${esc(x.description)}${x.items && x.items.code ? `<div class="muted">${esc(x.items.code)}</div>` : ''}</td>
      <td class="n">${qty(x.qty_ordered)}</td><td class="n">${money(x.unit_price, dec)}</td><td class="n">${money(x.line_total, dec)}</td></tr>`).join('');
    const wh = o.warehouses ? `${o.warehouses.code} - ${o.warehouses.name}` : '';
    const body = `${header(co.row, 'Purchase order', [
      ['Order no', o.po_no], ['Date', o.order_date], ['Expected delivery', o.expected_date], ['Reference', o.reference], ...ask.extras,
    ])}
      <div class="parties"><div><div class="muted">Supplier</div><strong>${esc(supplier.name || '')}</strong><div>${detailHtml(supplier)}</div></div>
        <div><div class="muted">Deliver to</div><strong>${esc(wh)}</strong><div>${addressHtml(co.row)}</div></div></div>
      ${greetingHtml(s, supplier.name)}
      <table class="lines"><thead><tr><th>#</th><th>Description</th><th class="n">Quantity</th><th class="n">Unit price</th><th class="n">Total</th></tr></thead>
        <tbody>${rows}</tbody></table>
      <table class="tot"><tr class="grand"><td>Order total (${esc(o.currency_code)})</td><td class="n">${money(o.total, dec)}</td></tr></table>
      ${o.notes ? `<div class="note"><strong>Notes</strong><br>${nl(o.notes)}</div>` : ''}
      <div class="note muted">Please quote the order number on your delivery note and invoice.</div>${endHtml(co.row, s)}`;
    await printHtml(`Purchase order ${o.po_no || ''}`, body, s);
  } catch (e) { ui.errorFrom(e, 'Could not prepare the document for printing.'); }
}

/* ---------- receipt (payment received) and payment advice (bills paid) ---------- */

const MONEY_DOCS = {
  receipt: {
    title: 'Receipt', noLabel: 'Receipt no', partyLabel: 'Received from', amountLabel: 'Amount received',
    partyTable: 'customers', partyKey: 'customer_id', noKey: 'receipt_no', dateKey: 'receipt_date',
    allocTable: 'sales_allocations', allocKey: 'receipt_id', docCol: 'Invoice', bankLabel: 'Received into',
    join: 'doc:sales_documents!sales_allocations_invoice_id_fkey(*)',
    note: 'Thank you for your payment.',
  },
  payment: {
    title: 'Payment advice', noLabel: 'Payment no', partyLabel: 'Paid to', amountLabel: 'Amount paid',
    partyTable: 'suppliers', partyKey: 'supplier_id', noKey: 'payment_no', dateKey: 'payment_date',
    allocTable: 'purchase_allocations', allocKey: 'payment_id', docCol: 'Your invoice', bankLabel: 'Paid from',
    join: 'doc:purchase_documents!purchase_allocations_bill_id_fkey(*)',
    note: 'Please allocate this payment against the invoices listed.',
  },
};

// bankName: name of the bank or cash account the money went into (or came out of), '' when unknown.
function moneyBody({ kind, company, base, r, allocs, party, dec, s, extras = [], bankName = '' }) {
  const k = MONEY_DOCS[kind];
  const p = party || {};
  const cur = esc(r.currency_code);
  const onAccount = Number(r.amount) - Number(r.allocated_amount);
  // Supplier bills: show their invoice number first, ours underneath.
  const docNo = (doc) => (kind === 'payment' && doc.supplier_ref
    ? `${esc(doc.supplier_ref)}<div class="muted">${esc(doc.doc_no)}</div>` : esc(doc.doc_no));
  const rows = allocs.map((a, i) => {
    const doc = a.doc || {};
    return `<tr><td>${i + 1}</td><td>${docNo(doc)}</td><td>${esc(doc.doc_date || '')}</td>
      <td class="n">${doc.gross_total !== undefined && doc.gross_total !== null ? money(doc.gross_total, dec) : ''}</td><td class="n">${money(a.amount, dec)}</td></tr>`;
  }).join('');
  const accountRow = onAccount >= 0.005
    ? `<tr><td></td><td colspan="3">On account</td><td class="n">${money(onAccount, dec)}</td></tr>` : '';
  // Payment details: whichever of these are known.
  const foreign = base && r.currency_code !== base && Number(r.fx_rate) > 0;
  const details = [
    [k.bankLabel, bankName],
    ['Reference', r.reference],
    ['Exchange rate', foreign ? `1 ${r.currency_code} = ${Number(r.fx_rate).toFixed(4)} ${base}` : ''],
  ].filter(([, v]) => v && String(v).trim());
  const detailRows = details.length
    ? `<table class="meta" style="margin-top:8px">${details.map(([l, v]) =>
      `<tr><td class="muted" style="padding-right:10px">${esc(l)}</td><td><strong>${esc(v)}</strong></td></tr>`).join('')}</table>` : '';
  const body = `${header(company, k.title, [
    [k.noLabel, r[k.noKey]], ['Date', r[k.dateKey]], ...extras,
  ])}
    <div class="parties"><div><div class="muted">${k.partyLabel}</div><strong>${esc(p.name || '')}</strong>
      ${p.code ? `<div class="muted">${esc(p.code)}</div>` : ''}<div>${detailHtml(p)}</div></div>
      <div><div class="muted">${k.amountLabel}</div><div class="amount">${money(r.amount, dec)} ${cur}</div>
      ${detailRows}
      ${r.status === 'reversed' ? `<span class="paid void">REVERSED${r.reversed_on ? ` ${esc(r.reversed_on)}` : ''}</span>` : ''}</div></div>
    ${greetingHtml(s, p.name)}
    <table class="lines"><thead><tr><th>#</th><th>${k.docCol}</th><th>Date</th><th class="n">Invoice total</th><th class="n">Amount applied</th></tr></thead>
      <tbody>${rows || accountRow ? rows + accountRow : '<tr><td colspan="5" class="muted">Not allocated to any invoice.</td></tr>'}</tbody></table>
    <table class="tot"><tr class="grand"><td>Total (${cur})</td><td class="n">${money(r.amount, dec)}</td></tr></table>
    ${r.notes ? `<div class="note"><strong>Notes</strong><br>${nl(r.notes)}</div>` : ''}
    ${endHtml(company, s.closing && s.closing.trim() ? s : { ...s, closing: k.note })}`;
  return { title: k.title, body };
}

// kind: 'receipt' (customer_receipts row) or 'payment' (supplier_payments row).
export async function printMoneyDocument(ctx, kind, r) {
  const k = MONEY_DOCS[kind];
  try {
    const [al, party, co, dec, cfg, bk] = await Promise.all([
      supabase.from(k.allocTable).select(`*, ${k.join}`).eq(k.allocKey, r.id).order('created_at'),
      supabase.from(k.partyTable).select('*').eq('id', r[k.partyKey]).maybeSingle(),
      loadCompany(ctx),
      decimalsOf(r.currency_code),
      loadSettings(ctx.companyId),
      r.bank_account_id ? supabase.from('gl_accounts').select('name').eq('id', r.bank_account_id).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    if (al.error) throw al.error;
    const ask = await askExtras(cfg.settings, false);
    if (!ask) return;
    const s = { ...cfg.settings, template: ask.template };
    const { title, body } = moneyBody({
      kind, company: co.row, base: co.base, r, allocs: al.data, party: party.data, dec, s, extras: ask.extras,
      bankName: bk.data ? bk.data.name : '',
    });
    await printHtml(`${title} ${r[k.noKey] || ''}`, body, s);
  } catch (e) { ui.errorFrom(e, 'Could not prepare the document for printing.'); }
}

/* ---------- shared links (customers view a document in the browser) ---------- */

// Asks for the same extras as printing, before a share link is made. kind: 'sales' or 'receipt'.
// Resolves { extras, show_project, show_job, template } or null when cancelled.
export async function askShareOptions(ctx, kind, doc) {
  const cfg = await loadSettings(ctx.companyId);
  let withProject = false;
  let withJob = false;
  if (kind === 'sales') {
    const l = await supabase.from('sales_document_lines').select('projects(*)').eq('document_id', doc.id);
    const projects = l.error ? [] : l.data.map((x) => x.projects).filter(Boolean);
    withProject = projects.length > 0;
    withJob = projects.some((x) => String(x.job || '').trim());
  }
  const ask = await askExtras(cfg.settings, withProject, 'Create link', withJob);
  return ask ? { extras: ask.extras, show_project: ask.project, show_job: ask.job, template: ask.template } : null;
}

// On screen the document sits on a sheet of paper; on a phone the columns stack. Printing is unchanged.
const SHARED_CSS = `@media screen{
  html{background:#e9ecef}body{padding:16px}
  .page{background:#fff;max-width:210mm;min-height:0;margin:0 auto;padding:14mm;box-sizing:border-box;
    box-shadow:0 2px 12px rgba(0,0,0,.15);border-radius:4px;overflow-x:auto}
  .share-bar{max-width:210mm;margin:0 auto 12px;display:flex;justify-content:flex-end}
  .share-bar button{font:600 14px Arial,sans-serif;padding:9px 16px;border:0;border-radius:6px;background:#1f5fbf;color:#fff;cursor:pointer}
}
@media screen and (max-width:640px){
  body{padding:8px}.page{padding:16px}
  .head,.parties{flex-direction:column;gap:12px}.head>div[style]{text-align:left!important}.head .meta{margin-left:0!important}
  table.tot,.bank{width:100%}
}
@media print{.share-bar{display:none}}`;

// Full HTML page for get_shared_document()'s result, with a Print / Save as PDF bar on top.
export function sharedDocumentHtml(data) {
  const s = { ...DEFAULT_SETTINGS, ...(data.settings || {}), ...(data.template ? { template: data.template } : {}) };
  const dec = data.decimals !== null && data.decimals !== undefined ? Number(data.decimals) : 2;
  const extras = Array.isArray(data.extras) ? data.extras : [];
  let doc;
  if (data.kind === 'receipt') {
    doc = moneyBody({
      kind: 'receipt', company: data.company || {}, base: data.base, r: data.receipt, allocs: data.allocations || [],
      party: data.customer, dec, s, extras, bankName: data.received_into || '',
    });
    doc.title = `${doc.title} ${data.receipt.receipt_no || ''}`;
  } else {
    doc = salesBody({
      company: data.company || {}, base: data.base, d: data.doc, lines: data.lines || [], dec, customer: data.customer || {},
      termsName: data.terms || '', s, bank: data.bank, extras, projectText: data.project || '', jobText: data.job || '',
      outstanding: data.outstanding === null || data.outstanding === undefined ? null : Number(data.outstanding),
    });
    doc.title = `${doc.title} ${data.doc.doc_no || ''}`;
  }
  const bar = '<div class="share-bar"><button type="button" id="share-print">Print / Save as PDF</button></div>';
  return docHtml(doc.title, doc.body, s, SHARED_CSS).replace('<body>', `<body>${bar}`);
}

/* ---------- statement of account ---------- */
// opts: { title, partyTable, partyId, from, to, base, headers: { debit, credit, balance },
//         blocks: [{ cur, dec, opening, closing, lines: [{ date, type, no, ref, debit, credit, balance }] }],
//         openItems: [{ type, no, date, due, cur, outstanding, base }],
//         breakdown (optional, replaces openItems): [{ cur, dec, total,
//           items: [{ type, no, date, due, original, applied, outstanding, detail: [{ text, amount }] }] }] }

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

    // breakdown (optional): the balance by source document, replacing the plain open items list.
    const breakdown = (opts.breakdown || []).map((b) => `<h2>Balance by document at ${esc(opts.to)} (${esc(b.cur)})</h2>
      <table class="lines"><thead><tr><th>Type</th><th>No</th><th>Date</th><th>Due</th><th class="n">Original</th><th class="n">Paid / applied</th><th class="n">Outstanding</th></tr></thead><tbody>
      ${b.items.map((i) => `<tr><td>${esc(i.type)}</td><td>${esc(i.no)}</td><td>${esc(i.date)}</td><td>${esc(i.due || '')}</td>
        <td class="n">${signed(i.original, b.dec)}</td><td class="n">${signed(i.applied, b.dec)}</td><td class="n">${signed(i.outstanding, b.dec)}</td></tr>
        ${i.detail.map((x) => `<tr class="sub"><td></td><td class="txt" colspan="4">${esc(x.text)}</td><td class="n">${signed(x.amount, b.dec)}</td><td></td></tr>`).join('')}`).join('')}
      <tr class="strong"><td colspan="6">Balance (${esc(b.cur)})</td><td class="n">${signed(b.total, b.dec) || '0.00'}</td></tr></tbody></table>`).join('');

    const items = opts.breakdown ? breakdown : opts.openItems.length ? `<h2>Open items at ${esc(opts.to)}</h2>
      <table class="lines"><thead><tr><th>Type</th><th>No</th><th>Date</th><th>Due</th><th>Cur</th><th class="n">Outstanding</th></tr></thead><tbody>
      ${opts.openItems.map((i) => `<tr><td>${esc(i.type)}</td><td>${esc(i.no)}</td><td>${esc(i.date)}</td><td>${esc(i.due || '')}</td>
        <td>${esc(i.cur)}</td><td class="n">${signed(i.outstanding, 2)}</td></tr>`).join('')}</tbody></table>` : '';

    const due = opts.blocks.filter((b) => Math.abs(b.closing) >= 0.005).map((b) => `${signed(b.closing, b.dec)} ${esc(b.cur)}`).join(' &nbsp;·&nbsp; ');
    const body = `${header(co.row, opts.title || 'Statement of account', [['Statement date', opts.to], ['Period from', opts.from]])}
      <div class="parties"><div><div class="muted">Account</div><strong>${esc(party.name || '')}</strong>
        ${party.code ? `<div class="muted">${esc(party.code)}</div>` : ''}<div>${detailHtml(party)}</div></div>
        <div><div class="muted">Balance</div><div style="font-size:16px"><strong>${due || '0.00'}</strong></div>
        <div class="muted">${esc(opts.balanceNote || 'Brackets are credit balances.')}</div></div></div>
      ${greetingHtml(s, party.name)}${blocks || '<p class="muted">No activity in this period.</p>'}${items}${opts.partyTable === 'customers' ? bankHtml(bankFor(cfg.banks, opts.base)) : ''}${endHtml(co.row, s)}`;
    await printHtml(`${opts.title || 'Statement'} ${party.code || ''}`, body, s);
  } catch (e) { ui.errorFrom(e, 'Could not prepare the statement for printing.'); }
}
