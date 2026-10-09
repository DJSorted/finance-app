import { supabase } from '../core/supabase.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';

const ctx = await startPage();

const toolbar = document.getElementById('toolbar');
const hint = document.getElementById('hint');
const panel = document.getElementById('panel');

const IS_MANAGER = ctx ? ['owner', 'admin'].includes(ctx.role) : false;
const ROLES = ['owner', 'admin', 'accountant', 'clerk', 'viewer'];
const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', accountant: 'Accountant', clerk: 'Clerk', viewer: 'Viewer' };
const ROLE_ABOUT = {
  owner: 'Everything, including ownership, the base currency and who has access.',
  admin: 'Everything day to day, and manages users except owners and other admins.',
  accountant: 'Posts and corrects transactions, runs periods, depreciation and reports, and edits setup and master data.',
  clerk: 'Day-to-day capture: documents, bookings, stock and nursery work. Cannot change setup or master data.',
  viewer: 'Can see everything but cannot change anything.',
};

let members = [];
let invites = [];
let log = [];

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dateOnly = (s) => (s ? String(s).slice(0, 10) : '');
const dateTime = (s) => (s ? new Date(s).toLocaleString() : 'Never');
function btn(text, cls, onClick) {
  const b = el('button', `btn ${cls}`.trim(), text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/* ---------- who can do what (the database enforces the same rules) ---------- */

const rolesICanGive = () => (ctx.role === 'owner' ? ROLES : ['accountant', 'clerk', 'viewer']);
function canManage(m) {
  if (m.is_me) return false;
  if (ctx.role === 'owner') return true;
  return ctx.role === 'admin' && ['accountant', 'clerk', 'viewer'].includes(m.role);
}

/* ---------- invitations ---------- */

const inviteLink = (email) => `${location.origin}/pages/join.html?email=${encodeURIComponent(email)}`;

function inviteText(email, role, expires) {
  return `Hello,\n\nYou have been invited to join ${ctx.company.name} on Finance App as ${ROLE_LABEL[role]}.\n\n`
    + `1. Open this link: ${inviteLink(email)}\n`
    + `2. Create an account (or sign in) using this email address: ${email}\n`
    + '3. If you are asked to confirm your email, do that, then open the link again and choose Accept.\n\n'
    + `This invitation expires on ${dateOnly(expires)}.\n`;
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); ui.success('Copied.'); return; } catch (e) { /* fall back */ }
  const t = el('textarea');
  t.value = text;
  document.body.append(t);
  t.select();
  try { document.execCommand('copy'); ui.success('Copied.'); } catch (e) { ui.warn('Could not copy. Select the text and copy it yourself.'); }
  t.remove();
}

function openMail(email, role, expires) {
  const subject = `Invitation to ${ctx.company.name} on Finance App`;
  location.href = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(inviteText(email, role, expires))}`;
}

async function showInvite(email, role, expires) {
  const node = el('div');
  node.append(el('p', 'muted', `The invitation for ${email} is saved. They can accept it once they have an account with that email address. Send them this message:`));
  const ta = el('textarea');
  ta.value = inviteText(email, role, expires);
  ta.readOnly = true;
  ta.rows = 10;
  ta.style.width = '100%';
  node.append(ta);
  const res = await ui.dialog({
    title: 'Invitation ready', node, wide: true, dismissValue: 'close',
    buttons: [
      { label: 'Close', value: 'close', className: 'btn-ghost' },
      { label: 'Copy message', value: 'copy', className: '' },
      { label: 'Open in email', value: 'mail', className: 'btn-primary' },
    ],
  });
  if (res === 'copy') await copyText(ta.value);
  else if (res === 'mail') openMail(email, role, expires);
}

async function openInvite() {
  const saved = await ui.form({
    title: 'Invite someone', submitText: 'Create invitation',
    fields: [
      { name: 'email', label: 'Email address', type: 'email', required: true, full: true },
      { name: 'role', label: 'Role', type: 'select', required: true, full: true,
        options: rolesICanGive().map((r) => ({ value: r, label: `${ROLE_LABEL[r]}: ${ROLE_ABOUT[r]}` })) },
    ],
    values: { role: 'clerk' },
    onSubmit: async (v) => {
      const { error } = await supabase.rpc('invite_member', { p_company: ctx.companyId, p_email: v.email, p_role: v.role });
      if (error) throw error;
    },
  });
  if (!saved) return;
  await refresh();
  const email = (document.querySelector('.ui-form input[type=email]') || {}).value;
  const latest = invites[0];
  if (latest) await showInvite(latest.email, latest.role, latest.expires_at);
  else if (email) ui.created('Invitation');
}

// the form above has closed by now, so use the newest invitation we just created
async function resend(inv) {
  const { error } = await supabase.rpc('invite_member', { p_company: ctx.companyId, p_email: inv.email, p_role: inv.role });
  if (error) return ui.errorFrom(error);
  await refresh();
  const fresh = invites.find((x) => x.email.toLowerCase() === inv.email.toLowerCase());
  await showInvite(inv.email, inv.role, fresh ? fresh.expires_at : inv.expires_at);
}

async function revoke(inv) {
  const ok = await ui.confirm({ title: 'Revoke invitation', message: `Revoke the invitation for ${inv.email}? The link will stop working.`, confirmText: 'Revoke', danger: true });
  if (!ok) return;
  const { error } = await supabase.rpc('revoke_invitation', { p_invitation: inv.id });
  if (error) return ui.errorFrom(error);
  ui.updated('Invitation');
  await refresh();
}

/* ---------- data ---------- */

async function load() {
  const cid = ctx.companyId;
  if (!IS_MANAGER) { members = []; invites = []; log = []; return; }
  const [m, i, l] = await Promise.all([
    supabase.rpc('company_member_list', { p_company: cid }),
    supabase.from('company_invitations').select('*').eq('company_id', cid).eq('status', 'pending').order('created_at', { ascending: false }),
    supabase.from('member_log').select('*').eq('company_id', cid).order('created_at', { ascending: false }).limit(40),
  ]);
  for (const r of [m, i, l]) if (r.error) throw r.error;
  members = m.data;
  invites = i.data;
  log = l.data;
}

async function refresh() {
  try { await load(); } catch (e) { ui.errorFrom(e, 'Could not load the users.'); }
  render();
}

/* ---------- page ---------- */

function render() {
  document.getElementById('company-title').textContent = ctx.company.name;
  toolbar.replaceChildren();
  if (IS_MANAGER) toolbar.append(btn('Invite someone', 'btn-primary', openInvite));
  if (ctx.role !== 'owner') toolbar.append(btn('Leave this company', 'btn-ghost', () => leave()));
  hint.textContent = IS_MANAGER
    ? 'People with access to this company. Changes take effect immediately. Invitations are sent by you (email or copy the message), and only work for the invited email address once it is confirmed.'
    : `You are ${ROLE_LABEL[ctx.role]} in this company. Only owners and admins can manage users.`;

  let html = '';
  if (IS_MANAGER) {
    const owners = members.filter((m) => m.role === 'owner').length;
    const rows = members.map((m) => {
      const manage = canManage(m);
      const roleCell = manage
        ? `<select class="compact" data-role="${m.user_id}">${rolesICanGive().map((r) => `<option value="${r}" ${r === m.role ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}</select>`
        : `<span class="badge">${ROLE_LABEL[m.role]}</span>`;
      const act = manage ? `<button class="btn btn-sm" data-remove="${m.user_id}">Remove</button>`
        : (m.is_me && !(m.role === 'owner' && owners <= 1) ? '<button class="btn btn-sm" data-leave="1">Leave</button>' : '');
      return `<tr><td>${esc(m.full_name || '')}${m.is_me ? ' <span class="badge open">You</span>' : ''}</td><td>${esc(m.email)}</td><td>${roleCell}</td>
        <td>${esc(dateTime(m.last_sign_in))}</td><td>${esc(dateOnly(m.joined_at))}</td><td><div class="row-actions">${act}</div></td></tr>`;
    }).join('');
    html += `<div class="card"><h4 style="margin-top:0">Members</h4><div class="table-wrap"><table class="grid"><thead><tr>
      <th>Name</th><th>Email</th><th>Role</th><th>Last sign-in</th><th>Joined</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>`;

    html += `<div class="card" style="margin-top:1rem"><h4 style="margin-top:0">Pending invitations</h4>${invites.length ? `<div class="table-wrap"><table class="grid"><thead><tr>
      <th>Email</th><th>Role</th><th>Sent</th><th>Expires</th><th></th></tr></thead><tbody>${invites.map((i) => `<tr>
      <td>${esc(i.email)}</td><td>${ROLE_LABEL[i.role]}</td><td>${esc(dateOnly(i.created_at))}</td><td>${esc(dateOnly(i.expires_at))}</td>
      <td><div class="row-actions"><button class="btn btn-sm" data-mail="${i.id}">Email</button><button class="btn btn-sm" data-copy="${i.id}">Copy message</button>
      <button class="btn btn-sm" data-resend="${i.id}">Resend</button><button class="btn btn-sm" data-revoke="${i.id}">Revoke</button></div></td></tr>`).join('')}</tbody></table></div>`
      : '<p class="muted">No pending invitations.</p>'}</div>`;
  }

  html += `<div class="card" style="margin-top:1rem"><h4 style="margin-top:0">What each role can do</h4><div class="table-wrap"><table class="grid"><thead>
    <tr><th>Role</th><th>Access</th></tr></thead><tbody>${ROLES.map((r) => `<tr><td><strong>${ROLE_LABEL[r]}</strong>${r === ctx.role ? ' <span class="badge open">You</span>' : ''}</td><td>${esc(ROLE_ABOUT[r])}</td></tr>`).join('')}
    </tbody></table></div></div>`;

  if (IS_MANAGER) {
    html += `<div class="card" style="margin-top:1rem"><h4 style="margin-top:0">Recent changes</h4>${log.length ? `<div class="table-wrap"><table class="grid"><thead><tr>
      <th>When</th><th>By</th><th>Action</th><th>Person</th><th>Detail</th></tr></thead><tbody>${log.map((l) => `<tr><td>${esc(dateTime(l.created_at))}</td>
      <td>${esc(l.actor_email || '')}</td><td>${esc(l.action)}</td><td>${esc(l.target_email || '')}</td><td>${esc(l.detail || '')}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="muted">Nothing yet.</p>'}</div>`;
  }
  panel.innerHTML = html;
}

/* ---------- actions ---------- */

panel.addEventListener('change', async (e) => {
  const sel = e.target.closest('select[data-role]');
  if (!sel) return;
  const m = members.find((x) => x.user_id === sel.dataset.role);
  if (!m || sel.value === m.role) return;
  const ok = await ui.confirm({
    title: 'Change role', message: `Change ${m.email} from ${ROLE_LABEL[m.role]} to ${ROLE_LABEL[sel.value]}?`, confirmText: 'Change role',
  });
  if (!ok) { sel.value = m.role; return; }
  const { error } = await supabase.rpc('set_member_role', { p_company: ctx.companyId, p_user: m.user_id, p_role: sel.value });
  if (error) { ui.errorFrom(error); sel.value = m.role; return; }
  ui.updated('Role');
  await refresh();
});

panel.addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.remove) {
    const m = members.find((x) => x.user_id === t.dataset.remove);
    const ok = await ui.confirm({
      title: 'Remove user', message: `Remove ${m.email} from ${ctx.company.name}? They lose access immediately. Their records stay.`, confirmText: 'Remove', danger: true,
    });
    if (!ok) return;
    const { error } = await supabase.rpc('remove_member', { p_company: ctx.companyId, p_user: m.user_id });
    if (error) return ui.errorFrom(error);
    ui.deleted('User');
    await refresh();
  } else if (t.dataset.leave) {
    await leave();
  } else {
    const inv = invites.find((x) => x.id === (t.dataset.mail || t.dataset.copy || t.dataset.resend || t.dataset.revoke));
    if (!inv) return;
    if (t.dataset.mail) openMail(inv.email, inv.role, inv.expires_at);
    else if (t.dataset.copy) await copyText(inviteText(inv.email, inv.role, inv.expires_at));
    else if (t.dataset.resend) await resend(inv);
    else if (t.dataset.revoke) await revoke(inv);
  }
});

async function leave() {
  const ok = await ui.confirm({
    title: 'Leave company', message: `Leave ${ctx.company.name}? You will lose access until someone invites you again.`, confirmText: 'Leave', danger: true,
  });
  if (!ok) return;
  const { error } = await supabase.rpc('remove_member', { p_company: ctx.companyId, p_user: ctx.session.user.id });
  if (error) return ui.errorFrom(error);
  try { localStorage.removeItem('activeCompanyId'); } catch (e) { /* ignore */ }
  location.href = '/';
}

if (ctx) await refresh();