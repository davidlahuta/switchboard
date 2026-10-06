import { useEffect } from 'react';
import { appBadgeCount } from '@shared/badge.ts';
import type { Run } from '@shared/types.ts';

type BadgingNavigator = Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };

/**
 * The count of sessions waiting on you, on the installed app's icon: the home screen on iOS, the
 * taskbar or dock on a desktop. Browsers without the Badging API, and iOS before notifications are
 * allowed, simply show nothing. While the app is closed, each notification carries the count and
 * the service worker sets it (see sw.js).
 */
export function useAppBadge(runs: readonly Run[] | undefined): void {
  const count = runs ? appBadgeCount(runs) : null;
  useEffect(() => {
    if (count === null) return;
    const nav = navigator as BadgingNavigator;
    if (!nav.setAppBadge) return;
    const done = count > 0 ? nav.setAppBadge(count) : (nav.clearAppBadge?.() ?? nav.setAppBadge(0));
    done.catch(() => undefined); // not installed, or no permission: nothing to show it on
  }, [count]);
}
