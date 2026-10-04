import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { Button } from './controls.tsx';

/** Modal built on the native <dialog> element (focus trapping, Escape and inert background come for free). */
export function Dialog({ open, onClose, title, children, footer, wide, labelledBy }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean; labelledBy?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = labelledBy ?? 'dialog-title';
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`dialog${wide ? ' dialog-wide' : ''}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <>
          <div className="dialog-head">
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="icon-btn icon-btn-sm" aria-label="Close" onClick={onClose}>
              <X size={18} aria-hidden="true" />
            </button>
          </div>
          <div className="dialog-body">{children}</div>
          {footer && <div className="dialog-foot">{footer}</div>}
        </>
      )}
    </dialog>
  );
}

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  danger,
  busy,
  confirmDisabled,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={danger ? 'danger-solid' : 'primary'} loading={busy} disabled={confirmDisabled} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
}

/** Popover menu with roving keyboard focus (arrow keys, Home/End, Escape). */
export function Menu({ trigger, items, align = 'end', label }: { trigger: (props: { onClick: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'menu'; ref: (el: HTMLButtonElement | null) => void }) => ReactNode; items: MenuItem[]; align?: 'start' | 'end'; label: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback((focusTrigger = true) => {
    setOpen(false);
    if (focusTrigger) triggerRef.current?.focus();
  }, []);
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const width = 230;
    const left = align === 'end' ? Math.max(8, r.right - width) : Math.min(window.innerWidth - width - 8, r.left);
    setPos({ top: r.bottom + 6 + window.scrollY, left });
  }, [open, align]);
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node) && !triggerRef.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open, close]);
  const onKey = (e: KeyboardEvent) => {
    const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      buttons[(i + 1) % buttons.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      buttons[(i - 1 + buttons.length) % buttons.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      buttons[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      buttons[buttons.length - 1]?.focus();
    } else if (e.key === 'Tab') close(false);
  };
  return (
    <>
      {trigger({
        onClick: () => setOpen((o) => !o),
        'aria-expanded': open,
        'aria-haspopup': 'menu',
        ref: (el) => {
          triggerRef.current = el;
        },
      })}
      {open &&
        pos &&
        createPortal(
          <div ref={menuRef} className="menu" role="menu" aria-label={label} style={{ top: pos.top, left: pos.left, position: 'absolute', width: 230 }} onKeyDown={onKey}>
            {items.map((it, i) => (
              <div key={i}>
                {it.separatorBefore && <div className="menu-sep" role="separator" />}
                <button
                  type="button"
                  role="menuitem"
                  className={`menu-item${it.danger ? ' danger' : ''}`}
                  disabled={it.disabled}
                  onClick={() => {
                    close();
                    it.onSelect();
                  }}
                >
                  {it.icon}
                  {it.label}
                </button>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

// ───────────── Toasts ─────────────

interface Toast {
  id: number;
  tone: 'success' | 'error' | 'info';
  title: string;
  detail?: string | null;
}

const ToastContext = createContext<(t: Omit<Toast, 'id'>) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);
  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = ++counter.current;
    setToasts((prev) => [...prev.slice(-3), { ...t, id }]);
    window.setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), t.tone === 'error' ? 9000 : 5000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite" aria-relevant="additions">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`} role={t.tone === 'error' ? 'alert' : 'status'}>
            {t.tone === 'success' ? <CircleCheck size={18} aria-hidden="true" /> : t.tone === 'error' ? <CircleAlert size={18} aria-hidden="true" /> : <Info size={18} aria-hidden="true" />}
            <div className="toast-body">
              <strong>{t.title}</strong>
              {t.detail && <small>{t.detail}</small>}
            </div>
            <button type="button" className="icon-btn icon-btn-sm" aria-label="Dismiss notification" onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}>
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
