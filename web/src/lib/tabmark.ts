import type { MarkTone, SessionMark } from '@shared/marks.ts';

/**
 * The session mark, in the one place a browser can show it: the tab.
 *
 * A terminal open in the browser is the same thing as a terminal open in a Windows Terminal tab,
 * and the operator reads a row of them the same way — so it carries the same mark, from the same
 * definition in shared/marks.ts. The title is the glyph, exactly as the native tab writes it.
 *
 * The favicon is colour, because a browser tab is not a terminal tab: open enough of them and the
 * title is squeezed away to nothing while the icon stays. So the one part that survives a narrow
 * tab is the part that says how loudly the session is asking, in the tones the list uses — see
 * .attention-* in styles.css, and keep the two together.
 *
 * These are the dark palette's values in both themes, because the strip an icon is drawn on is the
 * browser's and not the page's: it does not follow prefers-color-scheme, and the brighter set is
 * the one that holds up against either. A favicon also cannot carry the glyph itself — it is emoji
 * on most platforms, and an SVG favicon renders those at whatever size and colour the system font
 * chooses, which is how one vocabulary quietly becomes two.
 */
const TONE_COLOR: Record<MarkTone, string> = {
  blocked: '#f2a93b',
  message: '#4d8dff',
  unseen: '#3ecf73',
  busy: '#6c7684',
  delegating: '#6c7684',
  background: '#343e4c',
  limited: '#f2a93b',
};

/** What the tab shows for a session that wants nothing: the app's own blue. */
const IDLE_COLOR = '#3b82f6';

/**
 * The app icon in one colour: a rounded square with Switchboard's three lines on it.
 *
 * Drawn rather than templated from the tag in index.html, so the shape is identical whatever the
 * state and only the colour moves. Keep it in step with that tag.
 */
function icon(color: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
    `<rect width="32" height="32" rx="7" fill="${color}"/>` +
    `<path d="M8 11h16M8 16h10M8 21h13" stroke="white" stroke-width="3" stroke-linecap="round"/>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function faviconFor(mark: SessionMark | null): string {
  return icon(mark ? TONE_COLOR[mark.tone] : IDLE_COLOR);
}

/** What the tab says when it is not looking at one session; the same pair index.html ships with. */
export function resetTab(): void {
  document.title = 'Switchboard';
  setFavicon(icon(IDLE_COLOR));
}

/**
 * Point the page's icon somewhere.
 *
 * The tag is the one in index.html rather than a second one appended next to it: browsers pick
 * among several `rel="icon"` links by their own rules, and a page that leaves both in place can
 * keep showing the old one.
 */
export function setFavicon(href: string): void {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (link) link.href = href;
}
