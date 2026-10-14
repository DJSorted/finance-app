import { supabase } from '../core/supabase.js';
import { createCompany, setActiveCompany } from '../core/auth.js';
import { startPage } from '../core/shell.js';
import { ui } from '../core/ui.js';

const ctx = await startPage();

if (ctx) {
  document.getElementById('company-title').textContent = ctx.company.name;
  document.getElementById('hint').textContent = 'Create a separate company under your login. It has its own chart of accounts, customers, stock and base currency. Switch between your companies with the Company selector at the top of the menu.';
  const panel = document.getElementById('panel');
  panel.innerHTML = `<div style="max-width:460px">
    <div class="field"><label for="nc-name">Company name</label><input id="nc-name" type="text"></div>
    <div class="field"><label for="nc-base">Base currency</label><select id="nc-base"><option value="">Select base currency</option></select>
      <p class="muted">Choose carefully. It is locked once you post transactions.</p></div>
    <button class="btn btn-primary" id="nc-create" type="button">Create company</button></div>`;

  const sel = document.getElementById('nc-base');
  const { data, error } = await supabase.from('currencies').select('code, name').order('code');
  if (error) ui.errorFrom(error, 'Could not load currencies.');
  else data.forEach((c) => { const o = document.createElement('option'); o.value = c.code; o.textContent = `${c.code} - ${c.name}`; sel.append(o); });

  document.getElementById('nc-create').addEventListener('click', async (ev) => {
    const b = ev.currentTarget;
    const name = document.getElementById('nc-name').value.trim();
    const base = sel.value;
    if (!name || !base) return ui.warn('Enter a company name and choose a base currency.');
    const ok = await ui.confirm({
      title: 'Create company',
      message: `Create "${name}" with ${base} as the base currency?\nYou will be switched to it. The base currency cannot be changed after transactions are posted.`,
      confirmText: 'Create',
    });
    if (!ok) return;
    b.disabled = true;
    try {
      const id = await createCompany(name, base);
      setActiveCompany(id);
      ui.created('Company');
      setTimeout(() => { location.href = '/'; }, 800);
    } catch (e) {
      b.disabled = false;
      ui.errorFrom(e, 'Could not create the company.');
    }
  });
}