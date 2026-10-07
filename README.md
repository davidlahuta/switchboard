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
- A subscription knows which account it is **for** as well as which account it is **on**, and says so when
  they differ. A login that lands on the wrong account is otherwise invisible: the usage that comes back is
  real, it is simply somebody else's, and where both accounts are on the desk one pool gets ranked twice and
  work is spread across capacity that does not exist. Such a subscription is badged *wrong account*, reports
  no headroom, is left out of the burn forecast and is never chosen — until you log in again or rename it to
  what it is.
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

**Accounts and tools**

- Google and Microsoft accounts, kept in Switchboard like subscriptions and given to each session you choose: several at once, of either provider, each under its own MCP server. Sessions only ever see short-lived tokens. See [Google and Microsoft accounts](#google-and-microsoft-accounts).
- Every session gets a Playwright browser and Claude Code's *You should know* plugin, each a checkbox away from without.

---

## Requirements

- Windows 10/11 with [Windows Terminal](https://aka.ms/terminal) (for one-click sessions); satellite desks can also be Linux, see [More than one desk](#more-than-one-desk)
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
**Subscriptions → Add subscription**. Switchboard runs `claude auth login` for the new profile, which
opens a browser on the desk. Sign in with the account you want (a private browser window helps if you
are already signed in to claude.ai with another account). Not at the desk, or no browser opened? The
card shows the sign-in link: open it on whatever device you are on, sign in, and paste the code the
page ends on into the box under it. The card turns *ready* once the login lands.

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
- Leave it running overnight. A session whose turn *fails* — a spend cap, an overloaded API, an error
  it could not carry on from — is told to carry on by itself, on a backoff, until it has a turn that
  ends properly. A session that stops because it is **finished**, or because it asked you something,
  or because you parked it, is never told anything: only a failed turn leaves the mark, and a good
  turn clears it. Sessions with *Send the continue message* switched off are left alone either way.
- Trust it to come back. A session whose terminal dies — a window closed, a claude that fell
  over, a resume that collided with a process still shutting down — is reopened and resumed on a
  backoff that starts at half a minute, and gives up after a few attempts rather than reopening a
  terminal all night (Settings → *Bring sessions back when their terminal dies*). Stopping a session
  yourself is never undone.
- Trust it to wait for **subagents**. A session says it is idle the moment its own turn ends, but a
  subagent launched in the background keeps running — and spending — for minutes after that, so a
  queued restart or swap waits for the subagents too, and the session lists say what it still has
  open. Background shells and monitors are shown the same way but do not hold anything up: a dev
  server would block a restart for ever, and re-running one costs nothing like a subagent's tokens.

- A limit takes the whole session with it. A subagent is not a separate claim on the account, so a session
  that runs out takes its subagents down too, and none of them ever reports finishing — so a limit that is
  *known* to have stopped the session clears them itself. Otherwise the first thing those ghosts do is hold
  up the swap the limit is asking for: the respawn falls due, sees a subagent and waits for work that died
  with the turn. Known matters — a spend cap read off the terminal may be a subagent's own failure while the
  parent carries on, and writing off a live subagent is how a respawn takes a session out from under one —
  so only a limit Claude Code reported, or one the usage numbers corroborate, counts. One limit is also
  answered once, however many times the banner is reprinted as Claude Code retries: a second reading of the
  same limit does not buy the session another three minutes before it moves.
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
  `⏳` waiting out a limit, and nothing at all when it is idle and read. A session that has been told
  to carry on as often as it is worth asking carries `❗` too: nothing else is coming for it. The
  lists sort the first three to the top, and in that order — a session stopped on a question is
  above one that has only finished something, however long ago it stopped, because it is the one
  that will still be sitting there tomorrow. A session that is merely working wants nothing from you
  and will finish on its own.
- **Hand back** the terminal when you are done with it on the phone. A pseudo-terminal has one size:
  while a browser is fitted to its own screen it owns that size, and the desktop window is parked
  rather than shown a frame drawn for other dimensions. The browser then follows the desktop
  terminal until you ask it to fit again.
- **Relaunch** it in a new terminal, or give every session one at once from Settings → *All sessions*, alongside
  *Restart claude in every session* and *Rebalance subscriptions* — which looks at the whole desk in one pass and
  moves the sessions that would be clearly better off elsewhere. Swapping them one at a time from their own menus
  cannot do the same thing: each of those answers is given as though it were the only session moving, so every one
  of them names the same emptiest subscription and they all pile onto it. A rebalance counts its own moves as it
  makes them — worst-placed session first, each destination worth less once it has been given one, each source
  worth more to the sessions left on it — and asks the same margin a proactive swap does before moving anything at
  all. Pressing it straight after *Give every session a new terminal* is safe and does what both asked: the queued
  relaunch is absorbed into the swap rather than raced with it, so each session comes back once, on its new
  subscription, in a new terminal. A session already on its way somewhere for a limit is left where it is going. Both are queued per session, so pressing either on a working desk interrupts
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
and can be filtered to one repository.

A session is **one line**: its mark, its name, what it is doing right now, when it was last active,
and the two things worth doing to a session you are only glancing at — open its terminal, or tell it
to carry on. Everything that is a decision rather than a reflex is one tap away: open the row and it
says where it lives, which subscription it is on, its session id and its swap history, and offers
restart, swap, hand-back and stop. A desk of nine sessions fits on a phone screen that way, which is
the point — the rows that stay closed are the ones with nothing to answer.

The list moves under you, so it says so: a row that changes places **slides** there rather than
jumping, and a row whose state changes **lights up** for a moment even when it does not move. The
two are different questions — what moved, and what changed — and a session that picks up a subagent
or stalls where it stands answers only the second. Both are off under `prefers-reduced-motion`.

Names are the row's own: as long as the session called itself, ending in an ellipsis with the whole
thing in the tooltip when the row runs out of width. The badges beside them yield first and fade out
at the edge — a session you cannot name is not worth listing.

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

## More than one desk

One Switchboard (the **hub**) can host sessions on other machines too — a laptop, a Linux box — over
Tailscale. Each extra machine (a **satellite**) runs a small desk agent that dials out to the hub; the
hub keeps the board, the subscriptions, the logins and the decisions, and the satellite does what
only a process on that machine can: open terminals, read and write files there, ask git. The hub
runs sessions of its own as well.

Sessions on a satellite need nothing new. They talk to `127.0.0.1` as they always do; the agent
listens there and relays to the hub. Their logins come from the hub (a satellite never holds or
renews one of its own), their transcripts are mirrored to it, and the web terminal drives them like
any other. Nothing about a satellite's user name, home folder or repository folders has to match
the hub's.

**Placement.** Every desk has a *recommended maximum* of sessions (a guess from its cores and memory
until you set one on the Desks page). A new session goes to a desk under its maximum, preferring one
that already has the repository, then the least loaded; a desk without the repository clones it
first. A desk goes over its maximum only when every desk that could take the session is full. New
session lets you pick a desk instead, and `sb_new_session` takes the same `desk`. The Desks page
also keeps a repository to some desks only.

### Setting up the hub

The hub is an ordinary Switchboard (see [Quick start](#quick-start) and [Always on](#always-on)) that
satellites can reach over your tailnet:

1. Install [Tailscale](https://tailscale.com/download) and sign in.
2. Share the daemon with the tailnet. Satellites connect over HTTPS, so this is required, not
   optional:

   ```powershell
   tailscale serve --bg 4477
   ```

   The hub then answers at `https://<machine>.<tailnet>.ts.net`. Your tailnet must have HTTPS
   certificates and Serve enabled; the CLI prints an approval link when they are not. The Desks
   page reads this address from `tailscale serve status`, so the commands it shows are ready to
   paste.
3. Optional, but it saves logging in on every satellite: **Desks → Credentials for sessions** (see
   [Credentials](#credentials) below).

### Adding a satellite

The same on every platform:

1. On the hub, open **Desks → Add a desk**. It shows a single-use pairing code (good for ten
   minutes, and only until the hub restarts) and the exact commands for the new machine.
2. On the new machine, install the prerequisites for its platform (below), then:

   ```sh
   git clone https://github.com/davidlahuta/switchboard
   cd switchboard
   npm ci
   node src/cli.ts desk join https://<hub>.<tailnet>.ts.net <code>
   node src/cli.ts service install --desk
   ```

   `desk join` takes `--name <name>` if the machine's host name is not what you want to see on the
   board.
3. It appears on the hub's Desks page as online within a few seconds, with the tools it found
   (claude, git, gh, az, tmux) and the repositories under its clone folder.

Check it from the satellite with `node src/cli.ts desk status` (which hub, whether the agent runs,
whether it is connected) and `node src/cli.ts service status --desk`.

A machine is either a hub or a satellite: `service install --desk` replaces a daemon's automatic
start if the machine had one. The satellite needs nothing to be open on its side — the agent only
listens on `127.0.0.1` and dials out to the hub.

Afterwards, **Update Switchboard** on the Desks page runs `git pull` (and `npm ci` when the lockfile
changed) on that desk and restarts its agent; its sessions keep running through it. When
Switchboard keeps Claude Code updated, it runs `claude update` on every online satellite too, and a
new version restarts only that desk's sessions, each once it is idle.

### When a satellite goes away

A satellite can sleep, lose its network or be carried to a meeting, and nothing is lost. Within a
minute the hub marks it offline and says so: the Desks page shows it as **offline** (or **away**
for a portable desk), and each of its sessions carries an *offline* badge where its desk name is.
Its sessions are not moved or restarted somewhere else, since their conversations and working copies
are on that machine. They wait for it, without using up revive attempts, and the coordination board
keeps their claims and work as they were.

When the machine wakes, the agent notices it slept and reconnects at once, and every session
reattaches by itself within seconds, with the transcripts written meanwhile caught up. For a minute
after it reconnects the desk shows **reconnecting**, and nothing there is brought back or judged
dead while its sessions find their way back. A session whose claude really did end while the desk
was away is then resumed as usual. A laptop with internet keeps working through Tailscale wherever
it is, so it stays online away from the desk too.

Mark a laptop **Portable** on the Desks page. New sessions go to it only when you pick it, or when
every desk that stays is at its recommended maximum, so sessions you didn't put there don't leave
with it.

### Windows satellite

Prerequisites:

```powershell
winget install OpenJS.NodeJS Git.Git Tailscale.Tailscale Microsoft.WindowsTerminal
irm https://claude.ai/install.ps1 | iex     # Claude Code
```

Sign in to Tailscale, open a new terminal so `node`, `git` and `claude` are on `PATH`, then run the
commands above. Optionally `winget install GitHub.cli Microsoft.AzureCLI` if sessions there should
use `gh` and `az`.

- `service install --desk` registers the logon task **Switchboard desk**, the same supervisor the
  hub uses, restarting the agent within seconds if it exits. The log is
  `%LOCALAPPDATA%\switchboard\desk.log`.
- Sessions open as Windows Terminal tabs, as on the hub.
- It starts at **logon**, not at boot, for the reason in [Always on](#always-on): terminal tabs need
  an interactive desktop. A satellite laptop that reboots is offline until someone signs in; its
  sessions wait for it (they are not moved to another desk, and do not use up revive attempts) and
  come back where they were. To sign in by itself after updates, turn on *Settings → Accounts →
  Sign-in options → Use my sign-in info to automatically finish setting up after an update*.
- The desk token is sealed with DPAPI in `%LOCALAPPDATA%\switchboard\desk.json`.

### Linux satellite

Any systemd distribution: Arch and its derivatives (including Omarchy, below), Fedora, Debian,
Ubuntu. Prerequisites: Node.js 24+, git, tmux, Tailscale and Claude Code. On Debian or Ubuntu, for
example:

```sh
sudo apt install git tmux
curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up
curl -fsSL https://claude.ai/install.sh | bash      # Claude Code
# Node.js 24+ from nodejs.org, NodeSource or your version manager: distribution packages are often older
```

- `service install --desk` writes the systemd **user** unit `~/.config/systemd/user/switchboard-desk.service`,
  enables and starts it, and turns on lingering (`loginctl enable-linger`), so it starts at
  **boot**, before anyone signs in. If enabling lingering needs root it says so; run the command it
  prints once.
- The unit restarts the agent whenever it exits, five seconds later and with no limit on retries, so
  a hub that is unreachable for an hour is simply retried until it answers. It uses
  `KillMode=process`: a restart of the agent leaves tmux and every claude in it running.
- The unit records the `PATH` and the `node` it was installed with. If you move either — a new Node
  version from a version manager, claude installed somewhere else — run `service install --desk`
  again.
- Logs: `~/.local/share/switchboard/desk.log` and `journalctl --user -u switchboard-desk`. The desk
  token is in `~/.local/share/switchboard/desk.json`, readable only by you.
- **Where sessions open.** An agent started at boot has no display, so sessions open in detached
  tmux sessions named `sb-<run>-…`. Drive them from the web terminal as any other, or at the machine
  with `tmux ls` and `tmux attach -t <name>`. An agent started from a desktop session (`node
  src/cli.ts desk`) opens a terminal window instead: `xdg-terminal-exec`, then ghostty, alacritty,
  kitty, foot, wezterm, gnome-terminal, konsole or xterm, whichever is found first.
  `SWITCHBOARD_TERMINAL=tmux` (or the name of a terminal) fixes the choice; set it before
  `service install --desk` and the unit keeps it.

### Omarchy satellite

[Omarchy](https://omarchy.org) is Arch with Hyprland, so everything under Linux applies; the
packages:

```sh
sudo pacman -S --needed git tmux tailscale github-cli
sudo systemctl enable --now tailscaled
sudo tailscale up
curl -fsSL https://claude.ai/install.sh | bash      # Claude Code, into ~/.local/bin
```

Node.js: Omarchy manages it with mise. `mise use -g node@24` gives a Node.js new enough. Run
`service install --desk` from a shell where `node --version` shows 24 or newer, because the unit
keeps that exact `node`. mise removes old versions when you upgrade, so run `service install --desk`
again after moving to a new Node version. Alternatively, `sudo pacman -S nodejs npm` gives a `node`
whose path never changes; check it is 24 or newer.

Omarchy's terminal is Alacritty or Ghostty, both supported when the agent runs from the desktop. The
service started at boot uses tmux, as above. Hyprland's idle lock and suspend do not stop the agent,
but a suspended machine is offline: on an always-on desk station, turn off suspend on idle in
Omarchy's power settings (or `hypridle.conf`).

`az`, if sessions need it: `yay -S azure-cli` (AUR).

### Credentials

A fresh desk can clone and push without logging in to anything when the hub holds the credentials.
**Desks → Credentials for sessions** takes:

- **A GitHub App** (recommended). Create one under your account or organization's *Settings →
  Developer settings → GitHub Apps* with repository permissions *Contents*, *Pull requests* and
  *Issues* read and write, and *Metadata* read; install it on the repositories (or all of them),
  then paste its App ID and private key. The hub mints one-hour tokens for each repository owner.
- **GitHub or Azure DevOps personal access tokens**, each limited to the hosts or organizations you
  give it.
- **An Azure service principal** for `az` and the Azure SDKs.

git reaches them through a credential helper placed in front of only those hosts; `gh` and `az` go
through shims that fetch a fresh token on every call, so a long session never holds a stale one.
They are applied to sessions on every desk, the hub included, and nothing is written to a
satellite's disk. With no credentials saved nothing changes: sessions use whatever logins the
machine already has.

### Moving the hub to another machine

The hub can move — to a new machine, from Windows to Linux or back — without stopping a single
session. The old hub becomes a satellite of the new one: its sessions stay where they run, and their
terminals, hooks and tools reconnect to `127.0.0.1:4477` as they do through any daemon restart, where
the desk agent now listens and relays them to the new hub.

Three commands carry it out:

- `hub stop` stops the daemon for good and removes its automatic start. On Windows it ends the
  supervisor loop and then the daemon, each by its process id. Sessions keep running.
- `hub export <file>` packs the hub into one file:
  - the database;
  - each subscription's settings and login;
  - the hub's copy of every live session's login;
  - the default subscription's login (the old user's own `~/.claude`);
  - the vault's secrets, opened so the new machine can seal them again.

  The file holds every login and secret in the clear, readable only by you. Copy it over a private
  channel, and delete it everywhere once the import is done.
- `hub import <file>` unpacks it on the new machine:
  - it makes a desk of the old hub, and moves that machine's sessions, agents, repositories,
    repository folders and placement settings onto it;
  - it points each subscription at a profile on the new machine;
  - it prints a claim code, good for a week, that the old machine uses with `desk join` to become
    that desk.

**Try it first.** `hub export trial.gz --dry-run` works while the daemon keeps running, and carries
no logins, secrets, paired devices or push subscriptions. Import it with its own data folder and
port, so it cannot reach anything real:

```sh
SWITCHBOARD_DATA_DIR=~/sb-trial SWITCHBOARD_PORT=4499 node src/cli.ts hub import trial.gz
SWITCHBOARD_DATA_DIR=~/sb-trial SWITCHBOARD_PORT=4499 node src/cli.ts daemon
```

A hub imported from a dry run never revives, restarts or updates anything. Its default subscription
is a folder of its own rather than `~/.claude`. Open it at `http://127.0.0.1:4499` and check that
every session is listed on the old hub's desk, waiting for it.

**The move, step by step:**

1. **New machine.** Set it up as a hub would be (Node.js 24+, git, tmux on Linux, Claude Code,
   Tailscale; see the platform notes above), clone Switchboard and `npm ci`. Don't start the daemon.
2. **Old hub.** Stop it, then export:
   ```sh
   node src/cli.ts hub stop
   node src/cli.ts hub export hub.gz
   ```
   From here until step 4, sessions keep working, but nothing coordinates them: no board, no swaps,
   no renewals. Keep the gap to minutes.
3. **New machine.** Copy `hub.gz` over (for example `scp` over the tailnet), then:
   ```sh
   node src/cli.ts hub import hub.gz --name <name for the old hub>
   node src/cli.ts service install
   tailscale serve --bg 4477            # or your own address; see Headscale below
   ```
   `--force` imports over an existing database and keeps it as a `.bak` file.
4. **Old hub.** Join as the desk it now is, with the code the import printed:
   ```sh
   node src/cli.ts desk join https://<new hub> <code>
   node src/cli.ts service install --desk
   ```
   Within seconds its sessions reattach. The new hub mirrors their transcripts, which takes a few
   minutes for long ones.
5. **Other satellites** keep their tokens and only need the new address:
   `node src/cli.ts desk set-hub https://<new hub>`. A running agent moves on its next reconnect,
   which is right away once the old hub is gone.
6. **Afterwards:**
   - Delete `hub.gz` on both machines.
   - On the phone, open the new address, pair again (**Settings → Remote access**) and turn
     notifications back on. Pairings and push subscriptions belong to an address.
   - On the old hub, delete `~/.claude/.credentials.json` if the new hub took it for the default
     subscription. Two machines holding the same login each renew it, and renewing logs the other
     one out. Delete the file rather than running `/logout`, which may revoke the login for both.
     If the new machine already had a login in `~/.claude`, the import kept it and put the old one
     next to it; it says which.

**Going back.** Until the old hub has joined, `node src/cli.ts service install` on the old hub
brings it back exactly as it was. The export doesn't change anything there. After it has joined,
moving back is the same move in the other direction: `hub stop` and `hub export` on the new hub,
`hub import --force` on the old one.

### Your own control server (Headscale)

[Headscale](https://headscale.net) is the open-source control server for Tailscale clients. With a
public IP and a domain, it replaces Tailscale's hosted coordination. The clients and the WireGuard
network stay the same, but MagicDNS names change, and there is no `tailscale serve` with
certificates. So the hub needs an HTTPS address of its own.

Make it a **separate step from moving the hub**. Move the hub on the tailnet you have, where
`tailscale serve` works on Linux as it does on Windows. Then switch the tailnet, and point the desks
at the new address with `desk set-hub`.

A setup that needs no DNS provider API, on an Arch/Omarchy hub (`sudo pacman -S headscale caddy`),
with `hs.example.com` and `sb.example.com` both pointing at your public IP:

- `/etc/headscale/config.yaml`: `server_url: https://hs.example.com`,
  `listen_addr: 127.0.0.1:8080`, and under `dns`, `magic_dns: true`, a `base_domain` that is not
  `example.com` or a parent of it (for example `tail.example.com`), and an extra record that sends
  `sb.example.com` to the hub's tailnet address *inside* the tailnet:
  ```yaml
  dns:
    extra_records:
      - name: sb.example.com
        type: A
        value: 100.64.0.1      # the hub's address: tailscale ip -4
  ```
- `/etc/caddy/Caddyfile`. Caddy fetches both certificates itself (ports 80 and 443 open), and the
  hub answers only on the tailnet:
  ```
  hs.example.com {
      reverse_proxy 127.0.0.1:8080
  }
  sb.example.com {
      @tailnet remote_ip 100.64.0.0/10 fd7a:115c:a1e0::/48
      handle @tailnet {
          reverse_proxy 127.0.0.1:4477
      }
      respond 403
  }
  ```
- `sudo systemctl enable --now headscale caddy`, then `sudo headscale users create <you>` and
  `sudo headscale preauthkeys create --user <id> --expiration 24h` (`headscale users list` shows
  the id) for each machine.
- Every machine, the hub included: `sudo tailscale up --login-server https://hs.example.com --authkey <key>`.
  On Windows it's `tailscale login --login-server https://hs.example.com --authkey <key>`. On the
  phone, the Tailscale app's account menu has a custom coordination server option.
- On the hub, tell Switchboard its address and reinstall its service so the setting sticks:
  `SWITCHBOARD_HUB_URL=https://sb.example.com node src/cli.ts service install`. Then on every
  satellite: `node src/cli.ts desk set-hub https://sb.example.com`.

Because public DNS resolves `sb.example.com` to the public IP and the tailnet resolves it to the
hub, Caddy can prove the name over HTTP while the hub itself is only reachable from your machines.
Anything else gets a 403. Caddy marks requests as proxied, so Switchboard asks for a paired device
or a desk token on every one, exactly as behind `tailscale serve`.

## Claude Code updates

Switchboard can keep `claude` current itself (Settings → Claude Code version). It runs
`claude update` on a schedule, and when the version changes it restarts hosted sessions onto the
new build by resuming the same session GUID — each one waits until its agent is idle, so no turn
is interrupted.

## Google and Microsoft accounts

Sessions can work in your mail, files and calendars: Gmail, Drive, Calendar, Docs, Sheets, Slides,
Contacts and Tasks for Google; Outlook mail and calendar, OneDrive, To Do, OneNote, contacts and, for
work accounts, Teams chats and channels plus SharePoint for Microsoft. You add accounts once on the
**Accounts** page and choose which of them each session gets when you start it. A session can have
several accounts, of either provider, at the same time.

The whole feature is off until you give it an app (below). Without one the Accounts page explains what
to do and nothing else changes: no picker in the new-session dialog, no extra servers.

**How it works.** Switchboard keeps each account's refresh token sealed (DPAPI on Windows, like the
subscriptions' secrets) and gives a session's MCP servers short-lived access tokens, and only for the
accounts that session was started with. Each session gets one MCP server per account, named
`google-<id>` or `ms-<id>`, so its tools read `mcp__google-work__…` and the agent always knows which
account it is acting as.

- Google: [`workspace-mcp`](https://github.com/taylorwilsdon/google_workspace_mcp) (pinned version),
  one shared server per machine on `127.0.0.1:<port+20>` in external-token mode. It keeps no tokens of
  its own. Claude Code asks Switchboard for the account's token on every connection.
- Microsoft: [`@softeria/ms-365-mcp-server`](https://github.com/Softeria/ms-365-mcp-server) (pinned
  version), one process per account per session. A small preload makes it take its token from
  Switchboard instead of signing in or keeping a token cache.

Both are installed on first use under `%LOCALAPPDATA%\switchboard\mcp` (or `~/.local/share/switchboard/mcp`):
npm for Microsoft, [`uv`](https://docs.astral.sh/uv/) for Google, so install uv first
(`winget install astral-sh.uv`, or `sudo pacman -S uv`). A satellite installs and runs its own copies;
the tokens still come from the hub.

A session can send mail and messages without asking you first. That is deliberate: give a session only
the accounts its work needs. A session that starts another one can pass on some or all of its own
accounts, or none of them. It can never pass on an account it does not have.

You can change a running session's accounts from the person icon in its header. A claude cannot be
given new MCP servers while it runs, so the session restarts onto them once its turn is over, and the
conversation carries on.

### The apps

Both providers need an app registration before anything can read a mailbox. You register your own; it
does not need to be reviewed or verified, because only you and the accounts you add use it.

**Google** (in [Google Cloud Console](https://console.cloud.google.com), any project):

1. *APIs & Services → Library*: enable the Gmail, Google Drive, Google Calendar, Google Docs, Google
   Sheets, Google Slides, People and Google Tasks APIs.
2. *OAuth consent screen* (Google Auth Platform): User type **External**, then *Audience → Publish app*,
   so it is **In production**. In *Testing*, refresh tokens expire after 7 days. An unverified app in
   production works without that limit. Google shows a "Google hasn't verified this app" warning when
   you sign in (*Advanced → Go to …*), and the app is capped at 100 accounts over its lifetime.
3. *Data access*: you can leave the scopes empty; Switchboard asks for them when signing in:
   `openid`, `userinfo.email`, `userinfo.profile`, `https://mail.google.com/`, `drive`, `calendar`,
   `documents`, `spreadsheets`, `presentations`, `contacts`, `tasks`.
4. *Clients → Create client*: type **Web application**. Under *Authorized redirect URIs*, add the
   addresses the Accounts page lists: `http://localhost:4477/oauth/google/callback` and, if you use the
   hub from other devices, `https://<your hub>/oauth/google/callback`.
5. Paste the **client ID** and **client secret** into Accounts → Google.

**Microsoft** (in [Microsoft Entra](https://entra.microsoft.com) or with `az`; a free tenant of your own
works):

1. *App registrations → New registration*: supported account types **Accounts in any organizational
   directory and personal Microsoft accounts**.
2. *Authentication → Add a platform → Mobile and desktop applications*: add the redirect URIs from the
   Accounts page: `http://localhost:4477/oauth/microsoft/callback` and
   `https://<your hub>/oauth/microsoft/callback`. Set **Allow public client flows** to *Yes*. This is a
   public client: there is no secret, and sign-in uses PKCE.
3. *API permissions → Microsoft Graph → Delegated*: `offline_access`, `openid`, `profile`, `email`,
   `User.Read`, `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`, `Files.ReadWrite.All`,
   `Contacts.ReadWrite`, `Tasks.ReadWrite`, `Notes.ReadWrite`, plus, for work accounts, `Sites.Read.All`,
   `Chat.ReadWrite`, `ChatMessage.Send`, `ChannelMessage.Send`, `Team.ReadBasic.All`,
   `Channel.ReadBasic.All` and `People.Read`. (Switchboard asks for these when signing in, so listing
   them here only makes the consent screen predictable.)
4. Paste the **Application (client) ID** into Accounts → Microsoft.

With `az`:

```sh
az ad app create --display-name Switchboard --sign-in-audience AzureADandPersonalMicrosoftAccount \
  --public-client-redirect-uris http://localhost:4477/oauth/microsoft/callback https://<your hub>/oauth/microsoft/callback \
  --is-fallback-public-client true
```

**Work accounts.** Many organisations let users consent to apps themselves. Others (and anyone under
Microsoft's default policy for unverified apps) need an admin to consent once for the tenant. If signing
in stops at "Need admin approval", the account row offers an *admin consent* link to send to your admin.

**When an account stops working.** A revoked or expired grant, a changed password, or a new policy
marks the account *needs reconnecting*. You get a notification, and the sessions using it get an error
from its tools until you press **Reconnect** on the Accounts page. Nothing needs restarting.

The apps, accounts and refresh tokens move with `hub export` / `hub import` like everything else. A
dry-run export leaves the tokens out.

## Playwright and You should know

Every session also gets, unless you untick it when starting it:

- **Playwright**: the [Playwright MCP server](https://github.com/microsoft/playwright-mcp) (pinned
  version, `--isolated`), a browser the session can drive with a fresh profile of its own, so sessions
  never share cookies or collide. Installed on first use; until then, `npx` runs the same version.
- **You should know**: Claude Code's built-in `cc-plugin-you-should-know` plugin, enabled through the
  session's settings either way, so a session started without it does not inherit it from yours.

Both defaults are in Settings.

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

The key bar under the terminal is ordered by what a thumb reaches for rather than by what a
keyboard looks like: composer, keyboard, `Esc`, `Tab`, `⇧Tab`, `Enter`, then the arrows, `Ctrl‑C`,
`/` and paste. The bar pans sideways, and anything past the fold costs a swipe before it can be
pressed, so the keys that send and dismiss come before the ones that move around.

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
  cli.ts            entry point: daemon | run | mcp | desk | install | service | status
  daemon/           HTTP + WebSocket server, coordination, subscriptions, runs, auth,
                    usage polling, model catalogue, claude updates, auto-start
  mcp/shim.ts       stdio MCP server + channel, one per Claude Code session
  runner/runner.ts  PTY host that keeps the terminal alive across swaps
  desk/             the satellite's agent, cloning, and the git/gh/az credential helpers
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
| `SWITCHBOARD_TERMINAL`    | *(first one found)*               | Linux desks: a terminal (`alacritty`, `ghostty`, `kitty`, …) or `tmux` |
| `SWITCHBOARD_HUB_URL`     | *(from `tailscale serve`)*        | The address desks join this hub at, when it is not `tailscale serve`'s |

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
