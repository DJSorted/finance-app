import { supabase } from '../core/supabase.js';
import { createCompany, setActiveCompany, signOut } from '../core/auth.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';

const app = document.getElementById('app');
const ctx = await startPage({ allowNoCompany: true });
if (ctx) { if (ctx.noCompany) showCreateCompany(); else showHome(ctx); }

/* ---------- company setup (unchanged) ---------- */

async function showCreateCompany() {
  app.innerHTML = `
    <div class="card" style="max-width:480px;margin:2rem auto">
      <h2>Set up your company</h2>
      <p class="muted">Choose your base currency carefully. It is locked once you post transactions.</p>
      <div class="field"><label for="co-name">Company name</label><input id="co-name" type="text"></div>
      <div class="field"><label for="co-base">Base currency</label>
        <select id="co-base"><option value="">Select base currency</option></select></div>
      <div style="display:flex;gap:.5rem;justify-content:space-between;flex-wrap:wrap">
        <button class="btn btn-ghost" id="co-signout" type="button">Sign out</button>
        <button class="btn btn-primary" id="co-create" type="button">Create company</button>
      </div>
    </div>`;

  document.getElementById('co-signout').addEventListener('click', async () => {
    await signOut();
    location.href = '/pages/login.html';
  });

  const sel = document.getElementById('co-base');
  const { data, error } = await supabase.from('currencies').select('code, name').order('code');
  if (error) { ui.errorFrom(error, 'Could not load currencies.'); return; }
  data.forEach((c) => {
    const o = document.createElement('option');
    o.value = c.code;
    o.textContent = `${c.code} - ${c.name}`;
    sel.appendChild(o);
  });

  document.getElementById('co-create').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    const name = document.getElementById('co-name').value.trim();
    const base = sel.value;
    if (!name || !base) { ui.warn('Enter a company name and choose a base currency.'); return; }
    const ok = await ui.confirm({
      title: 'Create company',
      message: `Create "${name}" with ${base} as the base currency?\nThe base currency cannot be changed after transactions are posted.`,
      confirmText: 'Create',
    });
    if (!ok) return;
    btn.disabled = true;
    try {
      const id = await createCompany(name, base);
      setActiveCompany(id);
      ui.created('Company');
      setTimeout(() => location.reload(), 800);
    } catch (e) {
      btn.disabled = false;
      ui.errorFrom(e, 'Could not create the company.');
    }
  });
}

/* ---------- dashboard ---------- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num0 = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
const money = (n) => Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const D = (s) => new Date(`${s}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
const todayIso = () => iso(new Date());
const addDays = (s, n) => { const d = D(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const addYears = (s, n) => {
  const d = D(s);
  const m = d.getUTCMonth();
  d.setUTCFullYear(d.getUTCFullYear() + n);
  if (d.getUTCMonth() !== m) d.setUTCDate(0);
  return iso(d);
};
const settle = (p) => Promise.resolve(p)
  .then((r) => ({ data: r.data, count: r.count, error: r.error || null }))
  .catch((e) => ({ data: null, count: null, error: e }));

function tile({ label, value, sub, href, tone }) {
  return `<a class="tile ${tone || ''}" href="${href}"><div class="tile-label">${esc(label)}</div>
    <div class="tile-value">${value}</div><div class="tile-sub">${sub || ''}</div></a>`;
}
const unavailable = (label, href) => tile({ label, value: '<span class="muted">n/a</span>', sub: 'Unavailable right now', href });

function delta(cur, prev) {
  if (prev === null || Math.abs(prev) < 0.005) return 'no figures for last year';
  const p = ((cur - prev) / Math.abs(prev)) * 100;
  return `${p >= 0 ? '+' : ''}${p.toFixed(1)}% vs same period last year`;
}

async function showHome(c) {
  const cid = c.companyId;
  const today = todayIso();
  app.innerHTML = `<div class="dash-head"><h2>${esc(c.company.name)}</h2><span class="muted">Loading your figures...</span></div>`;

  const [cur, fy, acc] = await Promise.all([
    settle(supabase.from('company_currencies').select('code').eq('company_id', cid).eq('is_base', true).maybeSingle()),
    settle(supabase.from('fiscal_years').select('start_date, end_date').eq('company_id', cid).order('start_date')),
    settle(supabase.from('gl_accounts').select('id, code, name, control_type, normal_balance').eq('company_id', cid).eq('is_posting', true)),
  ]);
  const base = cur.data ? cur.data.code : '';
  const year = (fy.data || []).find((y) => today >= y.start_date && today <= y.end_date);
  const start = year ? year.start_date : `${today.slice(0, 4)}-01-01`;
  const accById = new Map((acc.data || []).map((a) => [a.id, a]));
  const m0 = D(today);
  m0.setUTCDate(1);
  m0.setUTCMonth(m0.getUTCMonth() - 11);
  const monthFrom = iso(m0);

  const rpc = (fn, args) => settle(supabase.rpc(fn, { p_company: cid, ...args }));
  const count = (table, f) => settle(f(supabase.from(table).select('id', { count: 'exact', head: true }).eq('company_id', cid)));

  const [tb, tbPrev, monthly, sOpen, pOpen, rSales, rPurch, rStock, rGrni, rFa, outNow, upcoming, hireCount, retBk,
    dInv, dBill, dJrn, holdExp, repair] = await Promise.all([
    rpc('trial_balance', { p_from: start, p_to: today }),
    rpc('trial_balance', { p_from: addYears(start, -1), p_to: addYears(today, -1) }),
    rpc('monthly_profit', { p_from: monthFrom, p_to: today }),
    rpc('sales_open_items', { p_customer: null, p_as_of: today }),
    rpc('purchase_open_items', { p_supplier: null, p_as_of: today }),
    rpc('sales_reconciliation', { p_as_of: today }),
    rpc('purchase_reconciliation', { p_as_of: today }),
    rpc('stock_reconciliation', { p_as_of: today }),
    rpc('grni_reconciliation', {}),
    rpc('fixed_asset_reconciliation', { p_as_of: today }),
    rpc('hire_out_now', {}),
    count('bookings', (q) => q.eq('status', 'confirmed').gte('start_date', today).lte('start_date', addDays(today, 7))),
    count('hire_items', (q) => q),
    settle(supabase.from('bookings').select('id, sales_documents!sales_documents_booking_id_fkey(id)')
      .eq('company_id', cid).in('status', ['returned', 'closed']).limit(500)),
    count('sales_documents', (q) => q.eq('doc_type', 'invoice').eq('status', 'draft')),
    count('purchase_documents', (q) => q.eq('doc_type', 'bill').eq('status', 'draft')),
    count('journals', (q) => q.eq('status', 'draft')),
    count('bookings', (q) => q.eq('status', 'provisional').lt('hold_until', today)),
    count('hire_unavailable', (q) => q.eq('status', 'open')),
  ]);

  /* ----- profit and loss ----- */
  const pl = (res) => {
    if (res.error || !res.data) return null;
    let income = 0;
    let net = 0;
    res.data.forEach((r) => {
      if (!r.account_id || r.class_type !== 'income_statement') return;
      const a = accById.get(r.account_id);
      const d = Number(r.debit) - Number(r.credit);
      net -= d;
      if (a && a.normal_balance === 'credit') income -= d;
    });
    return { income, expenses: income - net, profit: net };
  };
  const now = pl(tb);
  const prev = pl(tbPrev);

  /* ----- bank and stock balances ----- */
  let bank = null;
  let stockVal = null;
  const banks = [];
  if (!tb.error && tb.data) {
    bank = 0;
    stockVal = 0;
    tb.data.forEach((r) => {
      const a = r.account_id ? accById.get(r.account_id) : null;
      if (!a) return;
      if (a.control_type === 'bank') { bank += Number(r.closing); banks.push({ name: `${a.code} ${a.name}`, bal: Number(r.closing) }); }
      if (a.control_type === 'inventory') stockVal += Number(r.closing);
    });
  }

  /* ----- debtors and creditors ----- */
  const ageing = (res, owedKind) => {
    if (res.error || !res.data) return null;
    const b = { notDue: 0, d30: 0, d60: 0, d90: 0, d90p: 0, credits: 0, total: 0, overdue: 0 };
    res.data.forEach((r) => {
      const amt = Number(r.base_outstanding);
      b.total += amt;
      if (r.doc_kind !== owedKind) { b.credits += amt; return; }
      const days = Math.round((D(today) - D(r.due_date)) / 86400000);
      if (days <= 0) b.notDue += amt;
      else if (days <= 30) b.d30 += amt;
      else if (days <= 60) b.d60 += amt;
      else if (days <= 90) b.d90 += amt;
      else b.d90p += amt;
    });
    b.overdue = b.d30 + b.d60 + b.d90 + b.d90p;
    return b;
  };
  const deb = ageing(sOpen, 'invoice');
  const cre = ageing(pOpen, 'bill');
  const BUCKET_COLOURS = ['#2ecc8f', '#a3d977', '#f5b942', '#ef8a42', '#ef5b5b'];
  const bar = (b) => {
    const parts = [b.notDue, b.d30, b.d60, b.d90, b.d90p];
    const tot = parts.reduce((s, x) => s + Math.max(x, 0), 0);
    if (tot <= 0) return '';
    const names = ['Not due', '1-30 days', '31-60 days', '61-90 days', 'Over 90 days'];
    return `<div class="age-bar">${parts.map((x, i) => (x > 0 ? `<span style="width:${(x / tot) * 100}%;background:${BUCKET_COLOURS[i]}" title="${names[i]}: ${money(x)}"></span>` : '')).join('')}</div>`;
  };

  /* ----- tiles ----- */
  const t1 = [];
  if (now) {
    t1.push(tile({ label: 'Income, year to date', value: num0(now.income), sub: `${esc(base)} · ${delta(now.income, prev ? prev.income : null)}`, href: '/pages/income-statement.html' }));
    t1.push(tile({ label: 'Expenses, year to date', value: num0(now.expenses), sub: `${esc(base)} · ${delta(now.expenses, prev ? prev.expenses : null)}`, href: '/pages/income-statement.html' }));
    t1.push(tile({ label: 'Net profit, year to date', value: num0(now.profit), sub: `${esc(base)} · ${delta(now.profit, prev ? prev.profit : null)}`, href: '/pages/income-statement.html', tone: now.profit >= 0 ? 'good' : 'bad' }));
  } else {
    ['Income, year to date', 'Expenses, year to date', 'Net profit, year to date'].forEach((l) => t1.push(unavailable(l, '/pages/income-statement.html')));
  }
  t1.push(bank === null ? unavailable('Bank balance', '/pages/trial-balance.html')
    : tile({ label: 'Bank balance', value: num0(bank), href: '/pages/trial-balance.html', tone: bank < 0 ? 'bad' : '',
      sub: banks.length ? banks.slice(0, 3).map((b) => `${esc(b.name)}: ${num0(b.bal)}`).join('<br>') : 'No bank accounts set up (control type Bank)' }));

  const t2 = [];
  t2.push(deb ? tile({ label: 'Debtors', value: num0(deb.total), href: '/pages/debtors-ageing.html',
    sub: `${deb.overdue > 0 ? `<span style="color:var(--danger)">${num0(deb.overdue)} overdue</span>` : 'Nothing overdue'}${bar(deb)}` }) : unavailable('Debtors', '/pages/debtors-ageing.html'));
  t2.push(cre ? tile({ label: 'Creditors', value: num0(cre.total), href: '/pages/creditors-ageing.html',
    sub: `${cre.overdue > 0 ? `<span style="color:var(--danger)">${num0(cre.overdue)} overdue</span>` : 'Nothing overdue'}${bar(cre)}` }) : unavailable('Creditors', '/pages/creditors-ageing.html'));
  t2.push(stockVal === null ? unavailable('Stock value', '/pages/stock-valuation.html')
    : tile({ label: 'Stock value', value: num0(stockVal), sub: `${esc(base)} · inventory accounts`, href: '/pages/stock-valuation.html' }));

  if (hireCount.count > 0) {
    const out = outNow.data || [];
    const units = out.reduce((s, r) => s + Number(r.qty_out), 0);
    const late = new Set(out.filter((r) => r.days_overdue > 0).map((r) => r.booking_id)).size;
    const unbilled = (retBk.data || []).filter((b) => !(b.sales_documents || []).length).length;
    t2.push(tile({
      label: 'Hire', value: `${num0(units)} <span class="muted" style="font-size:.9rem">units out</span>`, href: '/pages/bookings.html',
      sub: `${late ? `<span style="color:var(--danger)">${late} booking(s) overdue</span><br>` : ''}`
        + `${upcoming.count || 0} starting in the next 7 days${unbilled ? `<br>${unbilled} returned, not invoiced` : ''}`,
    }));
  }

  /* ----- monthly chart ----- */
  const months = [];
  const mm = D(monthFrom);
  for (let i = 0; i < 12; i++) { months.push(iso(mm).slice(0, 7)); mm.setUTCMonth(mm.getUTCMonth() + 1); }
  const byMonth = new Map(((monthly.data) || []).map((r) => [String(r.month).slice(0, 7), r]));
  const maxV = Math.max(1, ...months.map((m) => Math.max(Number((byMonth.get(m) || {}).income || 0), Number((byMonth.get(m) || {}).expenses || 0))));
  const chart = monthly.error ? '<p class="muted">The chart is unavailable right now.</p>'
    : (!(monthly.data || []).length ? '<p class="muted">No income or expenses have been posted in the last 12 months.</p>'
      : `<div class="mini-chart">${months.map((m) => {
        const r = byMonth.get(m) || {};
        const inc = Number(r.income || 0);
        const exp = Number(r.expenses || 0);
        const lab = D(`${m}-01`).toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' });
        return `<div class="col"><div class="bars">
          <div class="bar inc" style="height:${(inc / maxV) * 100}%" title="${lab} income: ${money(inc)}"></div>
          <div class="bar exp" style="height:${(exp / maxV) * 100}%" title="${lab} expenses: ${money(exp)}"></div></div><small>${lab}</small></div>`;
      }).join('')}</div>
      <p class="tile-sub"><span style="color:var(--success)">■</span> Income &nbsp; <span style="color:var(--danger)">■</span> Expenses (${esc(base)})</p>`);

  /* ----- needs attention ----- */
  const attn = [];
  const add = (n, text, href) => { if (n > 0) attn.push(`<li><a href="${href}">${text}</a><strong>${n}</strong></li>`); };
  add(dInv.count || 0, 'Draft invoices to review and post', '/pages/invoices.html');
  add(dBill.count || 0, 'Draft supplier bills to post', '/pages/bills.html');
  add(dJrn.count || 0, 'Draft journals to post', '/pages/journals.html');
  if (deb && deb.overdue > 0) attn.push(`<li><a href="/pages/debtors-ageing.html">Overdue from customers</a><strong>${num0(deb.overdue)}</strong></li>`);
  if (cre && cre.overdue > 0) attn.push(`<li><a href="/pages/creditors-ageing.html">Overdue to suppliers</a><strong>${num0(cre.overdue)}</strong></li>`);
  add(holdExp.count || 0, 'Provisional bookings with an expired hold', '/pages/bookings.html');
  const lateBookings = new Set((outNow.data || []).filter((r) => r.days_overdue > 0).map((r) => r.booking_id)).size;
  add(lateBookings, 'Hire bookings overdue back', '/pages/hire-out.html');
  add(repair.count || 0, 'Hire repair queue entries open', '/pages/hire-repairs.html');
  if (hireCount.count > 0) {
    const unbilled = (retBk.data || []).filter((b) => !(b.sales_documents || []).length).length;
    add(unbilled, 'Returned hire bookings not invoiced', '/pages/bookings.html');
  }

  /* ----- books health ----- */
  const health = [];
  const check = (label, res, diffOf, href) => {
    if (res.error || !res.data || !res.data.length) { health.push(`<div class="health-row"><span>${label}</span><span class="muted">unavailable</span></div>`); return; }
    const d = diffOf(res.data[0]);
    health.push(`<div class="health-row"><a href="${href}">${label}</a>${Math.abs(d) < 0.005
      ? '<span class="badge open">Agrees</span>' : `<span class="badge st-error">Difference ${money(d)}</span>`}</div>`);
  };
  check('Debtors ledger and control account', rSales, (r) => Number(r.difference), '/pages/debtors-ageing.html');
  check('Creditors ledger and control account', rPurch, (r) => Number(r.difference), '/pages/creditors-ageing.html');
  check('Stock and inventory accounts', rStock, (r) => Number(r.difference), '/pages/stock-valuation.html');
  check('Goods received not invoiced', rGrni, (r) => Number(r.difference), '/pages/goods-received.html');
  check('Asset register and fixed asset accounts', rFa, (r) => Math.abs(Number(r.cost_diff)) + Math.abs(Number(r.accum_diff)), '/pages/fixed-assets.html');

  app.innerHTML = `
    <div class="dash-head"><div><h2>${esc(c.company.name)}</h2>
      <span class="muted">Financial year from ${esc(start)} · figures in ${esc(base)} · as at ${esc(today)}</span></div>
      <button class="btn" id="dash-refresh" type="button">Refresh</button></div>
    <div class="dash-grid">${t1.join('')}</div>
    <div class="dash-grid">${t2.join('')}</div>
    <div class="dash-wide">
      <div class="card"><h4 style="margin-top:0">Income and expenses, last 12 months</h4>${chart}</div>
      <div class="card"><h4 style="margin-top:0">Needs attention</h4>
        ${attn.length ? `<ul class="attn">${attn.join('')}</ul>` : '<p class="muted">Nothing needs your attention right now.</p>'}</div>
      <div class="card"><h4 style="margin-top:0">Books health</h4>${health.join('')}
        <p class="tile-sub">Each sub-ledger is checked against its control account in the ledger.</p></div>
    </div>
    <div class="card"><h4 style="margin-top:0">Quick actions</h4>
      <div class="quick">
        <a class="btn" href="/pages/invoices.html">Invoices</a><a class="btn" href="/pages/bills.html">Supplier bills</a>
        <a class="btn" href="/pages/receipts.html">Receipts</a><a class="btn" href="/pages/payments.html">Supplier payments</a>
        <a class="btn" href="/pages/journals.html">Journals</a><a class="btn" href="/pages/bookings.html">Bookings</a>
        <a class="btn" href="/pages/balance-sheet.html">Balance Sheet</a><a class="btn" href="/pages/income-statement.html">Income Statement</a>
      </div></div>`;
  document.getElementById('dash-refresh').addEventListener('click', () => showHome(c));
}