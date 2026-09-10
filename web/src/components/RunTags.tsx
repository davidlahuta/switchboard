import type { Model, Run, UpdateStatus } from '@shared/types.ts';
import { modelShort } from '../lib/format.ts';
import { Badge } from './ui.tsx';

/**
 * What you want to know about a running session at a glance beyond its status: which model it is
 * on, whether its claude build is the one that is installed now, and whether it is running without
 * tool-approval prompts.
 */
export function RunTags({
  run,
  models,
  update,
  className,
}: {
  run: Run;
  models: Model[];
  update: UpdateStatus;
  className?: string;
}) {
  const model = modelShort(run.model, models);
  const latest = update.currentVersion;
  const outdated = !!run.version && !!latest && run.version !== latest;
  if (!model && !run.version && !run.skipPermissions && !run.staleRunner) return null;
  return (
    <span className={className ? `run-tags ${className}` : 'run-tags'}>
      {model && (
        <Badge tone="neutral" title={run.model ? `Model ${run.model}` : undefined}>
          {model}
        </Badge>
      )}
      {run.skipPermissions && (
        <Badge tone="muted" title="Started with --dangerously-skip-permissions: tools run without asking for approval">
          skip tool permissions
        </Badge>
      )}
      {run.version && (
        <span className="mono dim small" title={`Claude Code ${run.version}`}>
          v{run.version}
        </span>
      )}
      {outdated && (
        <Badge tone="warn" title={`Running claude ${run.version}, latest is ${latest} — restart to update`}>
          outdated
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
