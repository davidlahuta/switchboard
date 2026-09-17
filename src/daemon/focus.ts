import { spawn } from 'node:child_process';
import { IS_WINDOWS } from '../config.ts';
import { logger } from '../log.ts';

const log = logger('focus');

/** How long an action waits for the watcher to be ready before it goes ahead regardless. */
const READY_WAIT_MS = 3000;

/*
 * Notes the window in front and the state of every Windows Terminal window, says "ready", then
 * undoes whatever Windows Terminal does to come forward for as long as it keeps doing it: hands the
 * foreground back, minimizes again a window that was minimized, and sends one that was behind
 * other windows back behind them. Windows Terminal has no way to open a tab without summoning its
 * window (1.24 has --maximized, --focus, --pos and --size, and no --minimized), so this is the only
 * place to stop it. It leaves the foreground alone when Windows Terminal already had it (the
 * operator is in it) or when focus goes somewhere else (the operator moved on). AttachThreadInput is
 * what lets a background process set the foreground: joined to the input of the thread that owns
 * it, the call is no longer refused as focus stealing.
 */
const WATCH_SCRIPT = `Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class SwitchboardFocus {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

  const int SW_SHOWMINNOACTIVE = 7;
  const uint GW_HWNDPREV = 3;
  const uint SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOACTIVATE = 0x10;

  class Term { public IntPtr H; public bool Minimized; public IntPtr Above; }
  static IntPtr prev;
  static string prevOwner = "";
  static readonly List<Term> terms = new List<Term>();

  static bool IsTerminal(IntPtr h) {
    var sb = new StringBuilder(64);
    GetClassName(h, sb, sb.Capacity);
    return sb.ToString() == "CASCADIA_HOSTING_WINDOW_CLASS";
  }

  static string Owner(IntPtr h) {
    uint pid;
    GetWindowThreadProcessId(h, out pid);
    try { return Process.GetProcessById((int)pid).ProcessName; } catch { return ""; }
  }

  // The nearest window above h that can be seen: where h goes back to in the z-order.
  static IntPtr VisibleAbove(IntPtr h) {
    for (var w = GetWindow(h, GW_HWNDPREV); w != IntPtr.Zero; w = GetWindow(w, GW_HWNDPREV)) {
      if (IsWindowVisible(w) && !IsIconic(w)) return w;
    }
    return IntPtr.Zero;
  }

  // Before the tab is opened or closed: the window in front, and every terminal window's state.
  public static string Snapshot() {
    prev = GetForegroundWindow();
    prevOwner = Owner(prev);
    EnumWindows((h, l) => {
      if (IsTerminal(h) && IsWindowVisible(h)) terms.Add(new Term { H = h, Minimized = IsIconic(h), Above = VisibleAbove(h) });
      return true;
    }, IntPtr.Zero);
    return prevOwner;
  }

  static bool TakeBack(IntPtr fg) {
    uint pid;
    uint tid = GetWindowThreadProcessId(fg, out pid);
    uint me = GetCurrentThreadId();
    AttachThreadInput(me, tid, true);
    BringWindowToTop(prev);
    SetForegroundWindow(prev);
    AttachThreadInput(me, tid, false);
    return GetForegroundWindow() == prev;
  }

  // Undo whatever Windows Terminal does to come forward, for as long as it keeps doing it.
  public static string Watch(int timeoutMs, int settleMs) {
    if (prev == IntPtr.Zero || IsTerminal(prev)) return "kept: Windows Terminal already had focus";
    var start = DateTime.UtcNow;
    DateTime? lastFix = null;
    int focusFixes = 0, minimized = 0, lowered = 0;
    bool refused = false;
    string movedTo = null;
    while ((DateTime.UtcNow - start).TotalMilliseconds < timeoutMs) {
      if (lastFix.HasValue && (DateTime.UtcNow - lastFix.Value).TotalMilliseconds > settleMs) break;
      Thread.Sleep(15);
      var fg = GetForegroundWindow();
      if (movedTo == null && fg != prev && fg != IntPtr.Zero) {
        if (IsTerminal(fg)) {
          if (!IsWindow(prev)) return "left: the window that had focus is gone";
          if (TakeBack(fg)) { focusFixes++; refused = false; } else refused = true;
          lastFix = DateTime.UtcNow;
        } else {
          // The operator went somewhere else: their choice. The terminal is still put back below.
          movedTo = Owner(fg);
        }
      }
      foreach (var t in terms) {
        if (!IsWindow(t.H)) continue;
        if (t.Minimized) {
          if (!IsIconic(t.H)) { ShowWindow(t.H, SW_SHOWMINNOACTIVE); minimized++; lastFix = DateTime.UtcNow; }
        } else if (t.Above != IntPtr.Zero && IsWindow(t.Above) && IsWindowVisible(t.Above) && VisibleAbove(t.H) != t.Above && lowered < 40) {
          SetWindowPos(t.H, t.Above, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
          lowered++;
          lastFix = DateTime.UtcNow;
        }
      }
    }
    if (refused) return "refused: Windows kept Windows Terminal in front";
    if (!lastFix.HasValue) return movedTo != null ? "left: focus moved to " + movedTo : "kept: Windows Terminal never took focus";
    var what = new List<string>();
    if (focusFixes > 0) what.Add("focus");
    if (minimized > 0) what.Add("minimized again");
    if (lowered > 0) what.Add("sent back behind");
    return "restored " + prevOwner + " (" + string.Join(", ", what) + ")";
  }
}
'@
$owner = [SwitchboardFocus]::Snapshot()
[Console]::Out.WriteLine("ready $owner"); [Console]::Out.Flush()
[SwitchboardFocus]::Watch(5000, 800)`;

/**
 * Do something that makes Windows Terminal come to the front — open a tab, close one — and put the
 * foreground back where it was.
 *
 * Windows Terminal summons its window for every `wt -w <window> new-tab`, and has no option not to:
 * a session relaunched, revived or rebalanced from the web UI yanked the operator out of whatever
 * they were typing into, once per session, which for "new terminal for every session" is ten times.
 * Nothing asked Windows Terminal to come forward except the tab it was given, so the window the
 * operator was in is handed its focus back as soon as Windows Terminal takes it.
 *
 * The action waits for the watcher to have noted the current window, because noting it afterwards
 * would note Windows Terminal. PowerShell is slow to start on a busy desk, so it waits at most
 * READY_WAIT_MS and then goes ahead without the watcher rather than holding a terminal back.
 * SWITCHBOARD_TERMINAL_FOCUS=follow leaves Windows Terminal to take focus as it always did.
 */
export function keepFocus(action: () => void, what: string): void {
  if (!IS_WINDOWS || process.env.SWITCHBOARD_TERMINAL_FOCUS === 'follow') {
    action();
    return;
  }
  let acted = false;
  const act = (): void => {
    if (acted) return;
    acted = true;
    action();
  };
  const timer = setTimeout(() => {
    log.debug('focus watcher was not ready in time; going ahead without it', { what });
    act();
  }, READY_WAIT_MS);
  let out = '';
  const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WATCH_SCRIPT], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  ps.stdout.setEncoding('utf8');
  ps.stdout.on('data', (chunk: string) => {
    out += chunk;
    if (!acted && out.includes('ready')) {
      clearTimeout(timer);
      act();
    }
  });
  ps.on('error', (err) => {
    clearTimeout(timer);
    log.warn('could not start the focus watcher', { what, error: err.message });
    act();
  });
  ps.on('close', () => {
    clearTimeout(timer);
    act();
    const said = out.trim().split(/\r?\n/).pop() ?? '';
    // Every outcome at info: whether this works is only visible after the fact, one line per tab.
    if (said.startsWith('restored')) log.info('put the foreground back after Windows Terminal took it', { what, to: said.slice('restored '.length) });
    else if (said.startsWith('refused')) log.warn('Windows Terminal took the foreground and Windows would not give it back', { what });
    else log.info('left the foreground alone', { what, why: said || 'the watcher said nothing' });
  });
}
