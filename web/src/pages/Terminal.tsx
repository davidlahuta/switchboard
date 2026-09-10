import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Terminal as XTerm, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { RunStatus, StateSnapshot, TermClientFrame, TermServerFrame } from '@shared/types.ts';
import { RestartMenu } from '../components/RestartMenu.tsx';
import { HandoffButton } from '../components/HandoffButton.tsx';
import { SessionName } from '../components/SessionName.tsx';
import { RunTags } from '../components/RunTags.tsx';
import { SwapMenu } from '../components/SwapMenu.tsx';
import { Icon, StatusPill } from '../components/ui.tsx';
import { api, wsUrl } from '../lib/api.ts';
import { href, navigate } from '../lib/router.ts';
import { emitToast } from '../lib/toast.ts';

const FONT = '"Cascadia Code", "JetBrains Mono", Menlo, Consolas, monospace';
const FONT_KEY = 'sb.term.fontSize';
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

const KEYS: KeyDef[] = [
  { label: 'Esc', aria: 'Escape', seq: '\x1b' },
  { label: 'Tab', aria: 'Tab', seq: '\t' },
  { label: '⇧Tab', aria: 'Shift Tab', seq: '\x1b[Z' },
  { label: '↑', aria: 'Arrow up', seq: (app) => (app ? '\x1bOA' : '\x1b[A') },
  { label: '↓', aria: 'Arrow down', seq: (app) => (app ? '\x1bOB' : '\x1b[B') },
  { label: '←', aria: 'Arrow left', seq: (app) => (app ? '\x1bOD' : '\x1b[D') },
  { label: '→', aria: 'Arrow right', seq: (app) => (app ? '\x1bOC' : '\x1b[C') },
  { label: 'Enter', aria: 'Enter', seq: '\r', wide: true },
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
  const [fontSize, setFontSize] = useState(initialFontSize);
  // Fitted on every open, deliberately not remembered: it is a per-screen choice, and the screen
  // you open a session on is rarely the one you last turned it off on.
  const [fit, setFit] = useState(true);
  // Open by default. On a phone the composer is the reliable way to write a prompt: typing into
  // the grid goes through the browser's hidden input, where autocorrect and IME rewrite as they
  // please, and there is nowhere to see what you typed before you send it.
  const [composerOpen, setComposerOpen] = useState(() => readStorage(COMPOSER_KEY) !== '0');
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
    const dims = fitAddon.proposeDimensions();
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
      // No scrollback. This view mirrors a TUI that repaints its own frame: scrolling away from
      // that frame shows history the session is about to overwrite, and leaves a scrollbar that
      // does nothing useful. The desktop terminal keeps its own scrollback.
      scrollback: 0,
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
    if (window.matchMedia('(pointer: fine)').matches) term.focus();

    /**
     * Drag to scroll, by turning the drag into the wheel events xterm already knows what to do
     * with — which, while the session is tracking the mouse, means handing them to it so it
     * scrolls its own view, exactly as a mouse wheel does on the desktop.
     *
     * xterm has touch scrolling of its own but gives up the moment a program tracks the mouse,
     * which Claude Code's interface always does. The touch then reached Safari with nothing to
     * scroll and it bounced the whole page instead. Taps are left alone so the session still
     * receives them; only a deliberate vertical drag is taken, and taking it stops the bounce.
     */
    const screen = host.querySelector('.xterm-screen') ?? host;
    let anchor = 0;
    let travelled = 0;
    let dragging = false;
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      anchor = e.touches[0].clientY;
      travelled = 0;
      dragging = false;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const y = e.touches[0].clientY;
      const step = anchor - y;
      anchor = y;
      travelled += Math.abs(step);
      if (!dragging && travelled < 8) return;
      dragging = true;
      e.preventDefault();
      e.stopPropagation();
      screen.dispatchEvent(new WheelEvent('wheel', { deltaY: step, deltaMode: 0, bubbles: true, cancelable: true }));
    };
    host.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
    host.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });

    return () => {
      host.removeEventListener('touchstart', onTouchStart, { capture: true });
      host.removeEventListener('touchmove', onTouchMove, { capture: true });
      sub.dispose();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * iOS rubber-bands the document whenever a drag finds nothing to scroll, which on a page that is
   * a single fixed panel is every drag that misses the terminal. Nothing here scrolls the
   * document, so it is held still for as long as this page is open.
   */
  useEffect(() => {
    document.body.classList.add('term-open');
    return () => document.body.classList.remove('term-open');
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

  // ---- fit mode + window resize ----
  useEffect(() => {
    fitOnRef.current = fit;
    if (!fit) {
      // Following the desktop terminal: the grid is laid out at its own size, so the pixel height
      // pinned for fitted mode has to go or it would crop it.
      const host = hostRef.current;
      if (host) {
        host.style.top = '';
        host.style.height = '';
      }
      return;
    }
    const raf = requestAnimationFrame(requestFit);
    let t = 0;
    // Width, not height: on a phone the height changes every time the keyboard opens, and the
    // terminal must not be resized for that. Rotating or resizing a window changes the width.
    let lastWidth = window.innerWidth;
    const onResize = () => {
      const width = window.innerWidth;
      const widthChanged = width !== lastWidth;
      lastWidth = width;
      if (!widthChanged && window.visualViewport && window.visualViewport.height < window.innerHeight - 80) return;
      window.clearTimeout(t);
      t = window.setTimeout(requestFit, 150);
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
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
  useEffect(() => {
    const prev = document.title;
    document.title = `${run?.name ?? 'Session'} · Switchboard`;
    return () => {
      document.title = prev;
    };
  }, [run?.name]);

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

  const onComposerKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
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
    <div className="term-page" ref={pageRef}>
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
            The runner is disconnected. Waiting for it to come back…
          </div>
        )}
        {exited && (
          <div className="term-banner term-banner-exited" role="status">
            <span>
              Session exited{run?.exitCode != null ? ` (code ${run.exitCode})` : ''}.
            </span>
            <span className="term-banner-actions">
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
            placeholder="Type a prompt… (Ctrl+Enter sends)"
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
          onClick={() => termRef.current?.focus()}
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
        <button type="button" className="key key-wide" onMouseDown={keepFocus} onClick={() => void paste()} aria-label="Paste from clipboard" disabled={exited}>
          <Icon name="paste" size={14} /> Paste
        </button>
      </nav>
    </div>
  );
}
