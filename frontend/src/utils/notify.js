// In-page notices, used in place of the browser's alert().
//
// alert() blocks the whole page, cannot be styled, and on a phone covers the
// form the message is about. A notice appears at the bottom of the screen, is
// announced by screen readers (role="alert"), can be dismissed with its button,
// and goes away on its own.

const HOST_ID = 'rp-notices';
const VISIBLE_MS = 6000;
const MAX_NOTICES = 3;

function host() {
  let el = document.getElementById(HOST_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = HOST_ID;
    el.setAttribute('aria-live', 'assertive');
    el.setAttribute('aria-atomic', 'false');
    Object.assign(el.style, {
      position: 'fixed',
      left: '50%',
      bottom: '16px',
      transform: 'translateX(-50%)',
      zIndex: '100000',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      width: 'min(92vw, 420px)',
      pointerEvents: 'none',
    });
    document.body.appendChild(el);
  }
  return el;
}

/**
 * Shows a short message to the user.
 * @param {string} message
 * @param {{ type?: 'error' | 'info' }} [options]
 */
export function notify(message, { type = 'error' } = {}) {
  const text = String(message ?? '').trim();
  if (!text || typeof document === 'undefined') return;

  const container = host();
  while (container.children.length >= MAX_NOTICES) container.firstChild.remove();

  const notice = document.createElement('div');
  notice.setAttribute('role', type === 'error' ? 'alert' : 'status');
  Object.assign(notice.style, {
    pointerEvents: 'auto',
    display: 'flex',
    alignItems: 'flex-start',
    gap: '12px',
    padding: '12px 14px',
    borderRadius: '10px',
    background: '#0f172a',
    color: '#f8fafc',
    borderLeft: `4px solid ${type === 'error' ? '#f87171' : '#38bdf8'}`,
    boxShadow: '0 10px 30px rgba(0, 0, 0, 0.35)',
    font: '14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif',
    whiteSpace: 'pre-line',
    overflowWrap: 'anywhere',
  });

  const body = document.createElement('span');
  body.textContent = text;
  body.style.flex = '1';

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Dismiss message');
  Object.assign(close.style, {
    background: 'transparent',
    border: '0',
    color: '#f8fafc',
    font: 'inherit',
    fontSize: '18px',
    lineHeight: '1',
    cursor: 'pointer',
    padding: '0 2px',
  });

  const remove = () => notice.remove();
  close.addEventListener('click', remove);
  notice.append(body, close);
  container.appendChild(notice);
  setTimeout(remove, VISIBLE_MS);
}
