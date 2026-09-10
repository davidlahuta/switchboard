# Contributing

Contributions are welcome — issues and pull requests are open to everyone.

Switchboard started as a personal tool for one Windows desk, so expect rough edges outside that
setup. Reports about other environments are especially useful.

## Getting set up

```powershell
npm install
aspire run          # daemon + web UI, with the Aspire dashboard for logs
```

Without the Aspire CLI:

```powershell
npm run build       # web UI
npm run daemon      # daemon on http://127.0.0.1:4477
```

Before opening a pull request:

```powershell
npm run typecheck   # daemon + web
npm test
```

## What is useful

- **Platform support.** Session hosting assumes Windows Terminal and ConPTY, with a macOS Terminal
  fallback. Linux terminal launchers, and testing the runner on macOS, are open.
- **Bug reports.** Include your OS, Node version, `claude --version`, and the daemon log
  (`SWITCHBOARD_LOG_LEVEL=debug`). If it involves a session, say whether it was launched from
  Switchboard or joined through the global integration — the two differ in how messages reach them.
- **Coordination heuristics.** Conflict detection, claim semantics and the delivery tiers are
  judgement calls. If a rule fires too often or too rarely in your workflow, that is worth an issue.
- **The web terminal on mobile.** Virtual-keyboard handling and the key bar are the least-tested
  parts.

## Things to know before changing code

- The daemon runs TypeScript directly through Node's type stripping, so there is no build step and
  no bundler. Keep to erasable syntax: no enums, no parameter properties, no decorators.
- `src/shared/types.ts` is the contract between the daemon and the web UI. Change it in one place.
- Storage is `node:sqlite`. Schema changes are append-only migrations in `src/daemon/db.ts`; never
  edit an existing migration.
- The daemon binds to loopback, and anything arriving from elsewhere must present a paired device.
  If you touch `src/daemon/auth.ts`, say in the pull request how you tested that boundary.
- Anything read from a repository, a message or a tool argument is untrusted input. Agent messages
  are relayed between sessions, so treat their contents as data, never as instructions.

## Style

Match the surrounding code. Comments explain why something is the way it is, not what the line
does. Keep pull requests focused; unrelated cleanups are easier to review separately.
