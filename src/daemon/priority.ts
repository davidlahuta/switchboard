import { execFile } from 'node:child_process';
import os from 'node:os';
import { IS_WINDOWS } from '../config.ts';
import { logger } from '../log.ts';

const log = logger('priority');

/*
 * Memory priority and I/O priority, read and set on this process by pid. Node has no API for
 * either, so a one-shot PowerShell does it. ProcessPagePriority is information class 39 (5 is
 * normal), ProcessIoPriority is 33 (2 is normal); the handle needs query and set rights.
 */
const RAISE_SCRIPT = (target: number): string =>
  [
    'Add-Type @"',
    'using System; using System.Runtime.InteropServices;',
    'public static class SwitchboardPriority {',
    '  [DllImport("ntdll.dll")] public static extern int NtQueryInformationProcess(IntPtr h, int cls, ref int info, int len, out int ret);',
    '  [DllImport("ntdll.dll")] public static extern int NtSetInformationProcess(IntPtr h, int cls, ref int info, int len);',
    '  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(int access, bool inherit, int procId);',
    '  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);',
    '}',
    '"@',
    `$h = [SwitchboardPriority]::OpenProcess(0x0600, $false, ${target})`,
    'if ($h -eq [IntPtr]::Zero) { "cannot-open"; exit 1 }',
    '$m = 0; $i = 0; $r = 0',
    '[void][SwitchboardPriority]::NtQueryInformationProcess($h, 39, [ref]$m, 4, [ref]$r)',
    '[void][SwitchboardPriority]::NtQueryInformationProcess($h, 33, [ref]$i, 4, [ref]$r)',
    '$before = "$m/$i"',
    'if ($m -lt 5) { $v = 5; [void][SwitchboardPriority]::NtSetInformationProcess($h, 39, [ref]$v, 4) }',
    'if ($i -lt 2) { $v = 2; [void][SwitchboardPriority]::NtSetInformationProcess($h, 33, [ref]$v, 4) }',
    '[void][SwitchboardPriority]::NtQueryInformationProcess($h, 39, [ref]$m, 4, [ref]$r)',
    '[void][SwitchboardPriority]::NtQueryInformationProcess($h, 33, [ref]$i, 4, [ref]$r)',
    '[void][SwitchboardPriority]::CloseHandle($h)',
    '"$before -> $m/$i"',
  ].join('\n');

/**
 * Run the daemon at normal CPU, memory and I/O priority, however it came to be started.
 *
 * The logon task used to register at Task Scheduler's default priority 7, which starts a process
 * below normal on CPU and at low memory and low I/O priority, and everything that task starts
 * inherits all three. On a desk short of memory that made the daemon the first process Windows
 * paged out and the last whose page-ins it served: every session's hooks timed out, and the web
 * page would not load.
 *
 * The task is registered at normal priority now, and that was not enough, which is why this exists.
 * A task definition only applies when the task starts, and the supervisor loop it starts runs for as
 * long as the desk stays logged in — so a supervisor started at yesterday's logon went on launching
 * every daemon restart at low priority, today, under a task that said normal. And raising the CPU
 * class alone does not help: measured, a process lowered like that and then set back to a normal
 * class keeps its low memory and I/O priority. So the daemon puts all three right itself, at start.
 *
 * Deliberately fire-and-forget. PowerShell is slow to start on a machine that is paging, and the
 * daemon has hooks to answer in the meantime; the CPU class, which Node can set directly, goes first.
 */
export function ensureNormalPriority(): void {
  if (!IS_WINDOWS) return;
  try {
    os.setPriority(0, os.constants.priority.PRIORITY_NORMAL);
  } catch (err) {
    log.warn('could not set a normal CPU priority', err instanceof Error ? err.message : err);
  }
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', RAISE_SCRIPT(process.pid)],
    { windowsHide: true, timeout: 180_000 },
    (err, stdout) => {
      const said = (stdout ?? '').trim().split(/\r?\n/).pop() ?? '';
      if (err || !said.includes('->')) {
        log.warn('could not set normal memory and I/O priority', err instanceof Error ? err.message.split('\n')[0] : said);
        return;
      }
      const [before, after] = said.split('->').map((x) => x.trim());
      if (before !== after) log.info('raised to normal memory and I/O priority', { memoryIo: said, note: 'the process that started the daemon was running at low priority' });
      else log.debug('memory and I/O priority already normal', { memoryIo: after });
    },
  );
}
