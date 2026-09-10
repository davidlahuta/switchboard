import type { Model, Run, UpdateStatus } from '@shared/types.ts';
import { modelShort } from '../lib/format.ts';
import { Badge } from './ui.tsx';

/**
 * The two things you want to know about a running session at a glance beyond its status: which
 * model it is on, and whether its claude build is the one that is installed now.
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
  if (!model && !run.version) return null;
  return (
    <span className={className ? `run-tags ${className}` : 'run-tags'}>
      {model && (
        <Badge tone="neutral" title={run.model ? `Model ${run.model}` : undefined}>
          {model}
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
