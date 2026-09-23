import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Terminal as XTerm, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WHEEL_LINES, WHEEL_REPORT_GAP_MS } from '@shared/scroll.ts';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { RunStatus, StateSnapshot, TermClientFrame, TermServerFrame } from '@shared/types.ts';
import { sessionMark, tabTitle } from '@shared/marks.ts';
import { RestartMenu } from '../components/RestartMenu.tsx';
import { ResumeButton } from '../components/ResumeButton.tsx';
import { HandoffButton } from '../components/HandoffButton.tsx';
import { SessionName } from '../components/SessionName.tsx';
import { RunTags } from '../components/RunTags.tsx';
import { SwapMenu } from '../components/SwapMenu.tsx';
import { Icon, StatusPill } from '../components/ui.tsx';
import { api, wsUrl } from '../lib/api.ts';
import { href, navigate } from '../lib/router.ts';
import { emitToast } from '../lib/toast.ts';
import { osc52Text } from '../lib/clipboard.ts';
import { faviconFor, resetTab, setFavicon } from '../lib/tabmark.ts';

const FONT = '"Cascadia Code", "JetBrains Mono", Menlo, Consolas, monospace';
const FONT_KEY = 'sb.term.fontSize';

/**
 * The grid that fills the box, all of its width.
 *
 * FitAddon keeps room for a vertical scrollbar whenever the terminal has scrollback, and xterm
 * reports that scrollbar as 15 px wide even when it is not drawn (it falls back to 15 when it
 * measures nothing). This view hides it, so those pixels were a strip of empty space down the
 * right of every session, a column or two lost from the grid. Same arithmetic as FitAddon, less
 * the scrollbar.
 */
function fullWidthDimensions(term: XTerm, fitAddon: FitAddon): { cols: number; rows: number } | undefined {
  const dims = fitAddon.proposeDimensions();
  const cell = (term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width?: number } } } } } })._core?._renderService
    ?.dimensions?.css?.cell?.width;
  const el = term.element;
  const parent = el?.parentElement;
  if (!dims || !cell || !el || !parent) return dims;
  const px = (style: CSSStyleDeclaration, prop: string): number => parseInt(style.getPropertyValue(prop)) || 0;
  const outer = window.getComputedStyle(parent);
  const inner = window.getComputedStyle(el);
  const width = Math.max(0, px(outer, 'width') - px(inner, 'padding-left') - px(inner, 'padding-right'));
  return { cols: Math.max(2, Math.floor(width / cell)), rows: dims.rows };
}
const COMPOSER_KEY = 'sb.term.composer';
const MIN_FONT = 6;
const MAX_FONT = 28;

const THEME: ITheme = {
  background: '#0b0e13',
  foreground: '#d8dee9',
  cursor: '#e6edf3',
  cursorAccent: '#0b0e13',
  selectionBackground: '#2f4a7a',
  black: '#1c2128',
  red: '#ff6b6b',
  green: '#5fd068',
  yellow: '#e8c547',
  blue: '#5aa2ff',
  magenta: '#d38aff',
  cyan: '#4fd1d9',
  white: '#c9d1d9',
  brightBlack: '#6e7681',
  brightRed: '#ff8f8f',
  brightGreen: '#85e89d',
  brightYellow: '#f5d76e',
  brightBlue: '#8cc2ff',
  brightMagenta: '#e2b0ff',
  brightCyan: '#7ee3ea',
  brightWhite: '#f0f6fc',
};

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStorage(key: string, v: string): void {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* ignore */
  }
}

function initialFontSize(): number {
  const v = Number(readStorage(FONT_KEY));
  if (v >= MIN_FONT && v <= MAX_FONT) return v;
  return window.innerWidth < 600 ? 10 : 13;
}

type Conn = 'connecting' | 'open' | 'closed';

interface KeyDef {
  label: string;
  aria: string;
  seq: string | ((app: boolean) => string);
  wide?: boolean;
}

/*
 * Ordered by what a thumb reaches for rather than by what a keyboard looks like. This bar is the one
 * thing on the terminal page that pans sideways, and a key past the fold costs a swipe before it can
 * be pressed — which on a phone made sending a prompt a two-gesture affair, Enter having sat at the
 * far end behind four arrows. It now follows the keys that come before it in use.
 */
const KEYS: KeyDef[] = [
  { label: 'Esc', aria: 'Escape', seq: '\x1b' },
  { label: 'Tab', aria: 'Tab', seq: '\t' },
  { label: '⇧Tab', aria: 'Shift Tab', seq: '\x1b[Z' },
  { label: 'Enter', aria: 'Enter', seq: '\r', wide: true },
  { label: '↑', aria: 'Arrow up', seq: (app) => (app ? '\x1bOA' : '\x1b[A') },
  { label: '↓', aria: 'Arrow down', seq: (app) => (app ? '\x1bOB' : '\x1b[B') },
  { label: '←', aria: 'Arrow left', seq: (app) => (app ? '\x1bOD' : '\x1b[D') },
  { label: '→', aria: 'Arrow right', seq: (app) => (app ? '\x1bOC' : '\x1b[C') },
  { label: 'Ctrl‑C', aria: 'Control C (interrupt)', seq: '\x03', wide: true },
  { label: '/', aria: 'Slash', seq: '/' },
];

export default function TerminalPage({ runId, state }: { runId: string; state: StateSnapshot }) {
  const run = state.runs.find((r) => r.id === runId) ?? null;

  const pageRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const fitOnRef = useRef(false);
  const lastRequested = useRef<{ key: string; at: number } | null>(null);
  const exitedRef = useRef(false);

  const [conn, setConn] = useState<Conn>('connecting');
  const [liveStatus, setLiveStatus] = useState<RunStatus | null>(null);
  const [liveSub, setLiveSub] = useState<string | null>(null);
  const [size, setSize] = useState<{ cols: number; rows: number } | null>(null);
  const [typing, setTyping] = useState<'composer' | 'terminal' | null>(null);
  const [fontSize, setFontSize] = useState(initialFontSize);
  // Fitted on every open, deliberately not remembered: it is a per-screen choice, and the screen
  // you open a session on is rarely the one you last turned it off on.
  const [fit, setFit] = useState(true);
  // Open by default. On a phone the composer is the reliable way to write a prompt: typing into
  // the grid goes through the browser's hidden input, where autocorrect and IME rewrite as they
  // please, and there is nowhere to see what you typed before you send it.
  const [composerOpen, setComposerOpen] = useState(() => readStorage(COMPOSER_KEY) !== '0');
  /** Text the session copied that the browser would not let the page put on the clipboard unasked. */
  const [copyReady, setCopyReady] = useState<string | null>(null);
  const setCopyReadyRef = useRef(setCopyReady);
  setCopyReadyRef.current = setCopyReady;
  const [draft, setDraft] = useState(() => {
    try {
      return sessionStorage.getItem(`sb.term.draft.${runId}`) ?? '';
    } catch {
      return '';
    }
  });

  const status: RunStatus | null = liveStatus ?? run?.status ?? null;
  const subLabel = liveSub ?? run?.subscriptionLabel ?? '';
  const exited = status === 'exited';
  exitedRef.current = exited;

  // ---- sending ----
  const sendFrame = useCallback((f: TermClientFrame): boolean => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(f));
      return true;
    }
    return false;
  }, []);

  const sendInput = useCallback(
    (data: string) => {
      if (!sendFrame({ type: 'input', data })) emitToast('warn', 'Not connected to the session');
    },
    [sendFrame],
  );

  // ---- fit to screen ----
  /**
   * Size the session to the space this page has for it.
   *
   * The terminal is pinned to the bottom of that space at a fixed pixel height rather than filling
   * it, so that when a phone's keyboard takes half the screen the top of the frame is covered and
   * the prompt stays in view. Re-fitting on a keyboard instead would resize the pseudo-terminal
   * twice per message and make the session reflow its whole layout each time.
   */
  const requestFit = useCallback(() => {
    const term = termRef.current;
    const fitAddon = fitAddonRef.current;
    const host = hostRef.current;
    const box = scrollerRef.current;
    if (!term || !fitAddon || !host || !box) return;
    host.style.top = '0';
    host.style.height = '';
    const dims = fullWidthDimensions(term, fitAddon);
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
    const cols = Math.max(20, dims.cols);
    const rows = Math.max(6, dims.rows);
    if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
    host.style.height = `${box.clientHeight}px`;
    host.style.top = 'auto';
    const key = `${cols}x${rows}`;
    lastRequested.current = { key, at: Date.now() };
    setSize({ cols, rows });
    sendFrame({ type: 'resize', cols, rows });
  }, [sendFrame]);

  /** Take the size back from the desktop terminal and fit to this screen again. */
  const takeOver = useCallback(() => {
    setFit(true);
  }, []);

  // ---- xterm lifecycle ----
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new XTerm({
      cols: run?.cols ?? 120,
      rows: run?.rows ?? 30,
      fontFamily: FONT,
      fontSize,
      lineHeight: 1.1,
      theme: THEME,
      cursorBlink: true,
      /*
       * Scrollback, because Claude Code has two renderers and picks one per account. The full-screen
       * one draws on the alternate screen, which has no scrollback whatever this says, and takes
       * the wheel itself through mouse tracking. The plain one writes the conversation into the
       * terminal's own history like any command-line program — and with no history to scroll, the
       * browser turned the wheel into arrow keys, which the session answered with "Scroll wheel is
       * sending arrow keys · use PgUp/PgDn to scroll" and nothing moved.
       */
      scrollback: 10_000,
      allowProposedApi: false,
      macOptionIsMeta: true,
      rightClickSelectsWord: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(
      new WebLinksAddon((_e, uri) => {
        window.open(uri, '_blank', 'noopener,noreferrer');
      }),
    );
    term.open(host);
    termRef.current = term;
    fitAddonRef.current = fitAddon;
    const sub = term.onData((data) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data } satisfies TermClientFrame));
    });

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const ws = wsRef.current;
      // Shift+Enter is a new line, not a submit. A terminal sends a plain carriage return for it
      // unless told otherwise; this is the sequence Claude Code's own /terminal-setup installs.
      if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input', data: '\x1b\r' } satisfies TermClientFrame));
        }
        return false;
      }
      // Ctrl/Cmd+C with text selected in the page (Shift+drag, which the session does not see) copies
      // it, as in any terminal; with nothing selected it is ^C, the session's interrupt.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'c' && term.hasSelection()) {
        e.preventDefault();
        void navigator.clipboard?.writeText(term.getSelection()).catch(() => setCopyReadyRef.current(term.getSelection()));
        term.clearSelection();
        return false;
      }
      // Hand Ctrl/Cmd+V back to the browser. xterm would otherwise claim it and send ^V to the
      // session, which is not a paste anywhere; letting the paste event through reaches xterm's
      // own paste handler, brackets included.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'v') return false;
      return true;
    });
    if (window.matchMedia('(pointer: fine)').matches) term.focus();

    // What the session copies lands on this device's clipboard; see osc52Text.
    term.parser.registerOscHandler(52, (data) => {
      const text = osc52Text(data);
      if (text === null) return true;
      const clipboard = navigator.clipboard;
      if (!clipboard?.writeText) setCopyReadyRef.current(text);
      // A phone's browser may refuse a write it cannot tie to a tap; the key bar then offers one.
      else clipboard.writeText(text).then(() => setCopyReadyRef.current(null), () => setCopyReadyRef.current(text));
      return true;
    });

    /*
     * Scrolling, by distance rather than by event.
     *
     * Claude Code draws one of two ways. The plain renderer writes into the terminal's own history,
     * which xterm scrolls line by line. The full-screen renderer tracks the mouse and scrolls its own
     * view a few lines for every wheel report it receives, and xterm sends one report per wheel
     * event however small or large. So a trackpad, which fires a stream of tiny events, and a drag
     * turned into one wheel event per touchmove, both drove it at the speed of the event stream
     * rather than of the finger: a flick lurched, a slow drag stuttered, and nothing carried on after
     * the finger lifted.
     *
     * So movement is measured in pixels and paid out in whole lines: to xterm's history directly, or
     * to the session as one wheel report per APP_LINES_PER_REPORT lines of travel. A flick keeps
     * going and slows to a stop.
     */
    const screen = host.querySelector('.xterm-screen') ?? host;

    const synthetic = new WeakSet<Event>();
    const tracking = (): boolean => term.modes.mouseTrackingMode !== 'none';
    const rowHeight = (): number => Math.max(8, screen.getBoundingClientRect().height / term.rows || 17);
    let pending = 0; // pixels travelled and not yet scrolled
    /*
     * Wheel reports owed to the session, sent one at a time at least WHEEL_REPORT_GAP_MS apart:
     * two closer than 5 ms are counted by Claude Code as one line, not WHEEL_LINES (shared/scroll.ts).
     */
    let owed = 0;
    let pacer = 0;
    /*
     * Where the reports say the wheel is: the finger, or the pointer. xterm reports a wheel at the
     * cell under it and sends nothing for one outside the grid, and a synthetic event has no position
     * of its own — (0, 0), above the terminal — so every report was dropped and a drag moved nothing.
     * Claude Code may also scroll whatever is under that point, so it has to be the real one.
     */
    let at = { x: 0, y: 0 };
    const aimAt = (x: number, y: number): void => {
      at = { x, y };
    };
    const sendReport = (): void => {
      pacer = 0;
      if (!owed) return;
      const dir = Math.sign(owed);
      owed -= dir;
      const r = screen.getBoundingClientRect();
      const inside = at.x > r.left && at.x < r.right && at.y > r.top && at.y < r.bottom;
      const ev = new WheelEvent('wheel', {
        deltaY: dir,
        deltaMode: WheelEvent.DOM_DELTA_LINE,
        clientX: inside ? at.x : r.left + r.width / 2,
        clientY: inside ? at.y : r.top + r.height / 2,
        bubbles: true,
        cancelable: true,
      });
      synthetic.add(ev);
      screen.dispatchEvent(ev);
      if (owed) pacer = window.setTimeout(sendReport, WHEEL_REPORT_GAP_MS);
    };
    const scrollPixels = (px: number): void => {
      pending += px;
      const perStep = rowHeight() * (tracking() ? WHEEL_LINES : 1);
      const steps = Math.trunc(pending / perStep);
      if (!steps) return;
      pending -= steps * perStep;
      if (!tracking()) {
        term.scrollLines(steps);
        return;
      }
      // A change of direction drops what was owed the other way rather than playing it out first.
      if (owed && Math.sign(owed) !== Math.sign(steps)) owed = 0;
      owed += steps;
      if (!pacer) sendReport();
    };

    // A trackpad or wheel on a session that scrolls itself: paced by distance, like a finger.
    term.attachCustomWheelEventHandler((e) => {
      if (synthetic.has(e) || !tracking()) return true;
      aimAt(e.clientX, e.clientY);
      const px =
        e.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? e.deltaY * rowHeight()
          : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? e.deltaY * rowHeight() * term.rows
            : e.deltaY;
      scrollPixels(px);
      e.preventDefault();
      return false;
    });

    /*
     * Touch, through pointer events.
     *
     * Touch events stay with the element the finger first landed on, and here that is a run of text
     * the session redraws the moment it scrolls: the element is replaced, the rest of the touch goes
     * to a node no longer on the page and never reaches this handler, and the view moved a line or
     * three and stopped — sooner or later depending on when the redraw came. Pointer events are
     * delivered to whatever is under the finger at each move, and the drag captures the pointer once
     * it is recognised, so it keeps coming however the screen changes beneath it.
     *
     * xterm's own touch scrolling gives up the moment a program tracks the mouse, which the
     * full-screen renderer always does. Taps are left alone so the session still receives them; only
     * a deliberate vertical drag is taken, and a drag that moves selection handles belongs to the
     * selection.
     */
    let finger: number | null = null; // the pointer being followed
    let startY = 0;
    let lastY = 0;
    let travelled = 0;
    let dragging = false;
    let samples: Array<{ t: number; y: number }> = [];
    let glide = 0;
    /*
     * Finger movement is collected and applied once per frame. Moves arrive unevenly — two in one
     * frame, none in the next — and applying each as it came moved the view in uneven jumps.
     */
    let moved = 0;
    let moveFrame = 0;
    const flushMove = (): void => {
      moveFrame = 0;
      const px = moved;
      moved = 0;
      if (px) scrollPixels(px);
    };
    const stopGlide = (): void => {
      if (glide) cancelAnimationFrame(glide);
      glide = 0;
      if (moveFrame) cancelAnimationFrame(moveFrame);
      moveFrame = 0;
      moved = 0;
      owed = 0; // a touch stops the view where it is, including reports not yet sent
    };
    const isTouch = (e: PointerEvent): boolean => e.pointerType === 'touch' || e.pointerType === 'pen';
    const onPointerDown = (e: PointerEvent) => {
      if (!isTouch(e)) return;
      stopGlide();
      if (finger !== null) {
        finger = null; // a second finger: a pinch or a two-finger gesture, not a scroll
        return;
      }
      finger = e.pointerId;
      startY = lastY = e.clientY;
      aimAt(e.clientX, e.clientY);
      travelled = 0;
      dragging = false;
      pending = 0;
      samples = [{ t: performance.now(), y: lastY }];
    };
    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerId !== finger) return;
      const y = e.clientY;
      const step = lastY - y;
      lastY = y;
      travelled += Math.abs(step);
      const now = performance.now();
      samples.push({ t: now, y });
      while (samples.length > 2 && now - samples[0].t > 100) samples.shift();
      if (!dragging && travelled < 8) return;
      if (!window.getSelection()?.isCollapsed) return;
      if (!dragging) {
        try {
          host.setPointerCapture(e.pointerId);
        } catch {
          // already released: the move still counts
        }
      }
      e.preventDefault();
      e.stopPropagation();
      // The first frame of a drag carries the distance it took to recognise it as one.
      moved += dragging ? step : startY - y;
      dragging = true;
      if (!moveFrame) moveFrame = requestAnimationFrame(flushMove);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (e.pointerId !== finger) return;
      finger = null;
      if (moveFrame) {
        cancelAnimationFrame(moveFrame);
        flushMove();
      }
      if (e.type === 'pointercancel' || !dragging || samples.length < 2) return;
      const first = samples[0];
      const last = samples[samples.length - 1];
      if (performance.now() - last.t > 60) return; // the finger stopped before it lifted
      let velocity = (first.y - last.y) / Math.max(1, last.t - first.t); // px per ms, in the scrolling direction
      let then = performance.now();
      const frame = (now: number) => {
        const dt = Math.min(50, now - then);
        then = now;
        scrollPixels(velocity * dt);
        velocity *= Math.pow(0.994, dt); // comes to rest in about a second and a half
        glide = Math.abs(velocity) > 0.02 ? requestAnimationFrame(frame) : 0;
      };
      glide = requestAnimationFrame(frame);
    };
    host.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
    host.addEventListener('pointermove', onPointerMove, { capture: true, passive: false });
    host.addEventListener('pointerup', onPointerUp, { capture: true, passive: true });
    host.addEventListener('pointercancel', onPointerUp, { capture: true, passive: true });

    return () => {
      stopGlide();
      window.clearTimeout(pacer);
      host.removeEventListener('pointerdown', onPointerDown, { capture: true });
      host.removeEventListener('pointermove', onPointerMove, { capture: true });
      host.removeEventListener('pointerup', onPointerUp, { capture: true });
      host.removeEventListener('pointercancel', onPointerUp, { capture: true });
      sub.dispose();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const focusTerminal = useCallback(() => termRef.current?.focus(), []);

  /** Which field is live, so the chrome around it can stand down while a keyboard is up. */
  useEffect(() => {
    const ta = termRef.current?.textarea;
    if (!ta) return;
    const on = () => setTyping('terminal');
    const off = () => setTyping((t) => (t === 'terminal' ? null : t));
    ta.addEventListener('focus', on);
    ta.addEventListener('blur', off);
    return () => {
      ta.removeEventListener('focus', on);
      ta.removeEventListener('blur', off);
    };
  }, []);

  /**
   * iOS rubber-bands the document whenever a drag finds nothing to scroll, which on a page that is
   * a single fixed panel is every drag that misses the terminal. Nothing here scrolls the
   * document, so it is held still for as long as this page is open.
   */
  useEffect(() => {
    document.body.classList.add('term-open');
    // Safari and Chrome tint their own bars with this, which is as close to one application as a
    // page in a browser tab gets. Installed to the home screen there are no bars at all.
    const tags = [...document.querySelectorAll('meta[name="theme-color"]')] as HTMLMetaElement[];
    const previous = tags.map((t) => t.content);
    for (const t of tags) t.content = '#0b0e13';
    return () => {
      document.body.classList.remove('term-open');
      tags.forEach((t, i) => (t.content = previous[i]));
    };
  }, []);

  // ---- websocket with reconnect ----
  useEffect(() => {
    let disposed = false;
    let attempt = 0;
    let retry = 0;

    const scrollToBottom = () => {
      const sc = scrollerRef.current;
      if (sc) sc.scrollTop = sc.scrollHeight;
    };
    /**
     * Unfitted, the grid is taller than this box and the prompt sits at its bottom, so the view has
     * to follow it down — otherwise you are looking at the top of the screen with no way to see
     * what you are typing. Only when the reader is already at the bottom: scrolling up to read
     * something must not be undone by the next line of output.
     */
    const keepBottom = () => {
      const sc = scrollerRef.current;
      if (!sc || fitOnRef.current) return;
      const atBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 48;
      if (atBottom) requestAnimationFrame(scrollToBottom);
    };

    const connect = () => {
      if (disposed) return;
      setConn('connecting');
      const ws = new WebSocket(wsUrl(`/ws/term/${encodeURIComponent(runId)}`));
      wsRef.current = ws;
      ws.onopen = () => {
        attempt = 0;
        setConn('open');
      };
      ws.onmessage = (ev) => {
        const term = termRef.current;
        if (!term) return;
        let f: TermServerFrame;
        try {
          f = JSON.parse(String(ev.data)) as TermServerFrame;
        } catch {
          return;
        }
        switch (f.type) {
          case 'snapshot':
            term.reset();
            term.resize(f.cols, f.rows);
            term.write(f.data, () => requestAnimationFrame(scrollToBottom));
            setSize({ cols: f.cols, rows: f.rows });
            if (fitOnRef.current) requestAnimationFrame(requestFit);
            break;
          case 'data':
            term.write(f.data, keepBottom);
            break;
          case 'resize': {
            term.resize(f.cols, f.rows);
            setSize({ cols: f.cols, rows: f.rows });
            keepBottom();
            const lr = lastRequested.current;
            if (fitOnRef.current && lr && lr.key !== `${f.cols}x${f.rows}` && Date.now() - lr.at > 1500) {
              fitOnRef.current = false;
              setFit(false);
              emitToast('info', 'The desktop terminal took the size back');
            }
            break;
          }
          case 'status':
            setLiveStatus(f.status);
            setLiveSub(f.subscriptionLabel);
            // A status arrives when the session comes up and whenever it comes back. Nothing has
            // changed on this end, so the observer that normally speaks for us stays quiet — say the
            // size again, or a session that respawned under this page keeps the console's.
            requestFit();
            break;
        }
      };
      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        if (disposed) return;
        setConn('closed');
        if (exitedRef.current) return;
        attempt++;
        const delay = Math.min(10_000, 400 * 2 ** Math.min(attempt, 5));
        retry = window.setTimeout(connect, delay);
      };
      ws.onerror = () => ws.close();
    };
    connect();

    const onVisible = () => {
      if (document.visibilityState === 'visible' && !wsRef.current && !disposed && !exitedRef.current) {
        window.clearTimeout(retry);
        attempt = 0;
        connect();
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      disposed = true;
      window.clearTimeout(retry);
      document.removeEventListener('visibilitychange', onVisible);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [runId, requestFit]);

  // Reconnect when an exited run comes back (e.g. store says running again).
  useEffect(() => {
    if (run && run.status !== 'exited' && liveStatus === 'exited') setLiveStatus(null);
  }, [run, liveStatus]);

  // ---- font size ----
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    writeStorage(FONT_KEY, String(fontSize));
    if (fitOnRef.current) requestAnimationFrame(requestFit);
  }, [fontSize, requestFit]);

  // ---- fit mode ----
  useEffect(() => {
    fitOnRef.current = fit;
    const host = hostRef.current;
    const box = scrollerRef.current;
    if (!fit) {
      // Following the desktop terminal: the grid is laid out at its own size, so the pixel height
      // pinned for fitted mode has to go or it would crop it.
      if (host) {
        host.style.top = '';
        host.style.height = '';
      }
      return;
    }
    if (!box) return;
    /*
     * Fit whenever the box changes size, rather than once on mount and then on window resizes.
     * On mount the box is often not measurable yet, and a fit that cannot measure leaves the
     * terminal at the size the pseudo-terminal happens to have — larger than the screen, with the
     * bottom of the conversation cut off. Banners appearing and disappearing move it too.
     *
     * A keyboard also shrinks the box, and that must not re-fit: the terminal is pinned to the
     * bottom precisely so the keyboard can cover the top of it without the session reflowing.
     */
    let t = 0;
    const observer = new ResizeObserver(() => {
      const vv = window.visualViewport;
      if (vv && vv.height < window.innerHeight - 80) return;
      window.clearTimeout(t);
      t = window.setTimeout(requestFit, 60);
    });
    observer.observe(box);
    const raf = requestAnimationFrame(requestFit);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t);
      observer.disconnect();
    };
  }, [fit, requestFit]);

  // ---- keep the whole page inside the visual viewport (virtual keyboards) ----
  useEffect(() => {
    const vv = window.visualViewport;
    const el = pageRef.current;
    if (!vv || !el) return;
    const update = () => {
      // The page follows the visible area, so the composer and key bar sit above the keyboard. The
      // terminal keeps the height it was fitted at and is pinned to the bottom, so the keyboard
      // covers the top of the frame rather than reflowing the session.
      el.style.height = `${vv.height}px`;
      el.style.transform = `translateY(${vv.offsetTop}px)`;
      const sc = scrollerRef.current;
      if (sc && !fitOnRef.current) sc.scrollTop = sc.scrollHeight;
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      el.style.height = '';
      el.style.transform = '';
    };
  }, []);

  // ---- misc ----
  /*
   * The browser tab carries the same mark as this session's row in the list and as its native
   * terminal tab: the glyph in the title, from the one definition in shared/marks.ts, and the tone
   * as the icon's colour for when a wall of tabs has squeezed the title away. It follows the mark
   * and not only the name, because what a session wants is the half that changes while you are
   * looking somewhere else.
   */
  const mark = run ? sessionMark(run) : null;
  useEffect(() => {
    document.title = run ? `${tabTitle(run, run.name)} · Switchboard` : 'Session · Switchboard';
    setFavicon(faviconFor(mark));
  }, [run?.name, mark?.glyph, mark?.tone]);
  /*
   * Putting the tab back is its own effect, and runs on the way out only. As the cleanup of the
   * one above it would also run on every mark change — blanking the title and the icon a frame
   * before they were set again, which in a row of tabs is a visible twitch every time a session
   * picks up a subagent. And it puts back what index.html ships with rather than whatever the tab
   * happened to say on mount, which after the first change is this page's own title.
   */
  useEffect(() => resetTab, []);

  useEffect(() => {
    try {
      sessionStorage.setItem(`sb.term.draft.${runId}`, draft);
    } catch {
      /* ignore */
    }
  }, [draft, runId]);

  useEffect(() => writeStorage(COMPOSER_KEY, composerOpen ? '1' : '0'), [composerOpen]);

  // ---- actions ----
  const pressKey = (k: KeyDef) => {
    const app = termRef.current?.modes.applicationCursorKeysMode ?? false;
    sendInput(typeof k.seq === 'function' ? k.seq(app) : k.seq);
  };

  const submitComposer = () => {
    const text = draft.replace(/\r\n?/g, '\n');
    if (!text.trim()) {
      sendInput('\r');
      return;
    }
    const payload = text.includes('\n') ? `\x1b[200~${text.replace(/\n/g, '\r')}\x1b[201~` : text;
    if (!sendFrame({ type: 'input', data: payload })) {
      emitToast('warn', 'Not connected to the session — your text is kept');
      return;
    }
    // Submit separately so the TUI does not treat the Enter as part of the pasted text.
    window.setTimeout(() => sendFrame({ type: 'input', data: '\r' }), 60);
    setDraft('');
    composerRef.current?.focus();
  };

  /**
   * Enter sends where there is a keyboard to hold Shift with; on a phone the return key is the only
   * way to get a new line, and the Send button is an inch away.
   */
  const enterSends = useRef(window.matchMedia('(pointer: fine)').matches);

  const onComposerKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.altKey) return;
    if (e.shiftKey) return; // a new line, in every case
    if (e.ctrlKey || e.metaKey || enterSends.current) {
      e.preventDefault();
      submitComposer();
    }
  };

  const paste = async () => {
    try {
      if (!navigator.clipboard?.readText) throw new Error('unsupported');
      const text = await navigator.clipboard.readText();
      if (!text) {
        emitToast('info', 'Clipboard is empty');
        return;
      }
      // term.paste applies bracketed paste mode and newline conversion, then emits onData.
      termRef.current?.paste(text);
    } catch {
      setComposerOpen(true);
      window.setTimeout(() => composerRef.current?.focus(), 0);
      emitToast('info', 'Clipboard access is blocked here — paste into the composer and press Send');
    }
  };

  const forget = async () => {
    if (await api.del(`/api/runs/${encodeURIComponent(runId)}`)) navigate(href.sessions());
  };

  const keepFocus = (e: React.MouseEvent) => e.preventDefault();

  return (
    <div className="term-page" ref={pageRef} data-typing={typing ?? undefined}>
      <header className="term-head">
        <a className="btn btn-icon btn-ghost" href={href.sessions()} aria-label="Back to sessions" title="Back">
          <Icon name="back" />
        </a>
        <div className="term-title">
          <div className="term-name">{run ? <SessionName run={run} as="div" /> : 'Session'}</div>
          <div className="term-meta">
            {status && <StatusPill status={status} title="Run status" />}
            {run?.agentStatus && status !== 'exited' && <StatusPill status={run.agentStatus} title="Agent status" />}
            <span className="term-sub" title="Subscription">
              {subLabel}
            </span>
            {run && <RunTags run={run} models={state.models} update={state.update} />}
            {size && (
              <span className="term-size mono" title="Terminal size (columns × rows)">
                {size.cols}×{size.rows}
              </span>
            )}
          </div>
        </div>
        <div className="term-tools">
          <button
            type="button"
            className="btn btn-icon btn-ghost"
            onClick={() => setFontSize((s) => Math.max(MIN_FONT, s - 1))}
            aria-label="Smaller text"
            title="Smaller text"
          >
            <span className="aa">A−</span>
          </button>
          <button
            type="button"
            className="btn btn-icon btn-ghost"
            onClick={() => setFontSize((s) => Math.min(MAX_FONT, s + 1))}
            aria-label="Larger text"
            title="Larger text"
          >
            <span className="aa">A+</span>
          </button>
          {run && <HandoffButton run={{ ...run, status: status ?? run.status }} compact onHandoff={() => setFit(false)} />}
          {run && <SwapMenu run={{ ...run, status: status ?? run.status }} subs={state.subscriptions} compact />}
          {run && <RestartMenu run={{ ...run, status: status ?? run.status }} compact />}
        </div>
      </header>

      <div className="term-stage">
        {conn !== 'open' && !exited && (
          <div className="term-banner" role="status">
            {conn === 'connecting' ? 'Connecting…' : 'Connection lost — reconnecting…'}
          </div>
        )}
        {status === 'swapping' && (
          <div className="term-banner term-banner-info" role="status">
            Swapping subscription — the session resumes in a moment…
          </div>
        )}
        {!fit && !exited && (
          <div className="term-banner term-banner-info" role="status">
            <span>Following the desktop terminal, at its size.</span>
            <span className="term-banner-actions">
              <button type="button" className="btn btn-sm" onClick={takeOver}>
                <Icon name="fit" size={14} /> Fit to this screen
              </button>
            </span>
          </div>
        )}
        {status === 'disconnected' && (
          <div className="term-banner term-banner-warn" role="status">
            <span>This session has no terminal — the machine may have been restarted. The conversation is kept.</span>
            {run && (
              <span className="term-banner-actions">
                <ResumeButton run={run} compact />
              </span>
            )}
          </div>
        )}
        {exited && (
          <div className="term-banner term-banner-exited" role="status">
            <span>
              Session exited{run?.exitCode != null ? ` (code ${run.exitCode})` : ''}. The conversation is kept — resuming
              opens a new terminal on it.
            </span>
            <span className="term-banner-actions">
              {run && <ResumeButton run={run} compact />}
              <a className="btn btn-sm" href={href.sessions()}>
                Sessions
              </a>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => void forget()}>
                Forget
              </button>
            </span>
          </div>
        )}
        {!run && (
          <div className="term-banner term-banner-warn" role="status">
            This session is not in the list of runs. Showing whatever the daemon streams.
          </div>
        )}
        <div className={fit ? 'term-scroller fit' : 'term-scroller'} ref={scrollerRef}>
          <div className={fit ? 'term-host fit' : 'term-host'} ref={hostRef} />
        </div>
      </div>

      {composerOpen && (
        <div className="term-composer">
          <textarea
            ref={composerRef}
            className="input composer-input mono"
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onComposerKey}
            onFocus={() => setTyping('composer')}
            onBlur={() => setTyping((t) => (t === 'composer' ? null : t))}
            placeholder={enterSends.current ? 'Type a prompt… (Enter sends, Shift+Enter for a new line)' : 'Type a prompt… (Ctrl+Enter sends)'}
            aria-label="Prompt composer"
            autoCapitalize="sentences"
            disabled={exited}
          />
          <button type="button" className="btn btn-primary btn-send" onClick={submitComposer} disabled={exited} aria-label="Send prompt">
            <Icon name="send" size={16} />
          </button>
        </div>
      )}

      <nav className="keybar" aria-label="Terminal keys">
        <button
          type="button"
          className={composerOpen ? 'key key-tool is-on' : 'key key-tool'}
          onMouseDown={keepFocus}
          onClick={() => setComposerOpen((o) => !o)}
          aria-pressed={composerOpen}
          aria-label="Toggle composer"
          title="Composer"
        >
          <Icon name="message" size={16} />
        </button>
        <button
          type="button"
          className="key key-tool"
          onMouseDown={keepFocus}
          onClick={focusTerminal}
          aria-label="Type directly in the terminal (opens the keyboard)"
          title="Type in terminal"
        >
          ⌨
        </button>
        {KEYS.map((k) => (
          <button
            key={k.aria}
            type="button"
            className={k.wide ? 'key key-wide' : 'key'}
            onMouseDown={keepFocus}
            onClick={() => pressKey(k)}
            aria-label={k.aria}
            disabled={exited}
          >
            {k.label}
          </button>
        ))}
        {copyReady !== null && (
          <button
            type="button"
            className="key key-wide key-ready"
            onMouseDown={keepFocus}
            onClick={() => {
              void navigator.clipboard?.writeText(copyReady).then(
                () => emitToast('success', 'Copied'),
                () => emitToast('error', 'This browser would not allow copying'),
              );
              setCopyReady(null);
            }}
            aria-label="Copy the selection"
          >
            <Icon name="copy" size={14} /> Copy
          </button>
        )}
        <button type="button" className="key key-wide" onMouseDown={keepFocus} onClick={() => void paste()} aria-label="Paste from clipboard" disabled={exited}>
          <Icon name="paste" size={14} /> Paste
        </button>
      </nav>
    </div>
  );
}
