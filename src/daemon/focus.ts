import { spawn } from 'node:child_process';
import { IS_WINDOWS } from '../config.ts';
import { logger } from '../log.ts';

const log = logger('focus');

/** How long an action waits for the watcher to be ready before it goes ahead regardless. */
const READY_WAIT_MS = 3000;

/*
 * Notes the window in front, says "ready", then watches for Windows Terminal to take the foreground
 * and hands it back. It does nothing when Windows Terminal already had focus (the operator is in it),
 * when focus goes somewhere other than Windows Terminal (the operator moved on), or when the window
 * that had it is gone. AttachThreadInput is what lets a background process set the foreground: joined
 * to the input of the thread that owns it, the call is no longer refused as focus stealing.
 */
const WATCH_SCRIPT = [
  'Add-Type @"',
  'using System; using System.Runtime.InteropServices;',
  'public static class SwitchboardFocus {',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  '  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);',
  '  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
  '}',
  '"@',
  'function Owner($h) { $p = 0; [void][SwitchboardFocus]::GetWindowThreadProcessId($h, [ref]$p); try { (Get-Process -Id $p -ErrorAction Stop).ProcessName } catch { "" } }',
  '$prev = [SwitchboardFocus]::GetForegroundWindow()',
  '$prevOwner = Owner $prev',
  '[Console]::Out.WriteLine("ready $prevOwner"); [Console]::Out.Flush()',
  'if ($prev -eq [IntPtr]::Zero -or $prevOwner -eq "WindowsTerminal") { "kept: Windows Terminal already had focus"; exit 0 }',
  '$deadline = [DateTime]::UtcNow.AddSeconds(5)',
  'while ([DateTime]::UtcNow -lt $deadline) {',
  '  Start-Sleep -Milliseconds 100',
  '  $fg = [SwitchboardFocus]::GetForegroundWindow()',
  '  if ($fg -eq $prev -or $fg -eq [IntPtr]::Zero) { continue }',
  '  $owner = Owner $fg',
  '  if ($owner -ne "WindowsTerminal") { "left: focus moved to $owner"; exit 0 }',
  '  if (-not [SwitchboardFocus]::IsWindow($prev)) { "left: the window that had focus is gone"; exit 0 }',
  '  Start-Sleep -Milliseconds 200',
  '  $p = 0; $tid = [SwitchboardFocus]::GetWindowThreadProcessId($fg, [ref]$p); $me = [SwitchboardFocus]::GetCurrentThreadId()',
  '  [void][SwitchboardFocus]::AttachThreadInput($me, $tid, $true)',
  '  [void][SwitchboardFocus]::BringWindowToTop($prev); [void][SwitchboardFocus]::SetForegroundWindow($prev)',
  '  [void][SwitchboardFocus]::AttachThreadInput($me, $tid, $false)',
  '  Start-Sleep -Milliseconds 150',
  '  if ([SwitchboardFocus]::GetForegroundWindow() -eq $prev) { "restored $prevOwner" } else { "refused: Windows kept Windows Terminal in front" }',
  '  exit 0',
  '}',
  '"kept: Windows Terminal never took focus"',
].join('\n');

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
    if (said.startsWith('restored')) log.info('put the foreground back after Windows Terminal took it', { what, to: said.slice('restored '.length) });
    else if (said.startsWith('refused')) log.warn('Windows Terminal took the foreground and Windows would not give it back', { what });
    else log.debug('focus watcher finished', { what, said });
  });
}
