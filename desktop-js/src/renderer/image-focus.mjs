// 放大时保留原图片及交互控件，避免重新映射红圈和拖动坐标。
export function setupImageFocus({ element, state, documentRef = document }) {
  let active = null;

  function close() {
    if (!active) return;
    const { card, button } = active;
    active = null;
    card.classList.remove('focus-view');
    card.removeAttribute('role');
    card.removeAttribute('aria-modal');
    card.removeAttribute('aria-label');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-label', `放大${button.dataset.focusLabel}`);
    button.textContent = '放大';
    documentRef.body.classList.remove('focus-active');
    button.focus({ preventScroll: true });
  }

  documentRef.querySelectorAll('[data-focus-target]').forEach((button) => {
    button.addEventListener('click', () => {
      if (state.busy) return;
      if (active?.button === button) {
        close();
        return;
      }
      close();
      const card = element(button.dataset.focusTarget);
      if (!card) return;
      active = { card, button };
      card.classList.add('focus-view');
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-modal', 'true');
      card.setAttribute('aria-label', `放大查看${button.dataset.focusLabel}`);
      button.setAttribute('aria-expanded', 'true');
      button.setAttribute('aria-label', `退出放大的${button.dataset.focusLabel}`);
      button.textContent = '退出放大';
      documentRef.body.classList.add('focus-active');
      button.focus({ preventScroll: true });
    });
  });

  documentRef.addEventListener('keydown', (event) => {
    if (!active || element('table-dialog').open || element('species-preview-dialog').open) return;
    if (event.key === 'Escape' && !state.busy) {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [
      ...active.card.querySelectorAll(
        'button:not(:disabled), summary, input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((node) => node.getClientRects().length && !node.closest('[hidden]'));
    if (!focusable.length) {
      event.preventDefault();
      return;
    }
    const index = focusable.indexOf(documentRef.activeElement);
    if (index < 0 || (!event.shiftKey && index === focusable.length - 1)) {
      event.preventDefault();
      focusable[0].focus();
    } else if (event.shiftKey && index === 0) {
      event.preventDefault();
      focusable[focusable.length - 1].focus();
    }
  });
}
