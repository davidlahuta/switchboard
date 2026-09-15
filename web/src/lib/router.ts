import { useEffect, useState } from 'react';

export type Route =
  | { name: 'overview' }
  | { name: 'repo'; id: string }
  | { name: 'sessions'; repo: string | null }
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
      return parts[1] ? { name: 'terminal', runId: parts[1] } : { name: 'sessions', repo: query.get('repo') };
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

export function navigate(path: string, replace = false): void {
  const target = path.startsWith('#') ? path : `#${path}`;
  if (location.hash === target) return;
  /*
   * Replacing rather than pushing is for state the reader did not ask to navigate to — restoring a
   * filter they left behind, say. Back should undo what they did, not walk them through what the
   * page did to itself on the way in.
   */
  if (replace) {
    history.replaceState(null, '', `${location.pathname}${location.search}${target}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    return;
  }
  location.hash = target;
}

/**
 * The repository filter as it travels in the URL.
 *
 * Absent means all of them; `none` means the sessions that belong to no repository, which is a real
 * choice and not the absence of one — so it cannot be the empty string, which a URL cannot tell
 * apart from a parameter nobody set.
 */
export const REPO_ALL = 'all';
export const REPO_NONE = '';

export function repoParam(filter: string): string | null {
  if (filter === REPO_ALL) return null;
  return filter === REPO_NONE ? 'none' : filter;
}

export function repoFilterOf(param: string | null): string {
  if (param === null) return REPO_ALL;
  return param === 'none' ? REPO_NONE : param;
}

export const href = {
  overview: () => '#/',
  repo: (id: string) => `#/repos/${encodeURIComponent(id)}`,
  sessions: (filter: string = REPO_ALL) => {
    const param = repoParam(filter);
    return param === null ? '#/sessions' : `#/sessions?repo=${encodeURIComponent(param)}`;
  },
  terminal: (runId: string) => `#/sessions/${encodeURIComponent(runId)}`,
  subscriptions: () => '#/subscriptions',
  settings: () => '#/settings',
};
