import { getSession, signIn, signUp, signOut, setActiveCompany } from '/js/core/auth.js';
import { supabase } from '/js/core/supabase.js';
import { ui } from '/js/core/ui.js';

const box = document.getElementById('box');
const params = new URLSearchParams(location.search);
const invitedEmail = (params.get('email') || '').trim();

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', accountant: 'Accountant', clerk: 'Clerk', viewer: 'Viewer' };
let mode = 'signin';

async function main() {
  const session = await getSession();
  if (!session) renderAuth(); else await renderInvites(session);
}

/* ---------- not signed in ---------- */

function renderAuth() {
  const up = mode === 'signup';
  box.innerHTML = `
    <h2>${up ? 'Create your account' : 'Sign in'}</h2>
    <p class="muted">${invitedEmail
    ? `You were invited using <strong>${esc(invitedEmail)}</strong>. ${up ? 'Create your account' : 'Sign in'} with that email address to see the invitation.`
    : 'Sign in with the email address you were invited on to see your invitation.'}</p>
    <form id="form" novalidate>
      <div class="field"><label for="email">Email</label><input id="email" type="email" autocomplete="username" required></div>
      <div class="field"><label for="password">Password</label>
        <input id="password" type="password" autocomplete="${up ? 'new-password' : 'current-password'}" required></div>
      ${up ? '<div class="field"><label for="confirm">Confirm password</label><input id="confirm" type="password" autocomplete="new-password"></div>' : ''}
      <button class="btn btn-primary btn-block" id="submit" type="submit">${up ? 'Create account' : 'Sign in'}</button>
    </form>
    <p class="muted" style="margin-top:1rem"><a href="#" id="toggle">${up ? 'Have an account? Sign in' : 'Need an account? Create one'}</a></p>`;
  document.getElementById('email').value = invitedEmail;
  document.getElementById('toggle').addEventListener('click', (e) => { e.preventDefault(); mode = up ? 'signin' : 'signup'; renderAuth(); });
  document.getElementById('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    if (!email || !password) return ui.warn('Enter your email and password.');
    if (up) {
      if (password.length < 8) return ui.warn('Your password must be at least 8 characters.');
      if (password !== document.getElementById('confirm').value) return ui.warn('The passwords do not match.');
    }
    const submit = document.getElementById('submit');
    submit.disabled = true;
    try {
      if (!up) {
        await signIn(email, password);
        await main();
      } else {
        const res = await signUp(email, password);
        if (res.user && res.user.identities && res.user.identities.length === 0) {
          ui.warn('An account with this email already exists. Sign in instead.');
          mode = 'signin';
          renderAuth();
        } else if (res.session) {
          await main();
        } else {
          await ui.alert({
            title: 'Check your email',
            message: `We sent a confirmation link to ${email}. Open it to confirm your address. You will then be brought back here to accept your invitation. If you land somewhere else, open your invitation link again.`,
          });
          submit.disabled = false;
        }
      }
    } catch (err) {
      ui.errorFrom(err, 'Could not continue.');
      submit.disabled = false;
    }
  });
}

/* ---------- signed in ---------- */

async function renderInvites(session) {
  const { data, error } = await supabase.rpc('my_invitations');
  if (error) { ui.errorFrom(error, 'Could not load your invitations.'); return; }
  const email = session.user.email;
  const list = data || [];
  box.innerHTML = `
    <h2>Join a company</h2>
    <p class="muted">Signed in as <strong>${esc(email)}</strong></p>
    ${list.length ? list.map((i) => `<div class="card" style="margin:.75rem 0" data-inv="${i.id}">
      <strong>${esc(i.company_name)}</strong>
      <p class="muted" style="margin:.25rem 0 .75rem">${esc(i.invited_by_name || 'Someone')} invited you as <strong>${ROLE_LABEL[i.role]}</strong>.
        Expires ${esc(String(i.expires_at).slice(0, 10))}.</p>
      <div style="display:flex;gap:.5rem"><button class="btn btn-primary" data-accept="${i.id}" data-company="${i.company_id}" type="button">Accept</button>
      <button class="btn btn-ghost" data-decline="${i.id}" type="button">Decline</button></div></div>`).join('')
    : `<p>There are no pending invitations for this email address. Ask the person who invited you to check which address they used, or sign in with a different account.</p>`}
    <div style="display:flex;gap:.5rem;justify-content:space-between;margin-top:1rem;flex-wrap:wrap">
      <button class="btn btn-ghost" id="out" type="button">Sign out</button>
      <a class="btn" href="/">Go to my companies</a>
    </div>`;
  document.getElementById('out').addEventListener('click', async () => { await signOut(); mode = 'signin'; renderAuth(); });
  box.querySelectorAll('[data-accept]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const { data: cid, error: e2 } = await supabase.rpc('accept_invitation', { p_invitation: b.dataset.accept });
      if (e2) throw e2;
      setActiveCompany(cid);
      ui.success('You have joined the company.');
      setTimeout(() => { location.href = '/'; }, 600);
    } catch (err) { ui.errorFrom(err, 'Could not accept the invitation.'); b.disabled = false; }
  }));
  box.querySelectorAll('[data-decline]').forEach((b) => b.addEventListener('click', async () => {
    const ok = await ui.confirm({ title: 'Decline invitation', message: 'Decline this invitation?', confirmText: 'Decline', danger: true });
    if (!ok) return;
    const { error: e2 } = await supabase.rpc('decline_invitation', { p_invitation: b.dataset.decline });
    if (e2) return ui.errorFrom(e2);
    await main();
  }));
}

await main();