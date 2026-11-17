'use strict';

// `edit-reminder <id> [-p] [-r] [-a] [-z <tz>] <when> <text...>` — full
// re-spec of an existing reminder, keyed on the same short ids as cancel.
// The when-format may flip oneshot ↔ cron. deliverVia and bells are
// recomputed from the edit's flags. Whenever the existing row is an
// announcement or the edit carries -a, the channel-admin gate is re-run.

import { DateTime } from 'luxon';

import { log } from '@eeveebot/libeevee';

import {
  ReminderRow,
  findReminderByShortId,
  getUserTz,
  updateReminder,
} from '../lib/database.mjs';
import { computeDue, resolveTz, resolveWhen } from '../lib/parse-time.mjs';
import { armTimer, clearTimer } from '../lib/scheduler.mjs';
import {
  DEFAULT_MAX_HORIZON_DAYS,
  DEFAULT_TZ,
  CommandData,
  ModuleContext,
  checkChannelAdmin,
  isDmRequest,
  parseFlags,
  reply,
  shortId,
} from '../lib/utils.mjs';

const BEL = '\u0007';

function oldWhen(row: ReminderRow): string {
  if (row.kind === 'cron') {
    return `cron "${row.cronExpr}" ${row.cronTz ?? ''}`.trim();
  }
  return `${DateTime.fromISO(row.dueAt ?? row.nextDueAt)
    .toUTC()
    .toFormat('yyyy-MM-dd HH:mm')} UTC`;
}

export async function handleEditReminder(
  ctx: ModuleContext,
  data: CommandData
): Promise<'success' | 'error'> {
  const args = data.text.trim().split(/\s+/).filter(Boolean);
  const rawId = args[0];
  if (!rawId) {
    reply(
      ctx,
      data,
      `${data.nick}: usage: edit-reminder <id> [-p] [-r] [-a] [-z <tz>] <when> <text...>`
    );
    return 'error';
  }
  const prefix = rawId.replace(/^#/, '');
  if (!prefix) {
    reply(ctx, data, `${data.nick}: usage: edit-reminder <id> ...`);
    return 'error';
  }

  const matches = findReminderByShortId(prefix);
  if (matches.length === 0) {
    reply(ctx, data, `${data.nick}: no active reminder with id ${prefix}`);
    return 'error';
  }
  if (matches.length > 1) {
    reply(
      ctx,
      data,
      `${data.nick}: id ${prefix} matches ${matches.length} reminders — type more characters`
    );
    return 'error';
  }
  const row: ReminderRow = matches[0];

  const parsed = parseFlags(args.slice(1));
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
      `${data.nick}: could not parse the new time — use a relative time (1h30m), a wall-clock time (10:00), or a crontab expression (30 9 * * *)`
    );
    return 'error';
  }
  const text = parsed.rest.slice(resolved.textStart).join(' ').trim();
  if (!text) {
    reply(ctx, data, `${data.nick}: the reminder needs text after the time`);
    return 'error';
  }
  if (r && resolved.when.kind !== 'cron') {
    reply(ctx, data, `${data.nick}: the -r flag needs a crontab expression`);
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

  try {
    // Permission: touching an announcement (existing row, or -a in this
    // edit) requires the channel-admin gate. Otherwise creator-only.
    const touchesAnnouncement = row.deliverVia === 'announcement' || a;
    if (touchesAnnouncement) {
      const gateChannel =
        row.deliverVia === 'announcement' ? row.channel : data.channel;
      const admin = await checkChannelAdmin(ctx, data, gateChannel);
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
          `${data.nick}: only channel admins can edit announcements`
        );
        return 'error';
      }
    } else if (row.creatorIdent !== data.user) {
      reply(ctx, data, `${data.nick}: you can only edit your own reminders`);
      return 'error';
    }

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
      tz = userTz ?? ctx.config.defaultTz ?? DEFAULT_TZ;
    }

    const due = computeDue(
      resolved.when,
      tz,
      ctx.config.maxHorizonDays ?? DEFAULT_MAX_HORIZON_DAYS
    );

    // Bells recomputed from this edit's flags: passthrough on -p/-a.
    const reminderText = p || a ? text : text.replaceAll(BEL, '');
    const deliverVia = a ? 'announcement' : p ? 'dm' : 'channel';
    const bells = p || a ? 1 : 0;

    // Delivery target: -p retargets to the editor's nick; a channel-issued
    // edit retargets to that channel. A DM-issued edit without -p keeps the
    // row's original target — we can't retarget a channel from a DM, and
    // delivering to the bot's own nick would loop.
    let channel = row.channel;
    if (p) {
      channel = data.nick;
    } else if (!isDmRequest(data)) {
      channel = data.channel;
    }

    updateReminder(row.id, {
      kind: due.kind,
      deliverVia,
      channel,
      cronExpr: due.cronExpr,
      cronTz: due.cronTz,
      dueAt: due.dueAt,
      nextDueAt: due.nextDueAt,
      bells,
      text: reminderText,
      editedDate: new Date().toISOString(),
    });
    clearTimer(row.id);
    armTimer(row.id, due.nextDueAt);

    const newWhen =
      due.kind === 'cron'
        ? `cron "${due.cronExpr}" ${tz} (next ${due.localDisplay})`
        : `${due.localDisplay}`;
    reply(
      ctx,
      data,
      `${data.nick}: updated reminder #${shortId(row.id)}: ${oldWhen(row)} → ${newWhen}, text replaced`
    );
    return 'success';
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'something went wrong';
    log.error('Failed to edit reminder', {
      producer: 'reminders',
      error: message,
    });
    reply(ctx, data, `${data.nick}: ${message}`);
    return 'error';
  }
}
