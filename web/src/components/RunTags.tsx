import type { Model, Run, UpdateStatus } from '@shared/types.ts';
import { kindLabel, triggerLabel, workSummary } from '@shared/respawn.ts';
import { QUIET_NOTE_MS, QUIET_WARN_MS, quietMs, runningWork, scheduledWork, workLines } from '../lib/activity.ts';
import { modelShort } from '../lib/format.ts';
import { clockTime, formatDuration } from '../lib/time.ts';
import { Badge, Icon } from './ui.tsx';

/**
 * What you want to know about a running session at a glance beyond its status: which model it is
 * on, whether its claude build is the one that is installed now, and whether it is running without
 * tool-approval prompts.
 *
 * `compact` keeps a row to one line by dropping everything the session merely *is* — how it was
 * configured, which build it runs — and keeping only what is unusual about it. Those settings are
 * the same on nearly every session, so repeating them down a list says nothing while costing the
 * width that the name and the exceptions need. The sessions table, where a row is read one at a
 * time, still shows them all.
 */
export function RunTags({
  run,
  models,
  update,
  className,
  compact,
}: {
  run: Run;
  models: Model[];
  update: UpdateStatus;
  className?: string;
  compact?: boolean;
}) {
  const model = modelShort(run.model, models);
  const latest = update.currentVersion;
  const outdated = !!run.version && !!latest && run.version !== latest;
  const settings = !compact && (run.skipPermissions || run.continueOnResume || !!run.version);
  const now = Date.now();
  const running = runningWork(run);
  const booked = scheduledWork(run);
  const work = workSummary(running);
  const next = booked.slice().sort((a, b) => (a.until ?? '9999').localeCompare(b.until ?? '9999'))[0];
  /*
   * A working session that has written nothing for a while: in a long foreground command, thinking,
   * or stuck. Which of those it is takes a look, and this is what says a look is worth taking.
   */
  const quiet = run.status !== 'exited' && run.agentStatus === 'working' ? quietMs(run, now) : 0;
  // Which machine it runs on, said only when that is not the hub: on a desk of one it is noise.
  const remote = run.deskId && run.deskId !== 'local';
  if (!remote && !model && !settings && !run.staleRunner && !run.waiting && !work && !next && !run.stalled && quiet < QUIET_NOTE_MS) return null;
  return (
    <span className={className ? `run-tags ${className}` : 'run-tags'}>
      {remote && (
        <Badge
          tone={run.deskOffline ? 'warn' : 'accent'}
          title={
            run.deskOffline
              ? `${run.deskName} is offline (asleep, away, or its agent stopped). The session is kept there and reattaches when the desk is back.`
              : `Runs on the desk ${run.deskName}; its folder is a path there.`
          }
        >
          <Icon name="desk" size={12} /> {run.deskName}
          {run.deskOffline ? ' · offline' : ''}
        </Badge>
      )}
      {run.stalled && (
        <Badge
          tone="warn"
          title={
            `Its last turn ended on ${run.stalled.reason} rather than on an answer, at ${new Date(run.stalled.since).toLocaleTimeString()}. ` +
            (run.stalled.nextTry
              ? `It is told to carry on again at ${new Date(run.stalled.nextTry).toLocaleTimeString()}${run.stalled.tries > 0 ? `, after ${run.stalled.tries} ${run.stalled.tries === 1 ? 'try' : 'tries'}` : ''}.`
              : 'It has been asked as often as it is worth asking, so it is waiting for you.') +
            ' A turn that ends properly clears this.'
          }
        >
          {run.stalled.nextTry ? `stalled · ${run.stalled.reason}` : `needs you · ${run.stalled.reason}`}
        </Badge>
      )}
      {quiet >= QUIET_NOTE_MS && (
        <Badge
          tone={quiet >= QUIET_WARN_MS ? 'warn' : 'muted'}
          title={
            `Working, and nothing written to its transcript for ${formatDuration(quiet)}` +
            (run.lastTool ? ` — last in ${run.lastTool}.` : '.') +
            ' A long foreground command or a long think looks like this; so does a session that is stuck. Open its terminal to tell which.'
          }
        >
          {run.lastTool ? `${run.lastTool} · ` : ''}quiet {formatDuration(quiet)}
        </Badge>
      )}
      {work && (
        <Badge
          tone="accent"
          title={
            `Still running:
${workLines(running, now)}

` +
            'A session reports itself idle when its own turn ends, so this is what it is still waiting on. ' +
            'A queued restart, swap or new terminal waits for subagents and workflows, and for background shells and monitors too ' +
            'unless the session is stuck on a limit or has lost its terminal.'
          }
        >
          {work}
        </Badge>
      )}
      {next && (
        <Badge
          tone="muted"
          title={
            `Booked to start again on its own:
${workLines(booked, now)}

` +
            'It is idle meanwhile and spends nothing. A queued restart, swap or new terminal does not wait for these.'
          }
        >
          ⏰ {next.kind === 'wakeup' ? 'loop' : 'scheduled'}
          {next.until ? ` ${clockTime(next.until)}` : ''}
          {booked.length > 1 ? ` +${booked.length - 1}` : ''}
        </Badge>
      )}
      {run.waiting && (
        <Badge
          tone="warn"
          title={
            `${kindLabel(run.waiting.kind)} queued — ${triggerLabel(run.waiting.trigger)}: ${run.waiting.reason}. ` +
            `Waiting since ${new Date(run.waiting.since).toLocaleTimeString()} for the session to be free — now: ${run.waiting.holding}. ` +
            (run.waiting.deadline
              ? `It happens regardless at ${new Date(run.waiting.deadline).toLocaleTimeString()}.`
              : 'It waits however long the turn takes.')
          }
        >
          {kindLabel(run.waiting.kind)} queued · {triggerLabel(run.waiting.trigger)}
        </Badge>
      )}
      {model && (
        <Badge tone="neutral" title={run.model ? `Model ${run.model}` : undefined}>
          {model}
        </Badge>
      )}
      {!compact && run.skipPermissions && (
        <Badge tone="muted" title="Started with --dangerously-skip-permissions: tools run without asking for approval">
          skip tool permissions
        </Badge>
      )}
      {!compact && run.version && (
        <span className="mono dim small" title={`Claude Code ${run.version}`}>
          v{run.version}
        </span>
      )}
      {outdated && (
        <Badge tone="warn" title={`Running claude ${run.version}, latest is ${latest} — restart to update`}>
          outdated
        </Badge>
      )}
      {!compact && run.continueOnResume && (
        <Badge tone="accent" title="This session is told to carry on whenever it comes back — after a swap, a restart, a relaunch or a resume">
          auto-continue
        </Badge>
      )}
      {run.staleRunner && (
        <Badge tone="warn" title="The window hosting this session was opened before the current Switchboard code was written. Relaunch it in a new terminal to pick the change up.">
          old host
        </Badge>
      )}
    </span>
  );
}

/**
 * A small mark beside a session's name for one that is told to carry on when it comes back — after
 * a restart, a swap, a relaunch or a revive. Shown in the lists, where the full tag is dropped for
 * width, because which sessions pick themselves up after a restart is the first thing to know on
 * opening the desk.
 */
export function AutoContinueMark({ run }: { run: Run }) {
  if (!run.continueOnResume) return null;
  return (
    <span className="auto-continue" title="Auto-continue: told to carry on whenever it comes back (restart, swap, relaunch, revive)" aria-label="Auto-continue on">
      <Icon name="refresh" size={12} />
    </span>
  );
}

/** Extra `claude` arguments this session was launched with, as an expander. */
export function RunArgs({ args }: { args: string[] }) {
  if (args.length === 0) return null;
  return (
    <details className="collapse args-collapse">
      <summary>
        {args.length} extra argument{args.length === 1 ? '' : 's'}
      </summary>
      <div className="chips">
        {args.map((a, i) => (
          <span className="chip" key={`${i}-${a}`} title={a}>
            {a === '' ? '""' : a}
          </span>
        ))}
      </div>
    </details>
  );
}
