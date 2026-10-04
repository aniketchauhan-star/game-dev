import { cloneElement, forwardRef, useId, useRef, useState, type ButtonHTMLAttributes, type FocusEvent, type MouseEvent, type InputHTMLAttributes, type ReactElement, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { CircleAlert } from 'lucide-react';

type Variant = 'default' | 'primary' | 'ai' | 'ghost' | 'danger' | 'danger-solid';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  block?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'default', size = 'md', loading, block, icon, className, children, disabled, ...rest }, ref) {
  const cls = ['btn', variant !== 'default' && `btn-${variant}`, size !== 'md' && `btn-${size}`, block && 'btn-block', loading && 'is-loading', className].filter(Boolean).join(' ');
  return (
    <button ref={ref} type="button" className={cls} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {icon}
      {children}
      {loading && <span className="spinner" aria-hidden="true" />}
    </button>
  );
});

/** Accessible tooltip: shown on hover and keyboard focus, and wired with aria-describedby. */
export function Tooltip({ label, children, side = 'top' }: { label: string; children: ReactElement<Record<string, unknown>>; side?: 'top' | 'right' | 'bottom' }) {
  const id = useId();
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const timer = useRef<number | null>(null);
  const show = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const p = side === 'right' ? { x: r.right + 10, y: r.top + r.height / 2 } : side === 'bottom' ? { x: r.left + r.width / 2, y: r.bottom + 8 } : { x: r.left + r.width / 2, y: r.top - 8 };
    timer.current = window.setTimeout(() => setPos(p), 280);
  };
  const hide = () => {
    if (timer.current) window.clearTimeout(timer.current);
    setPos(null);
  };
  const child = cloneElement(children, {
    'aria-describedby': pos ? id : undefined,
    onMouseEnter: (e: MouseEvent<HTMLElement>) => show(e.currentTarget),
    onMouseLeave: hide,
    onFocus: (e: FocusEvent<HTMLElement>) => show(e.currentTarget),
    onBlur: hide,
  });
  const transform = side === 'right' ? 'translate(0, -50%)' : side === 'bottom' ? 'translate(-50%, 0)' : 'translate(-50%, -100%)';
  return (
    <>
      {child}
      {pos &&
        createPortal(
          <div role="tooltip" id={id} className="tooltip" style={{ left: pos.x, top: pos.y, transform }}>
            {label}
          </div>,
          document.body,
        )}
    </>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  size?: 'sm' | 'md';
  bordered?: boolean;
  tooltipSide?: 'top' | 'right' | 'bottom';
  pressed?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({ label, size = 'md', bordered, tooltipSide = 'top', pressed, className, children, ...rest }, ref) {
  return (
    <Tooltip label={label} side={tooltipSide}>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        className={['icon-btn', size === 'sm' && 'icon-btn-sm', bordered && 'icon-btn-bordered', className].filter(Boolean).join(' ')}
        {...rest}
      >
        {children}
      </button>
    </Tooltip>
  );
});

export function Field({ label, help, error, required, children, htmlFor, className }: { label: ReactNode; help?: ReactNode; error?: string | null; required?: boolean; children: ReactNode; htmlFor?: string; className?: string }) {
  return (
    <div className={['field', className].filter(Boolean).join(' ')}>
      <label className="field-label" htmlFor={htmlFor}>
        {label}
        {required && (
          <span className="req" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {children}
      {error ? (
        <p className="field-error" role="alert">
          <CircleAlert size={14} aria-hidden="true" />
          {error}
        </p>
      ) : help ? (
        <p className="field-help">{help}</p>
      ) : null}
    </div>
  );
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { compact?: boolean }>(function TextInput({ className, compact, ...rest }, ref) {
  return <input ref={ref} className={['input', compact && 'input-sm', className].filter(Boolean).join(' ')} {...rest} />;
});

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={['textarea', className].filter(Boolean).join(' ')} {...rest} />;
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={['select', className].filter(Boolean).join(' ')} {...rest}>
      {children}
    </select>
  );
}

export function Checkbox({ label, hint, checked, onChange, disabled }: { label: ReactNode; hint?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="check-text">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </span>
    </label>
  );
}

export function Switch({ label, hint, checked, onChange, disabled }: { label: ReactNode; hint?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="switch">
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="check-text">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </span>
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: ReactNode; icon?: ReactNode; title?: string }>; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} title={o.title} onClick={() => onChange(o.value)}>
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ value, tabs, onChange, label }: { value: T; tabs: Array<{ value: T; label: ReactNode; count?: number }>; onChange: (v: T) => void; label: string }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t, i) => (
        <button
          key={t.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="tab"
          aria-selected={value === t.value}
          tabIndex={value === t.value ? 0 : -1}
          onClick={() => onChange(t.value)}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
            e.preventDefault();
            const next = (i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
            onChange(tabs[next]!.value);
            refs.current[next]?.focus();
          }}
        >
          {t.label}
          {t.count !== undefined && <span className="subtle small"> {t.count}</span>}
        </button>
      ))}
    </div>
  );
}
