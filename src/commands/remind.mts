'use strict';

// `remind [-p] [-r] [-a] [-z <tz>] <when> <text...>` — create a reminder.
// Flags are orthogonal: -p delivers by DM, -r marks recurring (crontab),
// -a makes it a channel-admin-gated announcement. They combine freely.

import { randomUUID } from 'node:crypto';

import { log } from '@eeveebot/libeevee';

import {
  ReminderRow,
  addReminder,
  countActiveByCreator,
  getUserTz,
} from '../lib/database.mjs';
import { computeDue, resolveTz, resolveWhen } from '../lib/parse-time.mjs';
import { armTimer } from '../lib/scheduler.mjs';
import {
  DEFAULT_MAX_HORIZON_DAYS,
  DEFAULT_MAX_REMINDERS,
  DEFAULT_TZ,
  CommandData,
  ModuleContext,
  checkChannelAdmin,
  effectiveTz,
  parseFlags,
  reply,
  shortId,
} from '../lib/utils.mjs';

const BEL = '\u0007';

export async function handleRemind(
  ctx: ModuleContext,
  data: CommandData
): Promise<'success' | 'error'> {
  const args = data.text.trim().split(/\s+/).filter(Boolean);
  const parsed = parseFlags(args);
  if (parsed.error) {
    reply(ctx, data, `${data.nick}: ${parsed.error}`);
    return 'error';
  }
  const { p, r, a } = parsed;

  const resolved = resolveWhen(parsed.rest);
  if (!resolved) {
    reply(
      ctx,
      data,
      `${data.nick}: could not parse the time — use a relative time (1h30m), a wall-clock time (10:00), or a crontab expression (30 9 * * *)`
    );
    return 'error';
  }
  const text = parsed.rest.slice(resolved.textStart).join(' ').trim();
  if (!text) {
    reply(ctx, data, `${data.nick}: the reminder needs text after the time`);
    return 'error';
  }

  if (r && resolved.when.kind !== 'cron') {
    reply(
      ctx,
      data,
      `${data.nick}: the -r flag needs a crontab expression, e.g. -r 30 9 * * * standup`
    );
    return 'error';
  }
  if (p && data.platform !== 'irc') {
    reply(
      ctx,
      data,
      `${data.nick}: DM delivery (-p) is only supported on IRC for now`
    );
    return 'error';
  }

  // Bells are passthrough: user-supplied BELs survive on -p/-a calls only.
  const reminderText = p || a ? text : text.replaceAll(BEL, '');

  try {
    // Timezone: -z (validated) > user preference > config default > UTC.
    const userTz = getUserTz(
      data.platform,
      data.network,
      data.instance,
      data.user
    );
    let tz: string;
    if (parsed.zTz) {
      const resolvedTz = resolveTz(parsed.zTz);
      if (!resolvedTz) {
        reply(
          ctx,
          data,
          `${data.nick}: I don't know the timezone "${parsed.zTz}" — try America/New_York, est, or Etc/UTC`
        );
        return 'error';
      }
      tz = resolvedTz;
    } else {
      tz = effectiveTz(null, userTz, ctx.config) ?? DEFAULT_TZ;
    }

    // Announcements are channel-admin gated.
    if (a) {
      const admin = await checkChannelAdmin(ctx, data, data.channel);
      if (!admin.ok) {
        reply(
          ctx,
          data,
          `${data.nick}: unable to verify admin status — try again later`
        );
        return 'error';
      }
      if (!admin.isAdmin) {
        reply(
          ctx,
          data,
          `${data.nick}: only channel admins can set announcements (-a)`
        );
        return 'error';
      }
    }

    // Per-user cap on active reminders.
    const cap = ctx.config.maxRemindersPerUser ?? DEFAULT_MAX_REMINDERS;
    if (
      countActiveByCreator(
        data.platform,
        data.network,
        data.instance,
        data.user
      ) >= cap
    ) {
      reply(
        ctx,
        data,
        `${data.nick}: you already have ${cap} active reminders — cancel some first with list-reminders and cancel-reminder`
      );
      return 'error';
    }

    const due = computeDue(
      resolved.when,
      tz,
      ctx.config.maxHorizonDays ?? DEFAULT_MAX_HORIZON_DAYS
    );

    const id = randomUUID();
    const deliverVia = a ? 'announcement' : p ? 'dm' : 'channel';
    const row: ReminderRow = {
      id,
      platform: data.platform,
      network: data.network,
      instance: data.instance,
      channel: p ? data.nick : data.channel,
      creatorIdent: data.user,
      creatorNick: data.nick,
      kind: due.kind,
      deliverVia,
      cronExpr: due.cronExpr,
      cronTz: due.cronTz,
      dueAt: due.dueAt,
      nextDueAt: due.nextDueAt,
      bells: p || a ? 1 : 0,
      text: reminderText,
      createdDate: new Date().toISOString(),
      editedDate: null,
      lastDeliveredDate: null,
      active: 1,
    };
    addReminder(row);
    armTimer(id, due.nextDueAt);
    ctx.updatePendingGauge();

    const confirmation =
      due.kind === 'cron'
        ? `${data.nick}: recurring reminder ${shortId(id)} set for cron "${due.cronExpr}" ${tz} — next fire ${due.localDisplay} (${due.utcDisplay})`
        : `${data.nick}: reminder ${shortId(id)} set for ${due.localDisplay} (${due.utcDisplay})`;
    reply(ctx, data, confirmation);
    return 'success';
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'something went wrong';
    log.error('Failed to set reminder', {
      producer: 'reminders',
      error: message,
    });
    reply(ctx, data, `${data.nick}: ${message}`);
    return 'error';
  }
}
