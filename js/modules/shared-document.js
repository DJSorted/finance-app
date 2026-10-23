import { supabase } from '../core/supabase.js';
import { sharedDocumentHtml } from '../core/print-docs.js';

/* Public page: shows the invoice, credit note or receipt behind a shared link (?t=<token>). No login.
   Everything comes from get_shared_document(), which returns nothing for an unknown, expired or revoked link. */

const msg = document.getElementById('msg');

function fail(title, text) {
  msg.replaceChildren();
  const h = document.createElement('h1');
  h.textContent = title;
  const p = document.createElement('p');
  p.textContent = text;
  msg.append(h, p);
}

const token = new URLSearchParams(location.search).get('t') || '';

if (!/^[0-9a-f]{32,}$/i.test(token)) {
  fail('Link not valid', 'This link is incomplete. Please check you copied the whole link.');
} else {
  const { data, error } = await supabase.rpc('get_shared_document', { p_token: token });
  if (error) {
    fail('Could not load the document', 'Please try again in a moment.');
  } else if (!data) {
    fail('Link no longer available', 'This link has expired or was withdrawn. Please ask the sender for a new one.');
  } else {
    const doc = new DOMParser().parseFromString(sharedDocumentHtml(data), 'text/html');
    document.title = doc.title;
    document.head.replaceWith(document.adoptNode(doc.head));
    document.body.replaceWith(document.adoptNode(doc.body));
    // Keep these after the swap, since the new head replaces the old one.
    for (const [name, content] of [['robots', 'noindex, nofollow'], ['referrer', 'no-referrer'],
      ['viewport', 'width=device-width, initial-scale=1']]) {
      const m = document.createElement('meta');
      m.name = name;
      m.content = content;
      document.head.prepend(m);
    }
    const printBtn = document.getElementById('share-print');
    if (printBtn) printBtn.addEventListener('click', () => window.print());
  }
}
