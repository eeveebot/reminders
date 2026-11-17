# reminders

> The eevee reminders module — time-based reminders delivered back to the originating channel or by DM, with timezone preferences, recurring crontab schedules, announcements, and full list/cancel/edit management.

## Commands

| Command | Description |
|---------|-------------|
| `remind <time> <text>` | Set a reminder. Delivered to the source channel with a nick highlight. |
| `remind -p <time\|cron> <text>` | Deliver by DM. Allows ASCII bells (passthrough). |
| `remind -r <cron> <text>` | Recurring — the time is a crontab expression. No bells. |
| `remind -a <time\|cron> <text>` | Announcement — no highlight, bells allowed. Channel admins only. |
| `remind -z <tz> <time\|cron> <text>` | Timezone override for this reminder only. |
| `tzset <tz>` | Set your timezone (handles DST). |
| `list-reminders` | List your reminders (id + text + time/schedule). |
| `list-reminders -a` | List this channel's announcements, any admin's (channel admins only). |
| `cancel-reminder <id>` | Cancel one of your reminders by id. |
| `edit-reminder <id> [flags] <time> <text>` | Fully re-specify a reminder — time, text, and flags. |

### Time formats

- **Relative:** `1h30m`, `2d12h`, `45s` — composable day/hour/minute/second units.
- **Wall-clock:** `10:00`, `9:30:15`, `10:00pm`, `10:00 am` — resolved in your timezone (`tzset`), a `-z` override, or the module default (UTC). A time that already passed today means tomorrow's.
- **Crontab:** 5-field (`30 9 * * *`) or 6-field with seconds (`0 30 9 * * *`), timezone-aware with full DST support.

### Flags

`-p`, `-r`, and `-a` are orthogonal and combine freely: `-p -r <cron>` is a recurring DM reminder; `-a -r <cron>` is a recurring channel announcement; `-a -p` is a DM announcement (odd, but allowed). `-z <tz>` takes a timezone argument. All flags precede the time spec. `-r` requires a crontab expression.

### Bells

ASCII BEL characters (`\u0007`) in reminder text are passed through for `-p` and `-a` reminders and stripped everywhere else. The module never adds its own bell.

### Ids and permissions

Reminder ids are the first 8 characters of the internal UUID, shown by `list-reminders` and accepted by `cancel-reminder`/`edit-reminder` (with or without a leading `#`).

- You can cancel/edit **your own** reminders.
- **Channel admins** can additionally cancel/edit **announcements** in their channel — any admin's.
- `edit-reminder` re-runs the channel-admin gate whenever the target is an announcement or the edit carries `-a`; flags and bells are fully re-specified from the edit.
- `list-reminders` shows DM reminders only when the request itself is a DM — a channel-issued list never leaks DM content.

## How it works

- **Storage:** SQLite (`better-sqlite3`) at `${MODULE_DATA}/reminders.db` (volume, tell's pattern) — two tables: `reminders` and `user_tz`. Timezone preferences are keyed by user ident, not nick.
- **Scheduling:** no tick loop. At startup every active reminder arms an individual `setTimeout`; crons re-arm at each fire; creations arm immediately; cancels clear the timer. SQLite is the durable schedule, so restarts re-arm everything for free.
- **Recovery:** if the module was down past a reminder's due time, oneshots fire immediately with a `[delayed 2h]` marker; crons fire once and resume their schedule (skip-and-continue).
- **Long delays:** Node's `setTimeout` caps at ~24.8 days, so far-future reminders arm capped timers and re-arm on wake until due.
- **Delivery:** `sendChatMessage` back to the original channel/network/instance/platform. DMs on IRC are a PRIVMSG to the creator's nick; `-p` on non-IRC platforms is rejected for now (Discord support is deferred until that connector works).
- **Module wiring:** command registration, help entries, stats, Prometheus metrics, and health checks via `@eeveebot/libeevee`, following the [echo module](https://github.com/eeveebot/echo) pattern; storage and lifecycle patterns follow the [tell module](https://github.com/eeveebot/tell).

## Install

This module is part of the eevee ecosystem and is not published independently.

```bash
cd reminders
npm install
npm run build
npm run dev
```

### Docker

A `Dockerfile` is included for containerized deployment. It performs a multi-stage build: the builder stage installs dev dependencies and compiles TypeScript, and the final stage copies only production artifacts. The image builds the `better-sqlite3` native module, so both stages install `python3` and `g++`.

```bash
docker build --secret id=GITHUB_TOKEN,src=<token-file> -t eevee-reminders .
```

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NATS_HOST` | Yes | — | NATS server hostname |
| `NATS_TOKEN` | Yes | — | NATS authentication token |
| `MODULE_DATA` | Yes | — | Data directory for the SQLite database (volume) |
| `MODULE_CONFIG_PATH` | No | — | Path to a YAML configuration file |
| `HTTP_API_PORT` | No | `9000` | Port for the HTTP metrics/health server |

### YAML Configuration File

If `MODULE_CONFIG_PATH` is set, the module loads additional settings from the specified YAML file. See [`config/example.yaml`](./config/example.yaml):

```yaml
ratelimit:
  mode: drop        # "drop" (silently ignore) or "queue" (buffer and delay)
  level: user       # "user" or "channel"
  limit: 5          # Maximum allowed invocations per interval
  interval: 1m      # Time window (e.g. "30s", "5m", "1h")

defaultTz: "Etc/UTC"        # IANA timezone for users without a preference
maxHorizonDays: 366         # maximum relative-time horizon
maxRemindersPerUser: 500    # active reminder cap per user
# dbPath: "./reminders.db"  # optional SQLite path override
```

## Development

```bash
# Install dependencies
npm install

# Lint
npm test

# Build (lint + compile TypeScript) — the full gate
npm run build

# Build and run locally
npm run dev
```

### Requirements

- **Node.js** ≥ 24.0.0
- **Python 3.x** for building the `better-sqlite3` native module (see AGENTS.md)
- Access to a NATS server (for runtime)
- Access to the `@eeveebot` GitHub Packages registry (for `@eeveebot/libeevee`)

## Contributing

This module is part of the [eevee project](https://github.com/eeveebot/eevee). See the contributing guidelines for details on development workflow, pull requests, and code standards.

## License

[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) — see [LICENSE](./LICENSE) for the full text.
