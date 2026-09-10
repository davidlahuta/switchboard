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

Each message is delivered once per recipient (tracked in `deliveries`).

### Busy repos

A repo with a dozen agents on it produces messages, events and file touches faster than anyone
reads them, and the repo view is refetched on every change. Three things keep that flat:

* **Watermark.** Each agent carries `read_through_id`: everything at or below it is settled for
  that agent — delivered, sent by it, addressed elsewhere, or older than it. "What has this agent
  not seen" only ever looks above the watermark, and the watermark moves up to just below the
  oldest still-unread message on each pass. An agent joining a repo starts at the newest message
  that predates it, so it never walks the history it was never going to be shown.
* **Caps.** The unread badge stops counting at `UNREAD_CAP` (200) and the file panel aggregates the
  most recent `TOUCH_SCAN` (4000) touches rather than the whole window, so its counts read as
  "recently", not "ever". Payloads are capped per panel.
* **Retention.** Events and file touches older than 14 days are deleted hourly, and events are
  capped per repo. Messages and notes are kept.

At 40 agents with 50k messages, 250k events and 400k touches, one repo view is ~25 ms and ~90 KB.

### Conflict prevention

* `PreToolUse` (Edit/Write/…): an **exclusive** claim held by another live agent → the edit is
  denied with a reason telling the agent who holds it and how to coordinate. A soft claim or a
  recent overlapping edit → allowed, with a warning injected as `additionalContext`.
* `PostToolUse`: records the touch; on a new overlap it opens a conflict, warns the editor inline
  and pushes a heads-up to the other agent.
* `SessionStart`: injects a short digest (who's here, their intents, pinned notes) ending in what
  this agent owes the others.
* A one-minute sweep chases what silence would otherwise hide: an agent editing without an intent,
  a claim its holder stopped using, a question nobody answered. Each is delivered as an ordinary
  message from `switchboard`, so it rides the existing channel/piggyback/stop-block machinery, and
  each is said at most once every 45 minutes.

### Keeping the board true

Everything above is advisory: an agent deep in its own task can read all of it and carry on. Three
things are not, because each of them is a way for one agent to leave another stuck indefinitely.

**A session that has gone is off the board in about a minute.** Presence used to be inferred from
silence, and an idle session at a prompt is silent — so the fallback had to be hours, and an agent
that died holding an exclusive claim blocked everyone until its claim expired. Two witnesses settle
it sooner: the run is over (`RunManager.sessionOver`, which watched the process end), or the
session's MCP shim socket closed and no hook arrived within the grace. Going offline releases the
agent's claims, so nothing dead holds a lock.

**Waiting is written down, and a lock nobody is using can be taken away.** A denied edit records a
row in `blocks` — who is waiting, on whose claim, for which path, since when. After ten minutes of
waiting, if the holder has touched nothing inside its own claim since the wait began, the claim is
released, both sides are told and the operator sees it happen; if the holder *is* working in there,
it keeps it and is told somebody is standing in front of it. A ring of agents each waiting on the
next one's claim (`findWaitCycle`) never resolves on its own however patient everyone is, so it is
opened as a `deadlock` conflict and broken at the claim whose holder has been quiet longest.

**A terminal that changes conversation stays one seat on the board.** `/clear` starts a fresh
conversation under a new session id, and Claude Code neither fires `SessionEnd` for the old one
(that runs only on shutdown) nor restarts MCP servers — so the shim goes on announcing the id it was
launched with. Left alone that is a ghost agent the liveness sweep will never retire, still holding
the name, an intent nobody is working on and claims nobody will release, while the session actually
in that terminal sits under an id the push channel cannot reach. `RunManager.rebind` holds both ids
at the moment of the swap, so `Coordinator.sessionReplaced` re-keys the shim socket to the new id,
carries across anything asked of it that it was never shown, and retires the old conversation —
releasing its claims and freeing its name for the session now in that seat, which inherits when the
seat was taken and how far it had read. (`/clear` also restores the session's working directory to
the one it was launched in; that arrives as `CwdChanged` and on `SessionStart`, and is handled like
any other move.)

**A turn does not end owing the repo something.** The `Stop` hook is held once — and only once per
agent per ten minutes — when the agent has read a question and not answered it, or holds an
exclusive claim somebody is currently blocked on, or has push-worthy messages it has never been
shown. Nothing else qualifies: intent and tidy bookkeeping are nudged where they happen, because a
block that fires for everything is one an agent learns to sit through.

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

**Tokens are renewed before they die.** A Claude Code token lasts about eight hours and the CLI
renews it on the next API call it makes — which a session sitting at a prompt never makes, and a
subscription with nothing running on it certainly never makes, so one would simply expire and every
reading Switchboard takes for it go stale until somebody logged in again. Fifteen minutes before
expiry the daemon runs `claude doctor` in that profile: it renews an expired token through the
CLI's own locked refresh path and leaves a healthy one untouched, at no cost in tokens and with no
conversation. (`claude auth status`, which this used to run, only reports what is already on disk —
the renewal never happened.) One attempt per subscription per minute, backing off to five when the
refresh token itself is dead, which is the case that needs a person.

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
target cannot drift apart. `subscriptionScore` then shares that headroom with the sessions already
on the subscription and adjusts for an imminent reset and for where the session has just been.

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

**Name and model** are shared with Claude Code rather than mirrored. `SessionStart` and
`UserPromptSubmit` report the session's title and can set it, so a rename in the web UI reaches the
session on its next prompt; a shadow copy of the last reported title is what says which side moved.
The other direction cannot wait for a prompt — `/rename` is a local command, and someone who renames
a session and then looks at the web UI types nothing at all — so the file Claude Code writes it to,
`<config>/projects/<slug>/<session>/custom-title.json`, is polled for live sessions instead. The
poll only ever adopts: pushing is the hook's job, and consuming a pending push here would lose it.

The model works the same way. Claude Code names it in the `SessionStart` hook only, but the
transcript carries it twice over: every assistant turn records the model it ran on, and `/model`
appends a record naming the new one the moment it is chosen. The transcript's tail is read whenever
its size or mtime changes, so a switch made in an idle session shows up before its next turn. The model is read back from the session
transcript on `Stop`, because Claude Code names the model in `SessionStart` only and a mid-session
`/model` would otherwise go unnoticed until the next restart.

**A folder that is gone.** A session is tied to the directory it works in, and directories are
deleted and moved. Launching into one that is not there gives a terminal that exits on a Windows
error code and explains nothing, so the run reports it instead: the list says *folder gone*, Resume
is not offered, and the API refuses with the path and the session id to resume elsewhere.

**Closing the tab.** Windows Terminal keeps a tab whose process exited non-zero, and killing claude
reports 1 — so a stop or a relaunch used to leave its tab behind every time. An exit that was asked
for reports success and the tab goes; a session that fell over on its own keeps its tab, because at
the desk that screen is the only account of what happened. Either way the run is still listed, and
Resume opens a fresh terminal on the same conversation.

**Startup prompts.** Two confirmations stand between a launched session and a prompt, and a session
waiting at either is a session nobody is at.

Switchboard registers its own MCP server as a channel so it can push into an idle session, and that
flag makes Claude Code stop at a confirmation every time. The runner answers it, and only it: the
warning is about running channels obtained from elsewhere, so it is answered only when the list is
exactly this machine's own Switchboard server.

Folder trust is granted in the profile before the process starts, rather than answered on screen —
choosing the folder here is the trust decision, and repeating it once per subscription only moves it
to a dialog. Claude Code keys those by absolute path with forward slashes even on Windows; building
the key any other way matches nothing, which is what left trust silently failing to travel across a
swap. The dialog is still answered if it appears anyway, for the launch folder and no other.

Nothing is ever typed at a session showing a confirmation. The continue message ends in a carriage
return, and the option these dialogs start on is the one that exits — which is how a session was
once killed instead of resumed. The screen is checked first, and a session sitting on a dialog is
reported rather than answered.

**Resuming.** A session that was started and then restarted before it was ever used has no
transcript, and Claude Code exits with "No conversation found" when asked to resume one. Switchboard
checks for the transcript first and starts under the same session id instead, so a session keeps its
identity either way. Once a session is back at a prompt on a conversation it already had, the
continue message is typed into it. That is armed when the process spawns rather than from the
SessionStart hook: the hook does not arrive for every way a session comes back, and when it does it
only serves to bring the wait forward.

A resume is not taken on trust. Claude Code answers a transcript it finds but cannot load with a
"Failed to resume session" line and then a **new** conversation carrying an id of its own — it does
not exit. Following that id would overwrite the only pointer the run holds to the conversation it
was resuming, which is how a day's work stopped being reachable from Switchboard while its
transcript sat untouched on disk. So the id a `--resume` was sent to fetch is written to
`runs.resuming` at the spawn and only cleared when the session reports having it; a session that
reports anything else is stopped, kept off the board, and the run stays pointed at the conversation
it asked for. The failure is a toast naming the `claude --resume <id>` that still works. See
`rebindDecision`.

**Swap** = wait until the agent is idle (or it just hit a limit) → kill claude → reset the terminal →
respawn `claude --resume <same id>` in the session's last cwd with the new `CLAUDE_CONFIG_DIR` →
when the `SessionStart(resume)` hook arrives, optionally type the continue message. The continue
message is only sent once that hook confirms a live prompt: typing blindly could answer a dialog
(folder trust, a permission prompt) instead. Folder trust is copied into the target profile first,
for the same reason.

Triggers: manual (UI), `StopFailure` hook with `rate_limit`, a limit message detected in the PTY
output (fallback), or proactive (usage above threshold while idle).

**Restart** and **relaunch** are the same machinery with a different thing changed while the session
is down — the claude binary, or the terminal itself — so they queue the same way. A request that
lands mid-turn is held rather than refused: the operator asked for a restart, not for a ruling on
whether now is a good moment, and "not now, try again later" only means they come back and ask
again. `force` is how they say they meant now. Whatever is queued is written to `runs.pending_respawn`
so it survives a daemon restart, carries the `trigger` that asked for it — an operator, a claude
update, a usage limit, the proactive threshold, a subscription coming back — and is reported with
that trigger wherever it is shown. Settings → *All sessions* queues one across the fleet.

## Burn rate

The subscription cards answer "where should the next session go". They do not answer the question
that decides an afternoon — whether the desk is about to stop — because that one is about the pool:
several sessions across several subscriptions spend one budget, and either it lasts until the
windows turn over or it does not.

`src/daemon/burn.ts` measures the rate from the usage samples already stored every five minutes,
since nothing reports a rate. Each subscription's own percentage is differenced and scaled by its
plan weight (percent does not add up across plans: a 20x at 50% and a Pro at 50% are not "50% of the
desk"), and a **fall** is read as the window turning over rather than as usage being handed back, so
only the climbs count. Under half an hour of samples is treated as no rate at all rather than as a
confident one.

The forecast is then walked forward rather than divided, because dividing headroom by rate answers a
different question: capacity coming back at 16:40 is exactly what decides whether the desk stops.
Each subscription carries its own reset, spending is drawn from whoever has the most left — the way
a swap would actually place the sessions doing the spending — and the answer is the first moment
there is nothing anywhere. Reaching the horizon with headroom left is reported as **never**: at this
rate the windows hand capacity back faster than the desk can spend it, which is the common case and
is worth saying out loud.

Both windows are forecast separately and either one stops the desk, so the Overview headline is
whichever arrives first. The whole thing is cached for thirty seconds — a snapshot is rendered far
more often than usage moves.

## What a session still has running

A session's status answers a narrower question than it looks like it does. `Stop` fires when the
**main thread's** turn ends, and a subagent launched in the background outlives that turn — measured
on 2.1.268, with a hook recorder in front of `claude -p`:

```
49623 SubagentStart  agent_id=aa23…
49639 PostToolUse    Agent  (main)      ← the Agent tool returns immediately
50871 Stop           (main)             ← the session now reports idle
52556 PreToolUse     Bash   agent_id=aa23…
93298 PostToolUse    Bash   agent_id=aa23…
95181 SubagentStop   agent_id=aa23…     ← 44s after it looked finished
```

A subagent that calls no tools at all leaves 13 seconds of total hook silence in the same shape, and
a real research subagent leaves minutes. Taking the session in that window kills the subagent
mid-flight and throws away every token it has spent, which is the most expensive thing Switchboard
can do by accident.

Every hook payload carries **`agent_id`** — "present only when the hook fires from within a
subagent" — so a subagent's own tool calls are told apart from the main thread's rather than, as
before, being counted as the main thread working. That reading was accidental cover: it held only
while the subagent kept calling tools.

Three kinds of work are tracked in `session_work`, in the database so that a daemon restart during a
twenty-minute subagent does not forget it:

- **subagents** — authoritative, from `SubagentStart` / `SubagentStop`.
- **background shells** — inferred, because nothing announces them: a `Bash` with
  `run_in_background` returns `backgroundTaskId` in its tool result and fires no hook when it ends.
- **monitors** — the same handle, from the `Monitor` tool.

Ends are taken from `SubagentStop`, from a later `KillShell`/`TaskStop` naming the id, or from a
`BashOutput`/`TaskOutput` whose result says the task is over. Anything else is caught by silence
(half an hour for a subagent, six hours for a shell), and everything a session owns is ended
wholesale when its process restarts, ends, or stops on a usage limit — a limit kills the subagents
too, and waiting for them to announce an end that will never come would hold off the very swap that
fixes it.

The marks read from the same data, so a tab and a list cannot disagree about what a session is
doing: `◐` says its own turn has ended but its subagents have not, `◌` says it is idle while still
holding a background shell or monitor. And "it has finished something you have not seen" is no
longer decided by the main thread alone — a session whose subagents are still running has not
finished anything yet, so it does not get a `✓` for going quiet.

**Only subagents hold a respawn.** `readyForRespawn` in `src/shared/respawn.ts` is the one rule, used
by the daemon to decide and by the web to label the button, so the two cannot drift. A background
shell does not hold anything: a dev server started this morning would block a restart for ever, and
re-running it costs nothing like what a subagent costs. A respawn that comes due on its deadline
gives way to a live subagent for up to twenty minutes; `SubagentStop` then takes the queued respawn
after a few seconds' pause, which is long enough for the session to wake up and read the report the
wait was for.

**When it happens** matters more than it looks, because a swap kills whatever the turn had in
flight, subagents included. Only a session positively known to be at a prompt is taken — not one
that merely fails to look busy, since a turn can run for an hour without a hook and a session at a
permission prompt, one still starting and one the liveness sweep gave up on all read the same from
here. `StopFailure` is the exception: that limit has already ended the turn, so there is nothing
left to protect. The same limit seen only in the terminal's output says nothing about the turn, so
it is queued behind it with a few minutes' grace. A session that is cut short anyway is told so on
the way back in, because "continue" alone invites it to trust the tail of a transcript whose last
tool calls may have been killed halfway.

**Where it lands** is the subscription with the most headroom once the sessions already on it are
counted — they burn it down together, and how long a session lasts before it has to move again is
what decides how often it moves. A window minutes from resetting counts for what it is about to be
worth. A subscription this session has just left is discounted, so two of them drifting either side
of each other cannot pass a session back and forth. And a session already running is only moved for
a clear improvement: a swap costs a turn, which is a bad trade for a few points of headroom, twice
over once the numbers cross back.

**A session that has already stopped** is judged differently, because the question is no longer
whether somewhere else is better than where it is: it has nowhere. The proactive threshold is what
keeps a working session from moving for a small gain, and applying it to a stopped one is how a
session sat out a reset that had already happened — every subscription was above the bar, so
nothing moved, and it waited for its own window instead. So a swap made at a limit will take any
subscription that is not itself spent, and every usage refresh revisits the sessions the board
still shows as `limited` (`rescueLimited`, at most once a minute per session, and never on numbers
already marked stale). If their own subscription has come back they are not moved at all — that
would cost a resume to arrive where they already are — only typed the continue message; otherwise
they move to whatever has room, and are told to carry on there. Which of the three it is, is
`rescueDecision`.

**An out-of-date terminal is replaced rather than reused.** Half of Switchboard lives in the
process hosting the session's terminal, and that process keeps the code it started with, so
respawning claude inside it brings the session back on a new build of claude and an old build of
everything around it — the *old host* badge, worn for the rest of the session's life, and the
reason a fix to the runner never reached the sessions that most needed it. Coming back is the one
moment when a fresh terminal costs nothing a respawn does not already cost, so `executeRespawn`
relaunches instead whenever `runnerStale` says so. That covers every way a session comes back —
swap, restart, update-restart — because they all funnel through there; if the relaunch cannot
happen (the folder is gone) the respawn in place still goes ahead.

## Web terminal

The runner streams PTY output to the daemon, which feeds a headless xterm per run
(`@xterm/headless` + serialize addon). A browser attaching to `/ws/term/:runId` receives the
serialized current screen and then live data, and can send input. Enter sends and Shift+Enter opens
a new line, in the composer and in the grid alike — the grid gets `ESC CR` for the latter, the
sequence Claude Code's own `/terminal-setup` installs, because a terminal otherwise sends a plain
carriage return for both. Ctrl/Cmd+V is handed back to the browser rather than claimed by xterm,
which would send `^V` to the session instead of pasting. It offers a key bar (Esc, Tab,
⇧Tab, arrows, Ctrl‑C, Enter) plus a text composer, which is the default way in: on a phone, typing
into the grid goes through the browser's hidden input where autocorrect rewrites as it pleases, and
there is nowhere to read a prompt back before sending it.

The browser view is always fitted to its own screen — there is no unfitted mode to choose, because
a mirror of a TUI at someone else's dimensions is not useful. It re-fits whenever its box changes
size, watched rather than caught on window events: on mount the box is often not measurable yet, and
a fit that cannot measure would leave the terminal at whatever size the pseudo-terminal has. It keeps no scrollback of its own:
the session tracks the mouse, so xterm hands wheel events to it and the session scrolls its own
view, which is what a reader wants and leaves no second scrollbar to get lost in. Touch is bridged
to the same path — xterm's own touch scrolling bows out whenever a program tracks the mouse, so a
vertical drag is turned into wheel events and, being consumed, no longer leaves iOS rubber-banding
the page for want of anything to scroll. The terminal is pinned to the bottom of its
box at a fixed height rather than stretched to it, so a phone's keyboard covers the top of the frame
and leaves the prompt visible; re-fitting on the keyboard instead would resize the pseudo-terminal
twice per message and reflow the whole session each time. **Hand back** returns the size to the
desktop terminal, and the browser then follows at whatever size that window has until it is asked
to fit again.

The Windows Terminal tab owns the PTY size until a browser fits to its own screen, which is what a
phone needs. Only one of them can own it — claude positions the cursor absolutely and wraps for the
size it was given, so drawing that into a console of another size lands lines on top of each other,
and Windows Terminal ignores a programmatic resize (`CSI 8;h;w t`) so the console cannot be made to
follow. While the browser owns the size the console is therefore **parked**: it is cleared, told
what is happening, and stops being written to. It takes the size back when the browser stops
fitting, the last viewer disconnects, or the window is resized, and claude is nudged into a full
repaint at the console's own dimensions.

The tab's title is the session's name. Tabs are opened without `--suppressApplicationTitle` and the
runner sets the title itself, so renaming a session reaches its tab; title sequences from claude are
dropped on the way to the console, which would otherwise put the old name back.

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

Schema changes are an append-only list of migrations in `src/daemon/db.ts`, applied on open and
tracked with `PRAGMA user_version`.
