// Notices (banners that fade after 6 seconds and stay listed in the details panel) and dialogs.

import { $, el, icon } from './dom.js';

export class Notices {
  constructor(container) {
    this.container = container;
    this.log = [];
    this.onChange = () => {};
  }

  /** level: 'notice' (something the movie can play around) or 'info' */
  show(text, { level = 'notice', duration = 6000, key = null } = {}) {
    if (key && this.log.some((n) => n.key === key)) return;
    const entry = { text, level, key, at: new Date() };
    this.log.push(entry);
    this.onChange();
    const node = el('div.notice' + (level === 'info' ? '.info' : ''), { role: 'status' },
      icon(level === 'info' ? 'info' : 'alert'),
      el('div.text', { text }),
      el('button', { 'aria-label': 'Dismiss', onclick: () => remove() }, icon('close')));
    const remove = () => {
      node.classList.add('hide');
      setTimeout(() => node.remove(), 300);
    };
    this.container.append(node);
    while (this.container.children.length > 3) this.container.firstElementChild.remove();
    if (duration) setTimeout(remove, duration);
  }

  clear() {
    this.log = [];
    this.container.innerHTML = '';
    this.onChange();
  }
}

/** Shows the modal dialog. actions: [{label, primary, onClick}]. Returns a close function. */
export function showDialog({ iconName = 'alert', title, body, actions = [], dismissable = true }) {
  const back = $('#dialog');
  $('#dialog-icon').replaceChildren(icon(iconName));
  $('#dialog-title').textContent = title;
  const b = $('#dialog-body');
  b.replaceChildren(...(Array.isArray(body) ? body : [body]).filter(Boolean).map((x) => (typeof x === 'string' ? el('p', { text: x }) : x)));
  const close = () => { back.hidden = true; back.onclick = null; document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape' && dismissable) { e.stopPropagation(); close(); } };
  $('#dialog-actions').replaceChildren(...actions.map((a) => el('button.btn' + (a.primary ? '.primary' : ''), {
    text: a.label,
    onclick: () => { close(); a.onClick && a.onClick(); },
  })));
  back.onclick = (e) => { if (e.target === back && dismissable) close(); };
  document.addEventListener('keydown', onKey, true);
  back.hidden = false;
  const first = $('#dialog-actions button.primary') || $('#dialog-actions button');
  if (first) first.focus();
  return close;
}
