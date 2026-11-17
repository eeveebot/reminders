'use strict';

// Time, timezone, and crontab parsing for the reminders module.
// Pure functions only — no NATS, no database — so the trickiest logic in
// this module stays trivially reviewable and testable in isolation.

import { DateTime } from 'luxon';

import { CronExpressionParser } from 'cron-parser';

// Common US + Euro abbreviation → IANA alias map (case-insensitive).
// Everything not listed here must be a valid IANA zone name.
const TZ_ALIASES: Record<string, string> = {
  utc: 'Etc/UTC',
  gmt: 'Etc/UTC',
  est: 'America/New_York',
  edt: 'America/New_York',
  cst: 'America/Chicago',
  cdt: 'America/Chicago',
  mst: 'America/Denver',
  mdt: 'America/Denver',
  pst: 'America/Los_Angeles',
  pdt: 'America/Los_Angeles',
  akst: 'America/Anchorage',
  akdt: 'America/Anchorage',
  hst: 'Pacific/Honolulu',
  cet: 'Europe/Paris',
  cest: 'Europe/Paris',
  eet: 'Europe/Helsinki',
  eest: 'Europe/Helsinki',
  bst: 'Europe/London',
};

// Relative durations: 1h30m, 2d12h, 45s, 90m …
const RELATIVE_RE = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i;

// Wall-clock times: 10:00, 9:30:15, 10:00pm, 10:00:30 AM
const ABSOLUTE_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(a\.?m\.?|p\.?m\.?)?$/i;

export type WhenSpec =
  | { kind: 'relative'; durationMs: number }
  | { kind: 'absolute'; hour: number; minute: number; second: number }
  | { kind: 'cron'; expression: string };

export interface DueResult {
  kind: 'oneshot' | 'cron';
  dueAt: string | null; // ISO UTC, oneshot only
  cronExpr: string | null;
  cronTz: string | null;
  nextDueAt: string; // ISO UTC — what the timer arms against
  localDisplay: string; // e.g. "2026-11-18 10:00 America/New_York"
  utcDisplay: string; // e.g. "14:00 UTC"
}

// Parse a relative duration token like "1h30m". Returns milliseconds, or
// null when the token is not a relative time.
export function parseRelative(token: string): number | null {
  const match = token.match(RELATIVE_RE);
  if (!match) {
    return null;
  }
  const [, d, h, m, s] = match;
  if (
    d === undefined &&
    h === undefined &&
    m === undefined &&
    s === undefined
  ) {
    return null;
  }
  const days = d ? parseInt(d, 10) : 0;
  const hours = h ? parseInt(h, 10) : 0;
  const minutes = m ? parseInt(m, 10) : 0;
  const seconds = s ? parseInt(s, 10) : 0;
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

// Parse a wall-clock token like "10:00" or "9:30:15pm". Returns the
// hour/minute/second triple, or null when the token is not a time of day.
export function parseAbsolute(
  token: string
): { hour: number; minute: number; second: number } | null {
  const match = token.match(ABSOLUTE_RE);
  if (!match) {
    return null;
  }
  let hour = parseInt(match[1] ?? '0', 10);
  const minute = parseInt(match[2] ?? '0', 10);
  const second = match[3] ? parseInt(match[3], 10) : 0;
  const meridiem = (match[4] ?? '').toLowerCase().replace(/\./g, '');
  if (minute > 59 || second > 59) {
    return null;
  }
  if (meridiem === 'pm') {
    if (hour < 12) {
      hour += 12;
    }
  } else if (meridiem === 'am') {
    if (hour === 12) {
      hour = 0;
    }
  } else if (hour > 23) {
    return null;
  }
  if (hour > 23) {
    return null;
  }
  return { hour, minute, second };
}

// Resolve a timezone input: alias map first, then valid IANA name.
// Returns the canonical zone name, or null when unknown.
export function resolveTz(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  const alias = TZ_ALIASES[trimmed.toLowerCase()];
  if (alias) {
    return alias;
  }
  if (DateTime.now().setZone(trimmed).isValid) {
    return trimmed;
  }
  return null;
}

// Validate a crontab expression (5- or 6-field).
export function isValidCron(expression: string): boolean {
  try {
    CronExpressionParser.parse(expression);
    return true;
  } catch {
    return false;
  }
}

// Consume the <when> portion of an argument list. Tries, in order:
// a single relative token, a single wall-clock token, a 5-field crontab,
// then a 6-field crontab. Returns the parsed spec plus the index where the
// reminder text starts, or null when nothing parses.
export function resolveWhen(
  args: string[]
): { when: WhenSpec; textStart: number } | null {
  const first = args[0];
  if (first === undefined) {
    return null;
  }
  const relative = parseRelative(first);
  if (relative !== null) {
    return { when: { kind: 'relative', durationMs: relative }, textStart: 1 };
  }
  const absolute = parseAbsolute(first);
  if (absolute !== null) {
    // Optional separate meridiem token: "10:00 am", "9:30 pm"
    const next = args[1];
    if (next !== undefined && /^[ap]\.?m\.?$/i.test(next)) {
      const meridiem = next.toLowerCase().replace(/\./g, '');
      let hour = absolute.hour;
      if (meridiem === 'pm') {
        if (hour < 12) {
          hour += 12;
        }
      } else if (hour === 12) {
        hour = 0;
      }
      return {
        when: {
          kind: 'absolute',
          hour,
          minute: absolute.minute,
          second: absolute.second,
        },
        textStart: 2,
      };
    }
    return { when: { kind: 'absolute', ...absolute }, textStart: 1 };
  }
  for (const fieldCount of [5, 6]) {
    // must leave at least one word of reminder text after the expression
    if (args.length < fieldCount + 1) {
      continue;
    }
    const expression = args.slice(0, fieldCount).join(' ');
    if (isValidCron(expression)) {
      return { when: { kind: 'cron', expression }, textStart: fieldCount };
    }
  }
  return null;
}

// Next run of a crontab expression from a given moment, in a given tz.
// Returns an ISO UTC timestamp.
export function nextCronRun(
  expression: string,
  tz: string,
  fromMs: number = Date.now()
): string {
  const interval = CronExpressionParser.parse(expression, {
    currentDate: new Date(fromMs),
    tz,
  });
  const next = interval.next().toISOString();
  if (next === null) {
    throw new Error(
      `crontab expression "${expression}" has no upcoming run in ${tz}`
    );
  }
  return next;
}

// Fully resolve a parsed when-spec into concrete due data.
// Throws Error with a user-friendly message on invalid input
// (horizon exceeded, impossible wall-clock in the target tz).
export function computeDue(
  when: WhenSpec,
  tz: string,
  maxHorizonDays: number
): DueResult {
  const now = DateTime.now();
  if (when.kind === 'relative') {
    const maxMs = maxHorizonDays * 86_400_000;
    if (when.durationMs < 0 || when.durationMs > maxMs) {
      throw new Error(
        `relative times must be between now and ${maxHorizonDays} days out`
      );
    }
    const due = now.plus(when.durationMs);
    return {
      kind: 'oneshot',
      dueAt: due.toUTC().toISO(),
      cronExpr: null,
      cronTz: null,
      nextDueAt: due.toUTC().toISO() ?? '',
      localDisplay: `${due.setZone(tz).toFormat('yyyy-MM-dd HH:mm')} ${tz}`,
      utcDisplay: `${due.toUTC().toFormat('HH:mm')} UTC`,
    };
  }
  if (when.kind === 'absolute') {
    let due = DateTime.fromObject(
      { hour: when.hour, minute: when.minute, second: when.second },
      { zone: tz }
    );
    if (!due.isValid) {
      throw new Error(`that time is not valid in ${tz}`);
    }
    // Strict rollover: 10:00 said at 10:00:01 means tomorrow's 10:00.
    if (due <= now) {
      due = due.plus({ days: 1 });
    }
    return {
      kind: 'oneshot',
      dueAt: due.toUTC().toISO(),
      cronExpr: null,
      cronTz: null,
      nextDueAt: due.toUTC().toISO() ?? '',
      localDisplay: `${due.setZone(tz).toFormat('yyyy-MM-dd HH:mm')} ${tz}`,
      utcDisplay: `${due.toUTC().toFormat('HH:mm')} UTC`,
    };
  }
  const nextIso = nextCronRun(when.expression, tz);
  const next = DateTime.fromISO(nextIso);
  return {
    kind: 'cron',
    dueAt: null,
    cronExpr: when.expression,
    cronTz: tz,
    nextDueAt: nextIso,
    localDisplay: `${next.setZone(tz).toFormat('yyyy-MM-dd HH:mm')} ${tz}`,
    utcDisplay: `${next.toUTC().toFormat('HH:mm')} UTC`,
  };
}

// Compact humanized age for the [delayed N] marker — most significant unit only.
export function humanizeDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  return `${Math.round(hours / 24)}d`;
}
