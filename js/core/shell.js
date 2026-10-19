import { supabase } from './supabase.js';
import { requireAuth, signOut, getMemberships, getActiveMembership, setActiveCompany } from './auth.js';
import { ui } from './ui.js';
import { logoUrl } from './logo.js';
import { setExportContext } from './export.js';
import { watchTableFilters } from './table-filters.js';

// Add new pages here and they appear in the sidebar on every screen.
const NAV = [
  { section: 'Overview', pinned: true, items: [{ href: '/', label: 'Home' }, { href: '/pages/search.html', label: 'Search' }] },
  { section: 'Accounting', items: [
    { href: '/pages/journals.html', label: 'Journals' },
    { href: '/pages/trial-balance.html', label: 'Trial Balance' },
    { href: '/pages/general-ledger.html', label: 'General Ledger' },
    { href: '/pages/open-items.html', label: 'Open Items' },
    { href: '/pages/party-ledgers.html', label: 'Debtors & Creditors Ledger' },
    { href: '/pages/audit-log.html', label: 'Audit Log', roles: ['owner', 'admin', 'accountant'] },
  ] },
  { section: 'Reports', items: [
    { href: '/pages/income-statement.html', label: 'Income Statement' },
    { href: '/pages/income-trend.html', label: 'Income Trend' },
    { href: '/pages/balance-sheet.html', label: 'Balance Sheet' },
    { href: '/pages/cash-flow.html', label: 'Cash Flow' },
    { href: '/pages/bank-transactions.html', label: 'Bank Transactions' },
  ] },
  { section: 'Setup', items: [
    { href: '/pages/company.html', label: 'Company Profile' },
    { href: '/pages/document-settings.html', label: 'Document Settings', roles: ['owner', 'admin', 'accountant'] },
    { href: '/pages/new-company.html', label: 'New Company' },
    { href: '/pages/members.html', label: 'Users' },
    { href: '/pages/chart.html', label: 'Chart of Accounts' },
    { href: '/pages/reports.html', label: 'Report Layouts' },
    { href: '/pages/calendar.html', label: 'Financial Calendar' },
    { href: '/pages/year-end.html', label: 'Year-End Close' },
    { href: '/pages/delete-company.html', label: 'Delete Company', ownerOnly: true },
    { href: '/pages/currencies.html', label: 'Currencies & Rates' },
    { href: '/pages/data-info.html', label: 'Data & Records' },
    { href: '/pages/attachments.html', label: 'Attachments' },
    { href: '/pages/data-export.html', label: 'Full Data Export' },
    { href: '/pages/opening-balances.html', label: 'Opening Balances', roles: ['owner', 'admin', 'accountant'] },
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
    { href: '/pages/item-groups.html', label: 'Item Groups' },
    { href: '/pages/units.html', label: 'Units of Measure' },
    { href: '/pages/warehouses.html', label: 'Warehouses' },
    { href: '/pages/stock-adjustments.html', label: 'Stock Adjustments' },
    { href: '/pages/stock-transfers.html', label: 'Stock Transfers' },
    { href: '/pages/stock-valuation.html', label: 'Stock Valuation' },
    { href: '/pages/stock-movements.html', label: 'Stock Movements' },
    { href: '/pages/price-updates.html', label: 'Price Updates' },
  ] },
  { section: 'Manufacturing', items: [
    { href: '/pages/boms.html', label: 'Bills of Materials' },
    { href: '/pages/work-orders.html', label: 'Work Orders' },
  ] },
  { section: 'Fixed Assets', items: [
    { href: '/pages/fixed-assets.html', label: 'Asset Register' },
    { href: '/pages/depreciation.html', label: 'Depreciation' },
    { href: '/pages/asset-categories.html', label: 'Asset Categories' },
  ] },
  { section: 'Hire', items: [
    { href: '/pages/bookings.html', label: 'Bookings' },
    { href: '/pages/hire-calendar.html', label: 'Hire Calendar' },
    { href: '/pages/hire-out.html', label: 'Out on Hire' },
    { href: '/pages/hire-repairs.html', label: 'Repair Queue' },
    { href: '/pages/hire-items.html', label: 'Hire Items' },
    { href: '/pages/hire-reports.html', label: 'Hire Reports' },
  ] },
  { section: 'Nursery', items: [
    { href: '/pages/nursery.html', label: 'Nursery Batches' },
    { href: '/pages/nursery-bills.html', label: 'Allocate Bill Lines' },
  ] },
  { section: 'Projects', items: [
    { href: '/pages/projects.html', label: 'Projects' },
    { href: '/pages/project-report.html', label: 'Project Report' },
  ] },
  { section: 'POS', items: [
    { href: '/pages/pos.html', label: 'Point of Sale' },
    { href: '/pages/pos-shifts.html', label: 'POS Shifts' },
    { href: '/pages/pos-registers.html', label: 'Registers' },
    { href: '/pages/pos-methods.html', label: 'Payment Methods' },
  ] },
  { section: 'Sales', items: [
    { href: '/pages/invoices.html', label: 'Invoices' },
    { href: '/pages/credit-notes.html', label: 'Credit Notes' },
    { href: '/pages/receipts.html', label: 'Receipts' },
    { href: '/pages/customer-statement.html', label: 'Customer Statement' },
    { href: '/pages/debtors-ageing.html', label: 'Debtors Ageing' },
    { href: '/pages/interest.html', label: 'Interest' },
    { href: '/pages/customers.html', label: 'Customers' },
  ] },
  { section: 'Purchases', items: [
    { href: '/pages/purchase-orders.html', label: 'Purchase Orders' },
    { href: '/pages/goods-received.html', label: 'Goods Received' },
    { href: '/pages/bills.html', label: 'Bills' },
    { href: '/pages/supplier-credit-notes.html', label: 'Supplier Credit Notes' },
    { href: '/pages/payments.html', label: 'Supplier Payments' },
    { href: '/pages/supplier-statement.html', label: 'Supplier Statement' },
    { href: '/pages/creditors-ageing.html', label: 'Creditors Ageing' },
    { href: '/pages/suppliers.html', label: 'Suppliers' },
  ] },
];
const EDIT_ROLES = ['owner', 'admin', 'accountant'];

// Pages that get column filters (lists without their own totals or tree rows)
const FILTER_PAGES = new Set([
  '/pages/bookings', '/pages/hire-items', '/pages/hire-repairs', '/pages/hire-out',
  '/pages/journals', '/pages/invoices', '/pages/credit-notes', '/pages/receipts',
  '/pages/bills', '/pages/supplier-credit-notes', '/pages/payments', '/pages/purchase-orders', '/pages/goods-received',
  '/pages/stock-adjustments', '/pages/stock-transfers', '/pages/customers', '/pages/suppliers', '/pages/items',
  '/pages/item-categories', '/pages/units', '/pages/warehouses', '/pages/tax', '/pages/payment-terms',
  '/pages/number-sequences', '/pages/asset-categories',
]);

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

// Fills the page's own search box when the address has ?q=
function applyUrlSearch() {
  const q = new URLSearchParams(location.search).get('q');
  if (!q) return;
  let tries = 0;
  const apply = () => {
    const box = document.querySelector('#toolbar input[type="search"], #toolbar input[placeholder^="Search"]');
    if (!box) return false;
    box.value = q;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  };
  if (apply()) return;
  const t = setInterval(() => { if (apply() || ++tries > 40) clearInterval(t); }, 150);
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
    if (opts.allowNoCompany) {
      // Someone who has been invited goes straight to the invitation instead of the company setup form
      try {
        const { data } = await supabase.rpc('my_invitations');
        if (data && data.length) { location.href = '/pages/join.html'; return null; }
      } catch (e) { /* carry on to company setup */ }
      reveal();
      return { session, noCompany: true };
    }
    reveal();
    location.href = '/';
    return null;
  }

  const active = getActiveMembership(memberships);
  setActiveCompany(active.company_id);
  buildShell(session, memberships, active);
  setExportContext({ company: active.companies.name });
  const panelEl = document.getElementById('panel');
  if (panelEl && FILTER_PAGES.has(normPath(location.pathname))) watchTableFilters(panelEl);
  showInvitationBar();
  applyUrlSearch();
  reveal();

  return {
    session,
    companyId: active.company_id,
    company: active.companies,
    role: active.role,
    canEdit: EDIT_ROLES.includes(active.role),
  };
}

// A reminder at the top of every page when someone has invited you to another company
function showInvitationBar() {
  Promise.resolve(supabase.rpc('my_invitations')).then(({ data }) => {
    if (!data || !data.length) return;
    const main = document.querySelector('main');
    if (!main) return;
    const bar = h('div', 'invite-bar');
    bar.append(h('span', '', `You have ${data.length} pending invitation${data.length === 1 ? '' : 's'} to join a company.`));
    const a = h('a', 'btn btn-sm', 'View');
    a.href = '/pages/join.html';
    bar.append(a);
    main.before(bar);
  }).catch(() => { /* the bar is optional */ });
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

  const sform = h('form', 'side-search');
  sform.style.cssText = 'padding:0 .75rem .5rem';
  const sbox = h('input');
  sbox.type = 'search';
  sbox.placeholder = 'Search everything ( / )';
  sbox.setAttribute('aria-label', 'Search everything');
  sbox.style.width = '100%';
  sform.append(sbox);
  sform.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = sbox.value.trim();
    if (v) location.href = `/pages/search.html?q=${encodeURIComponent(v)}`;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '')) { e.preventDefault(); sbox.focus(); }
  });
  sidebar.append(sform);

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
    s.items.filter((n) => (!n.ownerOnly || active.role === 'owner') && (!n.roles || n.roles.includes(active.role))).forEach((n) => {
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

  // Filters the menu as you type; matching groups open, Enter goes to the first match
  const mbox = h('input', 'nav-find');
  mbox.type = 'search';
  mbox.placeholder = 'Find a menu item ( m )';
  mbox.setAttribute('aria-label', 'Find a menu item');
  const filterNav = () => {
    const terms = mbox.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    nav.classList.toggle('filtering', terms.length > 0);
    nav.querySelectorAll('.nav-group').forEach((g) => {
      const section = g.querySelector('.nav-section').textContent.replace('▾', '').toLowerCase();
      let any = false;
      g.querySelectorAll('.nav-items a').forEach((a) => {
        const hay = `${a.textContent.toLowerCase()} ${section}`;
        const hit = terms.every((t) => hay.includes(t));
        a.classList.toggle('nav-hidden', terms.length > 0 && !hit);
        a.classList.remove('nav-first');
        if (hit) any = true;
      });
      g.classList.toggle('nav-hidden', terms.length > 0 && !any);
    });
    const first = terms.length ? nav.querySelector('.nav-group:not(.nav-hidden) .nav-items a:not(.nav-hidden)') : null;
    if (first) first.classList.add('nav-first');
  };
  mbox.addEventListener('input', filterNav);
  mbox.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = nav.querySelector('a.nav-first');
      if (first) location.href = first.href;
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      mbox.value = '';
      filterNav();
      mbox.blur();
    } else if (e.key === 'ArrowDown') {
      const first = nav.querySelector('a.nav-first');
      if (first) { e.preventDefault(); first.focus(); }
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'm' && !e.ctrlKey && !e.metaKey && !e.altKey && !/^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '') && !(document.activeElement || {}).isContentEditable) {
      e.preventDefault();
      document.body.classList.add('nav-open');
      mbox.focus();
    }
  });
  const mwrap = h('div', 'nav-find-wrap');
  mwrap.append(mbox);
  sidebar.append(mwrap, nav);

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