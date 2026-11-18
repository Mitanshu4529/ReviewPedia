import { useEffect, useRef } from 'react';

/**
 * Props that make a non-button element (div, span, a without href) usable from
 * the keyboard: focusable, announced as a button, activated by Enter or Space.
 *
 *   <div {...pressable(() => navigate('/profile'))}>My Profile</div>
 */
export const pressable = (onActivate) => ({
  role: 'button',
  tabIndex: 0,
  onClick: onActivate,
  onKeyDown: (e) => {
    if (e.target !== e.currentTarget) return; // a key pressed inside a nested control
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onActivate(e);
    }
  }
});

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

// Open dialogs, innermost last. Only the top one reacts to the keyboard, so
// Escape in a confirmation shown over another dialog closes just that one.
const openDialogs = [];

/**
 * Keyboard behaviour for a modal dialog:
 *  - focus moves into the dialog when it opens and back to where it was on close
 *  - Tab / Shift+Tab stay inside the dialog
 *  - Escape calls onClose
 *
 * Put the returned ref on the dialog element and give it role="dialog",
 * aria-modal="true" and tabIndex={-1}.
 */
export function useModalA11y(onClose, active = true) {
  const ref = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!active) return undefined;
    const container = ref.current;
    if (!container) return undefined;

    const token = {};
    openDialogs.push(token);
    const previouslyFocused = document.activeElement;

    const focusable = () => Array.from(container.querySelectorAll(FOCUSABLE))
      .filter(el => el.getClientRects().length > 0);

    if (!container.contains(document.activeElement)) {
      const first = focusable()[0];
      (first || container).focus({ preventScroll: true });
    }

    const onKeyDown = (e) => {
      if (openDialogs[openDialogs.length - 1] !== token) return;
      if (e.key === 'Escape') {
        if (onCloseRef.current) {
          e.stopPropagation();
          onCloseRef.current();
        }
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) {
        e.preventDefault();
        container.focus({ preventScroll: true });
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const inside = container.contains(document.activeElement);
      if (e.shiftKey && (!inside || document.activeElement === first || document.activeElement === container)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      const index = openDialogs.indexOf(token);
      if (index !== -1) openDialogs.splice(index, 1);
      if (previouslyFocused && typeof previouslyFocused.focus === 'function' && document.contains(previouslyFocused)) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, [active]);

  return ref;
}
