'use strict';

// `list-reminders [-a]` — list the invoking user's reminders (id + text +
// time/schedule). DM reminders are only included when the request itself
// arrives in a DM — a channel-issued list never leaks DM reminder content.
// `list-reminders -a` is channel-admin gated and lists announcements for
// that channel set by any admin, not just the invoking one.

import {
  getUserTz,
  listAnnouncementsByChannel,
  listByCreator,
} from '../lib/database.mjs';
import {
  DEFAULT_TZ,
  CommandData,
  ModuleContext,
  checkChannelAdmin,
  formatReminderRow,
  isDmRequest,
  isDmRow,
  reply,
} from '../lib/utils.mjs';

const MAX_LISTED = 10;

function moreClause(rows: number): string {
  return rows > MAX_LISTED ? ` | …and ${rows - MAX_LISTED} more` : '';
}

export async function handleListReminders(
  ctx: ModuleContext,
  data: CommandData
): Promise<'success' | 'error'> {
  const args = data.text.trim().split(/\s+/).filter(Boolean);
  const adminMode = args.length > 0 && args[0] === '-a';

  if (adminMode) {
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
        `${data.nick}: only channel admins can list announcements (-a)`
      );
      return 'error';
    }
    const rows = listAnnouncementsByChannel(
      data.platform,
      data.network,
      data.instance,
      data.channel
    );
    if (rows.length === 0) {
      reply(ctx, data, `${data.nick}: no announcements in ${data.channel}`);
      return 'success';
    }
    const lines = rows
      .slice(0, MAX_LISTED)
      .map((row) =>
        formatReminderRow(row, row.cronTz ?? ctx.config.defaultTz ?? DEFAULT_TZ)
      );
    reply(
      ctx,
      data,
      `${data.nick}: announcements in ${data.channel}: ${lines.join(' | ')}${moreClause(rows.length)}`
    );
    return 'success';
  }

  const includeDms = isDmRequest(data);
  const rows = listByCreator(
    data.platform,
    data.network,
    data.instance,
    data.user
  );
  const visible = rows.filter((row) => includeDms || !isDmRow(row));
  const hiddenCount = rows.length - visible.length;

  if (visible.length === 0) {
    reply(
      ctx,
      data,
      `${data.nick}: you have no reminders${hiddenCount > 0 ? ' visible from this channel — some are DM-only' : ''}`
    );
    return 'success';
  }

  const userTz =
    getUserTz(data.platform, data.network, data.instance, data.user) ??
    ctx.config.defaultTz ??
    DEFAULT_TZ;
  const lines = visible
    .slice(0, MAX_LISTED)
    .map((row) => formatReminderRow(row, userTz));
  const hiddenNote =
    hiddenCount > 0
      ? ` | (${hiddenCount} DM reminder${hiddenCount > 1 ? 's' : ''} hidden — ask me in a DM)`
      : '';
  reply(
    ctx,
    data,
    `${data.nick}: ${lines.join(' | ')}${moreClause(visible.length)}${hiddenNote}`
  );
  return 'success';
}
