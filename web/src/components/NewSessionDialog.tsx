import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import type { CreateRunRequest, RecentSession, Run, StateSnapshot } from '@shared/types.ts';
import { ApiError, request } from '../lib/api.ts';
import { parseArgv, reservedArgs } from '../lib/argv.ts';
import { contextLabel, subUsageShort, tokensShort, usableSubs } from '../lib/format.ts';
import { navigate, href } from '../lib/router.ts';
import { timeAgo } from '../lib/time.ts';
import { emitToast } from '../lib/toast.ts';
import { Dialog } from './ui.tsx';

const COMPACT_MIN = 20_000;
const COMPACT_MAX = 990_000;
const COMPACT_STEP = 10_000;

/** Loose on purpose: the daemon owns the real check, this only catches obvious typos. */
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function NewSessionDialog({
  open,
  onClose,
  state,
  initialCwd,
}: {
  open: boolean;
  onClose: () => void;
  state: StateSnapshot;
  initialCwd?: string;
}) {
  const listId = useId();
  const fieldId = useId();
  const [cwd, setCwd] = useState('');
  const [sub, setSub] = useState('auto');
  const [name, setName] = useState('');
  const [worktree, setWorktree] = useState('');
  /** Picked from the recent list. Always a session GUID, never a title. */
  const [resumePick, setResumePick] = useState('');
  /** Pasted by hand. Wins over the list when both are set. */
  const [resumeTyped, setResumeTyped] = useState('');
  const [autoSwap, setAutoSwap] = useState(state.settings.autoSwap);
  const [model, setModel] = useState('');
  const [autoCompact, setAutoCompact] = useState(state.settings.defaultAutoCompact);
  const [compactTokens, setCompactTokens] = useState(state.settings.defaultAutoCompactTokens);
  const [argsText, setArgsText] = useState('');
  const [recent, setRecent] = useState<RecentSession[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advOpen, setAdvOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCwd(initialCwd ?? state.repos[0]?.root ?? '');
    setSub('auto');
    setName('');
    setWorktree('');
    setResumePick('');
    setResumeTyped('');
    setAutoSwap(state.settings.autoSwap);
    // "" means "leave it to the daemon", which applies the default from Settings.
    setModel('');
    setAutoCompact(state.settings.defaultAutoCompact);
    setCompactTokens(state.settings.defaultAutoCompactTokens);
    setArgsText('');
    setError(null);
    setAdvOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // recent sessions for the chosen directory (debounced)
  useEffect(() => {
    if (!open) return;
    setRecent(null);
    setResumePick('');
    const dir = cwd.trim();
    if (!dir) return;
    let cancelled = false;
    const t = window.setTimeout(() => {
      request<RecentSession[]>('GET', `/api/sessions/recent?cwd=${encodeURIComponent(dir)}`)
        .then((r) => !cancelled && setRecent(Array.isArray(r) ? r : []))
        .catch(() => !cancelled && setRecent([]));
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [cwd, open]);

  const subs = usableSubs(state.subscriptions);
  const models = state.models;
  const selectedModel = models.find((m) => m.id === model) ?? null;

  const parsed = useMemo(() => parseArgv(argsText), [argsText]);
  const reserved = useMemo(() => reservedArgs(parsed.args), [parsed.args]);

  const typed = resumeTyped.trim();
  const resumeId = typed || resumePick;
  const typedLooksWrong = typed.length > 0 && !GUID_RE.test(typed);
  const resumedTitle = recent?.find((r) => r.id === resumeId)?.title ?? null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const dir = cwd.trim();
    if (!dir) {
      setError('Choose a directory.');
      return;
    }
    const body: CreateRunRequest = {
      cwd: dir,
      subscriptionId: sub,
      autoSwap,
      autoCompact,
      autoCompactTokens: clampTokens(compactTokens),
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(worktree.trim() && !resumeId ? { worktree: worktree.trim() } : {}),
      // Sessions are addressed by GUID; the title next to it is only a label.
      ...(resumeId ? { resumeSessionId: resumeId } : {}),
      ...(model ? { model } : {}),
      ...(parsed.args.length ? { args: parsed.args } : {}),
    };
    setBusy(true);
    setError(null);
    try {
      const run = await request<Run>('POST', '/api/runs', body);
      emitToast('success', `Started ${run.name} on ${run.subscriptionLabel}`);
      onClose();
      navigate(href.terminal(run.id));
    } catch (err) {
      // The daemon rejects arguments it manages itself with a 400 that explains which ones;
      // that message is far more useful than a generic toast, so it stays in the dialog — and the
      // fields it is about get revealed, since Advanced starts collapsed.
      setError(err instanceof ApiError || err instanceof Error ? err.message : String(err));
      if (parsed.args.length > 0 || typed) setAdvOpen(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New session"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="new-session-form" className="btn btn-primary" disabled={busy || !cwd.trim()}>
            {busy ? 'Starting…' : 'Start session'}
          </button>
        </>
      }
    >
      <form id="new-session-form" className="form" onSubmit={submit}>
        <label className="field">
          <span className="field-label">Directory</span>
          <input
            type="text"
            className="input mono"
            list={listId}
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="C:\\src\\my-repo"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            required
          />
          <datalist id={listId}>
            {state.repos.map((r) => (
              <option key={r.id} value={r.root}>
                {r.name}
              </option>
            ))}
          </datalist>
        </label>

        <label className="field">
          <span className="field-label">Subscription</span>
          <select className="input" value={sub} onChange={(e) => setSub(e.target.value)}>
            <option value="auto">Auto (most headroom)</option>
            {subs.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} — {subUsageShort(s)}
              </option>
            ))}
          </select>
          {subs.length === 0 && <span className="field-hint warn">No ready subscriptions. Add or log in on the Subscriptions page.</span>}
        </label>

        <div className="field-row">
          <label className="field">
            <span className="field-label">Name <span className="optional">optional</span></span>
            <input type="text" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="auth refactor" />
          </label>
          <label className="field">
            <span className="field-label">New worktree <span className="optional">optional</span></span>
            <input
              type="text"
              className="input mono"
              value={worktree}
              onChange={(e) => setWorktree(e.target.value)}
              placeholder="feature-x"
              autoCapitalize="off"
              spellCheck={false}
              disabled={!!resumeId}
            />
          </label>
        </div>

        <label className="field">
          <span className="field-label">Model</span>
          <select className="input" value={model} onChange={(e) => setModel(e.target.value)} disabled={models.length === 0}>
            <option value="">Default (from settings)</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName} — {contextLabel(m)}
              </option>
            ))}
          </select>
          {models.length === 0 ? (
            <span className="field-hint">Model list unavailable — the default is used.</span>
          ) : selectedModel ? (
            <span className="field-hint">
              {contextLabel(selectedModel)}
              {selectedModel.maxOutputTokens ? ` · up to ${tokensShort(selectedModel.maxOutputTokens)} output` : ''}
            </span>
          ) : (
            <span className="field-hint">
              {state.settings.defaultModel
                ? `Settings default: ${state.settings.defaultModel}`
                : 'Settings has no default, so Claude Code picks the model.'}
            </span>
          )}
        </label>

        <div className="field">
          <label className="check">
            <input type="checkbox" checked={autoCompact} onChange={(e) => setAutoCompact(e.target.checked)} />
            <span>
              Auto-compact the context
              <span className="field-hint">Summarise the conversation automatically once it grows past the threshold.</span>
            </span>
          </label>
          <div className="compact-row">
            <label className="field field-narrow">
              <span className="field-label">Threshold (tokens)</span>
              <input
                type="number"
                className="input"
                min={COMPACT_MIN}
                max={COMPACT_MAX}
                step={COMPACT_STEP}
                value={compactTokens}
                disabled={!autoCompact}
                onChange={(e) => setCompactTokens(Number(e.target.value))}
                onBlur={() => setCompactTokens((v) => clampTokens(v))}
              />
            </label>
            <span className={autoCompact ? 'compact-value mono' : 'compact-value mono dim'} aria-hidden="true">
              {tokensShort(clampTokens(compactTokens))}
            </span>
          </div>
        </div>

        <label className="field">
          <span className="field-label">Resume session <span className="optional">optional</span></span>
          <select
            className="input"
            value={resumePick}
            onChange={(e) => {
              setResumePick(e.target.value);
              setResumeTyped('');
            }}
            disabled={!recent || recent.length === 0 || typed.length > 0}
          >
            <option value="">
              {recent === null ? (cwd.trim() ? 'Looking for sessions…' : 'Start fresh') : recent.length ? 'Start fresh' : 'No previous sessions here'}
            </option>
            {recent?.map((r) => (
              <option key={r.id} value={r.id}>
                {(r.title || r.id).slice(0, 70)} · {timeAgo(r.mtime)}
              </option>
            ))}
          </select>
        </label>

        <details className="collapse advanced" open={advOpen} onToggle={(e) => setAdvOpen(e.currentTarget.open)}>
          <summary>Advanced</summary>
          <div className="form advanced-body">
            <label className="field">
              <span className="field-label">
                Resume by session ID <span className="optional">optional</span>
              </span>
              <input
                type="text"
                className="input mono"
                value={resumeTyped}
                onChange={(e) => setResumeTyped(e.target.value)}
                placeholder="3f2b9c14-7d51-4a0e-9b2f-8c1d6e5a4b30"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                aria-describedby={typedLooksWrong ? `${fieldId}-guid` : undefined}
              />
              {typedLooksWrong ? (
                <span className="field-hint warn" id={`${fieldId}-guid`}>
                  That doesn’t look like a session GUID (8-4-4-4-12 hex). It is sent as typed — Claude will refuse an unknown id.
                </span>
              ) : (
                <span className="field-hint">Paste a GUID from another machine. It overrides the list above.</span>
              )}
            </label>

            <label className="field">
              <span className="field-label">
                Additional claude arguments <span className="optional">optional</span>
              </span>
              <input
                type="text"
                className="input mono"
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                placeholder="--permission-mode auto --add-dir ../shared"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                aria-describedby={`${fieldId}-chips`}
              />
              <span className="field-hint">
                Appended to this session only. Quote values with spaces; single and double quotes both work.
              </span>
              <div className="chips" id={`${fieldId}-chips`}>
                {parsed.args.map((a, i) => (
                  <span className="chip" key={`${i}-${a}`} title={a}>
                    {a === '' ? '""' : a}
                  </span>
                ))}
              </div>
              {parsed.unterminated && <span className="field-hint warn">Unclosed quote — the last argument may not split the way you expect.</span>}
              {reserved.length > 0 && (
                <span className="field-hint warn">
                  Switchboard manages {reserved.join(', ')} itself; use the fields above instead. Starting will fail with an explanation.
                </span>
              )}
            </label>
          </div>
        </details>

        <label className="check">
          <input type="checkbox" checked={autoSwap} onChange={(e) => setAutoSwap(e.target.checked)} />
          <span>
            Auto-swap on limits
            <span className="field-hint">Resume on the subscription with the most headroom when this one runs out.</span>
          </span>
        </label>

        {resumeId && (
          <p className="field-hint">
            Resuming <span className="mono">{resumeId}</span>
            {resumedTitle ? ` — “${resumedTitle.slice(0, 60)}”` : ''}
          </p>
        )}

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        {!state.daemon.wtAvailable && (
          <p className="field-hint warn">Windows Terminal was not detected; the daemon may not be able to open a tab.</p>
        )}
      </form>
    </Dialog>
  );
}

function clampTokens(v: number): number {
  if (!Number.isFinite(v)) return COMPACT_MIN;
  return Math.min(COMPACT_MAX, Math.max(COMPACT_MIN, Math.round(v)));
}
