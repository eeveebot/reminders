'use strict';

// `tzset <tz>` — set the invoking user's timezone preference.
// Accepts common US/Euro abbreviations (est, pdt, cet) or IANA names
// (America/New_York, Etc/UTC). DST is handled by the tz database.

import { getUserTz, setUserTz } from '../lib/database.mjs';
import { resolveTz } from '../lib/parse-time.mjs';
import {
  DEFAULT_TZ,
  CommandData,
  ModuleContext,
  reply,
} from '../lib/utils.mjs';

export async function handleTzset(
  ctx: ModuleContext,
  data: CommandData
): Promise<'success' | 'error'> {
  const args = data.text.trim().split(/\s+/).filter(Boolean);

  if (args.length === 0) {
    const current =
      getUserTz(data.platform, data.network, data.instance, data.user) ??
      ctx.config.defaultTz ??
      DEFAULT_TZ;
    reply(
      ctx,
      data,
      `${data.nick}: your timezone is ${current} — change it with tzset <tz> (e.g. tzset est or tzset Europe/Berlin)`
    );
    return 'success';
  }

  const input = args[0];
  if (input === undefined) {
    reply(ctx, data, `${data.nick}: usage: tzset <tz>`);
    return 'error';
  }
  const resolved = resolveTz(input);
  if (!resolved) {
    reply(
      ctx,
      data,
      `${data.nick}: I don't know the timezone "${input}" — try America/New_York, est, or Etc/UTC`
    );
    return 'error';
  }

  setUserTz({
    platform: data.platform,
    network: data.network,
    instance: data.instance,
    user: data.user,
    nick: data.nick,
    tz: resolved,
  });
  reply(ctx, data, `${data.nick}: timezone set to ${resolved}`);
  return 'success';
}
