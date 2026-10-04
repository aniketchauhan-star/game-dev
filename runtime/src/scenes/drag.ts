import { h } from '../dom.ts';

/**
 * Shared pointer-drag helper. A drag only starts after the pointer moves a few
 * pixels, so a plain tap/click stays a selection (the non-drag alternative).
 * The floating ghost lives in an overlay inside the scaled stage.
 */
export interface DragOptions {
  overlay: HTMLElement;
  toStage: (clientX: number, clientY: number) => { x: number; y: number };
  onStart?: () => void;
  onMove?: (clientX: number, clientY: number) => void;
  onDrop: (clientX: number, clientY: number) => void;
  onTap: () => void;
}

export function makeDraggable(el: HTMLElement, opts: DragOptions): () => void {
  let startX = 0;
  let startY = 0;
  let pointerId: number | null = null;
  let ghost: HTMLElement | null = null;
  let offset = { x: 0, y: 0 };

  const cleanup = () => {
    ghost?.remove();
    ghost = null;
    el.classList.remove('nx-dragging');
    pointerId = null;
  };

  const down = (e: PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    el.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent) => {
    if (pointerId !== e.pointerId) return;
    if (!ghost) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < 8) return;
      const r = el.getBoundingClientRect();
      const tl = opts.toStage(r.left, r.top);
      const br = opts.toStage(r.right, r.bottom);
      const at = opts.toStage(e.clientX, e.clientY);
      offset = { x: at.x - tl.x, y: at.y - tl.y };
      ghost = el.cloneNode(true) as HTMLElement;
      ghost.classList.add('nx-ghost');
      ghost.removeAttribute('id');
      ghost.setAttribute('aria-hidden', 'true');
      ghost.style.setProperty('width', `${br.x - tl.x}px`);
      ghost.style.setProperty('height', `${br.y - tl.y}px`);
      opts.overlay.appendChild(ghost);
      el.classList.add('nx-dragging');
      opts.onStart?.();
    }
    const at = opts.toStage(e.clientX, e.clientY);
    ghost.style.setProperty('transform', `translate(${at.x - offset.x}px, ${at.y - offset.y}px)`);
    opts.onMove?.(e.clientX, e.clientY);
  };
  const up = (e: PointerEvent) => {
    if (pointerId !== e.pointerId) return;
    const wasDrag = Boolean(ghost);
    cleanup();
    if (wasDrag) opts.onDrop(e.clientX, e.clientY);
    else opts.onTap();
  };
  const cancel = () => cleanup();
  // A click from the keyboard (Enter/Space) arrives as a click with detail 0 — treat it as a tap.
  const click = (e: MouseEvent) => {
    if (e.detail === 0) opts.onTap();
  };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('click', click);
  return () => {
    cleanup();
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', cancel);
    el.removeEventListener('click', click);
  };
}

/** Topmost element under the pointer matching `selector` (ignores the ghost). */
export function hitTest(clientX: number, clientY: number, selector: string): HTMLElement | null {
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    if (el.closest('.nx-ghost')) continue;
    const match = (el as HTMLElement).closest(selector);
    if (match) return match as HTMLElement;
  }
  return null;
}

export function marker(): HTMLElement {
  return h('div', { class: 'nx-insert-marker', attrs: { 'aria-hidden': 'true' } });
}
