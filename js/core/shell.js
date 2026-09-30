import { requireAuth, signOut, getMemberships, getActiveMembership, setActiveCompany } from './auth.js';
import { ui } from './ui.js';
import { supabase } from './supabase.js';

const NAV = [
  { href: '/', label: 'Home' },
  { href: '/pages/chart.html', label: 'Chart of Accounts' },
];
const EDIT_ROLES = ['owner', 'admin', 'accountant'];

// Every page calls this first. Returns the signed-in context, or null if it is redirecting.
export async function startPage() {
  const session = await requireAuth();
  if (!session) return null;

  let memberships;
  try { memberships = await getMemberships(session.user.id); }
  catch (e) { ui.errorFrom(e, 'Could not load your companies.'); return null; }
  if (!memberships.length) { location.href = '/'; return null; }

  const active = getActiveMembership(memberships);
  setActiveCompany(active.company_id);
  renderTopbar(session, memberships, active);

  return {
    session,
    companyId: active.company_id,
    company: active.companies,
    role: active.role,
    canEdit: EDIT_ROLES.includes(active.role),
  };
}

function renderTopbar(session, memberships, active) {
  const bar = document.createElement('header');
  bar.className = 'topbar';

  const left = document.createElement('div');
  left.className = 'left';
  const brand = document.createElement('div');
  brand.className = 'brand';
  brand.textContent = 'Finance App';
  const nav = document.createElement('nav');
  nav.className = 'nav';
  NAV.forEach((n) => {
    const a = document.createElement('a');
    a.href = n.href;
    a.textContent = n.label;
    if (location.pathname === n.href) a.className = 'active';
    nav.append(a);
  });
  left.append(brand, nav);

  const right = document.createElement('div');
  right.className = 'right';

  if (memberships.length > 1) {
    const sel = document.createElement('select');
    sel.className = 'compact';
    memberships.forEach((m) => {
      const o = document.createElement('option');
      o.value = m.company_id;
      o.textContent = m.companies.name;
      if (m.company_id === active.company_id) o.selected = true;
      sel.append(o);
    });
    sel.addEventListener('change', () => { setActiveCompany(sel.value); location.reload(); });
    right.append(sel);
  } else {
    const name = document.createElement('span');
    name.className = 'muted';
    name.textContent = active.companies.name;
    right.append(name);
  }

  const email = document.createElement('span');
  email.className = 'muted';
  email.textContent = session.user.email;
  const out = document.createElement('button');
  out.className = 'btn btn-ghost';
  out.type = 'button';
  out.textContent = 'Sign out';
  out.addEventListener('click', async () => {
    const ok = await ui.confirm({ title: 'Sign out', message: 'Sign out of Finance App?', confirmText: 'Sign out' });
    if (!ok) return;
    await signOut();
    location.href = '/pages/login.html';
  });
  right.append(email, out);

  bar.append(left, right);
  document.body.prepend(bar);
}