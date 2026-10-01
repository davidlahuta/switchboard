/*
 * The hub and its satellite desks.
 *
 * One daemon (the hub) owns everything that is decided: the board, subscriptions, logins, placement,
 * the web UI. A satellite runs `switchboard desk`, a small agent that dials out to the hub and does
 * what only a process on that machine can do — open terminals, read and write files there, ask git.
 * Sessions on a satellite still talk to 127.0.0.1: the agent listens where the daemon would and
 * relays hooks, runners and MCP shims to the hub over the authenticated connection it holds.
 *
 * Nothing about the satellite's Windows user or folder layout is assumed by the hub. It sends logical
 * descriptions (a subscription id, file contents, a repository key) and the agent turns them into
 * paths under its own user. Paths a desk reports are only ever used on that desk.
 */

/** The id of the hub's own desk. Rows from before desks existed carry NULL, which means the same. */
export const LOCAL_DESK = 'local';

/** What a desk can do, as it reports it. */
export interface DeskTools {
  claude: string | null;
  claudeVersion: string | null;
  /** Windows Terminal is available to open session tabs in */
  wt: boolean;
  git: string | null;
  node: string;
  gh: { installed: boolean; account: string | null };
  az: { installed: boolean; account: string | null };
}

export interface DeskRepo {
  /** where the clone is, on that desk */
  path: string;
  /** normalised origin, the identity a repository has across desks; null without an origin */
  remoteKey: string | null;
  remoteUrl: string | null;
  name: string;
  branch: string | null;
}

/** A desk as the web UI shows it. */
export interface Desk {
  id: string;
  name: string;
  /** the hub is the desk the daemon runs on */
  hub: boolean;
  hostname: string | null;
  platform: string | null;
  user: string | null;
  online: boolean;
  lastSeen: string | null;
  version: string | null;
  /** sessions this desk should host before placement overflows anywhere */
  recommendedMaxSessions: number;
  /** whether the operator set the number, or it is the guess from the hardware */
  maxIsDefault: boolean;
  liveRuns: number;
  enabled: boolean;
  /** where auto-clones go on that desk; null is the agent's default */
  cloneRoot: string | null;
  repoRoots: string[];
  cores: number | null;
  memGb: number | null;
  tools: DeskTools | null;
  repos: DeskRepo[];
  createdAt: string;
}

export interface DeskPairing {
  code: string;
  expiresAt: string;
  /** the command to run on the new desk */
  command: string;
}

/** Where a mirrored file lives: the desk's ~/.claude, or one of its subscription profiles. */
export type MirrorRoot = 'home' | `profile/${string}`;

/**
 * What a spawn on a satellite needs besides the spec the runner reads. The hub builds the spec as if
 * the session ran beside it; the agent swaps every hub path for one of its own before the runner
 * sees it, and strips this off.
 */
export interface DeskSpawnExtras {
  subscriptionId: string;
  /** claude's own arguments, before claudeCommand wraps them for the hub's binary */
  claudeArgs: string[];
  /** files the arguments name, by the hub path they are named by, with their contents */
  files: Record<string, string>;
  diffPanel: boolean;
  /** the folder the session opens in, to be trusted in the desk profile before it starts */
  trust: string;
  /** the session has a private login (CLAUDE_SECURESTORAGE_CONFIG_DIR); the agent keeps it in step */
  privateLogin: boolean;
  /** what the hub expects: the agent corrects it to what is actually on that desk's disk */
  resume: boolean;
  /**
   * What the session gets from the hub's vault: hosts git's credential helper goes in front of,
   * whether gh and az go through shims, and environment for the Azure SDKs. The agent builds the
   * helper and the shims with its own Node and its own install.
   */
  vault?: { hosts: string[]; shims: boolean; env: Record<string, string> };
}

/** Everything a desk profile is seeded with: the hub's own customisations, carried as contents. */
export interface ProfileSeed {
  files: Record<string, string>;
  claudeJson: Record<string, unknown>;
}

/** One session on a desk, as the hub tells the desk about it. */
export interface DeskRun {
  id: string;
  sessionId: string;
  cwd: string;
  lastCwd: string | null;
  pid: number | null;
  subscriptionId: string;
  hostSub: string | null;
  live: boolean;
}

/** What a desk says about each of its sessions, so the hub can answer questions without asking. */
export interface DeskRunInfo {
  /** where the session opens when it comes back; see sessionDir */
  home: string;
  workDir: boolean;
  claudeAlive: boolean;
}

export type HubToDesk =
  | { type: 'welcome'; deskId: string; name: string }
  | { type: 'rpc'; id: number; method: string; args: unknown }
  | { type: 'runs'; runs: DeskRun[] }
  | { type: 'login'; runId: string; content: string | null }
  | { type: 'seed'; seed: ProfileSeed }
  | { type: 'resync'; root: MirrorRoot; rel: string; from: number };

export type DeskToHub =
  | {
      type: 'hello';
      deskId: string;
      version: string;
      hostname: string;
      platform: string;
      user: string;
      cores: number;
      memGb: number;
      tools: DeskTools;
      runnerSourceMtime: number;
      repoRoots: string[];
      cloneRoot: string;
    }
  | { type: 'rpc-result'; id: number; ok: boolean; value?: unknown; error?: string }
  /** A piece of a file the hub mirrors: appended at `offset`, or the whole file when `truncate`. */
  | { type: 'file'; root: MirrorRoot; rel: string; offset: number; data: string; truncate?: boolean }
  | { type: 'login-changed'; runId: string; content: string }
  | { type: 'status'; runs: Record<string, DeskRunInfo>; runnerSourceMtime: number; tools?: DeskTools }
  | { type: 'repos'; repos: DeskRepo[] };

/** The prefix a satellite puts on a hook's transcript_path, for the hub to turn into its mirror. */
export const DESK_PATH_PREFIX = 'desk://';

/**
 * A repository's identity across desks: its origin, normalised so every way of writing the same
 * remote compares equal. Credentials, `.git`, case and the ssh/https spelling are all dropped.
 */
export function remoteKey(url: string | null | undefined): string | null {
  if (!url) return null;
  let u = url.trim();
  if (!u) return null;
  // scp-like ssh: git@host:org/repo
  const scp = u.match(/^[^@/]+@([^:/]+):(.+)$/);
  if (scp) u = `${scp[1]}/${scp[2]}`;
  else {
    try {
      const parsed = new URL(u);
      u = `${parsed.hostname}${parsed.pathname}`;
    } catch {
      // a local path or something git understands and URL does not: keep as given
    }
  }
  u = u.replace(/\\/g, '/').replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
  // Azure DevOps: org.visualstudio.com/project/_git/repo and dev.azure.com/org/project/_git/repo
  const vs = u.match(/^([^./]+)\.visualstudio\.com\/(?:defaultcollection\/)?([^/]+)\/_git\/([^/]+)$/);
  if (vs) return `dev.azure.com/${vs[1]}/${vs[2]}/${vs[3]}`;
  const ado = u.match(/^(?:ssh\.)?dev\.azure\.com\/(?:v3\/)?([^/]+)\/([^/]+)\/(?:_git\/)?([^/]+)$/);
  if (ado) return `dev.azure.com/${ado[1]}/${ado[2]}/${ado[3]}`;
  return u;
}

/** A guess at how many sessions a machine can host, for a desk the operator has not set one for. */
export function defaultMaxSessions(cores: number | null, memGb: number | null): number {
  if (!cores || !memGb) return 4;
  return Math.max(1, Math.min(Math.floor(cores / 2), Math.floor(memGb / 4)));
}

/**
 * Where a new session goes.
 *
 * Only desks that are online, enabled and allowed for the repository are eligible; having the
 * repository is a preference rather than a requirement, because a desk without it clones it. Among
 * desks still under their recommended maximum, one that already has the repository is preferred,
 * then the least loaded relative to its maximum, then the one already running sessions on that
 * repository, then the hub. Only when every eligible desk is at its maximum does a desk go over it.
 */
export interface PlacementDesk {
  id: string;
  online: boolean;
  enabled: boolean;
  allowed: boolean;
  hasRepo: boolean;
  load: number;
  max: number;
  /** live sessions on this desk in the same repository */
  repoSessions: number;
  hub: boolean;
}

export type PlacementResult =
  | { ok: true; desk: string; overflow: boolean; clone: boolean }
  | { ok: false; reasons: Array<{ desk: string; why: string }> };

export function deskPlacement(desks: PlacementDesk[], opts: { pinned?: string | null; canClone: boolean } = { canClone: true }): PlacementResult {
  const reasons: Array<{ desk: string; why: string }> = [];
  const eligible = desks.filter((d) => {
    if (opts.pinned && d.id !== opts.pinned) return false;
    const why = !d.online ? 'offline' : !d.enabled ? 'disabled' : !d.allowed ? 'not allowed for this repository' : !d.hasRepo && !opts.canClone ? 'has no clone of it' : null;
    if (why) reasons.push({ desk: d.id, why });
    return why === null;
  });
  if (!eligible.length) return { ok: false, reasons };
  const under = eligible.filter((d) => d.load < d.max);
  const pool = under.length ? under : eligible;
  const ratio = (d: PlacementDesk): number => (d.max > 0 ? d.load / d.max : Number.POSITIVE_INFINITY);
  const best = [...pool].sort(
    (a, b) =>
      Number(b.hasRepo) - Number(a.hasRepo) ||
      ratio(a) - ratio(b) ||
      b.repoSessions - a.repoSessions ||
      Number(b.hub) - Number(a.hub) ||
      a.id.localeCompare(b.id),
  )[0];
  return { ok: true, desk: best.id, overflow: !under.length, clone: !best.hasRepo };
}
