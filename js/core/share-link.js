import { supabase } from './supabase.js';
import { ui } from './ui.js';
import { askShareOptions } from './print-docs.js';

/* Share link dialog for invoices, credit notes and receipts: makes (or reuses) a private link the customer
   can open without logging in, then copies it or hands it to email or WhatsApp. Links last 90 days and can be
   revoked here. See sql/034_shared_links.sql. */

const COLUMN = { sales: 'sales_document_id', receipt: 'receipt_id' };

const linkUrl = (token) => `${location.origin}/pages/shared.html?t=${token}`;
const when = (ts) => new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

async function activeLink(kind, id) {
  const { data, error } = await supabase.from('shared_links').select('*').eq(COLUMN[kind], id)
    .is('revoked_at', null).gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false }).limit(1);
  if (error) throw error;
  return data[0] || null;
}

async function copyText(text, input) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall back below */ }
  input.select();
  try { return document.execCommand('copy'); } catch (e) { return false; }
}

// kind: 'sales' (sales_documents row) or 'receipt' (customer_receipts row).
// label: 'Invoice', 'Credit note' or 'Receipt'. docNo and amountText go into the message.
// intro: first line of the message, e.g. 'Thank you for your payment.' (optional).
export async function openShareDialog(ctx, { kind, doc, label, docNo, amountText, intro = '' }) {
  let link;
  try {
    link = await activeLink(kind, doc.id);
    if (!link) {
      const opts = await askShareOptions(ctx, kind, doc);
      if (!opts) return;
      const { data, error } = await supabase.from('shared_links')
        .insert({ company_id: ctx.companyId, [COLUMN[kind]]: doc.id, extras: opts.extras, show_project: opts.show_project,
          show_job: opts.show_job, template: opts.template })
        .select().single();
      if (error) throw error;
      link = data;
    }
  } catch (e) { ui.errorFrom(e, 'Could not make the link.'); return; }

  const cust = doc.customer_id
    ? (await supabase.from('customers').select('name, email').eq('id', doc.customer_id).maybeSingle()).data || {}
    : {};
  const url = linkUrl(link.token);
  const company = ctx.company ? ctx.company.name : '';
  const subject = `${label} ${docNo}${company ? ` from ${company}` : ''}`;
  const message = [`Hi ${cust.name || ''}`.trim() + ',', '', intro,
    `You can view ${label.toLowerCase()} ${docNo}${amountText ? ` (${amountText})` : ''} here:`, url, '',
    'Kind regards', company].filter((x, i, a) => !(x === '' && a[i - 1] === '')).join('\n');

  for (;;) {
    const node = document.createElement('div');
    const input = document.createElement('input');
    input.readOnly = true;
    input.value = url;
    input.style.width = '100%';
    input.addEventListener('focus', () => input.select());
    const info = document.createElement('p');
    info.className = 'muted';
    info.textContent = `Anyone with this link can view this ${label.toLowerCase()} until ${when(link.expires_at)}. `
      + (link.view_count ? `Opened ${link.view_count} time${link.view_count === 1 ? '' : 's'}, last on ${when(link.last_viewed_at)}.` : 'Not opened yet.');
    node.append(input, info);

    const buttons = [{ label: 'Close', value: 'close', className: 'btn-ghost' }, { label: 'Withdraw link', value: 'revoke', className: 'btn-danger' },
      { label: 'Copy link', value: 'copy', className: '' }, { label: 'Email', value: 'email', className: '' },
      { label: 'WhatsApp', value: 'whatsapp', className: 'btn-primary' }];
    const res = await ui.dialog({ title: `Share ${label.toLowerCase()} ${docNo}`, node, buttons, dismissValue: 'close' });

    if (res === 'copy') {
      // The dialog has closed; copy from a temporary field so the fallback has something to select.
      const tmp = document.createElement('input');
      tmp.value = url;
      tmp.style.cssText = 'position:fixed;opacity:0';
      document.body.append(tmp);
      const ok = await copyText(url, tmp);
      tmp.remove();
      if (ok) ui.success('Link copied.'); else ui.warn('Could not copy. Select the link and copy it yourself.');
      continue;
    }
    if (res === 'email') {
      location.href = `mailto:${encodeURIComponent(cust.email || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}`;
    } else if (res === 'whatsapp') {
      window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank', 'noopener');
    } else if (res === 'revoke') {
      const ok = await ui.confirm({ title: 'Withdraw link', confirmText: 'Withdraw',
        message: 'The customer will no longer be able to open this link. You can share a new link afterwards.' });
      if (!ok) continue;
      const { error } = await supabase.from('shared_links').update({ revoked_at: new Date().toISOString() }).eq('id', link.id);
      if (error) ui.errorFrom(error, 'Could not withdraw the link.'); else ui.success('Link withdrawn.');
    }
    return;
  }
}
