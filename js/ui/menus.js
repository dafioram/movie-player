// Popover menus that open above the control-bar buttons.

import { el, icon } from './dom.js';

export class MenuHost {
  constructor(node, appNode) {
    this.node = node;
    this.appNode = appNode;
    this.current = null;
    this.onClose = () => {};
    document.addEventListener('pointerdown', (e) => {
      if (!this.current) return;
      if (this.node.contains(e.target) || this.current.anchor.contains(e.target)) return;
      this.close();
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.current) { e.stopPropagation(); this.close(); this.current?.anchor.focus(); }
    }, true);
    window.addEventListener('resize', () => this.close());
  }

  get openName() {
    return this.current ? this.current.name : null;
  }

  toggle(name, anchor, build) {
    if (this.current && this.current.name === name) { this.close(); return; }
    this.open(name, anchor, build);
  }

  open(name, anchor, build) {
    this.close();
    this.current = { name, anchor, build };
    anchor.classList.add('active');
    this.appNode.classList.add('menu-open');
    this.refresh();
    this.node.hidden = false;
    this._position();
    const first = this.node.querySelector('.menu-item.selected, .menu-item:not(.disabled), button');
    if (first) first.focus({ preventScroll: true });
  }

  refresh() {
    if (!this.current) return;
    const scroll = this.node.scrollTop;
    this.node.replaceChildren();
    this.current.build(this);
    this.node.scrollTop = scroll;
    this._position();
  }

  _position() {
    const a = this.current.anchor.getBoundingClientRect();
    const m = this.node.getBoundingClientRect();
    const right = Math.max(12, window.innerWidth - a.right - 4);
    const left = window.innerWidth - right - m.width;
    this.node.style.right = (left < 12 ? window.innerWidth - m.width - 12 : right) + 'px';
    this.node.style.left = 'auto';
    this.node.style.bottom = window.innerHeight - a.top + 10 + 'px';
  }

  close() {
    if (!this.current) return;
    this.current.anchor.classList.remove('active');
    this.current = null;
    this.node.hidden = true;
    this.node.replaceChildren();
    this.appNode.classList.remove('menu-open');
    this.onClose();
  }

  /* ---------- builders ---------- */

  heading(text) {
    this.node.append(el('h3', { text }));
  }

  separator() {
    this.node.append(el('hr'));
  }

  hint(text) {
    this.node.append(el('div.hint', { text }));
  }

  item({ label, sub = null, aside = null, selected = false, disabled = false, title = null, onClick, keepOpen = false }) {
    const b = el('button.menu-item' + (selected ? '.selected' : '') + (disabled ? '.disabled' : ''), {
      role: 'menuitemradio', 'aria-checked': selected ? 'true' : 'false', 'aria-disabled': disabled ? 'true' : null, title,
    },
    icon('check', 'check'),
    el('span.label', {}, label, sub ? el('span.sub', { text: sub }) : null),
    aside ? el('span.aside', { text: aside }) : el('span'));
    b.addEventListener('click', () => {
      if (disabled) return;
      if (!keepOpen) this.close();
      onClick && onClick();
      if (keepOpen) this.refresh();
    });
    this.node.append(b);
    return b;
  }

  row(name, control) {
    this.node.append(el('div.menu-row', {}, el('span.name', { text: name }), control));
  }

  stepper(text, onDec, onInc, label) {
    return el('span.stepper', { role: 'group', 'aria-label': label || '' },
      el('button', { 'aria-label': 'Decrease', text: '−', onclick: () => { onDec(); this.refresh(); } }),
      el('output', { text }),
      el('button', { 'aria-label': 'Increase', text: '+', onclick: () => { onInc(); this.refresh(); } }));
  }

  switch(on, onToggle, label) {
    return el('button.switch', { role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': label || '', onclick: () => { onToggle(!on); this.refresh(); } });
  }

  select(options, value, onChange, label) {
    const s = el('select', { 'aria-label': label || '' }, ...options.map(([v, t]) => el('option', { value: v, text: t, selected: v === value })));
    s.addEventListener('change', () => onChange(s.value));
    return s;
  }
}
