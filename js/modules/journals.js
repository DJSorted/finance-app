import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { exportSheets } from '../core/export.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const panel = document.getElementById('panel');

const CAN_DRAFT = ctx ? ['owner', 'admin', 'accountant', 'clerk'].includes(ctx.role) : false;
const CAN_POST = ctx ? ctx.canEdit : false;

let journals = [];
let accounts = [];
let currencies = [];
let customers = [];
let suppliers = [];
let base = '';
let statusFilter = 'all';
let term = '';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const todayIso = () => new Date().toISOString().slice(0, 10);
function btn(text, cls, onClick) {
  const b = el('button', `btn ${cls}`.trim(), text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}
function option(select, value, text) {
  const o = el('option', '', text);
  o.value = value;
  select.append(o);
}

/* ---------- data ---------- */

async function load() {
  const cid = ctx.companyId;
  const [j, a, c, cu, s] = await Promise.all([
    supabase.from('journals').select('*, journal_lines(base_debit)').eq('company_id', cid)
      .order('journal_date', { ascending: false }).order('created_at', { ascending: false }).limit(300),
    supabase.from('gl_accounts').select('id, code, name, control_type, is_active')
      .eq('company_id', cid).eq('is_posting', true).order('code'),
    supabase.from('company_currencies').select('code, is_base').eq('company_id', cid).order('code'),
    supabase.from('customers').select('id, code, name').eq('company_id', cid).order('code'),
    supabase.from('suppliers').select('id, code, name').eq('company_id', cid).order('code'),
  ]);
  for (const r of [j, a, c, cu, s]) if (r.error) throw r.error;
  journals = j.data;
  accounts = a.data;
  currencies = c.data;
  customers = cu.data;
  suppliers = s.data;
  base = (currencies.find((x) => x.is_base) || {}).code || '';
}

async function refresh() {
  try { await load(); } catch (e) { ui.errorFrom(e, 'Could not load journals.'); }
  render();
}

const total = (j) => round2((j.journal_lines || []).reduce((s, l) => s + Number(l.base_debit), 0));

/* ---------- list ---------- */

function render() {
  hint.textContent = `Amounts in ${base}. Showing the latest 300 journals. Posted journals cannot be changed, only reversed.`;
  toolbar.replaceChildren();
  if (CAN_DRAFT) toolbar.append(btn('New journal', 'btn-primary', () => openEditor(null)));
  const box = el('input');
  box.type = 'search';
  box.placeholder = 'Search';
  box.value = term;
  box.style.maxWidth = '240px';
  box.addEventListener('input', () => { term = box.value.trim().toLowerCase(); renderTable(); });
  const sel = el('select', 'compact');
  [['all', 'All'], ['draft', 'Drafts'], ['posted', 'Posted']].forEach(([v, l]) => option(sel, v, l));
  sel.value = statusFilter;
  sel.addEventListener('change', () => { statusFilter = sel.value; renderTable(); });
  toolbar.append(box, sel, el('span', 'spacer'), btn('Export to Excel', '', doExport));
  renderTable();
}

function visible() {
  return journals.filter((j) => (statusFilter === 'all' || j.status === statusFilter)
    && (!term || [j.journal_no, j.description, j.reference, j.journal_date].some((x) => String(x || '').toLowerCase().includes(term))));
}

function renderTable() {
  const list = visible();
  if (!journals.length) { panel.innerHTML = '<p class="muted">No journals yet.</p>'; return; }
  if (!list.length) { panel.innerHTML = '<p class="muted">Nothing matches.</p>'; return; }
  const body = list.map((j) => `<tr class="clickable" data-id="${j.id}">
    <td>${esc(j.journal_no || 'Draft')}</td><td>${j.journal_date}</td><td>${esc(j.description)}</td>
    <td>${esc(j.reference || '')}</td>
    <td><span class="badge ${j.status === 'posted' ? 'open' : ''}">${j.status === 'posted' ? 'Posted' : 'Draft'}</span>
      ${j.reversed_by ? '<span class="badge">Reversed</span>' : ''}${j.reversal_of ? '<span class="badge">Reversal</span>' : ''}</td>
    <td class="num">${money(total(j))}</td></tr>`).join('');
  panel.innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr>
    <th>No</th><th>Date</th><th>Description</th><th>Reference</th><th>Status</th><th style="text-align:right">Amount</th>
    </tr></thead><tbody>${body}</tbody></table></div>`;
}

panel.addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  const j = journals.find((x) => x.id === tr.dataset.id);
  if (!j) return;
  if (j.status === 'draft') { if (CAN_DRAFT) openEditor(j); } else openViewer(j);
});

async function doExport() {
  try {
    await exportSheets(`journals-${todayIso()}.xlsx`, [{
      name: 'Journals',
      rows: visible().map((j) => ({
        no: j.journal_no || 'Draft', date: j.journal_date, description: j.description, reference: j.reference || '',
        status: j.status, amount: total(j),
      })),
      columns: [
        { key: 'no', header: 'No', width: 14 }, { key: 'date', header: 'Date', width: 12 },
        { key: 'description', header: 'Description', width: 40 }, { key: 'reference', header: 'Reference', width: 18 },
        { key: 'status', header: 'Status', width: 10 }, { key: 'amount', header: `Amount (${base})`, width: 16 },
      ],
    }]);
  } catch (e) { ui.errorFrom(e, 'Could not export.'); }
}

/* ---------- editor (drafts) ---------- */

async function openEditor(existing) {
  let journalId = existing ? existing.id : null;
  let seed = [];
  if (existing) {
    const { data, error } = await supabase.from('journal_lines').select('*')
      .eq('journal_id', existing.id).eq('is_system', false).order('line_no');
    if (error) return ui.errorFrom(error, 'Could not load the journal lines.');
    seed = data.map((l) => ({
      account_id: l.account_id, description: l.description || '', currency_code: l.currency_code,
      debit: Number(l.trx_debit) || '', credit: Number(l.trx_credit) || '',
      fx_rate: l.rate_source === 'manual' ? String(Number(l.fx_rate)) : '', party: l.customer_id || l.supplier_id || '',
    }));
  }
  while (seed.length < 2) seed.push({});

  const prevFocus = document.activeElement;
  const backdrop = el('div', 'modal-backdrop');
  const box = el('div', 'modal xwide');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.append(el('h3', 'modal-title', existing ? 'Edit draft journal' : 'New journal'));

  const field = (text, input, full) => {
    const w = el('div', `field${full ? ' full' : ''}`);
    w.append(el('label', '', text), input);
    return w;
  };
  const dateIn = el('input'); dateIn.type = 'date'; dateIn.value = existing ? existing.journal_date : todayIso();
  const refIn = el('input'); refIn.value = existing ? (existing.reference || '') : '';
  const descIn = el('input'); descIn.value = existing ? existing.description : '';
  const head = el('div', 'form-grid');
  head.append(field('Date *', dateIn), field('Reference', refIn), field('Description *', descIn, true));
  box.append(head);

  const wrap = el('div', 'lines-wrap');
  const table = el('table', 'lines-table');
  table.innerHTML = '<thead><tr><th style="min-width:220px">Account</th><th>Description</th><th>Currency</th>'
    + '<th>Debit</th><th>Credit</th><th>Rate</th><th style="min-width:180px">Customer / supplier</th><th></th></tr></thead>';
  const tbody = el('tbody');
  table.append(tbody);
  wrap.append(table);
  box.append(wrap);

  const rows = [];
  const totals = el('div', 'totals-bar');

  function recalc() {
    let d = 0;
    let c = 0;
    let missing = false;
    rows.forEach((r) => {
      const rt = r.curSel.value === base ? 1 : Number(r.rate.value);
      const dv = Number(r.dr.value) || 0;
      const cv = Number(r.cr.value) || 0;
      if ((dv || cv) && !(rt > 0)) { missing = true; return; }
      d += round2(dv * rt);
      c += round2(cv * rt);
    });
    const diff = round2(d - c);
    totals.innerHTML = `<span>Debits (${esc(base)}): ${money(d)}</span><span>Credits (${esc(base)}): ${money(c)}</span>`
      + (missing ? '<span class="bad">A rate is missing</span>'
        : `<span class="${diff === 0 ? 'ok' : 'bad'}">Difference: ${money(diff)}</span>`);
  }

  function addRow(s) {
    const tr = el('tr');
    const accSel = el('select');
    option(accSel, '', 'Select account');
    accounts.filter((a) => a.is_active || a.id === s.account_id).forEach((a) => option(accSel, a.id, `${a.code} - ${a.name}`));
    accSel.value = s.account_id || '';
    const descI = el('input'); descI.value = s.description || '';
    const curSel = el('select');
    currencies.forEach((c) => option(curSel, c.code, c.code));
    curSel.value = s.currency_code || base;
    const dr = el('input'); dr.type = 'number'; dr.step = 'any'; dr.min = '0'; dr.value = s.debit ?? '';
    const cr = el('input'); cr.type = 'number'; cr.step = 'any'; cr.min = '0'; cr.value = s.credit ?? '';
    const rate = el('input'); rate.type = 'number'; rate.step = 'any'; rate.value = s.fx_rate || '';
    const party = el('td');
    const del = el('button', 'btn btn-sm btn-ghost', '✕');
    del.type = 'button';
    del.title = 'Remove line';

    const row = { tr, accSel, descI, curSel, dr, cr, rate, party, partySel: null, partyKind: null, manual: !!s.fx_rate };

    [accSel, descI, curSel, dr, cr, rate].forEach((x) => { const td = el('td'); td.append(x); tr.append(td); });
    const delTd = el('td');
    delTd.append(del);
    tr.append(party, delTd);
    tbody.append(tr);

    row.buildParty = (selected) => {
      party.replaceChildren();
      row.partySel = null;
      row.partyKind = null;
      const a = accounts.find((x) => x.id === accSel.value);
      const type = a && a.control_type;
      if (type !== 'debtors' && type !== 'creditors') return;
      const list = type === 'debtors' ? customers : suppliers;
      const sel = el('select');
      option(sel, '', type === 'debtors' ? 'Select customer' : 'Select supplier');
      list.forEach((p) => option(sel, p.id, `${p.code} - ${p.name}`));
      sel.value = selected || '';
      party.append(sel);
      row.partySel = sel;
      row.partyKind = type === 'debtors' ? 'customer' : 'supplier';
    };

    row.syncRate = async () => {
      if (curSel.value === base) { rate.value = '1'; rate.disabled = true; row.manual = false; recalc(); return; }
      rate.disabled = false;
      if (row.manual) { recalc(); return; }
      if (!dateIn.value) return;
      const wanted = curSel.value;
      const { data, error } = await supabase.rpc('resolve_fx_rate', {
        p_company: ctx.companyId, p_trx_type: 'journal', p_from: wanted,
        p_doc_date: dateIn.value, p_trx_date: dateIn.value, p_posting_date: dateIn.value,
      });
      if (curSel.value !== wanted) return;
      rate.value = error ? '' : String(Number(data[0].rate));
      rate.placeholder = error ? 'no rate' : '';
      recalc();
    };

    accSel.addEventListener('change', () => { row.buildParty(''); });
    curSel.addEventListener('change', () => { row.manual = false; rate.value = ''; row.syncRate(); });
    dr.addEventListener('input', () => { if (dr.value) cr.value = ''; recalc(); });
    cr.addEventListener('input', () => { if (cr.value) dr.value = ''; recalc(); });
    rate.addEventListener('input', () => { row.manual = true; recalc(); });
    del.addEventListener('click', () => {
      rows.splice(rows.indexOf(row), 1);
      tr.remove();
      recalc();
    });

    rows.push(row);
    row.buildParty(s.party);
    row.syncRate();
  }

  seed.forEach(addRow);
  dateIn.addEventListener('change', () => rows.forEach((r) => r.syncRate()));

  const addBtn = btn('Add line', '', () => addRow({}));
  box.append(addBtn, totals);
  recalc();

  /* ---- buttons ---- */
  const actions = el('div', 'modal-actions');
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const close = () => {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    if (prevFocus && prevFocus.focus) prevFocus.focus();
  };
  document.addEventListener('keydown', onKey);

  if (existing) {
    const delBtn = btn('Delete draft', 'btn-danger', async () => {
      if (!(await ui.confirmDelete('Journal'))) return;
      const { error } = await supabase.from('journals').delete().eq('id', journalId);
      if (error) return ui.errorFrom(error);
      close();
      ui.deleted('Journal');
      await refresh();
    });
    actions.append(delBtn);
  }
  actions.append(el('span', 'spacer'), btn('Cancel', 'btn-ghost', close));
  const saveBtn = btn('Save draft', CAN_POST ? '' : 'btn-primary', () => {});
  actions.append(saveBtn);
  const postBtn = CAN_POST ? btn('Post', 'btn-primary', () => {}) : null;
  if (postBtn) actions.append(postBtn);
  box.append(actions);
  backdrop.append(box);
  document.body.append(backdrop);

  function collect() {
    if (!dateIn.value) throw new Error('Enter the journal date.');
    if (!descIn.value.trim()) throw new Error('Enter a description.');
    const out = [];
    rows.forEach((r, i) => {
      const dv = Number(r.dr.value) || 0;
      const cv = Number(r.cr.value) || 0;
      if (!r.accSel.value && !dv && !cv) return;
      const n = i + 1;
      if (!r.accSel.value) throw new Error(`Line ${n}: choose an account.`);
      if ((dv > 0) === (cv > 0)) throw new Error(`Line ${n}: enter either a debit or a credit amount.`);
      const line = {
        account_id: r.accSel.value, description: r.descI.value.trim(), currency_code: r.curSel.value,
        trx_debit: dv, trx_credit: cv,
        fx_rate: (r.curSel.value !== base && r.manual && Number(r.rate.value) > 0) ? Number(r.rate.value) : null,
      };
      if (r.partySel) {
        if (!r.partySel.value) throw new Error(`Line ${n}: choose a ${r.partyKind}.`);
        if (r.partyKind === 'customer') line.customer_id = r.partySel.value; else line.supplier_id = r.partySel.value;
      }
      out.push(line);
    });
    if (out.length < 2) throw new Error('A journal needs at least two lines.');
    return out;
  }

  async function persist() {
    const p_lines = collect();
    const { data, error } = await supabase.rpc('save_journal', {
      p_company: ctx.companyId, p_journal: journalId, p_date: dateIn.value,
      p_description: descIn.value, p_reference: refIn.value, p_lines,
    });
    if (error) throw error;
    journalId = data;
    return data;
  }

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try { await persist(); close(); ui.saved('Journal'); await refresh(); }
    catch (e) { ui.errorFrom(e, 'Could not save the journal.'); }
    finally { saveBtn.disabled = false; }
  });

  if (postBtn) {
    postBtn.addEventListener('click', async () => {
      try { collect(); } catch (e) { return ui.warn(e.message); }
      const ok = await ui.confirm({
        title: 'Post journal',
        message: 'Post this journal?\nPosted journals cannot be changed, only reversed.',
        confirmText: 'Post',
      });
      if (!ok) return;
      postBtn.disabled = true;
      try {
        const id = await persist();
        const { error } = await supabase.rpc('post_journal', { p_journal: id });
        if (error) { await refresh(); throw new Error(`Saved as a draft, but it could not be posted: ${error.message}`); }
        close();
        ui.success('Journal posted.');
        await refresh();
      } catch (e) { ui.errorFrom(e, 'Could not post the journal.'); }
      finally { postBtn.disabled = false; }
    });
  }
  descIn.focus();
}

/* ---------- viewer (posted) ---------- */

async function openViewer(j) {
  const { data: lines, error } = await supabase.from('journal_lines').select('*').eq('journal_id', j.id).order('line_no');
  if (error) return ui.errorFrom(error, 'Could not load the journal lines.');

  const accById = new Map(accounts.map((a) => [a.id, a]));
  const cust = new Map(customers.map((c) => [c.id, c]));
  const supp = new Map(suppliers.map((s) => [s.id, s]));
  const noOf = (id) => (journals.find((x) => x.id === id) || {}).journal_no || '';

  const node = el('div');
  const notes = [`${j.journal_date} · ${j.description}${j.reference ? ` · Ref ${j.reference}` : ''}`];
  if (j.reversal_of) notes.push(`Reversal of ${noOf(j.reversal_of)}`);
  if (j.reversed_by) notes.push(`Reversed by ${noOf(j.reversed_by)}`);
  node.append(el('p', 'muted', notes.join('\n')));
  node.firstChild.style.whiteSpace = 'pre-line';

  let td = 0;
  let tc = 0;
  const body = lines.map((l, i) => {
    const a = accById.get(l.account_id);
    const p = l.customer_id ? cust.get(l.customer_id) : (l.supplier_id ? supp.get(l.supplier_id) : null);
    td += Number(l.base_debit);
    tc += Number(l.base_credit);
    return `<tr><td>${i + 1}</td><td>${esc(a ? `${a.code} ${a.name}` : '')}</td><td>${esc(l.description || '')}</td>
      <td>${esc(l.currency_code)}</td>
      <td class="num">${Number(l.trx_debit) > 0 ? money(l.trx_debit) : ''}</td>
      <td class="num">${Number(l.trx_credit) > 0 ? money(l.trx_credit) : ''}</td>
      <td class="num">${l.currency_code === base ? '' : Number(l.fx_rate).toFixed(6)}</td>
      <td class="num">${Number(l.base_debit) > 0 ? money(l.base_debit) : ''}</td>
      <td class="num">${Number(l.base_credit) > 0 ? money(l.base_credit) : ''}</td>
      <td>${esc(p ? `${p.code} ${p.name}` : '')}</td></tr>`;
  }).join('');
  const tableWrap = el('div', 'table-wrap');
  tableWrap.innerHTML = `<table class="grid"><thead><tr><th>#</th><th>Account</th><th>Description</th><th>Cur</th>
    <th style="text-align:right">Debit</th><th style="text-align:right">Credit</th><th style="text-align:right">Rate</th>
    <th style="text-align:right">${esc(base)} debit</th><th style="text-align:right">${esc(base)} credit</th><th>Customer / supplier</th></tr></thead>
    <tbody>${body}<tr><td colspan="7"><strong>Total</strong></td><td class="num"><strong>${money(td)}</strong></td>
    <td class="num"><strong>${money(tc)}</strong></td><td></td></tr></tbody></table>`;
  node.append(tableWrap);

  const buttons = [{ label: 'Close', value: 'close', className: 'btn-ghost' }];
  if (CAN_POST && !j.reversed_by && !j.reversal_of) buttons.push({ label: 'Reverse', value: 'reverse', className: 'btn-danger' });
  const res = await ui.dialog({ title: `Journal ${j.journal_no}`, node, buttons, dismissValue: 'close', wide: true });
  if (res === 'reverse') await reverseJournal(j);
}

async function reverseJournal(j) {
  const saved = await ui.form({
    title: `Reverse ${j.journal_no}`,
    submitText: 'Reverse',
    fields: [
      { name: 'date', label: 'Reversal date', type: 'date', required: true, full: true, hint: 'Must fall in an open period.' },
      { name: 'description', label: 'Description (optional)', full: true },
    ],
    values: { date: todayIso() },
    onSubmit: async (v) => {
      const { error } = await supabase.rpc('reverse_journal', { p_journal: j.id, p_date: v.date, p_description: v.description });
      if (error) throw error;
    },
  });
  if (saved) { ui.success('Journal reversed.'); await refresh(); }
}

/* ---------- start ---------- */

if (ctx) {
  document.getElementById('company-title').textContent = ctx.company.name;
  await refresh();
}