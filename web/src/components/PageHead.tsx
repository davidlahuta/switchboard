import type { ReactNode } from 'react';

export function PageHead({
  title,
  subtitle,
  actions,
  back,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <header className="page-head">
      <div className="page-title">
        {back && (
          <a className="crumb" href={back.href}>
            ← {back.label}
          </a>
        )}
        <h1 className="h1">{title}</h1>
        {subtitle && <div className="page-sub">{subtitle}</div>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}
