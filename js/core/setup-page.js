import { supabase } from './supabase.js';
import { ui } from './ui.js';
import { exportSheets } from './export.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function btn(text, cls, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `btn ${cls}`.trim();
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

// One standard list + add/edit/delete + export screen for a setup table.
// cfg: { table, noun, plural, file, hint, orderBy, defaults, canAdd, canDelete,
//        lookups(ctx), columns(lk), fields(lk, row), toForm(row, lk), validate(v, row, rows), toPayload(v, row),
//        beforeDelete(row, rows), duplicateMessage }
// Every column needs header and text(row); html(row) is optional and must escape its own output.
export async function setupPage(ctx, cfg) {
  const toolbar = document.getElementById('toolbar');
  const hint = document.getElementById('hint');
  const panel = document.getElementById('panel');
  document.getElementById('company-title').textContent = ctx.company.name;
  hint.textContent = cfg.hint || '';

  const canAdd = ctx.canEdit && cfg.canAdd !== false;
  const canDelete = ctx.canEdit && cfg.canDelete !== false;
  let rows = [];
  let lk = {};

  async function load() {
    lk = cfg.lookups ? await cfg.lookups(ctx) : {};
    let q = supabase.from(cfg.table).select('*').eq('company_id', ctx.companyId);
    (cfg.orderBy || ['code']).forEach((c) => { q = q.order(c); });
    const { data, error } = await q;
    if (error) throw error;
    rows = data;
  }

  async function refresh() {
    try { await load(); } catch (e) { ui.errorFrom(e, `Could not load ${cfg.plural}.`); }
    render();
  }

  function render() {
    toolbar.replaceChildren();
    if (canAdd) toolbar.append(btn(`Add ${cfg.noun.toLowerCase()}`, 'btn-primary', () => openForm(null)));
    const sp = document.createElement('span');
    sp.className = 'spacer';
    toolbar.append(sp, btn('Export to Excel', '', doExport));

    if (!rows.length) { panel.innerHTML = `<p class="muted">No ${esc(cfg.plural)} yet.</p>`; return; }
    const cols = cfg.columns(lk);
    const head = cols.map((c) => `<th${c.num ? ' style="text-align:right"' : ''}>${esc(c.header)}</th>`).join('') + '<th></th>';
    const body = rows.map((r) => {
      const tds = cols.map((c) => `<td${c.num ? ' class="num"' : ''}>${c.html ? c.html(r) : esc(c.text(r))}</td>`).join('');
      const acts = ctx.canEdit
        ? `<div class="row-actions"><button class="btn btn-sm" data-act="edit">Edit</button>${canDelete ? '<button class="btn btn-sm" data-act="del">Delete</button>' : ''}</div>`
        : '';
      return `<tr data-id="${r.id}" class="${r.is_active === false ? 'inactive' : ''}">${tds}<td>${acts}</td></tr>`;
    }).join('');
    panel.innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  async function openForm(row) {
    const isEdit = !!row;
    const blank = (r) => Object.fromEntries(Object.entries(r).map(([k, x]) => [k, x === null ? '' : x]));
    const values = isEdit ? { ...blank(row), ...(cfg.toForm ? cfg.toForm(row, lk) : {}) } : { ...(cfg.defaults || {}) };
    const saved = await ui.form({
      title: `${isEdit ? 'Edit' : 'Add'} ${cfg.noun.toLowerCase()}`,
      fields: cfg.fields(lk, row),
      values,
      onSubmit: async (v) => {
        if (cfg.validate) cfg.validate(v, row, rows);
        const payload = cfg.toPayload ? cfg.toPayload(v, row) : v;
        const q = isEdit
          ? supabase.from(cfg.table).update(payload).eq('id', row.id)
          : supabase.from(cfg.table).insert({ ...payload, company_id: ctx.companyId });
        const { error } = await q;
        if (error) {
          if (error.code === '23505' && cfg.duplicateMessage) throw new Error(cfg.duplicateMessage);
          throw error;
        }
      },
    });
    if (saved) {
      if (isEdit) ui.updated(cfg.noun); else ui.created(cfg.noun);
      await refresh();
    }
  }

  async function doDelete(row) {
    const block = cfg.beforeDelete ? cfg.beforeDelete(row, rows) : '';
    if (block) return ui.warn(block);
    if (!(await ui.confirmDelete(cfg.noun))) return;
    const { error } = await supabase.from(cfg.table).delete().eq('id', row.id);
    if (error) return ui.errorFrom(error);
    ui.deleted(cfg.noun);
    await refresh();
  }

  async function doExport() {
    try {
      const cols = cfg.columns(lk);
      await exportSheets(`${cfg.file || cfg.table}-${new Date().toISOString().slice(0, 10)}.xlsx`, [{
        name: cfg.plural.slice(0, 31),
        rows: rows.map((r) => Object.fromEntries(cols.map((c) => [c.header, c.text(r)]))),
        columns: cols.map((c) => ({ key: c.header, header: c.header, width: c.width || 18 })),
      }]);
    } catch (e) { ui.errorFrom(e, 'Could not export.'); }
  }

  panel.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-act]');
    if (!t || !ctx.canEdit) return;
    const row = rows.find((r) => r.id === t.closest('tr').dataset.id);
    if (!row) return;
    if (t.dataset.act === 'edit') await openForm(row);
    else if (t.dataset.act === 'del' && canDelete) await doDelete(row);
  });

  await refresh();
}