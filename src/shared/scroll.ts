/**
 * How Claude Code's full-screen renderer is scrolled from the web terminal, agreed on both ends.
 *
 * The renderer scrolls its own view on wheel reports, and how far one report moves it depends on
 * timing. On Windows a report that follows the last within 5 ms moves one line, and any other moves
 * the terminal's "base", which varies by terminal, or more while its wheel acceleration is ramping.
 * The web terminal turns a finger or trackpad into reports paced by distance, so every one of those
 * rules made the same movement scroll a different amount: slowly in one session, fast in another.
 *
 * Sessions are started with the base fixed (CLAUDE_CODE_SCROLL_SPEED) and acceleration off, and the
 * web terminal sends one report per WHEEL_LINES lines of travel, never two closer than
 * WHEEL_REPORT_GAP_MS. Every report is then exactly WHEEL_LINES lines.
 */
export const WHEEL_LINES = 3;

/** Longer than the 5 ms inside which Claude Code counts a report as a single line. */
export const WHEEL_REPORT_GAP_MS = 8;
