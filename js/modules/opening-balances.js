import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const panel = document.getElementById('panel');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

let accounts = new Map();
let customers = new Map();
let suppliers = new Map();
let base = '';
let rows = [];
let result = null;
let busy = false;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function btn(text, cls, onClick) {
  const b = el('button', `btn ${cls}`.trim(), text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

const dateIn = el('input'); dateIn.type = 'date'; dateIn.style.width = 'auto';
const refIn = el('input'); refIn.value = 'Opening balances'; refIn.style.maxWidth = '220px';
const fileIn = el('input'); fileIn.type = 'file'; fileIn.accept = '.csv,.xlsx,.xls'; fileIn.style.width = 'auto';

/* ---------- reading the file ---------- */

function parseCsv(text) {
  const out = [];
  let row = [];
  let cell = '';
  let q = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',' || c === ';') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x !== '')) out.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== '')) out.push(row);
  return out;
}

function loadSheetJs() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = () => (window.XLSX ? resolve(window.XLSX) : reject(new Error('The spreadsheet reader did not start.')));
    s.onerror = () => reject(new Error('Could not load the spreadsheet reader. Check your connection or use a CSV file.'));
    document.head.append(s);
  });
}

async function readFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.csv')) return parseCsv(await file.text());
  const XLSX = await loadSheetJs();
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: true });
}

const num = (v) => {
  if (v === '' || v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  const n = Number(String(v).replace(/[\s,]/g, '').replace(/^\((.*)\)$/, '-$1'));
  return Number.isFinite(n) ? n : NaN;
};

function toRows(table) {
  if (!table.length) return [];
  const head = table[0].map((h) => String(h).trim().toLowerCase().replace(/\s+/g, '_'));
  const idx = (names) => head.findIndex((h) => names.includes(h));
  const col = { type: idx(['type']), code: idx(['code']), currency: idx(['currency', 'cur']), debit: idx(['debit', 'dr']),
    credit: idx(['credit', 'cr']), rate: idx(['rate', 'exchange_rate']), reference: idx(['reference', 'ref', 'description']) };
  if (col.type < 0 || col.code < 0 || col.debit < 0 || col.credit < 0) {
    throw new Error('The first row must have the columns type, code, currency, debit, credit, rate and reference (currency, rate and reference are optional). Download the template to see the layout.');
  }
  const get = (r, k) => (col[k] < 0 ? '' : r[col[k]]);
  const out = [];
  table.slice(1).forEach((r, i) => {
    if (!r.some((x) => String(x).trim() !== '')) return;
    let dr = num(get(r, 'debit'));
    let cr = num(get(r, 'credit'));
    if (dr < 0) { cr = -dr; dr = 0; } else if (cr < 0) { dr = -cr; cr = 0; }
    out.push({
      line: i + 2, type: String(get(r, 'type')).trim().toLowerCase(), code: String(get(r, 'code')).trim(),
      currency: String(get(r, 'currency')).trim().toUpperCase(), debit: dr, credit: cr,
      rate: num(get(r, 'rate')) || '', reference: String(get(r, 'reference')).trim(),
    });
  });
  return out;
}

/* ---------- screen ---------- */

const nameOf = (r) => {
  const m = r.type === 'account' ? accounts : (r.type === 'customer' ? customers : (r.type === 'supplier' ? suppliers : null));
  return m ? (m.get(r.code.toUpperCase()) || '') : '';
};

function render() {
  const root = el('div');
  if (!rows.length) {
    root.append(el('p', 'muted', 'Choose a CSV or Excel file with your opening balances. Use "Download template" for the layout.'));
    panel.replaceChildren(root);
    return;
  }
  const body = rows.map((r) => `<tr><td class="num">${r.line}</td><td>${esc(r.type)}</td><td>${esc(r.code)}</td><td>${esc(nameOf(r))}${nameOf(r) ? '' : ' <span class="badge st-error">Not found</span>'}</td>
    <td>${esc(r.currency || '')}</td><td class="num">${r.debit ? money(r.debit) : ''}</td><td class="num">${r.credit ? money(r.credit) : ''}</td>
    <td>${esc(r.reference)}</td></tr>`).join('');
  const wrap = el('div', 'table-wrap');
  wrap.style.maxHeight = '45vh';
  wrap.style.overflow = 'auto';
  wrap.innerHTML = `<table class="grid"><thead><tr><th>Row</th><th>Type</th><th>Code</th><th>Name</th><th>Cur</th><th style="text-align:right">Debit</th><th style="text-align:right">Credit</th><th>Reference</th></tr></thead><tbody>${body}</tbody></table>`;
  root.append(wrap);

  if (result) {
    const box = el('div', 'card');
    box.style.marginTop = '1rem';
    const diff = Number(result.difference);
    let html = `<p><strong>${result.rows}</strong> rows will be imported. Debits ${money(result.debit)}, credits ${money(result.credit)} (${esc(base)}).`;
    if (Math.abs(diff) >= 0.005) html += ` The difference of <strong>${money(Math.abs(diff))}</strong> goes ${diff > 0 ? 'to the credit of' : 'to the debit of'} the opening balance account${result.balancing_account ? ` ${esc(result.balancing_account)}` : ''}.`;
    else html += ' They balance.';
    html += '</p>';
    if (result.existing > 0) html += `<p style="color:var(--warning)">An opening balances journal has already been posted (${result.existing}). Importing again adds another one.</p>`;
    if (result.problems.length) html += `<h4 style="color:var(--danger);margin-bottom:.25rem">Fix these first</h4><ul>${result.problems.map((p) => `<li style="color:var(--danger)">${esc(p)}</li>`).join('')}</ul>`;
    box.innerHTML = html;
    root.append(box);
  }
  const actions = el('div', 'toolbar');
  actions.style.marginTop = '1rem';
  const ok = result && !result.problems.length;
  const draft = btn('Save as draft journal', '', () => submit('draft'));
  const post = btn('Post opening balances', 'btn-primary', () => submit('post'));
  draft.disabled = !ok || busy;
  post.disabled = !ok || busy;
  actions.append(draft, post);
  root.append(actions);
  panel.replaceChildren(root);
}

const payload = () => rows.map((r) => ({ type: r.type, code: r.code, currency: r.currency, debit: r.debit || '', credit: r.credit || '', rate: r.rate, reference: r.reference }));

async function check() {
  if (!dateIn.value) { result = null; render(); return; }
  panel.innerHTML = '<p class="muted">Checking...</p>';
  const { data, error } = await supabase.rpc('import_opening_balances', {
    p_company: ctx.companyId, p_date: dateIn.value, p_reference: refIn.value, p_lines: payload(), p_mode: 'preview',
  });
  if (error) { result = null; render(); return ui.errorFrom(error, 'Could not check the file.'); }
  result = data;
  render();
}

async function submit(mode) {
  const ok = await ui.confirm({
    title: mode === 'post' ? 'Post opening balances' : 'Save as draft',
    message: mode === 'post'
      ? `Post ${result.rows} opening balance rows as one journal dated ${dateIn.value}?\nPosted journals are locked. You can reverse the journal if something is wrong.`
      : `Save ${result.rows} rows as a draft journal dated ${dateIn.value}? You can review and post it in Journals.`,
    confirmText: mode === 'post' ? 'Post' : 'Save draft',
  });
  if (!ok) return;
  busy = true;
  render();
  const { data, error } = await supabase.rpc('import_opening_balances', {
    p_company: ctx.companyId, p_date: dateIn.value, p_reference: refIn.value, p_lines: payload(), p_mode: mode,
  });
  busy = false;
  if (error) { render(); return ui.errorFrom(error, 'Could not import the opening balances.'); }
  ui.success(data.posted ? 'Opening balances posted.' : 'Draft journal saved.');
  rows = [];
  result = null;
  fileIn.value = '';
  panel.innerHTML = `<p>${data.posted ? 'The opening balances are posted as a journal.' : 'The draft journal is waiting in Journals.'}
    <a class="btn" href="/pages/journals.html">Open Journals</a></p>`;
}

function template() {
  const csv = ['type,code,currency,debit,credit,rate,reference',
    'account,1000,,15000.00,,,Cash at bank',
    'account,2100,,,4000.00,,Loan',
    'customer,C001,USD,2500.00,,18.50,INV-0012',
    'supplier,S001,,,1200.00,,BILL-0034'].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'opening-balances-template.csv';
  document.body.append(a);
  a.click();
  a.remove();
}

async function init() {
  document.getElementById('company-title').textContent = ctx.company.name;
  if (!['owner', 'admin', 'accountant'].includes(ctx.role)) {
    panel.innerHTML = '<p class="muted">Only owners, admins and accountants can import opening balances.</p>';
    return;
  }
  const cid = ctx.companyId;
  const [a, c, s, fy, cu] = await Promise.all([
    supabase.from('gl_accounts').select('code, name').eq('company_id', cid).eq('is_posting', true),
    supabase.from('customers').select('code, name').eq('company_id', cid),
    supabase.from('suppliers').select('code, name').eq('company_id', cid),
    supabase.from('fiscal_years').select('start_date').eq('company_id', cid).order('start_date').limit(1),
    supabase.from('company_currencies').select('code').eq('company_id', cid).eq('is_base', true).maybeSingle(),
  ]);
  for (const r of [a, c, s, fy]) if (r.error) { ui.errorFrom(r.error, 'Could not load the setup.'); return; }
  accounts = new Map(a.data.map((x) => [x.code.toUpperCase(), x.name]));
  customers = new Map(c.data.map((x) => [x.code.toUpperCase(), x.name]));
  suppliers = new Map(s.data.map((x) => [x.code.toUpperCase(), x.name]));
  base = cu.data ? cu.data.code : '';
  dateIn.value = fy.data.length ? fy.data[0].start_date : '';

  fileIn.addEventListener('change', async () => {
    const f = fileIn.files[0];
    if (!f) return;
    try { rows = toRows(await readFile(f)); } catch (e) { rows = []; result = null; render(); return ui.warn(e.message); }
    result = null;
    render();
    if (rows.length) await check();
  });
  dateIn.addEventListener('change', () => { if (rows.length) check(); });
  refIn.addEventListener('change', () => { if (rows.length) check(); });

  toolbar.append(el('span', 'muted', 'Balances as at'), dateIn, el('span', 'muted', 'Reference'), refIn, fileIn,
    el('span', 'spacer'), btn('Download template', '', template));
  hint.textContent = 'One journal with a row per account, customer or supplier. Debits are assets and expenses, credits are liabilities, equity and income. '
    + 'Customer rows are what they owe you, supplier rows what you owe them: each becomes an open item you can match later with Apply credits. '
    + 'The date must fall in an open financial period. Stock, goods received not invoiced, work in progress and fixed assets are set up in Stock Adjustments and the Asset Register, not here.';
  render();
}

if (ctx) await init();