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

export const ui = {
  toast,
  dialog,
  success: (m) => toast(m, 'success'),
  info: (m) => toast(m, 'info'),
  warn: (m) => toast(m, 'warn', 5000),
  error: (m) => toast(m, 'error', 6000),
  errorFrom(err, fallback = 'Something went wrong.') {
    console.error(err);
    return toast((err && err.message) || fallback, 'error', 6000);
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