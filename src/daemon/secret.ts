import { execFile } from 'node:child_process';
import { IS_WINDOWS } from '../config.ts';
import { logger } from '../log.ts';

const log = logger('secret');

/*
 * Secrets at rest, sealed to this Windows user with DPAPI.
 *
 * Node has no binding for it, so Windows PowerShell 5.1 does the work: it is on every Windows install
 * and its System.Security assembly carries ProtectedData. The secret goes in on stdin and comes out on
 * stdout, never on a command line, where any process could read it. A few hundred milliseconds a
 * call, which is fine for something done when a desk joins or a credential is saved, and the callers
 * keep what they unseal in memory rather than asking again.
 *
 * Elsewhere, or if PowerShell cannot do it, protect answers null and the caller decides what to do
 * with plain text — the data directory is the user's own either way.
 */

const SCRIPT_PROTECT =
  "Add-Type -AssemblyName System.Security; $t=[Console]::In.ReadToEnd(); $b=[Text.Encoding]::UTF8.GetBytes($t); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))";
const SCRIPT_UNPROTECT =
  "Add-Type -AssemblyName System.Security; $t=[Console]::In.ReadToEnd().Trim(); $b=[Convert]::FromBase64String($t); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))";

function powershell(script: string, input: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          log.warn('DPAPI call failed', err.message);
          resolve(null);
          return;
        }
        resolve(stdout.replace(/\r?\n$/, ''));
      },
    );
    child.stdin?.end(input);
  });
}

/** Seal a secret to this Windows user, or null when that is not possible here. */
export async function protect(text: string): Promise<string | null> {
  if (!IS_WINDOWS) return null;
  const out = await powershell(SCRIPT_PROTECT, text);
  return out && /^[A-Za-z0-9+/=]+$/.test(out) ? out : null;
}

/** Open a sealed secret, or null when it cannot be (another user, another machine, corrupt). */
export async function unprotect(sealed: string): Promise<string | null> {
  if (!IS_WINDOWS) return null;
  return powershell(SCRIPT_UNPROTECT, sealed);
}
