/**
 * confirm-modal.js — shared promise-based confirmation modal
 * Usage: const ok = await showConfirmModal({ title, body, confirmLabel, cancelLabel, danger });
 * Returns true if user confirmed, false if cancelled/dismissed.
 */

let _cssInjected = false;

function injectCSS() {
  if (_cssInjected) return;
  _cssInjected = true;
  const style = document.createElement('style');
  style.textContent = `
.cm-overlay {
  position: fixed; inset: 0; z-index: 99999;
  background: rgba(0,0,0,.45);
  display: flex; align-items: center; justify-content: center;
  animation: cm-fadein .15s ease;
}
@keyframes cm-fadein { from { opacity: 0 } to { opacity: 1 } }
.cm-dialog {
  background: var(--color-surface, #fff);
  border: 1px solid var(--color-border, #e5e7eb);
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0,0,0,.18), 0 2px 8px rgba(0,0,0,.10);
  width: min(420px, 92vw);
  padding: 24px 24px 20px;
  animation: cm-slidein .15s ease;
}
@keyframes cm-slidein { from { transform: translateY(-8px); opacity: 0 } to { transform: none; opacity: 1 } }
.cm-title {
  font-size: 15px; font-weight: 600;
  color: var(--color-text, #111);
  margin: 0 0 10px;
}
.cm-body {
  font-size: 13px; line-height: 1.55;
  color: var(--color-text-muted, #6b7280);
  margin: 0 0 20px;
  white-space: pre-wrap;
}
.cm-actions {
  display: flex; justify-content: flex-end; gap: 8px;
}
.cm-btn {
  padding: 7px 16px; border-radius: 7px;
  font-size: 13px; font-weight: 500;
  cursor: pointer; border: none; outline: none;
  transition: opacity .1s, box-shadow .1s;
}
.cm-btn:focus-visible {
  box-shadow: 0 0 0 3px rgba(93,46,140,.35);
}
.cm-btn-cancel {
  background: var(--color-bg-subtle, #f3f4f6);
  color: var(--color-text, #111);
  border: 1px solid var(--color-border, #e5e7eb);
}
.cm-btn-cancel:hover { background: var(--color-border, #e5e7eb); }
.cm-btn-confirm {
  background: var(--color-primary, #5D2E8C);
  color: #fff;
}
.cm-btn-confirm:hover { opacity: .88; }
.cm-btn-confirm.cm-danger {
  background: var(--color-danger, #dc2626);
}
`;
  document.head.appendChild(style);
}

export function showConfirmModal({
  title = 'Are you sure?',
  body = '',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
} = {}) {
  injectCSS();

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'cm-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'cm-title');

    const dialog = document.createElement('div');
    dialog.className = 'cm-dialog';

    const titleEl = document.createElement('p');
    titleEl.className = 'cm-title';
    titleEl.id = 'cm-title';
    titleEl.textContent = title;

    const bodyEl = document.createElement('p');
    bodyEl.className = 'cm-body';
    bodyEl.textContent = body;

    const actions = document.createElement('div');
    actions.className = 'cm-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'cm-btn cm-btn-cancel';
    cancelBtn.textContent = cancelLabel;

    const confirmBtn = document.createElement('button');
    confirmBtn.className = `cm-btn cm-btn-confirm${danger ? ' cm-danger' : ''}`;
    confirmBtn.textContent = confirmLabel;

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    dialog.appendChild(titleEl);
    if (body) dialog.appendChild(bodyEl);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);

    function close(result) {
      document.removeEventListener('keydown', onKeyDown);
      overlay.remove();
      resolve(result);
    }

    function onKeyDown(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
      // For non-danger modals, Enter on the overlay (not inside a button) confirms.
      if (!danger && e.key === 'Enter' && e.target === document.body) {
        e.preventDefault();
        close(true);
      }
    }

    cancelBtn.addEventListener('click', () => close(false));
    confirmBtn.addEventListener('click', () => close(true));
    // Clicking the backdrop (but not the dialog) cancels
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });

    document.addEventListener('keydown', onKeyDown);
    document.body.appendChild(overlay);

    // Focus: danger → Cancel (safer default), else → Confirm
    (danger ? cancelBtn : confirmBtn).focus();
  });
}
