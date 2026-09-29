import { supabase } from '../core/supabase.js';
import { requireAuth, signOut, getMemberships, getActiveMembership, setActiveCompany, createCompany } from '../core/auth.js';
import { ui } from '../core/ui.js';

const app = document.getElementById('app');
const session = await requireAuth();
if (session) init();

async function init() {
  document.getElementById('user-email').textContent = session.user.email;
  document.getElementById('btn-signout').addEventListener('click', async () => {
    const ok = await ui.confirm({ title: 'Sign out', message: 'Sign out of Finance App?', confirmText: 'Sign out' });
    if (!ok) return;
    await signOut();
    location.href = '/pages/login.html';
  });

  let memberships;
  try { memberships = await getMemberships(session.user.id); }
  catch (e) { ui.errorFrom(e, 'Could not load your companies.'); return; }

  if (!memberships.length) return showCreateCompany();
  showHome(getActiveMembership(memberships));
}

async function showCreateCompany() {
  app.innerHTML = `
    <div class="card" style="max-width:480px;margin:2rem auto">
      <h2>Set up your company</h2>
      <p class="muted">Choose your base currency carefully. It is locked once you post transactions.</p>
      <div class="field"><label for="co-name">Company name</label><input id="co-name" type="text"></div>
      <div class="field"><label for="co-base">Base currency</label>
        <select id="co-base"><option value="">Select base currency</option></select></div>
      <button class="btn btn-primary" id="co-create" type="button">Create company</button>
    </div>`;

  const sel = document.getElementById('co-base');
  const { data, error } = await supabase.from('currencies').select('code, name').order('code');
  if (error) { ui.errorFrom(error, 'Could not load currencies.'); return; }
  data.forEach((c) => {
    const o = document.createElement('option');
    o.value = c.code; o.textContent = `${c.code} - ${c.name}`;
    sel.appendChild(o);
  });

  document.getElementById('co-create').addEventListener('click', async () => {
    const name = document.getElementById('co-name').value.trim();
    const base = sel.value;
    if (!name || !base) { ui.warn('Enter a company name and choose a base currency.'); return; }
    const ok = await ui.confirm({
      title: 'Create company',
      message: `Create "${name}" with ${base} as the base currency?\nThe base currency cannot be changed after transactions are posted.`,
      confirmText: 'Create',
    });
    if (!ok) return;
    try {
      const id = await createCompany(name, base);
      setActiveCompany(id);
      ui.created('Company');
      setTimeout(() => location.reload(), 800);
    } catch (e) { ui.errorFrom(e, 'Could not create the company.'); }
  });
}

function showHome(m) {
  document.getElementById('company-name').textContent = m.companies.name;
  app.innerHTML = `
    <div class="card">
      <h2></h2>
      <p class="muted">Foundation is working. Setups come next.</p>
      <span class="badge"></span>
    </div>`;
  app.querySelector('h2').textContent = `Welcome to ${m.companies.name}`;
  app.querySelector('.badge').textContent = `Your role: ${m.role}`;
}