import type { Model, Run, UpdateStatus } from '@shared/types.ts';
import { kindLabel, triggerLabel } from '@shared/respawn.ts';
import { modelShort } from '../lib/format.ts';
import { Badge } from './ui.tsx';

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
  if (!model && !settings && !run.staleRunner && !run.waiting) return null;
  return (
    <span className={className ? `run-tags ${className}` : 'run-tags'}>
      {run.waiting && (
        <Badge
          tone="warn"
          title={
            `${kindLabel(run.waiting.kind)} queued — ${triggerLabel(run.waiting.trigger)}: ${run.waiting.reason}. ` +
            `Waiting since ${new Date(run.waiting.since).toLocaleTimeString()} for this turn to end. ` +
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
