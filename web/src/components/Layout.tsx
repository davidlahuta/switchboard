import type { ReactNode } from 'react';
import { sortRepos } from '../lib/repos.ts';
import { href, type Route } from '../lib/router.ts';
import { useStore, type ConnState } from '../lib/store.tsx';
import { StaleCodeBanner } from './StaleCode.tsx';
import { Icon, type IconName } from './ui.tsx';

interface NavItem {
  key: string;
  label: string;
  short: string;
  icon: IconName;
  href: string;
  match: (r: Route) => boolean;
}

const NAV: NavItem[] = [
  { key: 'overview', label: 'Overview', short: 'Overview', icon: 'home', href: href.overview(), match: (r) => r.name === 'overview' || r.name === 'repo' },
  { key: 'sessions', label: 'Sessions', short: 'Sessions', icon: 'terminal', href: href.sessions(), match: (r) => r.name === 'sessions' || r.name === 'terminal' },
  { key: 'subs', label: 'Subscriptions', short: 'Subs', icon: 'card', href: href.subscriptions(), match: (r) => r.name === 'subscriptions' },
  { key: 'settings', label: 'Settings', short: 'Settings', icon: 'gear', href: href.settings(), match: (r) => r.name === 'settings' },
];

export function ConnDot({ conn }: { conn: ConnState }) {
  const text = conn === 'open' ? 'Live' : conn === 'connecting' ? 'Connecting…' : 'Offline – reconnecting';
  return (
    <span className={`conn conn-${conn}`} role="status" aria-label={`Connection: ${text}`} title={text}>
      <span className="conn-dot" aria-hidden="true" />
      <span className="conn-text">{text}</span>
    </span>
  );
}

export function Layout({ route, children, bare }: { route: Route; children: ReactNode; bare?: boolean }) {
  const { state, conn } = useStore();
  const unread = state?.repos.reduce((n, r) => n + r.unreadForHuman, 0) ?? 0;
  const conflicts = state?.repos.reduce((n, r) => n + r.openConflicts, 0) ?? 0;
  const liveRuns = state?.runs.filter((r) => r.status !== 'exited').length ?? 0;
  const badge = (key: string): number => (key === 'overview' ? unread + conflicts : key === 'sessions' ? liveRuns : 0);

  if (bare) return <div className="app app-bare">{children}</div>;

  return (
    <div className="app">
      <aside className="sidebar" aria-label="Primary">
        <a className="brand" href={href.overview()}>
          <span className="brand-mark" aria-hidden="true">
            <Icon name="list" size={16} />
          </span>
          Switchboard
        </a>
        <nav className="side-nav">
          {NAV.map((n) => (
            <a key={n.key} href={n.href} className={n.match(route) ? 'side-link active' : 'side-link'} aria-current={n.match(route) ? 'page' : undefined}>
              <Icon name={n.icon} />
              <span>{n.label}</span>
              {badge(n.key) > 0 && <span className={n.key === 'overview' ? 'nav-badge nav-badge-hot' : 'nav-badge'}>{badge(n.key)}</span>}
            </a>
          ))}
        </nav>
        {state && state.repos.length > 0 && (
          <nav className="side-repos" aria-label="Repositories">
            <div className="side-heading">Repos</div>
            {sortRepos(state.repos).map((r) => (
              <a
                key={r.id}
                href={href.repo(r.id)}
                className={route.name === 'repo' && route.id === r.id ? 'side-repo active' : 'side-repo'}
                title={r.root}
              >
                <span className={r.agentsOnline > 0 ? 'repo-dot on' : 'repo-dot'} aria-hidden="true" />
                <span className="side-repo-name">{r.name}</span>
                {r.openConflicts > 0 && <span className="nav-badge nav-badge-crit" title="Open conflicts">{r.openConflicts}</span>}
                {r.unreadForHuman > 0 && <span className="nav-badge nav-badge-hot" title="Unread messages for you">{r.unreadForHuman}</span>}
              </a>
            ))}
          </nav>
        )}
        <div className="side-foot">
          <ConnDot conn={conn} />
          {state && <span className="side-version">v{state.daemon.version}</span>}
        </div>
      </aside>

      <div className="main">
        <div className="mobile-top">
          <a className="brand" href={href.overview()}>
            <span className="brand-mark" aria-hidden="true">
              <Icon name="list" size={14} />
            </span>
            Switchboard
          </a>
          <ConnDot conn={conn} />
        </div>
        {state && <StaleCodeBanner daemon={state.daemon} />}
        <main className="content">{children}</main>
      </div>

      <nav className="tabbar" aria-label="Primary">
        {NAV.map((n) => (
          <a key={n.key} href={n.href} className={n.match(route) ? 'tab active' : 'tab'} aria-current={n.match(route) ? 'page' : undefined}>
            <span className="tab-icon">
              <Icon name={n.icon} size={20} />
              {badge(n.key) > 0 && <span className="tab-badge">{badge(n.key)}</span>}
            </span>
            <span className="tab-label">{n.short}</span>
          </a>
        ))}
      </nav>
    </div>
  );
}
