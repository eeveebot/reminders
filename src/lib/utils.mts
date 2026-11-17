'use strict';

// Shared helpers for the reminders command handlers: command payload type,
// config, reply helper, admin gate, flag parsing, and list formatting.

import { DateTime } from 'luxon';

import {
  NatsClient,
  RateLimitConfig,
  log,
  queryUserModes,
  sendChatMessage,
  ModuleMetrics,
} from '@eeveebot/libeevee';

import { ReminderRow } from './database.mjs';

// The router's command.execute payload (fields verified against the router
// and the IRC connector — botNick included).
export interface CommandData {
  platform: string;
  network: string;
  instance: string;
  channel: string;
  user: string; // ident on IRC
  nick: string;
  userHost?: string;
  text: string;
  originalText?: string;
  trace: string;
  timestamp?: string;
  botNick?: string;
}

export interface RemindersConfig {
  ratelimit?: RateLimitConfig;
  defaultTz?: string;
  maxHorizonDays?: number;
  maxRemindersPerUser?: number;
  dbPath?: string;
}

// Everything a command handler needs, handed in by main.
export interface ModuleContext {
  nats: InstanceType<typeof NatsClient>;
  config: RemindersConfig;
  metrics: ModuleMetrics;
  updatePendingGauge: () => void;
}

export const DEFAULT_TZ = 'Etc/UTC';
export const DEFAULT_MAX_HORIZON_DAYS = 366;
export const DEFAULT_MAX_REMINDERS = 500;

// Display ids: first 8 chars of the UUID, everywhere.
export function shortId(id: string): string {
  return id.slice(0, 8);
}

// A request is a DM when it was addressed to the bot's own nick
// (IRC PRIVMSG target = bot nick for PMs).
export function isDmRequest(data: CommandData): boolean {
  return Boolean(
    data.botNick &&
    data.channel &&
    data.channel.toLowerCase() === data.botNick.toLowerCase()
  );
}

// A stored row is a DM reminder when its delivery target is the creator's
// own nick rather than a channel.
export function isDmRow(row: ReminderRow): boolean {
  return row.channel.toLowerCase() === row.creatorNick.toLowerCase();
}

export function reply(
  ctx: ModuleContext,
  data: CommandData,
  text: string
): void {
  void sendChatMessage(
    ctx.nats,
    {
      channel: data.channel,
      network: data.network,
      instance: data.instance,
      platform: data.platform,
      text,
      trace: data.trace,
    },
    ctx.metrics
  );
}

export interface AdminCheck {
  ok: boolean; // false = the check itself failed (deny with an error)
  isAdmin: boolean;
}

// Channel-admin gate via the IRC connector. Existing failure semantics:
// NATS errors/timeout deny with an "unable to verify" message.
export async function checkChannelAdmin(
  ctx: ModuleContext,
  data: CommandData,
  channel: string
): Promise<AdminCheck> {
  try {
    const modes = await queryUserModes(
      ctx.nats,
      data.platform,
      data.instance,
      channel,
      data.nick,
      { metrics: ctx.metrics, producer: 'reminders' }
    );
    return { ok: true, isAdmin: modes.isChannelAdmin };
  } catch (error) {
    log.error('Failed to query user modes', {
      producer: 'reminders',
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, isAdmin: false };
  }
}

export interface ParsedFlags {
  p: boolean;
  r: boolean;
  a: boolean;
  zTz: string | null;
  rest: string[]; // remaining args: <when> ... <text...>
  error: string | null;
}

// Parse the orthogonal flag prefix -p/-r/-a/-z off the front of an arg list.
// All flags must precede <when>; -z consumes the next token.
export function parseFlags(args: string[]): ParsedFlags {
  const parsed: ParsedFlags = {
    p: false,
    r: false,
    a: false,
    zTz: null,
    rest: [],
    error: null,
  };
  let i = 0;
  while (i < args.length) {
    const token = args[i];
    if (token === undefined) {
      break;
    }
    if (token === '-p') {
      parsed.p = true;
      i += 1;
    } else if (token === '-r') {
      parsed.r = true;
      i += 1;
    } else if (token === '-a') {
      parsed.a = true;
      i += 1;
    } else if (token === '-z') {
      const value = args[i + 1];
      if (value === undefined) {
        parsed.error = 'the -z flag needs a timezone, e.g. -z America/New_York';
        return parsed;
      }
      parsed.zTz = value;
      i += 2;
    } else if (token.startsWith('-') && token.length > 1) {
      parsed.error = `unknown flag ${token} — supported flags: -p (DM), -r (recurring), -a (announcement), -z <tz>`;
      return parsed;
    } else {
      break;
    }
  }
  parsed.rest = args.slice(i);
  return parsed;
}

// Effective timezone: -z override > user preference > config default > UTC.
export function effectiveTz(
  zTz: string | null,
  userTz: string | undefined,
  config: RemindersConfig
): string {
  if (zTz) {
    return zTz;
  }
  return userTz ?? config.defaultTz ?? DEFAULT_TZ;
}

// Human-readable when-part of a row for list/confirm output.
export function formatWhen(row: ReminderRow, displayTz: string): string {
  if (row.kind === 'cron') {
    const next = DateTime.fromISO(row.nextDueAt).setZone(displayTz);
    return `cron "${row.cronExpr}" ${row.cronTz ?? ''} (next ${next.toFormat('yyyy-MM-dd HH:mm')} ${displayTz})`.replace(
      '  (next',
      ' (next'
    );
  }
  const due = DateTime.fromISO(row.dueAt ?? row.nextDueAt).setZone(displayTz);
  return `${due.toFormat('yyyy-MM-dd HH:mm')} ${displayTz}`;
}

// One line per reminder for list output: "id [target] when — "text"",
// where target is the delivery channel, or "private" for DMs.
export function formatReminderRow(row: ReminderRow, displayTz: string): string {
  const target = isDmRow(row) ? 'private' : row.channel;
  return `${shortId(row.id)} [${target}] ${formatWhen(row, displayTz)} — "${row.text}"`;
}
