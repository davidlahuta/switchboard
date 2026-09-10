import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { AgentStatus, RunStatus, Usage, UsageWindow } from '@shared/types.ts';
import { pctText, usageIssue, usageLevel } from '../lib/format.ts';
import { absTime, resetsIn, retryIn } from '../lib/time.ts';

// ---------- icons ----------

const ICONS = {
  plus: 'M12 5v14M5 12h14',
  back: 'M15 18l-6-6 6-6',
  chevronDown: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  terminal: 'M4 17l6-6-6-6M12 19h8',
  swap: 'M7 16V4M7 4L3 8M7 4l4 4M17 8v12M17 20l4-4M17 20l-4-4',
  stop: 'M6 6h12v12H6z',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6',
  refresh: 'M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5',
  key: 'M15 7a4 4 0 1 1-3.9 5H3v3h3v3h3v-3h2.1A4 4 0 0 1 15 7z',
  check: 'M5 12l5 5L20 7',
  x: 'M6 6l12 12M18 6L6 18',
  pin: 'M12 17v5M9 3h6l-1 6 4 4H6l4-4z',
  archive: 'M3 4h18v4H3zM5 8v12h14V8M10 12h4',
  send: 'M22 2L11 13M22 2l-7 20-4-9-9-4z',
  home: 'M3 11l9-8 9 8M5 10v10h14V10',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  card: 'M3 5h18v14H3zM3 10h18',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  repo: 'M4 4h12a4 4 0 0 1 4 4v12H8a4 4 0 0 1-4-4zM4 16a4 4 0 0 1 4-4h12',
  bolt: 'M13 2L3 14h9l-1 8 10-12h-9z',
  message: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  file: 'M14 2H6v20h12V8zM14 2v6h6',
  note: 'M4 4h16v12l-4 4H4zM16 20v-4h4',
  zoomIn: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.3-4.3M11 8v6M8 11h6',
  zoomOut: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.3-4.3M8 11h6',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  paste: 'M9 4h6v3H9zM7 5H5v16h14V5h-2',
  link: 'M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1',
  phone: 'M7 2h10v20H7zM11 18h2',
  warn: 'M12 3l10 18H2zM12 10v5M12 18h.01',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

export function IconButton({
  icon,
  label,
  onClick,
  disabled,
  variant,
  className,
}: {
  icon: IconName;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'danger' | 'ghost';
  className?: string;
}) {
  return (
    <button
      type="button"
      className={['btn', 'btn-icon', variant ? `btn-${variant}` : 'btn-ghost', className].filter(Boolean).join(' ')}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon name={icon} />
    </button>
  );
}

// ---------- status ----------

export function StatusPill({ status, title }: { status: AgentStatus | RunStatus | string; title?: string }) {
  return (
    <span className={`pill pill-${status}`} title={title}>
      <span className="pill-dot" aria-hidden="true" />
      {status}
    </span>
  );
}

export function Badge({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'warn' | 'crit' | 'ok' | 'muted';
  title?: string;
}) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

/**
 * Why the usage numbers are not current — "rate limited", "login expired", … — with a live
 * countdown to the moment polling resumes. Renders nothing when the numbers are fresh.
 */
export function StaleBadge({ usage, now }: { usage: Usage | null | undefined; now: number }) {
  const issue = usageIssue(usage);
  if (!issue) return null;
  const limited = usage?.errorKind === 'rate_limited';
  return (
    <span className="stale-flag">
      <Badge tone={issue.tone} title={issue.title}>
        {issue.label}
      </Badge>
      {limited && usage?.retryAt && (
        <span className="stale-retry small dim" title={`Polling resumes at ${absTime(usage.retryAt)}`}>
          {retryIn(usage.retryAt, now)}
        </span>
      )}
    </span>
  );
}

// ---------- usage ----------

export function UsageBar({
  label,
  window: w,
  now,
  compact,
  binding,
}: {
  label: string;
  window: UsageWindow | null | undefined;
  now: number;
  compact?: boolean;
  /** Marks the window that currently caps what you can use. */
  binding?: boolean;
}) {
  const pct = w ? Math.max(0, Math.min(100, w.pct)) : 0;
  const level = usageLevel(w?.pct);
  return (
    <div className={compact ? 'usage usage-compact' : 'usage'}>
      <div className="usage-head">
        <span className="usage-label">
          {label}
          {binding && (
            <span className="usage-binding" title="This window is the limit right now">
              ●
            </span>
          )}
        </span>
        <span className={`usage-pct lvl-${level}`}>{pctText(w)}</span>
      </div>
      <div
        className="usage-track"
        role="meter"
        aria-label={`${label} usage`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
      >
        <div className={`usage-fill fill-${level}`} style={{ width: `${pct}%` }} />
      </div>
      {!compact && <div className="usage-reset">{w ? resetsIn(w.resetsAt, now) : 'no data'}</div>}
    </div>
  );
}

// ---------- layout bits ----------

export function Empty({ children, icon }: { children: ReactNode; icon?: IconName }) {
  return (
    <div className="empty">
      {icon && <Icon name={icon} size={22} />}
      <div>{children}</div>
    </div>
  );
}

export function Section({
  title,
  actions,
  children,
  count,
  className,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  count?: number;
  className?: string;
}) {
  return (
    <section className={className ? `section ${className}` : 'section'}>
      <header className="section-head">
        <h2>
          {title}
          {count !== undefined && <span className="section-count">{count}</span>}
        </h2>
        {actions && <div className="section-actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label className="toggle" title={label}>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={label}
      />
      <span className="toggle-track" aria-hidden="true">
        <span className="toggle-thumb" />
      </span>
    </label>
  );
}

// ---------- dialog ----------

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener('keydown', onKey);
    // focus first field
    window.setTimeout(() => {
      const el = panelRef.current?.querySelector<HTMLElement>(
        'input:not([type=hidden]):not([disabled]), textarea, select, button.btn-primary',
      );
      el?.focus();
    }, 0);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panelRef}
        className={wide ? 'dialog dialog-wide' : 'dialog'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="dialog-head">
          <h2 id={titleId}>{title}</h2>
          <IconButton icon="x" label="Close" onClick={onClose} />
        </header>
        <div className="dialog-body">{children}</div>
        {footer && <footer className="dialog-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel = 'Confirm',
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={danger ? 'btn btn-danger-solid' : 'btn btn-primary'}
            onClick={onConfirm}
            disabled={busy}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}

// ---------- popover menu ----------

export function Popover({
  trigger,
  children,
  label,
  align = 'right',
}: {
  trigger: (props: { onClick: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'menu' }) => ReactNode;
  children: (close: () => void) => ReactNode;
  label: string;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [flipUp, setFlipUp] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !panelRef.current || !rootRef.current) return;
    const r = rootRef.current.getBoundingClientRect();
    const h = panelRef.current.offsetHeight;
    const vh = window.visualViewport?.height ?? window.innerHeight;
    setFlipUp(r.bottom + h + 8 > vh && r.top - h - 8 > 0);
  }, [open]);

  return (
    <div className="popover-root" ref={rootRef}>
      {trigger({ onClick: () => setOpen((o) => !o), 'aria-expanded': open, 'aria-haspopup': 'menu' })}
      {open && (
        <>
          <div className="popover-scrim" onClick={() => setOpen(false)} aria-hidden="true" />
          <div
            ref={panelRef}
            className={`popover popover-${align}${flipUp ? ' popover-up' : ''}`}
            role="menu"
            aria-label={label}
          >
            {children(() => setOpen(false))}
          </div>
        </>
      )}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <span className="spinner" role="status" aria-label={label} />;
}

export function Mono({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="mono" title={title}>
      {children}
    </span>
  );
}
