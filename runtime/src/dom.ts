/**
 * Tiny DOM helpers. Text is always set with textContent and styles through
 * CSSOM (never style attributes or innerHTML), which keeps the runtime safe
 * under a strict Content-Security-Policy.
 */

type Child = Node | string | number | null | undefined | false;

export interface Props {
  class?: string;
  text?: string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  style?: Record<string, string>;
  on?: Partial<Record<keyof HTMLElementEventMap, (e: Event) => void>>;
}

function applyProps(el: Element, props: Props): void {
  if (props.class) el.setAttribute('class', props.class);
  if (props.text !== undefined) el.textContent = props.text;
  if (props.attrs) {
    for (const [k, v] of Object.entries(props.attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'style') continue; // never: style attributes are blocked by CSP
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  if (props.style) for (const [k, v] of Object.entries(props.style)) (el as HTMLElement).style.setProperty(k, v);
  if (props.on) for (const [k, fn] of Object.entries(props.on)) if (fn) el.addEventListener(k, fn as EventListener);
}

function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyProps(el, props);
  append(el, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number | null | undefined> = {}, ...children: Child[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined && k !== 'style') el.setAttribute(k, String(v));
  append(el, children);
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function button(label: string, opts: { class?: string; icon?: SVGElement | null; onClick: () => void; ariaLabel?: string; disabled?: boolean }): HTMLButtonElement {
  const b = h('button', {
    class: `nx-btn ${opts.class ?? ''}`.trim(),
    attrs: { type: 'button', 'aria-label': opts.ariaLabel ?? null, disabled: opts.disabled ?? false },
    on: { click: () => opts.onClick() },
  });
  if (opts.icon) b.appendChild(opts.icon);
  if (label) b.appendChild(h('span', { class: 'nx-btn-label', text: label }));
  return b;
}

/** Shrink a text element's font size until it fits its box (keeps long instructions from overflowing). */
export function fitText(el: HTMLElement, minPx: number): void {
  const max = parseFloat(getComputedStyle(el).fontSize) || 40;
  let size = max;
  el.style.setProperty('font-size', `${size}px`);
  let guard = 0;
  // A few pixels of tolerance: glyph ascenders can exceed the line box without visible clipping.
  while ((el.scrollHeight > el.clientHeight + 4 || el.scrollWidth > el.clientWidth + 4) && size > minPx && guard++ < 40) {
    size -= 1;
    el.style.setProperty('font-size', `${size}px`);
  }
}
