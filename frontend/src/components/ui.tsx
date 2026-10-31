import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Loader2, X, ImageOff, Sparkles } from 'lucide-react';
import { cx } from '@/lib/util';
import { useGlide } from '@/lib/motion';
import { initials } from '@/lib/format';
import type { Tone } from '@/lib/domain';
import { PROPERTY_IMAGES } from '@/store/seed';

/* ─────────── Button ─────────── */

type BtnVariant = 'default' | 'primary' | 'accent' | 'ghost' | 'danger' | 'danger-solid';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: BtnVariant;
  size?: 'md' | 'sm' | 'xs';
  icon?: ReactNode;
  iconOnly?: boolean;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', icon, iconOnly, loading, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        'btn',
        variant !== 'default' && `btn-${variant}`,
        size !== 'md' && `btn-${size}`,
        iconOnly && 'btn-icon',
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Loader2 size={size === 'md' ? 16 : 14} className="spin" /> : icon}
      {children}
    </button>
  );
});

/* ─────────── Badge ─────────── */

export function Badge({ tone = 'neutral', dot, children, className, title }: { tone?: Tone | 'outline'; dot?: boolean; children: ReactNode; className?: string; title?: string }) {
  return (
    <span className={cx('badge', tone !== 'neutral' && `badge-${tone}`, className)} title={title}>
      {dot && <span className="dot" />}
      {children}
    </span>
  );
}

export function AiBadge({ title = 'Extracted by AI — editable, not yet verified by a person' }: { title?: string }) {
  return (
    <span className="badge badge-ai" title={title}>
      <Sparkles size={10} /> AI
    </span>
  );
}

/* ─────────── Avatar ─────────── */

export function Avatar({ name, hue, size = 'md', title }: { name: string; hue?: number; size?: 'sm' | 'md' | 'lg' | 'xl'; title?: string }) {
  const h = hue ?? hashHue(name);
  return (
    <span
      className={cx('avatar', size !== 'md' && size)}
      style={{ background: `oklch(0.84 0.09 ${h})` }}
      title={title ?? name}
      aria-hidden={!title}
    >
      {initials(name)}
    </span>
  );
}

export function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

/* ─────────── Overlay primitives ─────────── */

function useEscape(onClose: () => void, active = true) {
  useEffect(() => {
    if (!active) return;
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose, active]);
}

function useFocusFirst(ref: React.RefObject<HTMLElement>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const prev = document.activeElement as HTMLElement | null;
    const target = el.querySelector<HTMLElement>('[data-autofocus], input:not([type=hidden]):not([disabled]), textarea, select');
    (target ?? el).focus({ preventScroll: true });
    return () => prev?.focus?.({ preventScroll: true });
  }, [ref]);
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'wide' | 'narrow';
}) {
  useEscape(onClose, open);
  if (!open) return null;
  return createPortal(<ModalInner onClose={onClose} title={title} description={description} footer={footer} size={size}>{children}</ModalInner>, document.body);
}

function ModalInner({ onClose, title, description, children, footer, size }: { onClose: () => void; title: ReactNode; description?: ReactNode; children?: ReactNode; footer?: ReactNode; size?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusFirst(ref);
  return (
    <>
      <div className="overlay overlay-modal" onClick={onClose} />
      <div ref={ref} className={cx('modal', size)} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="modal-head">
          <div className="grow">
            <h2 className="modal-title" id={titleId}>{title}</h2>
            {description && <p className="modal-desc">{description}</p>}
          </div>
          <Button variant="ghost" size="sm" iconOnly icon={<X size={16} />} onClick={onClose} aria-label="Close" />
        </div>
        {children && <div className="modal-body">{children}</div>}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </>
  );
}

export function Drawer({
  open,
  onClose,
  children,
  header,
  footer,
  wide,
  label,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  header: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  label: string;
}) {
  useEscape(onClose, open);
  if (!open) return null;
  return createPortal(
    <>
      <div className="overlay" onClick={onClose} />
      <aside className={cx('drawer', wide && 'wide')} role="dialog" aria-modal="true" aria-label={label}>
        <div className="drawer-head">
          <div className="grow">{header}</div>
          <Button variant="ghost" size="sm" iconOnly icon={<X size={16} />} onClick={onClose} aria-label="Close panel" />
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </aside>
    </>,
    document.body,
  );
}

/* ─────────── Dropdown menu ─────────── */

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  hint?: string;
}

export type MenuEntry = MenuItem | 'sep' | { heading: string };

export function Menu({
  trigger,
  items,
  align = 'right',
  up,
  width,
}: {
  trigger: (props: { onClick: () => void; 'aria-expanded': boolean }) => ReactNode;
  items: MenuEntry[];
  align?: 'left' | 'right';
  up?: boolean;
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="menu-anchor" ref={ref}>
      {trigger({ onClick: () => setOpen((o) => !o), 'aria-expanded': open })}
      {open && (
        <div className={cx('menu', align, up && 'up')} role="menu" style={width ? { minWidth: width } : undefined}>
          {items.map((it, i) =>
            it === 'sep' ? (
              <div key={i} className="menu-sep" />
            ) : 'heading' in it ? (
              <div key={i} className="menu-label">{it.heading}</div>
            ) : (
              <button
                key={i}
                role="menuitem"
                className={cx('menu-item', it.danger && 'danger')}
                disabled={it.disabled}
                title={it.hint}
                onClick={() => {
                  setOpen(false);
                  it.onSelect?.();
                }}
              >
                {it.icon}
                <span className="grow">{it.label}</span>
                {it.checked && <span className="check-mark">●</span>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/* ─────────── Form controls ─────────── */

export function Field({ label, hint, error, children, className, htmlFor }: { label?: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string; htmlFor?: string }) {
  return (
    <div className={cx('field', className)}>
      {label && <label className="field-label" htmlFor={htmlFor}>{label}</label>}
      {children}
      {error ? <span className="field-error" role="alert">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean; inputSize?: 'sm' }>(function Input(
  { className, invalid, inputSize, ...rest },
  ref,
) {
  return <input ref={ref} className={cx('input', invalid && 'invalid', inputSize === 'sm' && 'input-sm', className)} aria-invalid={invalid || undefined} {...rest} />;
});

export function Select({ className, invalid, selectSize, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean; selectSize?: 'sm' }) {
  return (
    <select className={cx('select', invalid && 'invalid', selectSize === 'sm' && 'select-sm', className)} {...rest}>
      {children}
    </select>
  );
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx('textarea', className)} {...rest} />;
}

export function SearchInput({ value, onChange, placeholder = 'Search…', width = 240, autoFocus }: { value: string; onChange: (v: string) => void; placeholder?: string; width?: number | string; autoFocus?: boolean }) {
  return (
    <div className="input-wrap" style={{ width }}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input className="input input-sm" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} autoFocus={autoFocus} />
    </div>
  );
}

export function Checkbox({ checked, indeterminate, onChange, label, aria, disabled }: { checked: boolean; indeterminate?: boolean; onChange: (v: boolean) => void; label?: ReactNode; aria?: string; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate;
  }, [indeterminate]);
  return (
    <label className="check" onClick={(e) => e.stopPropagation()}>
      <input ref={ref} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-label={aria ?? (typeof label === 'string' ? label : undefined)} />
      {label}
    </label>
  );
}

export function Switch({ on, onChange, disabled, danger, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; danger?: boolean; label: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={cx('switch', on && 'on', danger && 'danger')} disabled={disabled} onClick={() => onChange(!on)} />;
}

export function Segmented<T extends string>({ value, onChange, options, mono, size }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[]; mono?: boolean; size?: 'sm' }) {
  const { box, ink } = useGlide<HTMLDivElement>('button.on', [value, options.length]);
  return (
    <div ref={box} className={cx('seg', 'has-thumb', mono && 'mono')} role="tablist" data-size={size}>
      <span ref={ink} className="seg-thumb" aria-hidden />
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={value === o.value} className={cx(value === o.value && 'on')} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode; count?: number }[] }) {
  const { box, ink } = useGlide<HTMLDivElement>('.tab.on', [value, tabs.map((t) => `${t.value}:${t.count ?? ''}`).join()], 'underline');
  return (
    <div ref={box} className="tabs has-ink" role="tablist">
      <span ref={ink} className="tab-ink" aria-hidden />
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={value === t.value} className={cx('tab', value === t.value && 'on')} onClick={() => onChange(t.value)}>
          {t.label}
          {t.count != null && <span className="count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/* ─────────── Layout bits ─────────── */

export function PageHeader({ eyebrow, title, sub, actions }: { eyebrow?: ReactNode; title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1 className="page-title">{title}</h1>
        {sub && <p className="page-sub">{sub}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function Card({ title, sub, icon, actions, children, className, bodyClass, flush, style }: { title?: ReactNode; sub?: ReactNode; icon?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string; bodyClass?: string; flush?: boolean; style?: React.CSSProperties }) {
  return (
    <section className={cx('card', className)} style={style}>
      {(title || actions) && (
        <header className="card-head">
          {icon && <span className="icon-chip">{icon}</span>}
          <div className="grow">
            {title && <h3 className="card-title">{title}</h3>}
            {sub && <div className="card-sub">{sub}</div>}
          </div>
          {actions}
        </header>
      )}
      <div className={cx(flush ? 'card-flush' : 'card-body', bodyClass)}>{children}</div>
    </section>
  );
}

export function Empty({ icon, title, description, action }: { icon: ReactNode; title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <div className="empty-title">{title}</div>
      {description && <div className="empty-desc">{description}</div>}
      {action && <div className="mt-8">{action}</div>}
    </div>
  );
}

export function Pager({ page, pageSize, total, onPage, onPageSize }: { page: number; pageSize: number; total: number; onPage: (p: number) => void; onPageSize?: (n: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total ? page * pageSize + 1 : 0;
  const to = Math.min(total, (page + 1) * pageSize);
  return (
    <div className="pager">
      <span className="num">
        {from}–{to} of {total.toLocaleString('en-US')}
      </span>
      {onPageSize && (
        <Select selectSize="sm" value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))} style={{ width: 92 }} aria-label="Rows per page">
          {[10, 25, 50, 100].map((n) => (
            <option key={n} value={n}>
              {n} / page
            </option>
          ))}
        </Select>
      )}
      <div className="ml-auto row">
        <span className="num">
          Page {page + 1} of {pages}
        </span>
        <Button size="sm" iconOnly icon={<ChevronLeft size={15} />} disabled={page === 0} onClick={() => onPage(page - 1)} aria-label="Previous page" />
        <Button size="sm" iconOnly icon={<ChevronRight size={15} />} disabled={page >= pages - 1} onClick={() => onPage(page + 1)} aria-label="Next page" />
      </div>
    </div>
  );
}

export function Progress({ value, tone }: { value: number; tone?: 'accent' | 'success' | 'danger' | 'warning' }) {
  return (
    <div className={cx('progress', tone)} role="progressbar" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      <i style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}

export function Delta({ value, invert, suffix = '' }: { value: number; invert?: boolean; suffix?: string }) {
  if (!Number.isFinite(value)) return <span className="delta flat">—</span>;
  const good = invert ? value < 0 : value > 0;
  const flat = Math.abs(value) < 0.005;
  return (
    <span className={cx('delta', flat ? 'flat' : good ? '' : 'down')}>
      {flat ? '±' : value > 0 ? '↑' : '↓'}
      {Math.abs(value) >= 1 ? Math.round(Math.abs(value * 100)) : Math.abs(value * 100).toFixed(1)}%{suffix}
    </span>
  );
}

/* ─────────── Property image ─────────── */

export function PropertyImage({ index, alt }: { index: number; alt: string }) {
  const [failed, setFailed] = useState(false);
  // Negative index = no photo uploaded (live data); never substitute a stock photo for a real listing.
  if (index < 0)
    return (
      <div className="ph" style={{ background: 'var(--fill)', flexDirection: 'column', gap: 6, fontSize: 12 }} aria-label={`${alt}: no photo yet`}>
        <ImageOff size={20} />
        No photo yet
      </div>
    );
  const id = PROPERTY_IMAGES[index % PROPERTY_IMAGES.length];
  if (failed)
    return (
      <div className="ph" style={{ background: `linear-gradient(135deg, oklch(0.4 0.03 ${(index * 47) % 360}), oklch(0.25 0.02 ${(index * 47 + 40) % 360}))` }}>
        <ImageOff size={20} />
      </div>
    );
  return <img src={`https://images.unsplash.com/${id}?auto=format&fit=crop&w=720&q=70`} alt={alt} loading="lazy" onError={() => setFailed(true)} />;
}

/* ─────────── Section helpers ─────────── */

export function KV({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv">
      {items.map(([k, v], i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

/* ─────────── Loading placeholder for tables ─────────── */

export function TableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="stack" style={{ padding: 16, gap: 10 }} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton" style={{ height: 34, opacity: 1 - i * 0.08 }} />
      ))}
    </div>
  );
}
