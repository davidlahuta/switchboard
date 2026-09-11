# Switchboard

**A local control room for Claude Code.** Switchboard runs on your machine and does two jobs:

1. **Keeps parallel agents from stepping on each other.** Every Claude Code session working on the
   same repository (across all its worktrees) joins one group. Agents can see who is working on
   what, claim files, message each other and the operator, and they get warned the moment two of
   them touch the same file.
2. **Juggles multiple Claude subscriptions.** Add all your Pro/Max logins, watch their 5‑hour and
   weekly limits in one dashboard, start a session on any of them with one click, and let
   Switchboard **move a running session to another subscription** when one runs dry. The terminal
   stays open and the conversation continues.

Each hosted session is also mirrored to the web UI as the real Claude Code terminal, so you can
keep driving your agents from your phone (for example over Tailscale). It is built to stay up:
registered with Task Scheduler, it restarts itself within seconds if it ever dies, and it can keep
`claude` itself up to date.

> Status: early, Windows-first (Windows Terminal + ConPTY). The coordination server works anywhere
> Claude Code runs; session hosting also has a macOS Terminal launcher.

---

## Features

**Coordination (MCP + hooks)**

- Repo groups keyed by the main worktree: `git worktree` and `claude --worktree` sessions share one group.
- Presence: working / idle / waiting for permission / rate-limited / offline, plus each agent's declared intent.
- Automatic file-touch tracking. Overlapping edits open a conflict, warn the editing agent inline and notify the other one.
- Soft and exclusive claims with TTLs. Exclusive claims block other agents' edits through a `PreToolUse` hook, with a clear reason telling them who to talk to.
- Messages (direct, broadcast, or to the human) with a token-aware delivery strategy:
  urgent messages and questions are **pushed** into the session through Claude Code channels, while FYIs
  ride along on the next hook call so idle agents aren't woken up for nothing.
- `sb_send` can wait for a reply, so agents can ask each other a question and continue.
- Shared pinned notes (decisions, gotchas) injected into every new session's start-up context.

**Subscriptions and sessions**

- Each subscription gets its own isolated `CLAUDE_CONFIG_DIR` profile. Transcripts, plugins, skills and settings are shared with `~/.claude`.
- Live usage per subscription (5‑hour, weekly, per-model weekly) with reset countdowns and 48 h history, plus aggregate capacity across all plans.
- Subscriptions are ranked by what you can actually use **right now**: plan size scaled by whichever window is tighter, so the one to start on is always first.
- One-click launch into a Windows Terminal tab, optionally in a fresh worktree or resuming an older session (including one started before Switchboard existed).
- Point it at the folder your repos live in and pick from a list instead of typing paths; linked worktrees are shown under the repo they belong to.
- Per session: model (1M-context models, listed from the API rather than hardcoded), auto-compact and its threshold, whether to skip tool permissions, and any extra `claude` arguments.
- **Hot swap**: `kill` + `claude --resume <same session>` under another subscription, in the same tab. It triggers
  manually, when a session runs into a usage limit, or on its own once a subscription crosses the threshold
  while the session is idle.
- A swap kills the session and resumes it, so it happens **between turns**. A turn can run for an hour with
  subagents under it, and only a session positively known to be at a prompt is taken; everything else waits.
  A limit that has already ended the turn is the exception, and a session cut short is told so rather than
  just being told to continue.
- **Restart on update**: `claude update` runs on a schedule; when the version changes, sessions restart onto the new build once their agent is idle — however long that takes.
- A session coming back on a conversation it already had is told to carry on, with a message you write (Settings → *Continue message*).
- The sessions list marks what wants looking at: a session stopped on a prompt only you can answer, one that
  has messaged you, or one that finished something you have not read. A session merely working gets no mark,
  because a mark on everything is a mark on nothing.
- Sessions carry **one name and one model** between Switchboard and Claude Code: rename in the web UI or with `/rename` in the session, change the model with `/model`, and both sides agree either way.
- Web terminal: full Claude Code TUI in the browser (xterm.js), built for a phone — fitted to the screen, pinned above the keyboard, with a key bar and a prompt composer, and one button to hand the terminal back to the desk.
- Device pairing for remote access (QR code). Local access needs no login. Add it to your phone's home screen and it runs without browser chrome.
- Runs as a Task Scheduler logon task with a supervisor that brings the daemon back if it exits.
- Sessions outlive their terminals. After a crash, a power cut or an exit, they are still listed — **Resume** opens a new terminal on the same conversation.

---

## Requirements

- Windows 10/11 with [Windows Terminal](https://aka.ms/terminal) (for one-click sessions)
- [Node.js](https://nodejs.org) 24 or newer (uses the built-in `node:sqlite` and native TypeScript type stripping)
- [Claude Code](https://code.claude.com) 2.1.x on `PATH`
- For development orchestration: [.NET 10 SDK](https://dotnet.microsoft.com) + [Aspire CLI](https://aspire.dev)

## Quick start

```powershell
git clone https://github.com/davidlahuta/switchboard
cd switchboard
npm install
aspire run
```

`aspire run` starts the daemon on **http://127.0.0.1:4477** and the web UI dev server. The Aspire
dashboard shows logs, health and restarts for both. Open the `web` endpoint from the dashboard.

Without Aspire:

```powershell
npm run build   # build the web UI once
npm run daemon  # daemon + UI on http://127.0.0.1:4477
```

### 1. Subscriptions

Your existing `~/.claude` login is imported automatically as **Default**. To add another:
**Subscriptions → Add subscription**. A terminal opens with `claude auth login` running inside the
new profile. Sign in with the account you want (a private browser window helps if you are
already signed in to claude.ai with another account). The card turns *ready* once the login lands.

### 2. Sessions

First tell Switchboard where your repositories live: **Settings → Repositories → Add folder**
(for example `C:\src`). It scans up to three levels deep for git repositories, so the new-session
dialog becomes a pick-from-a-list rather than a path to type.

**Sessions → New session**: pick a directory and a subscription (or *Auto*, which picks the one
with the most headroom). A tab opens in the Windows Terminal window you were last using, or in one
of Switchboard's own if you prefer (Settings → *Open sessions in the terminal window I am using*).
From there you can:

- **Swap** it to another subscription at any time. If the agent is mid-turn, the swap waits for the turn to finish.
  So do a restart and a relaunch: asking for one mid-turn queues it and takes the session the moment the turn ends,
  rather than refusing or cutting the work off. *Force now* is there for when you mean the other thing. Whatever is
  queued shows as a badge on the session saying what it is and what asked for it — you, a claude update, a usage limit.
  Where it lands is the subscription with the most room once the sessions already there are counted, so work
  spreads out rather than piling up, and a session is not moved for a margin too small to be worth the turn
  it costs — or moved back where it has just come from.
- Open it in the browser and keep working.
- Leave it running overnight. A session whose terminal dies — a window closed, a claude that fell
  over, a resume that collided with a process still shutting down — is reopened and resumed on a
  backoff that starts at half a minute, and gives up after a few attempts rather than reopening a
  terminal all night (Settings → *Bring sessions back when their terminal dies*). Stopping a session
  yourself is never undone.
- Trust it to wait for **subagents**. A session says it is idle the moment its own turn ends, but a
  subagent launched in the background keeps running — and spending — for minutes after that, so a
  queued restart or swap waits for the subagents too, and the session lists say what it still has
  open. Background shells and monitors are shown the same way but do not hold anything up: a dev
  server would block a restart for ever, and re-running one costs nothing like a subagent's tokens.

- Let it swap itself when it hits a limit (Settings → *Auto-swap*, on by default), or before it gets there
  (*Proactive swap*, on by default at 85%). Waiting for the limit means every swap lands mid-turn; whatever
  sits above the threshold has to carry one whole turn, so lower it if your turns run long. A session that
  does run out is not left there: the threshold is what stops a *working* session moving for a small gain,
  and one that has stopped will take anything with room left. It is checked again every time usage is read,
  so when a window turns over it either moves to whatever came back or — if that was its own — simply gets
  told to carry on where it is.
- **Rename** it from the pencil next to its name, or with `/rename` inside the session — there is one
  name, and whichever side you change it on the other follows, tab title included. The same goes for
  `/model`. The tab carries the same mark the session lists draw, so a strip of terminals and the web
  read as one thing: `❗` stopped on a prompt only you can answer, `✉` it has said something to you,
  `✓` finished something you have not looked at, `●` working, `◐` working through subagents (its own
  turn has ended, theirs has not), `◌` idle but still holding a background shell or monitor open,
  `⏳` waiting out a limit, and nothing at all when it is idle and read. The lists sort the first
  three to the top — a session that is merely working wants nothing from you and will finish on its
  own.
- **Hand back** the terminal when you are done with it on the phone. A pseudo-terminal has one size:
  while a browser is fitted to its own screen it owns that size, and the desktop window is parked
  rather than shown a frame drawn for other dimensions. The browser then follows the desktop
  terminal until you ask it to fit again.
- **Relaunch** it in a new terminal, or give every session one at once from Settings → *All sessions*, alongside
  *Restart claude in every session*. Both are queued per session, so pressing either on a working desk interrupts
  nothing. A restart in place reuses the window Switchboard opened, which
  hosts part of Switchboard itself, so it keeps running the code it started with; sessions in that
  state are badged *old host*. You rarely have to ask for it: a session badged that way gets a new
  terminal automatically the next time anything brings it back — a swap, a restart, an update —
  since that is the one moment when a fresh terminal costs nothing the respawn does not already
  cost. A relaunch resumes the same session GUID, so nothing is lost — and if
  Claude Code cannot pick that conversation up, the session it starts instead is stopped rather than
  allowed to take its place, leaving the run pointed at the conversation that is still on disk.

**Overview → Usage burn rate** answers the question the four percentages do not: at what the desk is
spending right now, does a ceiling arrive before the window under it resets? It pools every ready
subscription — weighted by plan, since a point of a 20x is worth twenty of a Pro — measures the rate
from the usage history, and walks it forward through each subscription's own reset. The answer is a
time, or *never*, which is what it usually is when the windows turn over faster than the desk spends
them.

The session list is ordered by activity — live sessions first, most recently active at the top —
and can be filtered to one repository. Each row says when its session was last active.

Each session can override the model (1M-context models only, listed live from the API rather than
hardcoded; a later `/model` inside the session is picked up automatically), auto-compact and its
threshold, whether to skip tool permissions
(`--dangerously-skip-permissions`, on by default — sessions running that way are badged
*skip tool permissions*), and pass extra `claude` arguments.

Switchboard refuses arguments it manages itself (`--session-id`, `--resume`, `--settings`, …) so a
session stays resumable and coordinated, and refuses ones that have their own control
(`--model`, `--name`, `--dangerously-skip-permissions`) so a setting is never applied twice.

To continue an existing conversation, use the **Session** dropdown: it lists the conversations
Claude Code has recorded for that folder, and its last entry lets you paste a session GUID from
anywhere else.

You can also start a hosted session from any terminal:

```powershell
node src/cli.ts run --sub auto --name "api refactor"
```

### 3. Coordination for sessions you start yourself

Hosted sessions get the MCP server, hooks and push channel automatically. To make every other
Claude Code session join as well:

```powershell
node src/cli.ts install     # or Settings → Claude Code integration → Install
```

This registers the `switchboard` MCP server at user scope and adds HTTP hooks to
`~/.claude/settings.json`. `uninstall` removes both. Sessions you start yourself get messages via
hooks and tools. Only hosted sessions receive real-time pushes, because channels need a start-up flag.

## Always on

Switchboard is meant to be running whenever the desk is. Register it with Task Scheduler:

```powershell
node src/cli.ts service install     # or Settings → Automatic start
```

This runs a small supervisor that keeps the daemon alive, restarting it within ~10 seconds if it
ever exits, with output appended to `%LOCALAPPDATA%\switchboard\daemon.log`. `service status`
reports the task state and whether the daemon answers; `service uninstall` removes it.

It is a **logon** task rather than a startup one: opening terminal tabs needs an interactive
desktop, which a session-0 service does not have. After an unattended reboot — Windows Update, a
power cut — the daemon comes back as soon as the desk signs in. If you want that to happen without
touching the machine, turn on *Settings → Accounts → Sign-in options → Use my sign-in info to
automatically finish setting up after an update*, and set the BIOS to power on after AC loss.

### What survives the machine going down

The conversations do. Claude Code writes them to disk under the subscription's profile, and
Switchboard only ever addresses a session by its id, so a terminal is a window onto a conversation
rather than the conversation itself.

When the daemon starts and finds sessions it recorded as running, it marks them **disconnected** —
the terminal is gone, the conversation is not. They stay in the list with everything they had:
directory, subscription, model, arguments, session id. **Resume** opens a new terminal and picks the
conversation up where it stopped. The same button is there when a session exits on its own, so an
unexpected exit is one click rather than a new session and a pasted GUID.

Tailscale and RustDesk are Windows services set to start automatically, so they are up before anyone
signs in. Switchboard is not, for the reason above — so after a power cut the path is: the machine
boots, you reach it over Tailscale with RustDesk, sign in, and Switchboard and every session are one
click from where they were.

## Claude Code updates

Switchboard can keep `claude` current itself (Settings → Claude Code version). It runs
`claude update` on a schedule, and when the version changes it restarts hosted sessions onto the
new build by resuming the same session GUID — each one waits until its agent is idle, so no turn
is interrupted.

## Remote access (phone)

The daemon listens on `127.0.0.1` only, so `http://localhost:4477` works on the desk and nowhere
else — on your phone, `localhost` means the phone. Pick one of two ways to bridge it:

**Tailscale serve (recommended).** On the desk:

```powershell
tailscale serve --bg 4477          # tailnet only, no public exposure
```

This gives you `https://<machine>.<tailnet>.ts.net` with a real certificate. Your tailnet admin
must have the Serve feature enabled; the CLI prints an approval link if it isn't.

**Direct bind.** If you'd rather not use `serve`, listen on the tailnet interface as well:

```powershell
$env:SWITCHBOARD_BIND = "100.x.y.z"   # your Tailscale IP; loopback stays bound either way
```

Then reach it at `http://100.x.y.z:4477` (Windows Firewall must allow inbound on that port).

On the phone, use **Share → Add to Home Screen**. It opens without browser chrome from then on,
which for a full-screen terminal is most of the screen back. Safari's own bar above the keyboard is
not something a page can remove, so the session header collapses while you type instead.

Either way, finish on the desk with **Settings → Remote access → Pair a device** and scan the QR
code with your phone. Only requests that come straight from the desk skip pairing; anything
proxied or arriving on another interface must present a paired device, which you can revoke at any
time.

## How agents use it

The MCP server exposes eight tools, with deliberately short descriptions to keep context cost low:

| Tool             | Purpose                                                                 |
|------------------|-------------------------------------------------------------------------|
| `sb_status`      | Who else is here, their intents and claims, open conflicts, pinned notes |
| `sb_intent`      | Announce the current task and the files it will touch                   |
| `sb_claim`       | Reserve paths (soft or exclusive, with TTL)                             |
| `sb_release`     | Release claims                                                          |
| `sb_send`        | Message an agent, everyone, or the human; optionally wait for the reply |
| `sb_inbox`       | Read unseen messages                                                    |
| `sb_note`        | Record a shared decision / fact / warning / todo                        |
| `sb_who_touches` | Who recently edited or claimed these paths                              |

The server's instructions set out a working agreement rather than a list of features: announce
before you edit, reserve then release, broadcast what the others cannot see, answer before you
stop, never wait in silence.

Nothing there depends on an agent remembering it. Hooks carry the board into the session on their
own — a start-up digest, inline overlap warnings, edits blocked inside exclusive claims, lazy
delivery of FYIs — and a sweep every minute chases the two silences that leave somebody waiting:

* An agent editing a shared repo without ever having announced anything is asked for an intent, at
  the moment it edits.
* A claim its holder stopped touching half an hour ago is raised with the holder — exclusive ones
  loudly, since everyone else is blocked on them meanwhile.
* A question nobody answered is put back to the agent it was asked of; if that agent has gone
  offline holding the answer, whoever asked is told to stop waiting.

`sb_status` and the start-up digest close on the same thing: what this agent owes the others,
written as steps rather than as state. Announcing an intent and releasing an exclusive claim are
broadcast to the live agents, so a claim that lifts does not go on shaping everybody else's work.

All of that can be read and ignored, so the three ways one agent can leave another stuck for good
are handled rather than mentioned:

* **Nobody waits on a dead session.** A session whose run has ended, or whose tools have
  disconnected without a hook since, is off the board in about a minute rather than after hours of
  silence — and going offline releases its claims.
* **Nobody waits forever on a live one.** A blocked edit records who is waiting on whom. Ten
  minutes later, a claim its holder has not touched since the wait began is released for the agent
  that is waiting; a holder still working in there keeps it and is told somebody is queued. Agents
  waiting on each other in a ring — which no amount of patience unpicks — are shown to the operator
  as a deadlock and broken at the quietest link.
* **A turn does not end owing something.** Stopping is held once, briefly, when the agent has read
  a question and not answered it or holds a lock somebody is standing in front of. Once: an agent
  that has been told and stops anyway has decided, and being asked every turn would only cost
  turns.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and the [API reference](docs/API.md).

```
src/
  cli.ts            entry point: daemon | run | mcp | install | service | status
  daemon/           HTTP + WebSocket server, coordination, subscriptions, runs, auth,
                    usage polling, model catalogue, claude updates, auto-start
  mcp/shim.ts       stdio MCP server + channel, one per Claude Code session
  runner/runner.ts  PTY host that keeps the terminal alive across swaps
  shared/           API types, MCP tool definitions, internal protocol
web/                React UI (Vite)
apphost.cs          Aspire AppHost for development
```

## Configuration

| Variable                  | Default                           | Meaning                                   |
|---------------------------|-----------------------------------|-------------------------------------------|
| `SWITCHBOARD_PORT`        | `4477`                            | Daemon port                               |
| `SWITCHBOARD_BIND`        | *(loopback only)*                 | Extra addresses to listen on, comma-separated |
| `SWITCHBOARD_DATA_DIR`    | `%LOCALAPPDATA%\switchboard`      | Database, profiles, runtime files         |
| `SWITCHBOARD_CLAUDE_PATH` | `claude` on `PATH`                | Claude Code executable                    |
| `SWITCHBOARD_WT_WINDOW`   | the window you are using          | Windows Terminal window for hosted tabs; overrides the setting |
| `SWITCHBOARD_LOG_LEVEL`   | `info`                            | `debug` / `info` / `warn` / `error`       |

Runtime settings (auto-swap, thresholds, continue message, repository folders, session defaults
for model, auto-compact and permission prompts, update schedule, conflict window, polling
interval) live in the UI under **Settings**.

## Caveats

- **Usage numbers come from the same OAuth endpoint Claude Code's `/usage` uses.** It is not a
  documented public API and may change. When it fails, cards say why — *rate limited*, *login
  expired*, *unreachable* — and limit detection still works through the `StopFailure` hook.
  That endpoint rate-limits per account, so a 429 pauses polling for every subscription until
  `Retry-After` expires; raise **Settings → usage polling** if you see it often.
- **The model list comes from `/v1/models`** and is filtered to models with a 1M-token context.
  If it cannot be fetched, sessions fall back to whatever Claude Code would pick by default.
- **Push delivery uses Claude Code channels** (research preview). Hosted sessions start with
  `--dangerously-load-development-channels server:switchboard`, because custom channels are not on
  Anthropic's allowlist. Team/Enterprise orgs must enable channels.
- Messages between agents are relayed text. The MCP instructions tell agents to treat them as
  peer input, not as instructions that override their user.
- Credentials never leave your machine. Switchboard reads each profile's `.credentials.json` only
  to query that account's usage and profile from `api.anthropic.com`, and never refreshes tokens
  itself (the `claude` CLI does).
- Make sure your use of multiple subscriptions complies with Anthropic's terms for your plans.

## Development

```powershell
npm run typecheck   # daemon + web
npm test            # node:test suite
aspire run          # daemon with --watch + Vite HMR
```

`aspire run` and the auto-start task both want port 4477, so stop one before using the other
(`node src/cli.ts service uninstall`, or just stop the task for the session).

**After pulling changes, restart the daemon.** It executes TypeScript straight from `src/`, and the
supervisor only relaunches it when it exits — so a running daemon keeps serving the old code, and
silently ignores request fields it does not yet know about. The UI notices this and offers a
restart; from a terminal, `curl -X POST http://127.0.0.1:4477/api/service/restart` or just kill the
process and let the supervisor bring it back.

## Contributing

Issues and pull requests are open. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, what's most
useful to work on, and the few conventions worth knowing before changing code.

## License

[MIT](LICENSE)
