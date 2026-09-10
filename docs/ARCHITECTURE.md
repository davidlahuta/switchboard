# Switchboard architecture

Switchboard is a single always-on local daemon with three jobs:

1. **Agent coordination** – an MCP server (plus Claude Code hooks) that groups every Claude Code
   session by repository and lets them see each other, claim files, message each other and get
   warned the moment they step on each other's toes.
2. **Subscription management** – N Claude subscriptions on one desk, each with its own isolated
   login, live usage limits, and one-click session launch.
3. **Session hosting** – sessions launched by Switchboard run in a thin PTY *runner* inside a
   Windows Terminal tab. The runner can hot-swap the session to another subscription
   (kill + `claude --resume` under a different `CLAUDE_CONFIG_DIR`) without closing the tab, and
   mirrors the terminal to the web UI so it can be driven from a phone.

```
               ┌──────────────────────── switchboard daemon (127.0.0.1:4477) ────────────────────────┐
               │  HTTP API · WebSocket hub · hook endpoint · SQLite · usage poller · updater · models │
               └──────▲──────────────▲──────────────────▲──────────────────▲──────────────────▲──────┘
          /ws/agent   │    /hooks/*  │        /ws/runner│         /ws/ui   │     /ws/term/:id │
                      │              │                  │                  │                  │
  ┌────────────────┐  │  ┌───────────┴────┐   ┌─────────┴───────┐   ┌──────┴─────┐     ┌──────┴─────┐
  │ switchboard mcp│  │  │ Claude Code    │   │ switchboard run │   │  Web UI    │     │ Web xterm  │
  │ (stdio shim,   ├──┘  │ HTTP hooks     │   │ (PTY host in a  │   │ (React)    │     │ (phone /   │
  │  one/session)  │     │ (all sessions) │   │  WT tab)        │   └────────────┘     │  browser)  │
  └───────▲────────┘     └───────▲────────┘   └───────┬─────────┘                      └────────────┘
          │ stdio (MCP + channel)│                    │ spawns / respawns
          └──────────── claude ──┴────────────────────┘
```

## Repository grouping

Every session is mapped to a **repo group** keyed by the absolute path of the main worktree:
`git rev-parse --path-format=absolute --git-common-dir` → its parent directory (or the common dir
itself for bare-repo layouts). All linked worktrees (including `claude --worktree` ones under
`.claude/worktrees/`) therefore share one group. File paths are stored **repo-relative** (forward
slashes, case-insensitive on Windows), so `src/a.ts` edited in worktree A and in worktree B is the
same file for conflict detection.

## Coordination model

| Concept      | What it is                                                                                   |
|--------------|----------------------------------------------------------------------------------------------|
| Agent        | One Claude Code session (keyed by Claude's session id). Presence is derived from hooks.      |
| Intent       | "What I'm doing right now" + the files/globs I expect to touch. Visible to everyone.         |
| Claim        | A soft (warn) or exclusive (block) reservation on paths/globs, with TTL.                     |
| File touch   | Every Edit/Write/MultiEdit/NotebookEdit is recorded automatically via the PostToolUse hook.  |
| Conflict     | Two agents touching the same file inside the conflict window, or an edit inside another agent's claim. |
| Message      | Direct or broadcast, typed (`info`, `question`, `request`, `handoff`, `warning`), threaded.  |
| Note         | Shared, pinnable repo memory (`decision`, `fact`, `warning`, `todo`).                        |

### Delivery strategy (token economy)

Waking an idle agent costs a full model turn, so delivery is tiered:

* **Push (channel)** – urgent messages, direct questions/requests, handoffs, conflicts and anything
  sent by the human from the UI are pushed into the session immediately via the Claude Code
  *channels* contract (`notifications/claude/channel`), which starts a turn if the agent is idle.
* **Piggyback (hooks)** – plain `info` broadcasts are never pushed. They are attached as compact
  `additionalContext` to the recipient's next `PostToolUse` / `UserPromptSubmit` hook call, batched
  and rate-limited, so awareness spreads without spending extra turns.
* **Pull (tool)** – `sb_inbox` and `sb_status` always work, even for sessions with neither.

Each message is delivered once per recipient (tracked in `message_delivery`).

### Conflict prevention

* `PreToolUse` (Edit/Write/…): an **exclusive** claim held by another live agent → the edit is
  denied with a reason telling the agent who holds it and how to coordinate. A soft claim or a
  recent overlapping edit → allowed, with a warning injected as `additionalContext`.
* `PostToolUse`: records the touch; on a new overlap it opens a conflict, warns the editor inline
  and pushes a heads-up to the other agent.
* `SessionStart`: injects a short digest (who's here, their intents, pinned notes).

### MCP tools (kept to eight, terse descriptions to save context)

`sb_status`, `sb_intent`, `sb_claim`, `sb_release`, `sb_send` (optionally waits for a reply),
`sb_inbox`, `sb_note`, `sb_who_touches`.

## Subscriptions

Each subscription is a **profile directory** used as `CLAUDE_CONFIG_DIR`
(`%LOCALAPPDATA%\switchboard\profiles\<id>`). `CLAUDE_CONFIG_DIR` relocates credentials,
`.claude.json`, `projects/`, `sessions/` etc., so logins are fully isolated. To make sessions
resumable across subscriptions and keep one set of customisations, a profile **junctions** the
shared folders to `~/.claude` (`projects`, `file-history`, `todos`, `plans`, `plugins`, `skills`,
`agents`, `commands`, `output-styles`) and copies `settings.json`, `CLAUDE.md` and
`keybindings.json`. Your existing `~/.claude` login is imported as the *default* subscription.

Adding a subscription opens a terminal running `claude auth login` inside the new profile; the
daemon watches for credentials and reads the account (email, plan) from the OAuth profile endpoint.

Usage (5-hour and weekly utilisation + reset times) is polled from the OAuth usage endpoint that
Claude Code's own `/usage` uses. It is undocumented and may change; failures are shown as *stale*
with the reason.

That endpoint rate-limits per account, not per subscription, so the poller treats a 429 as a
global signal: it honours `Retry-After` (falling back to capped exponential backoff), pauses every
subscription until it expires, and refuses manual refreshes in the meantime rather than extending
the penalty. Requests are also spaced apart so several subscriptions never burst together, and
subscriptions with no live session poll far less often.

**Headroom** is the ranking metric: `weight × (100 − max(5h%, 7d%)) / 100`. Both windows gate
every request, so the tighter one decides; the plan weight converts a percentage into something
comparable across plans. The daemon computes it so the overview's ordering and the automatic swap
target cannot drift apart.

## Models and updates

The model list comes from `/v1/models` and is filtered to models whose `max_input_tokens` is at
least 1M, so new models appear without a code change. Per-session, the model is passed as
`--model`; auto-compact is a *setting*, not a flag, so it travels in the per-run settings file
alongside the hooks.

The updater runs `claude update` on a schedule. When the version changes it restarts hosted
sessions onto the new build — a restart is the same machinery as a subscription swap, minus the
subscription change, so it resumes the same session GUID and waits for the agent to be idle.

## Repository discovery

The folders in `settings.repoRoots` are scanned up to three levels deep. A directory containing
`.git` is a repository and is *not* descended into, which stops submodules and nested checkouts
from exploding the scan; `node_modules`, build output and dotted directories are skipped outright.
Each hit is resolved through the same `resolveRepo` used for coordination, so a linked worktree
reports the `repoId` of its main worktree and the UI can group them together.

## Running from source

The daemon executes TypeScript directly (Node's type stripping), so there is no build step — and
no rebuild to forget. The cost is that a running daemon holds the code it started with: the
supervisor only relaunches it on exit, so after an edit or a `git pull` it serves the old code and
silently drops request fields it does not know. `/api/state` therefore reports `startedAt`,
`sourceChangedAt` (newest mtime under `src/`) and `staleCode`, and the UI offers a restart when
they disagree.

## Identity

A session is its **GUID** (Claude Code's session id). Everything durable keys off it: runs,
resumes, swaps, restarts, agent rows, message delivery. Display names exist only for humans and
for agents addressing each other; they are unique among *live* agents and can be reused once a
session goes offline. Name lookup therefore prefers live agents and refuses an ambiguous match
rather than guessing, telling the caller to use the GUID.

## Always on

`switchboard service install` registers a Task Scheduler **logon** task that runs a supervisor
script: it launches the daemon hidden, waits for it, and relaunches it about ten seconds after any
exit. Task Scheduler's own restart-on-failure cannot do this, because a task that launches a
detached process is considered finished immediately.

It is a logon task rather than a startup one because opening terminal tabs needs an interactive
desktop, which a session-0 service does not have. The cost is that after an unattended reboot the
daemon returns when the desk signs in.

## Session runner and subscription swap

`switchboard run` hosts `claude` in a ConPTY (`@lydell/node-pty`) and relays raw I/O to its own
console (the Windows Terminal tab). It always passes:

* `--session-id <uuid>` (new) or `--resume <uuid>` (after a swap),
* `--mcp-config <file>` registering the `switchboard` stdio shim,
* `--dangerously-load-development-channels server:switchboard` so pushes work,
* `--settings <file>` carrying the session's auto-compact settings, plus Switchboard's HTTP hooks
  when the profile does not already have them,
* `--model <id>` and any extra arguments configured for the session. Arguments Switchboard owns
  (`--session-id`, `--resume`, `--mcp-config`, `--settings`, `--worktree`, …) are refused, because
  overriding them would break the session's identity or its coordination.

**Swap** = wait until the agent is idle (or it just hit a limit) → kill claude → reset the terminal →
respawn `claude --resume <same id>` in the session's last cwd with the new `CLAUDE_CONFIG_DIR` →
when the `SessionStart(resume)` hook arrives, optionally type the continue message. The continue
message is only sent once that hook confirms a live prompt: typing blindly could answer a dialog
(folder trust, a permission prompt) instead. Folder trust is copied into the target profile first,
for the same reason.

Triggers: manual (UI), `StopFailure` hook with `rate_limit` (auto-swap + continue), a limit
message detected in the PTY output (fallback), or proactive (usage above threshold while idle).
Target = the enabled, logged-in subscription with the most headroom, weighted by live sessions.

## Web terminal

The runner streams PTY output to the daemon, which feeds a headless xterm per run
(`@xterm/headless` + serialize addon). A browser attaching to `/ws/term/:runId` receives the
serialized current screen and then live data, and can send input. The terminal size is owned by
the Windows Terminal tab; the web view renders at the same size (zoom/scroll on phones) and
offers a key bar (Esc, Tab, ⇧Tab, arrows, Ctrl‑C, Enter) plus a text composer.

## Security

* The daemon binds to `127.0.0.1` only. Remote access is meant to go through `tailscale serve`.
* Requests are **local** when the Host header is a loopback name and no proxy headers are present.
  Local requests need no auth.
* Everything else must carry a device cookie obtained by **pairing**: the local UI shows a
  one-time code / QR (valid 10 minutes). Devices are listed and revocable. Tokens are stored hashed.
* Host / Origin checks block DNS rebinding and cross-site requests.

## Storage

SQLite via the built-in `node:sqlite` at `%LOCALAPPDATA%\switchboard\switchboard.db`
(override with `SWITCHBOARD_DATA_DIR`). No native build step anywhere except the prebuilt PTY.
