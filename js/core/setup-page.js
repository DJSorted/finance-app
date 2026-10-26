import { supabase } from './supabase.js';
import { ui } from './ui.js';
import { exportSheets } from './export.js';
import { openSetupImport, hasImport } from './setup-import.js';
import { openAttachmentsDialog, TABLE_LABELS, clipCell, clipHead, fillClips } from './attachments.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function btn(text, cls, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `btn ${cls}`.trim();
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

function link(text, href, cls = '') {
  const a = document.createElement('a');
  a.className = `btn ${cls}`.trim();
  a.textContent = text;
  a.href = href;
  return a;
}

// One standard list + add/edit/delete + export screen for a setup table.
// cfg: { table, noun, plural, file, hint, orderBy, defaults, canAdd, canDelete, search,
//        lookups(ctx), columns(lk), fields(lk, row), toForm(row, lk), validate(v, row, rows), toPayload(v, row),
//        beforeDelete(row, rows), duplicateMessage,
//        toolbarLinks: [{ text, href, editOnly }]       extra buttons in the toolbar that open another page
//        rowLinks: [{ text, href(row) }]                extra buttons on each row (shown to people who can edit)
//        toolbarButtons: [{ text, onClick({ rows, lk, refresh }), editOnly }]   extra toolbar buttons that run code
//        rowButtons: [{ text, onClick(row, { rows, lk, refresh }), show(row), editOnly }]   extra row buttons that run code
//        attach: false,                                 turns off the Attach button (on by default for tables that can hold attachments)
//        formCols: 3,                                   a wider three-column add/edit dialog for long forms
//        detail: async (row, { lk, ctx }) => html }     list + detail layout: the list scrolls on top and the selected
//                                                       record shows in a panel below (html must escape its own output)
// Every column needs header and text(row); html(row) is optional and must escape its own output.
export async function setupPage(ctx, cfg) {
  const toolbar = document.getElementById('toolbar');
  const hint = document.getElementById('hint');
  const panel = document.getElementById('panel');
  document.getElementById('company-title').textContent = ctx.company.name;
  hint.textContent = cfg.hint || '';

  const canAdd = ctx.canEdit && cfg.canAdd !== false;
  const canDelete = ctx.canEdit && cfg.canDelete !== false;
  const canAttach = cfg.attach !== false && !!TABLE_LABELS[cfg.table];
  let rows = [];
  let lk = {};
  let term = '';

  // List + detail layout: the detail card sits under the list card
  let selectedId = null;
  let detailEl = null;
  let detailToken = 0;
  if (cfg.detail) {
    panel.classList.add('md-list');
    detailEl = document.createElement('div');
    detailEl.className = 'card md-detail';
    panel.after(detailEl);
  }

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

  function render() { renderToolbar(); renderTable(); }

  function renderToolbar() {
    toolbar.replaceChildren();
    if (canAdd) toolbar.append(btn(`Add ${cfg.noun.toLowerCase()}`, 'btn-primary', () => openForm(null)));
    (cfg.toolbarLinks || [])
      .filter((l) => !l.editOnly || ctx.canEdit)
      .forEach((l) => toolbar.append(link(l.text, l.href)));
    (cfg.toolbarButtons || [])
      .filter((b) => !b.editOnly || ctx.canEdit)
      .forEach((b) => toolbar.append(btn(b.text, '', () => b.onClick({ rows, lk, refresh }))));
    if (cfg.search) {
      const box = document.createElement('input');
      box.type = 'search';
      box.placeholder = 'Search';
      box.value = term;
      box.style.maxWidth = '260px';
      box.addEventListener('input', () => { term = box.value.trim().toLowerCase(); renderTable(); });
      toolbar.append(box);
    }
    const sp = document.createElement('span');
    sp.className = 'spacer';
    toolbar.append(sp);
    if (ctx.canEdit && hasImport(cfg.table)) {
      toolbar.append(btn('Import', '', () => openSetupImport({ ctx, cfg, lk, rows, onDone: refresh })));
    }
    toolbar.append(btn('Export to Excel', '', doExport));
  }

  function visibleRows() {
    if (!term) return rows;
    const cols = cfg.columns(lk);
    return rows.filter((r) => cols.some((c) => String(c.text(r)).toLowerCase().includes(term)));
  }

  function renderTable() {
    if (!rows.length) { panel.innerHTML = `<p class="muted">No ${esc(cfg.plural)} yet.</p>`; selectRow(null); return; }
    const list = visibleRows();
    if (!list.length) { panel.innerHTML = '<p class="muted">Nothing matches your search.</p>'; selectRow(null); return; }
    const cols = cfg.columns(lk);
    const head = cols.map((c) => `<th${c.num ? ' style="text-align:right"' : ''}>${esc(c.header)}</th>`).join('') + (canAttach ? clipHead : '') + '<th></th>';
    const body = list.map((r) => {
      const tds = cols.map((c) => `<td${c.num ? ' class="num"' : ''}>${c.html ? c.html(r) : esc(c.text(r))}</td>`).join('');
      const attachBtn = canAttach ? '<button class="btn btn-sm" data-act="attach">Attach</button>' : '';
      const extra = (ctx.canEdit ? (cfg.rowLinks || []).map((l) => `<a class="btn btn-sm" href="${esc(l.href(r))}">${esc(l.text)}</a>`).join('') : '')
        + (cfg.rowButtons || []).map((b, i) => ((!b.editOnly || ctx.canEdit) && (!b.show || b.show(r))
          ? `<button class="btn btn-sm" data-act="rb${i}">${esc(b.text)}</button>` : '')).join('');
      const editBtns = ctx.canEdit
        ? `<button class="btn btn-sm" data-act="edit">Edit</button>${canDelete ? '<button class="btn btn-sm" data-act="del">Delete</button>' : ''}`
        : '';
      const acts = attachBtn || extra || editBtns ? `<div class="row-actions">${extra}${attachBtn}${editBtns}</div>` : '';
      return `<tr data-id="${r.id}" class="${r.is_active === false ? 'inactive' : ''}">${tds}${canAttach ? clipCell(cfg.table, r.id) : ''}<td>${acts}</td></tr>`;
    }).join('');
    panel.innerHTML = `<div class="table-wrap"><table class="grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
    if (cfg.detail) selectRow(list.some((r) => r.id === selectedId) ? selectedId : list[0].id, false);
    if (canAttach) {
      fillClips(ctx, panel, (id) => {
        const row = rows.find((r) => r.id === id);
        const name = row ? [row.code, row.name].filter(Boolean).join(' - ') : '';
        return `Attachments: ${cfg.noun}${name ? ` ${name}` : ''}`;
      });
    }
  }

  // Highlights a row in the list and shows it in the detail panel
  async function selectRow(id, scroll = true) {
    if (!cfg.detail) return;
    selectedId = id;
    panel.querySelectorAll('tr.selected').forEach((tr) => tr.classList.remove('selected'));
    const row = rows.find((r) => r.id === id);
    if (!row) { detailEl.innerHTML = '<p class="muted">Select a record above to see its details.</p>'; delete detailEl.dataset.id; return; }
    const tr = panel.querySelector(`tr[data-id="${id}"]`);
    if (tr) { tr.classList.add('selected'); if (scroll) tr.scrollIntoView({ block: 'nearest' }); }

    const token = ++detailToken;
    const rb = (cfg.rowButtons || []).map((b, i) => ((!b.editOnly || ctx.canEdit) && (!b.show || b.show(row))
      ? `<button class="btn btn-sm" data-act="rb${i}">${esc(b.text)}</button>` : '')).join('');
    const acts = `<div class="row-actions md-actions">${rb}${canAttach ? '<button class="btn btn-sm" data-act="attach">Attach</button>' : ''}`
      + `${ctx.canEdit ? `<button class="btn btn-sm btn-primary" data-act="edit">Edit</button>${canDelete ? '<button class="btn btn-sm" data-act="del">Delete</button>' : ''}` : ''}</div>`;
    detailEl.dataset.id = id;
    if (!detailEl.innerHTML.trim()) detailEl.innerHTML = '<p class="muted">Loading...</p>';
    let html;
    try { html = await cfg.detail(row, { lk, ctx }); } catch (e) { html = `<p class="muted">Could not load the details: ${esc(e.message || e)}</p>`; }
    if (token !== detailToken) return;                       // a newer selection has started
    detailEl.innerHTML = html + acts;
  }

  async function openForm(row) {
    const isEdit = !!row;
    const blank = (r) => Object.fromEntries(Object.entries(r).map(([k, x]) => [k, x === null ? '' : x]));
    const values = isEdit ? { ...blank(row), ...(cfg.toForm ? cfg.toForm(row, lk) : {}) } : { ...(cfg.defaults || {}) };
    const saved = await ui.form({
      title: `${isEdit ? 'Edit' : 'Add'} ${cfg.noun.toLowerCase()}`,
      fields: cfg.fields(lk, row),
      values,
      cols: cfg.formCols,
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

  async function onAction(e) {
    const t = e.target.closest('[data-act]');
    if (!t) {
      // List + detail: clicking anywhere else on a row selects it
      const tr = cfg.detail && e.currentTarget === panel && !e.target.closest('a, button, input, select, label') ? e.target.closest('tr[data-id]') : null;
      if (tr) selectRow(tr.dataset.id, false);
      return;
    }
    const holder = t.closest('[data-id]');
    const row = holder && rows.find((r) => r.id === holder.dataset.id);
    if (!row) return;
    if (t.dataset.act === 'attach' && canAttach) {
      const name = [row.code, row.name].filter(Boolean).join(' - ');
      await openAttachmentsDialog(ctx, { table: cfg.table, recordId: row.id, title: `Attachments: ${cfg.noun}${name ? ` ${name}` : ''}` });
      return;
    }
    const rb = /^rb(\d+)$/.exec(t.dataset.act);
    if (rb) {
      const b = (cfg.rowButtons || [])[Number(rb[1])];
      if (b && (!b.editOnly || ctx.canEdit)) await b.onClick(row, { rows, lk, refresh });
      return;
    }
    if (!ctx.canEdit) return;
    if (t.dataset.act === 'edit') await openForm(row);
    else if (t.dataset.act === 'del' && canDelete) await doDelete(row);
  }
  panel.addEventListener('click', onAction);

  if (cfg.detail) {
    detailEl.addEventListener('click', onAction);
    // Up / down arrows move through the list when you are not typing
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const a = document.activeElement || {};
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName || '') || a.isContentEditable || document.querySelector('.modal-backdrop, dialog[open]')) return;
      const trs = [...panel.querySelectorAll('tr[data-id]')].filter((tr) => tr.offsetParent !== null);
      if (!trs.length) return;
      e.preventDefault();
      const i = trs.findIndex((tr) => tr.dataset.id === selectedId);
      const next = trs[Math.max(0, Math.min(trs.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      selectRow(next.dataset.id);
    });
  }

  await refresh();
}