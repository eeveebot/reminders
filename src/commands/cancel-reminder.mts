'use strict';

// `cancel-reminder <id>` — cancel an active reminder by its short id.
// Creators cancel their own reminders; channel admins can additionally
// cancel announcements in their channel, any admin's.

import {
  ReminderRow,
  deactivateReminder,
  findReminderByShortId,
} from '../lib/database.mjs';
import { clearTimer } from '../lib/scheduler.mjs';
import {
  CommandData,
  ModuleContext,
  checkChannelAdmin,
  reply,
  shortId,
} from '../lib/utils.mjs';

export async function handleCancelReminder(
  ctx: ModuleContext,
  data: CommandData
): Promise<'success' | 'error'> {
  const raw = data.text.trim().split(/\s+/).filter(Boolean)[0];
  if (!raw) {
    reply(
      ctx,
      data,
      `${data.nick}: usage: cancel-reminder <id> — ids are shown by list-reminders`
    );
    return 'error';
  }
  // Accept both "#a1b2c3d4" and bare "a1b2c3d4".
  const prefix = raw.replace(/^#/, '');
  if (!prefix) {
    reply(ctx, data, `${data.nick}: usage: cancel-reminder <id>`);
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

  if (row.deliverVia === 'announcement') {
    const admin = await checkChannelAdmin(ctx, data, row.channel);
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
        `${data.nick}: only channel admins can cancel announcements`
      );
      return 'error';
    }
  } else if (row.creatorIdent !== data.user) {
    reply(ctx, data, `${data.nick}: you can only cancel your own reminders`);
    return 'error';
  }

  clearTimer(row.id);
  deactivateReminder(row.id);
  ctx.updatePendingGauge();
  reply(
    ctx,
    data,
    `${data.nick}: cancelled reminder ${shortId(row.id)} — "${row.text}"`
  );
  return 'success';
}
