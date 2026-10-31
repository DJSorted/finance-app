import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';
import { makeModal } from '../core/attachments.js';
import { DEFAULT_SETTINGS, TEMPLATES, sampleDocumentHtml } from '../core/print-docs.js';

const ctx = await startPage();

const hint = document.getElementById('hint');
const panel = document.getElementById('panel');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CAN_EDIT = ctx ? ['owner', 'admin', 'accountant'].includes(ctx.role) : false;

let settings = { ...DEFAULT_SETTINGS };
let banks = [];
let currencies = [];
const form = {};

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
function option(select, value, text) { const o = el('option', '', text); o.value = value; select.append(o); }
const field = (text, input, full, note) => {
  const w = el('div', `field${full ? ' full' : ''}`);
  w.append(el('label', '', text), input);
  if (note) w.append(el('small', 'muted', note));
  return w;
};

async function load() {
  const cid = ctx.companyId;
  const [s, b, c] = await Promise.all([
    supabase.from('document_settings').select('*').eq('company_id', cid).maybeSingle(),
    supabase.from('document_bank_details').select('*').eq('company_id', cid).order('sort_order').order('created_at'),
    supabase.from('company_currencies').select('code').eq('company_id', cid).order('code'),
  ]);
  for (const r of [s, b, c]) if (r.error) throw r.error;
  settings = { ...DEFAULT_SETTINGS, ...(s.data || {}) };
  banks = b.data;
  currencies = c.data.map((x) => x.code);
}

function current() {
  return {
    template: form.template.value, accent: form.accent.value, greeting: form.greeting.value, closing: form.closing.value,
    footer_text: form.footer.value, extra1_label: form.e1.value, extra2_label: form.e2.value, show_project_default: form.proj.checked,
    show_job_default: form.job.checked,
  };
}

async function save() {
  const v = current();
  const { error } = await supabase.from('document_settings').upsert({
    company_id: ctx.companyId, template: v.template, accent: v.accent, greeting: v.greeting || null, closing: v.closing || null,
    footer_text: v.footer_text || null, extra1_label: v.extra1_label || null, extra2_label: v.extra2_label || null,
    show_project_default: v.show_project_default, show_job_default: v.show_job_default, updated_at: new Date().toISOString(),
  }, { onConflict: 'company_id' });
  if (error) return ui.errorFrom(error, 'Could not save the settings.');
  settings = { ...settings, ...v };
  ui.success('Document settings saved.');
}

async function preview() {
  const html = await sampleDocumentHtml(ctx, current(), banks);
  const { box, close } = makeModal('Preview', 'modal xwide');
  const frame = el('iframe');
  frame.style.cssText = 'width:100%;height:70vh;border:1px solid var(--border, #ccc);background:#fff;border-radius:6px';
  frame.srcdoc = html;
  const actions = el('div', 'modal-actions');
  actions.append(el('span', 'spacer'), btn('Close', 'btn-ghost', close));
  box.append(frame, actions);
}

function renderBanks(host) {
  host.replaceChildren();
  if (!banks.length) host.append(el('p', 'muted', 'No bank details yet. Add the account customers should pay into. You can add one per currency.'));
  else {
    const wrap = el('div', 'table-wrap');
    wrap.innerHTML = `<table class="grid"><thead><tr><th>Name</th><th>Currency</th><th>Details</th><th></th></tr></thead><tbody>${banks.map((b) => `<tr data-id="${b.id}">
      <td>${esc(b.label)}</td><td>${esc(b.currency_code || 'Any')}</td><td style="white-space:pre-line">${esc(b.details)}</td>
      <td>${CAN_EDIT ? '<div class="row-actions"><button class="btn btn-sm" data-act="edit">Edit</button><button class="btn btn-sm" data-act="del">Delete</button></div>' : ''}</td></tr>`).join('')}</tbody></table>`;
    wrap.addEventListener('click', async (e) => {
      const t = e.target.closest('[data-act]');
      if (!t) return;
      const b = banks.find((x) => x.id === t.closest('tr').dataset.id);
      if (!b) return;
      if (t.dataset.act === 'edit') return openBank(b, host);
      if (!(await ui.confirmDelete('Bank details'))) return;
      const { error } = await supabase.from('document_bank_details').delete().eq('id', b.id);
      if (error) return ui.errorFrom(error);
      ui.deleted('Bank details');
      await load();
      renderBanks(host);
    });
    host.append(wrap);
  }
  if (CAN_EDIT) host.append(btn('Add bank details', '', () => openBank(null, host)));
}

function openBank(row, host) {
  const { box, close } = makeModal(row ? 'Edit bank details' : 'Add bank details');
  const label = el('input'); label.value = row ? row.label : ''; label.placeholder = 'For example: Main account (ZAR)';
  const cur = el('select');
  option(cur, '', 'Any currency (used when there is no exact match)');
  currencies.forEach((c) => option(cur, c, c));
  cur.value = row && row.currency_code ? row.currency_code : '';
  const details = el('textarea');
  details.rows = 6;
  details.style.width = '100%';
  details.value = row ? row.details : '';
  details.placeholder = 'Bank, account name, account number, branch code, SWIFT/IBAN...';
  const grid = el('div', 'form-grid');
  grid.append(field('Name', label, true), field('Used for documents in', cur, true), field('Details', details, true));
  const actions = el('div', 'modal-actions');
  const go = btn('Save', 'btn-primary', async () => {
    if (!label.value.trim() || !details.value.trim()) return ui.warn('Enter a name and the bank details.');
    go.disabled = true;
    const payload = { label: label.value.trim(), details: details.value.trim(), currency_code: cur.value || null };
    const q = row
      ? supabase.from('document_bank_details').update(payload).eq('id', row.id)
      : supabase.from('document_bank_details').insert({ ...payload, company_id: ctx.companyId, sort_order: banks.length });
    const { error } = await q;
    go.disabled = false;
    if (error) return ui.errorFrom(error, 'Could not save the bank details.');
    close();
    ui.saved('Bank details');
    await load();
    renderBanks(host);
  });
  actions.append(el('span', 'spacer'), btn('Cancel', 'btn-ghost', close), go);
  box.append(grid, actions);
}

async function init() {
  document.getElementById('company-title').textContent = ctx.company.name;
  hint.textContent = 'How printed invoices, credit notes, purchase orders and statements look and what they say. Use {name} in the greeting for the customer or supplier name.';
  try { await load(); } catch (e) { ui.errorFrom(e, 'Could not load the document settings.'); return; }

  const root = el('div');
  const look = el('div', 'card');
  look.append(el('h4', '', 'Look'));
  look.firstChild.style.marginTop = '0';
  form.template = el('select');
  TEMPLATES.forEach(([v, l]) => option(form.template, v, l));
  form.template.value = settings.template;
  form.accent = el('input'); form.accent.type = 'color'; form.accent.value = /^#[0-9a-f]{6}$/i.test(settings.accent) ? settings.accent : DEFAULT_SETTINGS.accent;
  form.accent.style.width = '64px';
  const g1 = el('div', 'form-grid');
  g1.append(field('Template', form.template, false, 'The default layout. You can pick another each time you print.'),
    field('Accent colour', form.accent, false, 'Not used by the DJ Sorted layout.'));
  look.append(g1);

  const words = el('div', 'card');
  words.style.marginTop = '1rem';
  words.append(el('h4', '', 'Wording'));
  words.firstChild.style.marginTop = '0';
  form.greeting = el('input'); form.greeting.value = settings.greeting || ''; form.greeting.placeholder = 'Dear {name},';
  form.closing = el('textarea'); form.closing.rows = 2; form.closing.style.width = '100%'; form.closing.value = settings.closing || '';
  form.footer = el('textarea'); form.footer.rows = 3; form.footer.style.width = '100%'; form.footer.value = settings.footer_text || '';
  form.footer.placeholder = 'Company registration, VAT number, terms of business, website...';
  form.e1 = el('input'); form.e1.value = settings.extra1_label || '';
  form.e2 = el('input'); form.e2.value = settings.extra2_label || '';
  form.proj = el('input'); form.proj.type = 'checkbox'; form.proj.checked = !!settings.show_project_default; form.proj.style.width = 'auto';
  const projRow = el('div', 'field check');
  projRow.append(form.proj, el('label', '', 'Show the project on documents by default'));
  form.job = el('input'); form.job.type = 'checkbox'; form.job.checked = !!settings.show_job_default; form.job.style.width = 'auto';
  const jobRow = el('div', 'field check');
  jobRow.append(form.job, el('label', '', "Show the project's job on invoices by default"));
  const g2 = el('div', 'form-grid');
  g2.append(field('Greeting (above the lines)', form.greeting, true, 'Optional. For example: Dear {name},'),
    field('Closing message (centred at the bottom of the page)', form.closing, true),
    field('Footer (small print at the bottom)', form.footer, true),
    field('Extra field 1 label', form.e1, false, 'Asked for each time you print. Leave a value empty to leave the field off.'),
    field('Extra field 2 label', form.e2), projRow, jobRow);
  words.append(g2);

  const bankCard = el('div', 'card');
  bankCard.style.marginTop = '1rem';
  bankCard.append(el('h4', '', 'Bank details'));
  bankCard.firstChild.style.marginTop = '0';
  bankCard.append(el('p', 'muted', 'Printed on invoices. A document uses the bank details for its own currency, or the ones marked "Any currency".'));
  const bankHost = el('div');
  bankCard.append(bankHost);
  renderBanks(bankHost);

  const actions = el('div', 'toolbar');
  actions.style.marginTop = '1rem';
  actions.append(btn('Preview', '', preview));
  if (CAN_EDIT) actions.append(btn('Save settings', 'btn-primary', save));
  else actions.append(el('span', 'muted', 'Only owners, admins and accountants can change these settings.'));

  root.append(look, words, bankCard, actions);
  panel.replaceChildren(root);
  if (!CAN_EDIT) root.querySelectorAll('input, select, textarea').forEach((x) => { x.disabled = true; });
}

if (ctx) await init();