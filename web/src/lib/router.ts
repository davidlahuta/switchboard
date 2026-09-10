import { useEffect, useState } from 'react';

export type Route =
  | { name: 'overview' }
  | { name: 'repo'; id: string }
  | { name: 'sessions' }
  | { name: 'terminal'; runId: string }
  | { name: 'subscriptions' }
  | { name: 'settings' }
  | { name: 'pair'; code: string | null }
  | { name: 'notfound'; path: string };

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '') || '/';
  const [pathPart, queryPart = ''] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
  const query = new URLSearchParams(queryPart);
  if (parts.length === 0) return { name: 'overview' };
  switch (parts[0]) {
    case 'repos':
      return parts[1] ? { name: 'repo', id: parts[1] } : { name: 'overview' };
    case 'sessions':
      return parts[1] ? { name: 'terminal', runId: parts[1] } : { name: 'sessions' };
    case 'subscriptions':
      return { name: 'subscriptions' };
    case 'settings':
      return { name: 'settings' };
    case 'pair':
      return { name: 'pair', code: query.get('code') };
    default:
      return { name: 'notfound', path: pathPart };
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function navigate(path: string): void {
  const target = path.startsWith('#') ? path : `#${path}`;
  if (location.hash !== target) location.hash = target;
}

export const href = {
  overview: () => '#/',
  repo: (id: string) => `#/repos/${encodeURIComponent(id)}`,
  sessions: () => '#/sessions',
  terminal: (runId: string) => `#/sessions/${encodeURIComponent(runId)}`,
  subscriptions: () => '#/subscriptions',
  settings: () => '#/settings',
};
