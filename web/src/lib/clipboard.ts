/**
 * The text of an OSC 52 "set clipboard" request (`c;<base64>`), or null for anything else.
 *
 * Claude Code copies a selection by writing the machine's clipboard — the desk's, here — and by
 * sending this to the terminal, which is the only way the text reaches a terminal somewhere else.
 * xterm ignores it unless told otherwise, so nothing selected in the web terminal ever reached the
 * clipboard of the computer or phone it was selected on. A request to read the clipboard ("?") is
 * never answered: a session has no business reading the viewer's clipboard.
 */
export function osc52Text(data: string): string | null {
  const semi = data.indexOf(';');
  if (semi < 0) return null;
  const payload = data.slice(semi + 1);
  if (!payload || payload === '?') return null;
  try {
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}
