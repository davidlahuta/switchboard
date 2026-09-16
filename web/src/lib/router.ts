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

/**
 * Whether this is a phone or a tablet: a touch screen with no mouse. Tabs there are a switcher
 * behind a button rather than a row along the top, so a new tab per terminal buries the list it was
 * opened from and piles up tabs nobody closes, while Back is the natural way out.
 */
export function touchOnly(): boolean {
  return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
}

/**
 * A link into a session's terminal: a tab of its own on a desktop, the same tab on a phone.
 *
 * A terminal is somewhere the operator stays — typing into it, watching a turn — while the list it
 * was picked from keeps moving, and on a desktop sessions are worked on side by side. Opened in place
 * there, it took the list away and made Back the way between sessions. noopener, because the
 * terminal tab has no business with the window that opened it. See touchOnly for phones.
 */
export function terminalLink(runId: string): { href: string; target?: '_blank'; rel?: 'noopener' } {
  if (touchOnly()) return { href: href.terminal(runId) };
  return { href: href.terminal(runId), target: '_blank', rel: 'noopener' };
}

/**
 * The same, from code rather than a click on a link: after starting a session, say.
 *
 * A browser only lets a page open a tab close to a click, and a request in between can use that up,
 * so a tab that was refused is not the end of it — the terminal opens here instead of not at all.
 * The opener is cut by hand rather than with the noopener feature, which makes window.open return
 * null whether the tab opened or not, and so hides exactly the refusal this has to notice.
 */
export function openTerminal(runId: string): void {
  if (touchOnly()) {
    navigate(href.terminal(runId));
    return;
  }
  const tab = window.open(href.terminal(runId), '_blank');
  if (tab) tab.opener = null;
  else navigate(href.terminal(runId));
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
