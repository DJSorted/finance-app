// A reusable allocation grid.
// items: [{ id, doc_no, doc_date, due_date, outstanding, fx_rate, ... }]; any extra fields are kept on the item.
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n, d = 2) => Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const roundTo = (n, d) => { const f = 10 ** d; return Math.round((n + Number.EPSILON) * f) / f; };

export function createAllocationGrid({
  onChange = () => {},
  firstHeader = 'Invoice',
  emptyText = 'No open invoices in this currency for this customer.',
  autoLabel = 'Allocate oldest first',
} = {}) {
  let items = [];
  let total = 0;
  let dec = 2;
  const inputs = new Map();

  const node = el('div');
  const bar = el('div', 'toolbar');
  const autoBtn = el('button', 'btn btn-sm', autoLabel);
  const clearBtn = el('button', 'btn btn-sm', 'Clear');
  autoBtn.type = 'button';
  clearBtn.type = 'button';
  bar.append(autoBtn, clearBtn);

  const wrap = el('div', 'lines-wrap');
  const table = el('table', 'lines-table');
  table.style.minWidth = '560px';
  table.innerHTML = `<thead><tr><th>${esc(firstHeader)}</th><th>Date</th><th>Due</th><th style="text-align:right">Outstanding</th><th>Apply</th></tr></thead>`;
  const tbody = el('tbody');
  table.append(tbody);
  wrap.append(table);
  node.append(bar, wrap);

  function render() {
    tbody.replaceChildren();
    inputs.clear();
    if (!items.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="muted">${esc(emptyText)}</td></tr>`;
      return;
    }
    items.forEach((it) => {
      const tr = el('tr');
      tr.innerHTML = `<td>${esc(it.doc_no)}</td><td>${esc(it.doc_date)}</td><td>${esc(it.due_date)}</td>
        <td class="num">${money(it.outstanding, dec)}</td>`;
      const td = el('td');
      const inp = el('input');
      inp.type = 'number';
      inp.step = 'any';
      inp.min = '0';
      inp.addEventListener('input', () => {
        if (Number(inp.value) > it.outstanding) inp.value = String(roundTo(it.outstanding, dec));
        onChange();
      });
      td.append(inp);
      tr.append(td);
      tbody.append(tr);
      inputs.set(it.id, inp);
    });
  }

  autoBtn.addEventListener('click', () => {
    let left = total;
    items.forEach((it) => {
      const v = Math.min(it.outstanding, left);
      inputs.get(it.id).value = v > 0 ? String(roundTo(v, dec)) : '';
      left = roundTo(left - Math.max(v, 0), dec);
    });
    onChange();
  });
  clearBtn.addEventListener('click', () => { inputs.forEach((i) => { i.value = ''; }); onChange(); });

  const detailed = () => items
    .map((it) => ({ item: it, amount: roundTo(Number((inputs.get(it.id) || {}).value) || 0, dec) }))
    .filter((x) => x.amount > 0);

  return {
    node,
    setItems(list, decimals) {
      dec = decimals;
      items = [...list].sort((a, b) => (a.doc_date + a.doc_no).localeCompare(b.doc_date + b.doc_no));
      render();
    },
    setTotal(t) { total = t; },
    detailed,
    allocations: () => detailed().map((x) => ({ invoice_id: x.item.id, amount: x.amount })),
  };
}