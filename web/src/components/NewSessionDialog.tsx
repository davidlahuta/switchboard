import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { CreateRunRequest, DiscoveredRepo, RecentSession, Run, StateSnapshot } from '@shared/types.ts';
import { ApiError, request } from '../lib/api.ts';
import { parseArgv, reservedArgs } from '../lib/argv.ts';
import { contextLabel, subUsageShort, tokensShort, usableSubs } from '../lib/format.ts';
import { fetchDiscoveredRepos, matchRepo, mergeRepoChoices, samePath } from '../lib/repos.ts';
import { navigate, href } from '../lib/router.ts';
import { timeAgo } from '../lib/time.ts';
import { emitToast } from '../lib/toast.ts';
import { Badge, Dialog } from './ui.tsx';

const COMPACT_MIN = 20_000;
const COMPACT_MAX = 990_000;
const COMPACT_STEP = 10_000;

/** Loose on purpose: the daemon owns the real check, this only catches obvious typos. */
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The `Session` select has exactly three kinds of value: "" for a fresh session, a session GUID
 * picked from the recent list, or this sentinel, which reveals the paste field beneath it. That is
 * what makes `resumeSessionId` single-sourced — there is no second control to override it.
 */
const PASTE = '__paste__';

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
  const fieldId = useId();
  const [cwd, setCwd] = useState('');
  const [sub, setSub] = useState('auto');
  const [name, setName] = useState('');
  const [worktree, setWorktree] = useState('');
  /** "" (new session), a session GUID from the recent list, or PASTE. */
  const [sessionChoice, setSessionChoice] = useState('');
  /** Only meaningful while `sessionChoice === PASTE`; cleared whenever that stops being true. */
  const [pastedId, setPastedId] = useState('');
  const [autoSwap, setAutoSwap] = useState(state.settings.autoSwap);
  const [model, setModel] = useState('');
  const [autoCompact, setAutoCompact] = useState(state.settings.defaultAutoCompact);
  const [compactTokens, setCompactTokens] = useState(state.settings.defaultAutoCompactTokens);
  const [skipPermissions, setSkipPermissions] = useState(state.settings.defaultSkipPermissions);
  const [argsText, setArgsText] = useState('');
  const [recent, setRecent] = useState<RecentSession[] | null>(null);
  const [discovered, setDiscovered] = useState<DiscoveredRepo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advOpen, setAdvOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCwd(initialCwd ?? state.repos[0]?.root ?? '');
    setSub('auto');
    setName('');
    setWorktree('');
    setSessionChoice('');
    setPastedId('');
    setAutoSwap(state.settings.autoSwap);
    // "" means "leave it to the daemon", which applies the default from Settings.
    setModel('');
    setAutoCompact(state.settings.defaultAutoCompact);
    setCompactTokens(state.settings.defaultAutoCompactTokens);
    setSkipPermissions(state.settings.defaultSkipPermissions);
    setArgsText('');
    setError(null);
    setAdvOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Repositories to pick from. Fetched once per opening — the list is a ~60s-cached server scan,
  // so re-fetching it per keystroke would be pure waste.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setDiscovered(null);
    fetchDiscoveredRepos()
      .then((r) => !cancelled && setDiscovered(r))
      .catch(() => !cancelled && setDiscovered([]));
    return () => {
      cancelled = true;
    };
  }, [open]);

  // recent sessions for the chosen directory (debounced)
  useEffect(() => {
    if (!open) return;
    setRecent(null);
    // A GUID from the previous folder is meaningless here; a half-typed paste is still wanted.
    setSessionChoice((c) => (c === PASTE ? c : ''));
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
  const globalArgs = state.settings.claudeArgs;

  const parsed = useMemo(() => parseArgv(argsText), [argsText]);
  const reserved = useMemo(() => reservedArgs(parsed.args), [parsed.args]);

  const choices = useMemo(() => mergeRepoChoices(discovered ?? [], state.repos), [discovered, state.repos]);
  const cwdRepo = useMemo(() => choices.find((r) => samePath(r.path, cwd)) ?? null, [choices, cwd]);

  const pasteMode = sessionChoice === PASTE;
  const pasted = pastedId.trim();
  /** The single source of truth for what gets resumed: a GUID, or nothing. */
  const resumeId = pasteMode ? pasted : sessionChoice;
  const pasteLooksWrong = pasteMode && pasted.length > 0 && !GUID_RE.test(pasted);
  const resumedTitle = recent?.find((r) => r.id === resumeId)?.title ?? null;

  const pickSession = (value: string) => {
    setSessionChoice(value);
    if (value !== PASTE) setPastedId('');
  };

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
      skipPermissions,
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
      // The daemon rejects arguments it manages itself with a 400 that explains which ones and
      // which control to use instead; that message is far more useful than a generic toast, so it
      // stays in the dialog — and Advanced is revealed, since it starts collapsed.
      setError(err instanceof ApiError || err instanceof Error ? err.message : String(err));
      if (parsed.args.length > 0) setAdvOpen(true);
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
        <DirectoryField
          value={cwd}
          onChange={setCwd}
          choices={choices}
          match={cwdRepo}
          loading={discovered === null}
          noRootsConfigured={state.settings.repoRoots.length === 0}
          onGoToSettings={onClose}
        />

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

        <div className="field">
          <label className="field-label" htmlFor={`${fieldId}-session`}>
            Session
          </label>
          <select
            id={`${fieldId}-session`}
            className="input"
            value={sessionChoice}
            onChange={(e) => pickSession(e.target.value)}
          >
            <option value="">Start a new session</option>
            {recent && recent.length > 0 && (
              <optgroup label="Recent in this folder">
                {recent.map((r) => (
                  <option key={r.id} value={r.id}>
                    {(r.title || r.id).slice(0, 70)} · {timeAgo(r.mtime)}
                  </option>
                ))}
              </optgroup>
            )}
            <option value={PASTE}>Paste a session ID…</option>
          </select>
          {pasteMode ? (
            <>
              <input
                type="text"
                className="input mono"
                value={pastedId}
                onChange={(e) => setPastedId(e.target.value)}
                placeholder="3f2b9c14-7d51-4a0e-9b2f-8c1d6e5a4b30"
                aria-label="Session ID to resume"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                aria-describedby={`${fieldId}-guid`}
              />
              <span className={pasteLooksWrong ? 'field-hint warn' : 'field-hint'} id={`${fieldId}-guid`}>
                {pasteLooksWrong
                  ? 'That doesn’t look like a session GUID (8-4-4-4-12 hex). It is sent as typed — Claude will refuse an unknown id.'
                  : 'A session GUID from another machine or folder.'}
              </span>
            </>
          ) : recent === null ? (
            <span className="field-hint">{cwd.trim() ? 'Looking for previous sessions…' : 'Choose a directory to list previous sessions.'}</span>
          ) : recent.length === 0 ? (
            <span className="field-hint">No previous sessions in this folder.</span>
          ) : (
            <span className="field-hint">Resuming continues the conversation; a new session starts empty.</span>
          )}
        </div>

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
            {!!resumeId && <span className="field-hint">A resumed session keeps the worktree it started in.</span>}
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

        <label className="check">
          <input type="checkbox" checked={skipPermissions} onChange={(e) => setSkipPermissions(e.target.checked)} />
          <span>
            Skip permission prompts
            <span className="field-hint">The session runs tools without asking you to approve each one.</span>
          </span>
        </label>

        <label className="check">
          <input type="checkbox" checked={autoSwap} onChange={(e) => setAutoSwap(e.target.checked)} />
          <span>
            Auto-swap on limits
            <span className="field-hint">Resume on the subscription with the most headroom when this one runs out.</span>
          </span>
        </label>

        <details className="collapse advanced" open={advOpen} onToggle={(e) => setAdvOpen(e.currentTarget.open)}>
          <summary>Advanced</summary>
          <div className="form advanced-body">
            <label className="field">
              <span className="field-label">
                Additional claude arguments <span className="optional">optional</span>
              </span>
              <input
                type="text"
                className="input mono"
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                placeholder="e.g. --verbose"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                aria-describedby={`${fieldId}-args-hint`}
              />
              <span className="field-hint" id={`${fieldId}-args-hint`}>
                Nothing is passed unless you type it here. The placeholder is an example, not a value. Applies to this session only;
                quote values with spaces.
              </span>
              <div className="chips">
                {parsed.args.map((a, i) => (
                  <span className="chip" key={`${i}-${a}`} title={a}>
                    {a === '' ? '""' : a}
                  </span>
                ))}
              </div>
              {parsed.unterminated && <span className="field-hint warn">Unclosed quote — the last argument may not split the way you expect.</span>}
              {reserved.length > 0 && (
                <span className="field-hint warn">
                  Switchboard manages {reserved.join(', ')} itself; use the controls above instead. Starting will fail with an
                  explanation.
                </span>
              )}
            </label>

            <div className="field">
              <span className="field-label">Always applied (from Settings)</span>
              {globalArgs.length > 0 ? (
                <>
                  <div className="chips">
                    {globalArgs.map((a, i) => (
                      <span className="chip" key={`${i}-${a}`} title={a}>
                        {a === '' ? '""' : a}
                      </span>
                    ))}
                  </div>
                  <span className="field-hint">
                    Added to every session Switchboard launches, on top of anything typed above. Change them in{' '}
                    <a href={href.settings()} onClick={onClose}>
                      Settings
                    </a>
                    .
                  </span>
                </>
              ) : (
                <span className="field-hint">No global arguments are configured, so this session gets only what you type above.</span>
              )}
            </div>
          </div>
        </details>

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

// ---------------- directory picker ----------------

/** Suggestions shown at once; the rest are reachable by typing a few more characters. */
const MAX_SUGGESTIONS = 8;

/**
 * A path input that is also a picker. It stays a text input because pasting a path is the fastest
 * way in when the folder is not under a configured root, but typing is now the fallback rather
 * than the only option: the suggestions come from the daemon's repository scan, and lead with the
 * repository name rather than the path.
 */
function DirectoryField({
  value,
  onChange,
  choices,
  match,
  loading,
  noRootsConfigured,
  onGoToSettings,
}: {
  value: string;
  onChange: (v: string) => void;
  choices: DiscoveredRepo[];
  /** The discovered repo the typed path points at, when it is one. */
  match: DiscoveredRepo | null;
  loading: boolean;
  noRootsConfigured: boolean;
  onGoToSettings: () => void;
}) {
  const id = useId();
  const [listOpen, setListOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  // An exact match means the user already picked this repo — offering it back is noise, so the
  // list falls back to everything, which is what "let me pick a different one" needs.
  const filtered = useMemo(() => {
    const exact = choices.some((r) => samePath(r.path, value));
    const list = exact ? choices : choices.filter((r) => matchRepo(r, value));
    return list;
  }, [choices, value]);
  const shown = filtered.slice(0, MAX_SUGGESTIONS);
  const hidden = filtered.length - shown.length;

  const choose = (repo: DiscoveredRepo) => {
    onChange(repo.path);
    setListOpen(false);
    setActive(-1);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!listOpen) {
        setListOpen(true);
        setActive(0);
      } else setActive((a) => Math.min(shown.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(-1, a - 1));
    } else if (e.key === 'Enter' && listOpen && active >= 0 && shown[active]) {
      // Picking, not submitting — the form would otherwise start a session on the typed text.
      e.preventDefault();
      choose(shown[active]);
    } else if (e.key === 'Escape' && listOpen) {
      // Closes the suggestions only; a second Escape reaches the dialog.
      e.stopPropagation();
      setListOpen(false);
      setActive(-1);
    }
  };

  const expanded = listOpen && shown.length > 0;
  const nothingToPick = !loading && choices.length === 0 && noRootsConfigured;

  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        Directory
      </label>
      <div className="repo-picker">
        <input
          ref={inputRef}
          id={id}
          type="text"
          className="input mono"
          role="combobox"
          aria-expanded={expanded}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={expanded && active >= 0 ? `${id}-opt-${active}` : undefined}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setListOpen(true);
            setActive(-1);
          }}
          onClick={() => setListOpen(true)}
          onBlur={() => {
            setListOpen(false);
            setActive(-1);
          }}
          onKeyDown={onKeyDown}
          placeholder="C:\\src\\my-repo"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          required
        />
        {expanded && (
          <ul className="repo-suggest" id={`${id}-list`} role="listbox" aria-label="Repositories">
            {shown.map((r, i) => (
              <li
                key={r.path}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={i === active}
                className={i === active ? 'repo-option is-active' : 'repo-option'}
                // Keeps focus in the input, so blur does not tear the list down before the click.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(r)}
                onMouseEnter={() => setActive(i)}
              >
                <span className="repo-option-head">
                  <span className="repo-option-name">{r.name}</span>
                  {r.isWorktree && <Badge tone="muted">worktree</Badge>}
                  {r.branch && <span className="dim small">{r.branch}</span>}
                </span>
                <span className="repo-option-path mono dim">{r.path}</span>
              </li>
            ))}
            {hidden > 0 && (
              <li className="repo-suggest-more" role="presentation">
                {hidden} more — keep typing to narrow
              </li>
            )}
          </ul>
        )}
      </div>
      {nothingToPick ? (
        <span className="field-hint">
          No repositories to pick from.{' '}
          <a href={href.settings()} onClick={onGoToSettings}>
            Add a repo folder in Settings
          </a>{' '}
          to pick from a list.
        </span>
      ) : match ? (
        <span className="field-hint">
          {match.name}
          {match.branch ? ` · on ${match.branch}` : ''}
          {match.isWorktree ? ' · linked worktree' : ''}
        </span>
      ) : loading ? (
        <span className="field-hint">Looking for repositories…</span>
      ) : (
        <span className="field-hint">
          {choices.length > 0 ? `Type to filter, or press ↓ to pick from ${choices.length} repositories.` : 'Type or paste a full path.'}
        </span>
      )}
    </div>
  );
}

function clampTokens(v: number): number {
  if (!Number.isFinite(v)) return COMPACT_MIN;
  return Math.min(COMPACT_MAX, Math.max(COMPACT_MIN, Math.round(v)));
}
