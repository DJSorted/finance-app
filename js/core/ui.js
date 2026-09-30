// The ONLY way the app talks to the user. Keeps wording and styling identical everywhere.

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

let stackEl;
function getStack() {
  if (!stackEl) {
    stackEl = el('div', 'toast-stack');
    stackEl.setAttribute('aria-live', 'polite');
    document.body.appendChild(stackEl);
  }
  return stackEl;
}

export function toast(message, type = 'info', ms = 3500) {
  const t = el('div', `toast toast-${type}`, message);
  t.setAttribute('role', type === 'error' ? 'alert' : 'status');
  getStack().appendChild(t);
  const remove = () => { t.classList.add('toast-out'); setTimeout(() => t.remove(), 200); };
  t.addEventListener('click', remove);
  setTimeout(remove, ms);
  return t;
}

// Generic dialog. Resolves with the value of the clicked button (or dismissValue on Esc/backdrop).
export function dialog({ title, message, node, buttons, dismissValue = null }) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const backdrop = el('div', 'modal-backdrop');
    const box = el('div', 'modal');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.append(el('h3', 'modal-title', title || ''));
    if (message) box.append(el('p', 'modal-message', message));
    if (node) box.append(node);

    const actions = el('div', 'modal-actions');
    const onKey = (e) => { if (e.key === 'Escape') close(dismissValue); };
    const close = (value) => {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      if (prevFocus && prevFocus.focus) prevFocus.focus();
      resolve(value);
    };
    buttons.forEach((b) => {
      const btn = el('button', `btn ${b.className || ''}`.trim(), b.label);
      btn.type = 'button';
      btn.addEventListener('click', () => close(b.value));
      actions.append(btn);
    });
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(dismissValue); });
    box.append(actions);
    backdrop.append(box);
    document.body.append(backdrop);
    actions.lastElementChild.focus();
  });
}

// Standard form dialog used by every setup screen.
// fields: [{ name, label, type: text|number|select|checkbox|textarea, required, options:[{value,label}], hint, full }]
// onSubmit(values) may throw; the dialog then stays open and shows the error.
// Resolves true when saved, false when cancelled.
function formDialog({ title, fields, values = {}, submitText = 'Save', onSubmit }) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const backdrop = el('div', 'modal-backdrop');
    const box = el('div', 'modal wide');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.append(el('h3', 'modal-title', title));

    const form = el('form');
    form.noValidate = true;
    const grid = el('div', 'form-grid');
    const inputs = {};

    fields.forEach((f) => {
      const wrap = el('div', 'field' + (f.type === 'checkbox' ? ' check' : '') + (f.full ? ' full' : ''));
      const id = `f_${f.name}`;
      let input;
      if (f.type === 'select') {
        input = el('select');
        (f.options || []).forEach((o) => {
          const opt = el('option', '', o.label);
          opt.value = o.value;
          input.append(opt);
        });
        input.value = values[f.name] ?? '';
      } else if (f.type === 'textarea') {
        input = el('textarea');
        input.rows = 2;
        input.value = values[f.name] ?? '';
      } else if (f.type === 'checkbox') {
        input = el('input');
        input.type = 'checkbox';
        input.checked = !!values[f.name];
      } else {
        input = el('input');
        input.type = f.type || 'text';
        input.value = values[f.name] ?? '';
        if (f.placeholder) input.placeholder = f.placeholder;
      }
      input.id = id;
      if (f.disabled) input.disabled = true;
      const label = el('label', '', f.label + (f.required ? ' *' : ''));
      label.htmlFor = id;
      if (f.type === 'checkbox') wrap.append(input, label); else wrap.append(label, input);
      if (f.hint) wrap.append(el('span', 'hint', f.hint));
      inputs[f.name] = input;
      grid.append(wrap);
    });

    const actions = el('div', 'modal-actions');
    const cancel = el('button', 'btn btn-ghost', 'Cancel');
    cancel.type = 'button';
    const save = el('button', 'btn btn-primary', submitText);
    save.type = 'submit';
    actions.append(cancel, save);
    form.append(grid, actions);
    box.append(form);
    backdrop.append(box);
    document.body.append(backdrop);

    const onKey = (e) => { if (e.key === 'Escape') close(false); };
    const close = (v) => {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      if (prevFocus && prevFocus.focus) prevFocus.focus();
      resolve(v);
    };
    document.addEventListener('keydown', onKey);
    cancel.addEventListener('click', () => close(false));
    // Clicking outside does not close a form, so typed data is never lost by accident.

    const read = () => {
      const out = {};
      fields.forEach((f) => {
        const i = inputs[f.name];
        if (f.type === 'checkbox') out[f.name] = i.checked;
        else if (f.type === 'number') out[f.name] = i.value === '' ? null : Number(i.value);
        else out[f.name] = i.value.trim();
      });
      return out;
    };

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = read();
      for (const f of fields) {
        if (f.required && (v[f.name] === '' || v[f.name] === null)) {
          toast(`${f.label} is required.`, 'warn', 5000);
          inputs[f.name].focus();
          return;
        }
      }
      save.disabled = true;
      try {
        await onSubmit(v);
        close(true);
      } catch (err) {
        save.disabled = false;
        ui.errorFrom(err, 'Could not save.');
      }
    });

    const first = form.querySelector('input:not([type=checkbox]):not(:disabled), select:not(:disabled), textarea');
    if (first) first.focus();
  });
}

export const ui = {
  toast,
  dialog,
  form: formDialog,
  success: (m) => toast(m, 'success'),
  info: (m) => toast(m, 'info'),
  warn: (m) => toast(m, 'warn', 5000),
  error: (m) => toast(m, 'error', 6000),
  errorFrom(err, fallback = 'Something went wrong.') {
    console.error(err);
    let msg = (err && err.message) || fallback;
    if (err && err.code === '23505') msg = 'That code is already in use.';
    if (err && err.code === '23503') msg = 'This record is in use elsewhere, so that change is not allowed.';
    if (err && err.code === '42501') msg = 'You do not have permission to do that.';
    return toast(msg, 'error', 6000);
  },

  // Standard wording, used by every page
  saved: (what) => toast(`${what} saved.`, 'success'),
  created: (what) => toast(`${what} created.`, 'success'),
  updated: (what) => toast(`${what} updated.`, 'success'),
  deleted: (what) => toast(`${what} deleted.`, 'success'),

  confirm({ title = 'Please confirm', message, confirmText = 'Confirm', cancelText = 'Cancel', danger = false }) {
    return dialog({
      title, message, dismissValue: false,
      buttons: [
        { label: cancelText, value: false, className: 'btn-ghost' },
        { label: confirmText, value: true, className: danger ? 'btn-danger' : 'btn-primary' },
      ],
    });
  },
  confirmDelete(what) {
    return ui.confirm({
      title: `Delete ${what}`,
      message: `Delete this ${what.toLowerCase()}? This cannot be undone.`,
      confirmText: 'Delete', danger: true,
    });
  },
  alert({ title = 'Notice', message, okText = 'OK' }) {
    return dialog({ title, message, dismissValue: true, buttons: [{ label: okText, value: true, className: 'btn-primary' }] });
  },
};