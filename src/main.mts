'use strict';

// Reminders module — time-based reminders with per-reminder setTimeouts.
// SQLite is the durable schedule; the timer registry is disposable runtime
// state regenerated from the database on every startup. No tick loop.

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

import { DateTime } from 'luxon';

import {
  NatsClient,
  RateLimitConfig,
  Gauge,
  createModuleMetrics,
  createNatsConnection,
  defaultRateLimit,
  initializeSystemMetrics,
  loadModuleConfig,
  log,
  register,
  registerCommand,
  registerGracefulShutdown,
  registerHelp,
  registerStatsHandlers,
  sendChatMessage,
  setupHttpServer,
  HelpEntry,
  NatsSubscriptionResult,
} from '@eeveebot/libeevee';

import {
  ReminderRow,
  closeDatabase,
  countAllActive,
  findAllActive,
  getReminderById,
  getUserTz,
  initDatabase,
  markDelivered,
  scheduleNext,
} from './lib/database.mjs';
import { humanizeDuration, nextCronRun } from './lib/parse-time.mjs';
import { armTimer, clearAllTimers, setFireHandler } from './lib/scheduler.mjs';
import {
  CommandData,
  DEFAULT_TZ,
  ModuleContext,
  RemindersConfig,
  isDmRequest,
} from './lib/utils.mjs';
import { handleRemind } from './commands/remind.mjs';
import { handleTzset } from './commands/tzset.mjs';
import { handleListReminders } from './commands/list-reminders.mjs';
import { handleCancelReminder } from './commands/cancel-reminder.mjs';
import { handleEditReminder } from './commands/edit-reminder.mjs';

// Record module startup time for uptime tracking
const moduleStartTime = Date.now();
const moduleVersion = JSON.parse(
  fs.readFileSync(
    new URL('package.json', 'file://' + process.cwd() + '/'),
    'utf8'
  )
).version as string;

// Initialize module-scoped metrics recorder
const metrics = createModuleMetrics('reminders');

// Initialize system metrics
initializeSystemMetrics('reminders');

// Pending-reminder gauge, refreshed whenever the active set changes
const pendingGauge = new Gauge({
  name: 'eevee_reminders_pending',
  help: 'Number of active reminders held by the reminders module',
  registers: [register],
});

function updatePendingGauge(): void {
  pendingGauge.set(countAllActive());
}

// Command UUIDs (module + one per command)
const remindCommandUUID = '1304cbfe-dc51-4f7c-96fd-5880a01531d2';
const tzsetCommandUUID = 'adfd20bd-cd88-4ec2-a9f7-a34199e21e64';
const listCommandUUID = 'a89b6c94-a735-4299-ab69-c9ed93c70c25';
const cancelCommandUUID = 'f00e1d63-3922-4d7f-adfa-733b882b0f7c';
const editCommandUUID = '966db4da-9e75-4132-a772-6528413f6a28';

// Reminders module configuration interface
interface RemindersModuleConfig extends RemindersConfig {
  ratelimit?: RateLimitConfig;
}

const natsClients: InstanceType<typeof NatsClient>[] = [];

// Setup HTTP server for metrics and health checks
setupHttpServer({
  port: process.env.HTTP_API_PORT || '9000',
  serviceName: 'reminders',
  natsClients: natsClients,
});
const natsSubscriptions: Array<Promise<NatsSubscriptionResult>> = [];

// Load configuration at startup
const remindersConfig = loadModuleConfig<RemindersModuleConfig>({});

// Register graceful shutdown handlers
registerGracefulShutdown(natsClients);

// Setup NATS connection
const nats = await createNatsConnection();
natsClients.push(nats);

// ---- database ------------------------------------------------------------

const moduleData = process.env.MODULE_DATA;
if (!moduleData && !remindersConfig.dbPath) {
  throw new Error(
    'MODULE_DATA environment variable not set (or set dbPath in config)'
  );
}
initDatabase(remindersConfig.dbPath ?? `${moduleData}/reminders.db`);

// ---- delivery and firing -------------------------------------------------

// Bells are passthrough — rows carry whatever BELs were allowed at
// creation/edit time; delivery never adds its own.
function deliver(row: ReminderRow, delayMarker: string | null): void {
  let text = row.text;
  if (delayMarker) {
    text = `${delayMarker} ${text}`;
  }
  if (row.deliverVia !== 'announcement') {
    text = `${row.creatorNick}: ${text}`;
  }
  // Suffix with the request time — except recurring announcements, where a
  // stale creation date is noise rather than context.
  if (!(row.deliverVia === 'announcement' && row.kind === 'cron')) {
    const creatorTz =
      getUserTz(row.platform, row.network, row.instance, row.creatorIdent) ??
      remindersConfig.defaultTz ??
      DEFAULT_TZ;
    const requestedAt = DateTime.fromISO(row.createdDate)
      .setZone(creatorTz)
      .toFormat('yyyy-MM-dd HH:mm');
    text = `${text} (reminder requested at ${requestedAt} ${creatorTz})`;
  }
  void sendChatMessage(
    nats,
    {
      channel: row.channel,
      network: row.network,
      instance: row.instance,
      platform: row.platform,
      text,
      trace: randomUUID(),
    },
    metrics
  );
}

function fire(id: string): void {
  const row = getReminderById(id);
  if (!row || row.active !== 1) {
    return; // canceled between arming and firing
  }
  try {
    deliver(row, null);
    if (row.kind === 'cron') {
      const next = nextCronRun(row.cronExpr ?? '', row.cronTz ?? 'Etc/UTC');
      scheduleNext(id, next, new Date().toISOString());
      armTimer(id, next);
    } else {
      markDelivered(id, new Date().toISOString());
    }
    updatePendingGauge();
  } catch (error) {
    log.error('Failed to deliver reminder', {
      producer: 'reminders',
      id,
      error: error instanceof Error ? error.message : String(error),
    });
    metrics.recordError('delivery_error');
  }
}

setFireHandler(fire);

// ---- command registration and dispatch ------------------------------------

const ctx: ModuleContext = {
  nats,
  config: remindersConfig,
  metrics,
  updatePendingGauge,
};

const commandDefs = [
  { uuid: remindCommandUUID, name: 'remind', regex: '^remind\\s+' },
  { uuid: tzsetCommandUUID, name: 'tzset', regex: '^tzset\\s+' },
  { uuid: listCommandUUID, name: 'list-reminders', regex: '^list-reminders' },
  {
    uuid: cancelCommandUUID,
    name: 'cancel-reminder',
    regex: '^cancel-reminder\\s+',
  },
  { uuid: editCommandUUID, name: 'edit-reminder', regex: '^edit-reminder\\s+' },
];

for (const def of commandDefs) {
  const subs = await registerCommand(
    nats,
    {
      commandUUID: def.uuid,
      commandDisplayName: def.name,
      regex: def.regex,
      ratelimit: remindersConfig.ratelimit || defaultRateLimit,
    },
    metrics
  );
  natsSubscriptions.push(...subs);
}

type CommandHandler = (
  ctx: ModuleContext,
  data: CommandData
) => Promise<'success' | 'error'>;

function subscribeCommand(
  uuid: string,
  commandName: string,
  handler: CommandHandler
): void {
  const sub = nats.subscribe(`command.execute.${uuid}`, (subject, message) => {
    metrics.recordNatsSubscribe(subject);
    const startTime = Date.now();
    void (async () => {
      let platform = 'unknown';
      let network = 'unknown';
      let channel = 'unknown';
      let result: string = 'success';
      try {
        const data = JSON.parse(message.string()) as CommandData;
        platform = data.platform;
        network = data.network;
        channel = data.channel;
        log.info('Received command execution', {
          producer: 'reminders',
          command: commandName,
          platform: data.platform,
          channel: data.channel,
          user: data.user,
          dm: isDmRequest(data),
          originalText: data.originalText,
        });
        result = await handler(ctx, data);
      } catch (error) {
        result = 'error';
        log.error('Command execution failed', {
          producer: 'reminders',
          command: commandName,
          error: error instanceof Error ? error.message : String(error),
        });
        metrics.recordError('command_error');
      } finally {
        metrics.recordCommand(platform, network, channel, result);
        metrics.recordProcessingTime((Date.now() - startTime) / 1000);
      }
    })();
  });
  natsSubscriptions.push(sub);
}

subscribeCommand(remindCommandUUID, 'remind', handleRemind);
subscribeCommand(tzsetCommandUUID, 'tzset', handleTzset);
subscribeCommand(listCommandUUID, 'list-reminders', handleListReminders);
subscribeCommand(cancelCommandUUID, 'cancel-reminder', handleCancelReminder);
subscribeCommand(editCommandUUID, 'edit-reminder', handleEditReminder);

// ---- startup recovery ----------------------------------------------------
// Rows whose nextDueAt already passed while the module was down:
// oneshots fire immediately with a [delayed N] marker; crons fire once
// and resume their schedule from now (skip-and-continue).

const recoveryStart = Date.now();
const nowIso = new Date(recoveryStart).toISOString();
const activeRows = findAllActive();
let recoveredCount = 0;
for (const row of activeRows) {
  const dueMs = Date.parse(row.nextDueAt);
  if (Number.isNaN(dueMs)) {
    log.error('Skipping reminder with unparseable nextDueAt', {
      producer: 'reminders',
      id: row.id,
      nextDueAt: row.nextDueAt,
    });
    continue;
  }
  if (dueMs <= recoveryStart) {
    recoveredCount++;
    if (row.kind === 'cron') {
      deliver(row, null);
      const next = nextCronRun(row.cronExpr ?? '', row.cronTz ?? 'Etc/UTC');
      scheduleNext(row.id, next, nowIso);
      armTimer(row.id, next);
    } else {
      deliver(row, `[delayed ${humanizeDuration(recoveryStart - dueMs)}]`);
      markDelivered(row.id, nowIso);
    }
  } else {
    armTimer(row.id, row.nextDueAt);
  }
}
updatePendingGauge();
log.info('Startup recovery complete', {
  producer: 'reminders',
  active: activeRows.length,
  recovered: recoveredCount,
});

// ---- stats and help --------------------------------------------------------

const statsSubs = registerStatsHandlers({
  nats,
  moduleName: 'reminders',
  startTime: moduleStartTime,
  version: moduleVersion,
  metrics,
});
natsSubscriptions.push(...statsSubs);

const remindersHelp: HelpEntry[] = [
  {
    command: 'remind',
    descr: 'Set a reminder — delivered back to this channel (or by DM with -p)',
    params: [
      {
        param: 'time',
        required: true,
        descr: 'Relative (1h30m), wall-clock (10:00), or crontab (30 9 * * *)',
      },
      { param: 'text', required: true, descr: 'The reminder text' },
      {
        param: '-p',
        required: false,
        descr: 'Deliver by DM (allows ASCII bells)',
      },
      {
        param: '-r',
        required: false,
        descr: 'Recurring — time is a crontab expression',
      },
      {
        param: '-a',
        required: false,
        descr: 'Announcement — no highlight; channel admins only; allows bells',
      },
      {
        param: '-z <tz>',
        required: false,
        descr: 'Timezone override for this reminder',
      },
    ],
  },
  {
    command: 'tzset',
    descr: 'Set your timezone (America/New_York, est, Etc/UTC…) — handles DST',
    params: [
      {
        param: 'tz',
        required: true,
        descr: 'IANA name or common US/Euro abbreviation',
      },
    ],
  },
  {
    command: 'list-reminders',
    descr:
      'List your reminders (id + text + time) — DM reminders only shown in a DM',
    params: [
      {
        param: '-a',
        required: false,
        descr: "List this channel's announcements (channel admins only)",
      },
    ],
  },
  {
    command: 'cancel-reminder',
    descr: 'Cancel one of your reminders by its id',
    params: [
      {
        param: 'id',
        required: true,
        descr: 'The reminder id shown by list-reminders',
      },
    ],
  },
  {
    command: 'edit-reminder',
    descr: 'Fully re-specify one of your reminders (time, text, flags)',
    params: [
      {
        param: 'id',
        required: true,
        descr: 'The reminder id shown by list-reminders',
      },
      {
        param: 'time',
        required: true,
        descr: 'New relative/wall-clock/crontab time',
      },
      { param: 'text', required: true, descr: 'New reminder text' },
      {
        param: '-p/-r/-a/-z',
        required: false,
        descr: 'Same flags as remind — delivery and bells re-specified',
      },
    ],
  },
];

const helpSubs = await registerHelp(nats, 'reminders', remindersHelp, metrics);
natsSubscriptions.push(...helpSubs);

// Clean up timers and the database handle on exit
process.on('exit', () => {
  clearAllTimers();
  closeDatabase();
});
