// Column filters for list tables. A page opts in through FILTER_PAGES in shell.js.
// Adds a filter row under the headers (text, pick-list, date range or number range, chosen from the data)
// and keeps the filters when the page redraws its table.

const kept = new WeakMap();

function parseNum(t) {
  let s = String(t).replace(/[\s\u00a0]/g, '').replace(/[^\d.,()\-]/g, '');
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s) || s.startsWith('-');
  s = s.replace(/[()\-]/g, '');
  const dot = s.lastIndexOf('.');
  const comma = s.lastIndexOf(',');
  if (dot >= 0 && comma >= 0) s = comma > dot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (comma >= 0) s = /,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

function attach(container, table) {
  if (table.dataset.tf) return;
  const body = table.tBodies[0];
  if (!table.tHead || !body) return;
  const rows = [...body.rows].filter((r) => !r.classList.contains('row-root') && !r.classList.contains('row-parent') && r.cells.length > 2);
  if (rows.length < 8) return;
  table.dataset.tf = '1';

  const state = kept.get(container) || new Map();
  kept.set(container, state);
  const heads = [...table.tHead.rows[0].cells];
  const filterRow = document.createElement('tr');
  filterRow.className = 'filter-row';
  const tests = [];
  const resets = [];

  const control = (tag, type, placeholder, key, evt) => {
    const e = document.createElement(tag);
    if (type) e.type = type;
    if (placeholder) e.placeholder = placeholder;
    e.value = state.get(key) || '';
    e.addEventListener(evt, () => { state.set(key, e.value); apply(); });
    resets.push(() => { e.value = ''; state.delete(key); });
    return e;
  };

  heads.forEach((th, i) => {
    const cell = document.createElement('th');
    filterRow.append(cell);
    const label = th.textContent.trim();
    if (!label) return;
    const key = `${i}:${label}`;
    const texts = rows.map((r) => (r.cells[i] ? r.cells[i].textContent.trim() : ''));
    const filled = texts.filter(Boolean);
    if (!filled.length) return;
    const numeric = rows.some((r) => r.cells[i] && r.cells[i].classList.contains('num')) && filled.every((v) => parseNum(v) !== null);
    const dated = !numeric && filled.every((v) => /^\d{4}-\d{2}-\d{2}/.test(v));
    const distinct = [...new Set(filled)];
    const pick = !numeric && !dated && distinct.length >= 2 && distinct.length <= 12 && distinct.length <= filled.length / 2;

    if (numeric) {
      const a = control('input', 'number', 'min', `${key}:a`, 'input');
      const b = control('input', 'number', 'max', `${key}:b`, 'input');
      a.step = 'any';
      b.step = 'any';
      cell.append(a, b);
      tests.push((r) => {
        const lo = state.get(`${key}:a`);
        const hi = state.get(`${key}:b`);
        if (!lo && !hi) return true;
        const n = parseNum(r.cells[i].textContent);
        if (n === null) return false;
        return (!lo || n >= Number(lo)) && (!hi || n <= Number(hi));
      });
    } else if (dated) {
      cell.append(control('input', 'date', '', `${key}:a`, 'input'), control('input', 'date', '', `${key}:b`, 'input'));
      tests.push((r) => {
        const lo = state.get(`${key}:a`);
        const hi = state.get(`${key}:b`);
        if (!lo && !hi) return true;
        const d = r.cells[i].textContent.trim().slice(0, 10);
        return (!lo || d >= lo) && (!hi || d <= hi);
      });
    } else if (pick) {
      const s = control('select', '', '', key, 'change');
      const all = document.createElement('option');
      all.value = '';
      all.textContent = 'All';
      s.append(all);
      distinct.sort().forEach((v) => { const o = document.createElement('option'); o.value = v; o.textContent = v; s.append(o); });
      s.value = state.get(key) || '';
      cell.append(s);
      tests.push((r) => { const v = state.get(key); return !v || r.cells[i].textContent.trim() === v; });
    } else {
      cell.append(control('input', 'search', 'Filter', key, 'input'));
      tests.push((r) => {
        const v = (state.get(key) || '').trim().toLowerCase();
        if (!v) return true;
        const t = r.cells[i].textContent.toLowerCase();
        return v.split(/\s+/).every((w) => t.includes(w));
      });
    }
  });

  table.tHead.append(filterRow);
  const bar = document.createElement('div');
  bar.className = 'filter-count muted';
  const text = document.createElement('span');
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'btn btn-sm btn-ghost';
  clear.textContent = 'Clear filters';
  clear.addEventListener('click', () => { resets.forEach((f) => f()); apply(); });
  bar.append(text, clear);
  (table.closest('.table-wrap') || table).before(bar);

  function apply() {
    let shown = 0;
    rows.forEach((r) => {
      const ok = tests.every((t) => t(r));
      r.hidden = !ok;
      if (ok) shown++;
    });
    text.textContent = shown === rows.length ? `${rows.length} rows` : `Showing ${shown} of ${rows.length} rows`;
    clear.hidden = ![...state.values()].some((v) => v);
  }
  apply();
}

export function watchTableFilters(container) {
  let timer;
  const run = () => {
    obs.disconnect();
    try { container.querySelectorAll('table.grid').forEach((t) => attach(container, t)); }
    finally { obs.observe(container, { childList: true, subtree: true }); }
  };
  const obs = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(run, 30); });
  run();
}