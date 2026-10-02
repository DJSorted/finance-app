import { supabase } from './supabase.js';
import { requireAuth, signOut, getMemberships, getActiveMembership, setActiveCompany } from './auth.js';
import { ui } from './ui.js';
import { logoUrl } from './logo.js';

// Add new pages here and they appear in the sidebar on every screen.
const NAV = [
  { section: 'Overview', pinned: true, items: [{ href: '/', label: 'Home' }] },
    { section: 'Accounting', items: [
    { href: '/pages/journals.html', label: 'Journals' },
    { href: '/pages/trial-balance.html', label: 'Trial Balance' },
  ] },
  { section: 'Setup', items: [
    { href: '/pages/company.html', label: 'Company Profile' },
    { href: '/pages/chart.html', label: 'Chart of Accounts' },
    { href: '/pages/reports.html', label: 'Report Layouts' },
    { href: '/pages/calendar.html', label: 'Financial Calendar' },
    { href: '/pages/currencies.html', label: 'Currencies & Rates' },
  ] },
  { section: 'Defaults', items: [
    { href: '/pages/company-settings.html', label: 'Company Defaults' },
    { href: '/pages/tax.html', label: 'Tax Codes' },
    { href: '/pages/payment-terms.html', label: 'Payment Terms' },
    { href: '/pages/number-sequences.html', label: 'Number Sequences' },
  ] },
  { section: 'Inventory', items: [
    { href: '/pages/items.html', label: 'Items' },
    { href: '/pages/item-categories.html', label: 'Item Categories' },
    { href: '/pages/units.html', label: 'Units of Measure' },
    { href: '/pages/warehouses.html', label: 'Warehouses' },
  ] },
  { section: 'Sales', items: [
    { href: '/pages/invoices.html', label: 'Invoices' },
    { href: '/pages/credit-notes.html', label: 'Credit Notes' },
    { href: '/pages/receipts.html', label: 'Receipts' },
    { href: '/pages/customers.html', label: 'Customers' },
  ] },
  { section: 'Purchases', items: [{ href: '/pages/suppliers.html', label: 'Suppliers' }] },
];
const EDIT_ROLES = ['owner', 'admin', 'accountant'];

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// Makes /pages/chart.html, /pages/chart and /pages/chart/ all compare as equal
function normPath(p) {
  let x = p.replace(/\.html$/, '').replace(/\/index$/, '');
  if (x.length > 1) x = x.replace(/\/$/, '');
  return x || '/';
}

const NAV_KEY = 'navExpanded';
function loadExpanded() {
  try { return new Set(JSON.parse(localStorage.getItem(NAV_KEY) || '[]')); } catch (e) { return new Set(); }
}
function saveExpanded(set) {
  try { localStorage.setItem(NAV_KEY, JSON.stringify([...set])); } catch (e) { /* ignore */ }
}

// Every page calls this first. Returns the signed-in context, or null if it is redirecting.
// Pass { allowNoCompany: true } on the home page so it can show the company setup form.
export async function startPage(opts = {}) {
  const reveal = () => document.body.classList.add('ready');

  const session = await requireAuth();
  if (!session) return null;

  let memberships;
  try { memberships = await getMemberships(session.user.id); }
  catch (e) { reveal(); ui.errorFrom(e, 'Could not load your companies.'); return null; }

  if (!memberships.length) {
    reveal();
    if (opts.allowNoCompany) return { session, noCompany: true };
    location.href = '/';
    return null;
  }

  const active = getActiveMembership(memberships);
  setActiveCompany(active.company_id);
  buildShell(session, memberships, active);
  reveal();

  return {
    session,
    companyId: active.company_id,
    company: active.companies,
    role: active.role,
    canEdit: EDIT_ROLES.includes(active.role),
  };
}

function buildShell(session, memberships, active) {
  const path = normPath(location.pathname);
  const main = document.querySelector('main');

  /* ----- sidebar ----- */
  const sidebar = h('aside', 'sidebar');
  const brand = h('div', 'brand');
  if (active.companies.logo_path) {
    const img = h('img', 'brand-logo');
    img.alt = active.companies.name;
    img.src = logoUrl(active.companies);
    brand.append(img);
  } else {
    brand.textContent = 'Finance App';
  }
  sidebar.append(brand);

  const co = h('div', 'co');
  co.append(h('div', 'lbl', 'Company'));
  if (memberships.length > 1) {
    const sel = h('select');
    memberships.forEach((m) => {
      const o = h('option', '', m.companies.name);
      o.value = m.company_id;
      if (m.company_id === active.company_id) o.selected = true;
      sel.append(o);
    });
    sel.addEventListener('change', () => { setActiveCompany(sel.value); location.reload(); });
    co.append(sel);
  } else {
    co.append(h('div', 'co-name', active.companies.name));
  }
  sidebar.append(co);

    const expanded = loadExpanded();
  const nav = h('nav');
  NAV.forEach((s) => {
    const items = h('div', 'nav-items');
    s.items.forEach((n) => {
      const a = h('a', normPath(n.href) === path ? 'active' : '', n.label);
      a.href = n.href;
      items.append(a);
    });

    if (s.pinned) {
      const fixed = h('div', 'nav-group');
      fixed.append(h('div', 'nav-section static', s.section), items);
      nav.append(fixed);
      return;
    }

    const hasActive = s.items.some((n) => normPath(n.href) === path);
    const open = hasActive || expanded.has(s.section);
    const group = h('div', 'nav-group' + (open ? '' : ' collapsed'));
    const head = h('button', 'nav-section');
    head.type = 'button';
    head.setAttribute('aria-expanded', String(open));
    head.append(h('span', 'nav-caret', '▾'), h('span', '', s.section));
    head.addEventListener('click', () => {
      const isCollapsed = group.classList.toggle('collapsed');
      head.setAttribute('aria-expanded', String(!isCollapsed));
      if (isCollapsed) expanded.delete(s.section); else expanded.add(s.section);
      saveExpanded(expanded);
    });
    group.append(head, items);
    nav.append(group);
  });
  sidebar.append(nav);

  const meta = session.user.user_metadata || {};
  const who = h('button', 'btn btn-ghost', meta.full_name || session.user.email);
  who.type = 'button';
  who.title = 'Edit your display name';
  who.addEventListener('click', async () => {
    const saved = await ui.form({
      title: 'Your profile',
      fields: [
        { name: 'full_name', label: 'Display name', required: true, full: true },
        { name: 'email', label: 'Email', disabled: true, full: true },
      ],
      values: { full_name: meta.full_name || '', email: session.user.email },
      onSubmit: async (v) => {
        const { error } = await supabase.auth.updateUser({ data: { full_name: v.full_name } });
        if (error) throw error;
      },
    });
    if (saved) {
      ui.updated('Profile');
      setTimeout(() => location.reload(), 600);
    }
  });

  const out = h('button', 'btn btn-ghost', 'Sign out');
  out.type = 'button';
  out.addEventListener('click', async () => {
    const ok = await ui.confirm({ title: 'Sign out', message: 'Sign out of Finance App?', confirmText: 'Sign out' });
    if (!ok) return;
    await signOut();
    location.href = '/pages/login.html';
  });

  const foot = h('div', 'foot');
  foot.append(who, out);
  sidebar.append(foot);

  /* ----- slim top bar for phones and tablets ----- */
  const menu = h('button', 'menu-btn', '☰');
  menu.type = 'button';
  menu.setAttribute('aria-label', 'Open menu');
  const bar = h('header', 'mobilebar');
  bar.append(menu, h('span', 'brand', 'Finance App'), h('span', 'muted company', active.companies.name));

  const scrim = h('div', 'sidebar-scrim');
  const close = () => document.body.classList.remove('nav-open');
  menu.addEventListener('click', () => document.body.classList.toggle('nav-open'));
  scrim.addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  /* ----- assemble: the page's own <main> moves into the content area ----- */
  const body = h('div', 'app-body');
  body.append(bar, main);
  const shell = h('div', 'app-shell');
  shell.append(sidebar, scrim, body);
  document.body.prepend(shell);
}