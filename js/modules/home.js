import { supabase } from '../core/supabase.js';
import { createCompany, setActiveCompany, signOut } from '../core/auth.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';

const app = document.getElementById('app');
const ctx = await startPage({ allowNoCompany: true });
if (ctx) { if (ctx.noCompany) showCreateCompany(); else showHome(ctx); }

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

function showHome(c) {
  app.innerHTML = `
    <div class="card">
      <h2></h2>
      <p class="muted">Foundation is working. Setups come next.</p>
      <p><span class="badge"></span></p>
    </div>`;
  app.querySelector('h2').textContent = `Welcome to ${c.company.name}`;
  app.querySelector('.badge').textContent = `Your role: ${c.role}`;
}