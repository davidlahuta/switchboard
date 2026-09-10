# Switchboard HTTP / WebSocket API

Base URL: `http://127.0.0.1:4477` (override with `SWITCHBOARD_PORT`). All bodies are JSON. Types
live in [`src/shared/types.ts`](../src/shared/types.ts). Errors are `{ "error": string }` with a
4xx/5xx status.

Non-local requests (anything not addressed to a loopback Host, or arriving through a proxy such as
`tailscale serve`) need the `sb_device` cookie from pairing, except `/api/auth/*`.

## Auth & pairing

| Method | Path                     | Body / query         | Returns                          |
|--------|--------------------------|----------------------|----------------------------------|
| GET    | `/api/auth/status`       |                      | `AuthStatus`                     |
| POST   | `/api/auth/pair`         | `{ code, name }`     | sets `sb_device` cookie, `AuthStatus` |
| POST   | `/api/pairing` (local)   |                      | `PairingCode` (valid 10 min)     |
| GET    | `/api/devices` (local)   |                      | `Device[]`                       |
| DELETE | `/api/devices/:id` (local) |                    | `{ ok }`                         |

Pairing link format: `<origin>/#/pair?code=<code>`.

## State

| Method | Path                                  | Returns / body                          |
|--------|---------------------------------------|-----------------------------------------|
| GET    | `/api/state`                          | `StateSnapshot`                         |
| GET    | `/api/settings`                       | `Settings`                              |
| PATCH  | `/api/settings`                       | partial `Settings` → `Settings`         |
| GET    | `/api/integration`                    | `IntegrationStatus`                     |
| POST   | `/api/integration/install`            | `IntegrationStatus`                     |
| POST   | `/api/integration/uninstall`          | `IntegrationStatus`                     |

## Subscriptions

| Method | Path                                   | Body                                   | Returns          |
|--------|----------------------------------------|----------------------------------------|------------------|
| GET    | `/api/subscriptions`                   |                                        | `Subscription[]` |
| POST   | `/api/subscriptions`                   | `{ label, email? }` – creates profile and opens `claude auth login` | `Subscription` |
| PATCH  | `/api/subscriptions/:id`               | `{ label?, enabled?, priority? }`      | `Subscription`   |
| DELETE | `/api/subscriptions/:id?purge=1`       | purge also deletes the profile dir     | `{ ok }`         |
| POST   | `/api/subscriptions/:id/login`         | re-open login terminal                 | `{ ok }`         |
| POST   | `/api/subscriptions/:id/refresh`       | poll usage now                         | `Subscription`   |
| GET    | `/api/subscriptions/:id/history?hours=48` |                                     | `UsagePoint[]`   |

## Repos & coordination

| Method | Path                                  | Body                                   | Returns        |
|--------|---------------------------------------|----------------------------------------|----------------|
| GET    | `/api/repos`                          |                                        | `Repo[]`       |
| GET    | `/api/repos/discovered?refresh=1`     | git repos under `settings.repoRoots` (cached ~60 s) | `DiscoveredRepo[]` |
| POST   | `/api/repos`                          | `{ path }` – register a repo manually  | `Repo`         |
| GET    | `/api/repos/:id`                      |                                        | `RepoDetail`   |
| POST   | `/api/repos/:id/messages`             | `HumanMessageRequest`                  | `Message`      |
| POST   | `/api/repos/:id/read`                 | marks messages to the human as read    | `{ ok }`       |
| POST   | `/api/repos/:id/notes`                | `{ kind, body, pinned? }`              | `Note`         |
| PATCH  | `/api/notes/:id`                      | `{ pinned?, archived? }`               | `{ ok }`       |
| DELETE | `/api/claims/:id`                     |                                        | `{ ok }`       |
| POST   | `/api/conflicts/:id`                  | `{ status: 'resolved' \| 'dismissed' }`| `{ ok }`       |

## Runs (sessions hosted by Switchboard)

| Method | Path                     | Body               | Returns |
|--------|--------------------------|--------------------|---------|
| GET    | `/api/runs`              |                    | `Run[]` |
| POST   | `/api/runs`              | `CreateRunRequest` – opens a Windows Terminal tab. Besides `cwd`/`subscriptionId` it takes `name`, `worktree`, `resumeSessionId` (a GUID), `autoSwap`, `model`, `autoCompact`, `autoCompactTokens` and `args` (extra `claude` arguments; ones Switchboard manages are refused with 400) | `Run` |
| POST   | `/api/runs/:id/swap`     | `SwapRequest`      | `Run`   |
| POST   | `/api/runs/:id/restart`  | `{ force? }` – same subscription, resumes the same session GUID | `Run` |
| POST   | `/api/runs/:id/stop`     |                    | `{ ok }`|
| DELETE | `/api/runs/:id`          | forget an exited run | `{ ok }` |
| GET    | `/api/sessions/recent?cwd=` | recent Claude sessions for a directory (for "resume") | `{ id, title, mtime }[]` |

## Claude Code version and models

| Method | Path                            | Returns                                              |
|--------|---------------------------------|------------------------------------------------------|
| GET    | `/api/update`                   | `UpdateStatus`                                       |
| POST   | `/api/update/check`             | runs `claude update` now → `UpdateStatus`            |
| POST   | `/api/update/restart-sessions`  | `{ queued }` – restart live sessions when idle       |
| GET    | `/api/models`                   | `Model[]` – 1M-context models, cached 6 h            |
| POST   | `/api/models/refresh`           | `Model[]` – refetch now                              |

## Automatic start (local only)

| Method | Path                       | Body / returns                          |
|--------|----------------------------|-----------------------------------------|
| GET    | `/api/service`             | `ServiceStatus`                         |
| POST   | `/api/service/install`     | `{ delaySeconds? }` → `ServiceStatus`   |
| POST   | `/api/service/uninstall`   | `ServiceStatus`                         |

## WebSockets

* `/ws/ui` – server pushes `UiFrame`. On `invalidate`, refetch: scope `state` → `/api/state`,
  `repo:<id>` → `/api/repos/<id>`.
* `/ws/term/:runId` – terminal mirror. Server sends `TermServerFrame` (first a `snapshot`), client
  sends `TermClientFrame`.
* `/ws/agent` – used by the `switchboard mcp` stdio shim (internal).
* `/ws/runner` – used by `switchboard run` (internal).

## Hooks

`POST /hooks/:event` receives Claude Code HTTP hook payloads (`SessionStart`, `UserPromptSubmit`,
`PreToolUse`, `PostToolUse`, `Stop`, `StopFailure`, `Notification`, `SessionEnd`, `CwdChanged`)
and answers with hook JSON output. Internal.
