import { REPO_ALL, REPO_NONE, repoFilterOf, type Route } from './router.ts';

export const APP_TITLE = 'Switchboard';

/**
 * What the browser tab says on each page, or null for a page that writes its own.
 *
 * A row of Switchboard tabs that all read "Switchboard" is a row nobody can pick from, so each one
 * names the page and, where there is one, the thing on it — a repository, the repository a session
 * list is filtered to. The page comes first because the end of a title is what a narrow tab cuts.
 * A terminal is left to its own page, which puts the session's mark in the title (see Terminal.tsx).
 */
export function pageTitle(route: Route, repoName: (id: string) => string | undefined): string | null {
  const page = pageName(route, repoName);
  return page === null ? null : `${page} · ${APP_TITLE}`;
}

function pageName(route: Route, repoName: (id: string) => string | undefined): string | null {
  switch (route.name) {
    case 'overview':
      return 'Overview';
    case 'repo':
      return repoName(route.id) ?? 'Repo';
    case 'sessions': {
      const filter = repoFilterOf(route.repo);
      if (filter === REPO_ALL) return 'Sessions';
      if (filter === REPO_NONE) return 'Sessions · no repo';
      return `Sessions · ${repoName(filter) ?? filter}`;
    }
    case 'terminal':
      return null;
    case 'subscriptions':
      return 'Subscriptions';
    case 'settings':
      return 'Settings';
    case 'pair':
      return 'Pair a device';
    case 'notfound':
      return 'Not found';
  }
}
