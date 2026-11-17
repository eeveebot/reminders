'use strict';

// SQLite storage for the reminders module — tell pattern: better-sqlite3,
// prepared statements created at init, ${MODULE_DATA}/reminders.db volume.
// SQLite is the durable schedule; everything else is disposable state.

import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { log } from '@eeveebot/libeevee';

export interface ReminderRow {
  id: string;
  platform: string;
  network: string;
  instance: string;
  channel: string;
  creatorIdent: string;
  creatorNick: string;
  kind: string; // 'oneshot' | 'cron'
  deliverVia: string; // 'channel' | 'dm' | 'announcement'
  cronExpr: string | null;
  cronTz: string | null;
  dueAt: string | null;
  nextDueAt: string;
  bells: number;
  text: string;
  createdDate: string;
  editedDate: string | null;
  lastDeliveredDate: string | null;
  active: number;
}

export interface UserTzRow {
  platform: string;
  network: string;
  instance: string;
  user: string;
  nick: string;
  tz: string;
}

export interface ReminderUpdate {
  kind: string;
  deliverVia: string;
  channel: string;
  cronExpr: string | null;
  cronTz: string | null;
  dueAt: string | null;
  nextDueAt: string;
  bells: number;
  text: string;
  editedDate: string;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS reminders (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    network TEXT NOT NULL,
    instance TEXT NOT NULL,
    channel TEXT NOT NULL,
    creatorIdent TEXT NOT NULL,
    creatorNick TEXT NOT NULL,
    kind TEXT NOT NULL,
    deliverVia TEXT NOT NULL,
    cronExpr TEXT,
    cronTz TEXT,
    dueAt TEXT,
    nextDueAt TEXT NOT NULL,
    bells INTEGER NOT NULL DEFAULT 0,
    text TEXT NOT NULL,
    createdDate TEXT NOT NULL,
    editedDate TEXT,
    lastDeliveredDate TEXT,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (active, nextDueAt);

  CREATE TABLE IF NOT EXISTS user_tz (
    platform TEXT NOT NULL,
    network TEXT NOT NULL,
    instance TEXT NOT NULL,
    user TEXT NOT NULL,
    nick TEXT NOT NULL,
    tz TEXT NOT NULL,
    PRIMARY KEY (platform, network, instance, user)
  );
`;

let db: Database.Database | null = null;
let addReminderStmt: Database.Statement | null = null;
let getReminderByIdStmt: Database.Statement | null = null;
let findAllActiveStmt: Database.Statement | null = null;
let findOverdueStmt: Database.Statement | null = null;
let findByShortIdStmt: Database.Statement | null = null;
let markDeliveredStmt: Database.Statement | null = null;
let scheduleNextStmt: Database.Statement | null = null;
let deactivateStmt: Database.Statement | null = null;
let updateReminderStmt: Database.Statement | null = null;
let listByCreatorStmt: Database.Statement | null = null;
let listAnnouncementsByChannelStmt: Database.Statement | null = null;
let countActiveByCreatorStmt: Database.Statement | null = null;
let countAllActiveStmt: Database.Statement | null = null;
let getUserTzStmt: Database.Statement | null = null;
let setUserTzStmt: Database.Statement | null = null;

export function initDatabase(dbPath: string): void {
  if (db) {
    return;
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.exec(SCHEMA);

  addReminderStmt = db.prepare(`
    INSERT INTO reminders (
      id, platform, network, instance, channel, creatorIdent, creatorNick,
      kind, deliverVia, cronExpr, cronTz, dueAt, nextDueAt, bells, text,
      createdDate, editedDate, lastDeliveredDate, active
    ) VALUES (
      @id, @platform, @network, @instance, @channel, @creatorIdent, @creatorNick,
      @kind, @deliverVia, @cronExpr, @cronTz, @dueAt, @nextDueAt, @bells, @text,
      @createdDate, @editedDate, @lastDeliveredDate, @active
    )
  `);
  getReminderByIdStmt = db.prepare('SELECT * FROM reminders WHERE id = @id');
  findAllActiveStmt = db.prepare(
    'SELECT * FROM reminders WHERE active = 1 ORDER BY nextDueAt ASC'
  );
  findOverdueStmt = db.prepare(
    'SELECT * FROM reminders WHERE active = 1 AND nextDueAt <= @now ORDER BY nextDueAt ASC'
  );
  findByShortIdStmt = db.prepare(
    'SELECT * FROM reminders WHERE active = 1 AND substr(id, 1, @len) = @prefix ORDER BY nextDueAt ASC'
  );
  markDeliveredStmt = db.prepare(
    'UPDATE reminders SET lastDeliveredDate = @now, active = 0 WHERE id = @id'
  );
  scheduleNextStmt = db.prepare(
    'UPDATE reminders SET nextDueAt = @nextDueAt, lastDeliveredDate = @now WHERE id = @id'
  );
  deactivateStmt = db.prepare('UPDATE reminders SET active = 0 WHERE id = @id');
  updateReminderStmt = db.prepare(`
    UPDATE reminders SET
      kind = @kind,
      deliverVia = @deliverVia,
      channel = @channel,
      cronExpr = @cronExpr,
      cronTz = @cronTz,
      dueAt = @dueAt,
      nextDueAt = @nextDueAt,
      bells = @bells,
      text = @text,
      editedDate = @editedDate
    WHERE id = @id
  `);
  listByCreatorStmt = db.prepare(`
    SELECT * FROM reminders
    WHERE active = 1
      AND platform = @platform AND network = @network AND instance = @instance
      AND creatorIdent = @creatorIdent
    ORDER BY nextDueAt ASC
  `);
  listAnnouncementsByChannelStmt = db.prepare(`
    SELECT * FROM reminders
    WHERE active = 1
      AND platform = @platform AND network = @network AND instance = @instance
      AND channel = @channel AND deliverVia = 'announcement'
    ORDER BY nextDueAt ASC
  `);
  countActiveByCreatorStmt = db.prepare(`
    SELECT COUNT(*) AS count FROM reminders
    WHERE active = 1
      AND platform = @platform AND network = @network AND instance = @instance
      AND creatorIdent = @creatorIdent
  `);
  countAllActiveStmt = db.prepare(
    'SELECT COUNT(*) AS count FROM reminders WHERE active = 1'
  );
  getUserTzStmt = db.prepare(`
    SELECT tz FROM user_tz
    WHERE platform = @platform AND network = @network AND instance = @instance
      AND user = @user
    LIMIT 1
  `);
  setUserTzStmt = db.prepare(`
    INSERT INTO user_tz (platform, network, instance, user, nick, tz)
    VALUES (@platform, @network, @instance, @user, @nick, @tz)
    ON CONFLICT(platform, network, instance, user) DO UPDATE SET
      nick = excluded.nick,
      tz = excluded.tz
  `);

  log.info('Initialized reminders database', { producer: 'reminders', dbPath });
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

function must(stmt: Database.Statement | null): Database.Statement {
  if (!stmt) {
    throw new Error('reminders database not initialized');
  }
  return stmt;
}

export function addReminder(row: ReminderRow): void {
  must(addReminderStmt).run(row);
}

export function getReminderById(id: string): ReminderRow | undefined {
  return must(getReminderByIdStmt).get({ id }) as ReminderRow | undefined;
}

export function findAllActive(): ReminderRow[] {
  return must(findAllActiveStmt).all() as ReminderRow[];
}

export function findOverdue(nowIso: string): ReminderRow[] {
  return must(findOverdueStmt).all({ now: nowIso }) as ReminderRow[];
}

// Short-id resolution: match on the given prefix (any length). Returns all
// matching active rows — callers error on zero or multiple matches.
export function findReminderByShortId(prefix: string): ReminderRow[] {
  return must(findByShortIdStmt).all({
    prefix,
    len: prefix.length,
  }) as ReminderRow[];
}

export function markDelivered(id: string, nowIso: string): void {
  must(markDeliveredStmt).run({ id, now: nowIso });
}

export function scheduleNext(
  id: string,
  nextDueAt: string,
  nowIso: string
): void {
  must(scheduleNextStmt).run({ id, nextDueAt, now: nowIso });
}

export function deactivateReminder(id: string): void {
  must(deactivateStmt).run({ id });
}

export function updateReminder(id: string, update: ReminderUpdate): void {
  must(updateReminderStmt).run({ id, ...update });
}

export function listByCreator(
  platform: string,
  network: string,
  instance: string,
  creatorIdent: string
): ReminderRow[] {
  return must(listByCreatorStmt).all({
    platform,
    network,
    instance,
    creatorIdent,
  }) as ReminderRow[];
}

export function listAnnouncementsByChannel(
  platform: string,
  network: string,
  instance: string,
  channel: string
): ReminderRow[] {
  return must(listAnnouncementsByChannelStmt).all({
    platform,
    network,
    instance,
    channel,
  }) as ReminderRow[];
}

export function countActiveByCreator(
  platform: string,
  network: string,
  instance: string,
  creatorIdent: string
): number {
  const row = must(countActiveByCreatorStmt).get({
    platform,
    network,
    instance,
    creatorIdent,
  }) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function countAllActive(): number {
  const row = must(countAllActiveStmt).get() as { count: number } | undefined;
  return row?.count ?? 0;
}

export function getUserTz(
  platform: string,
  network: string,
  instance: string,
  user: string
): string | undefined {
  const row = must(getUserTzStmt).get({
    platform,
    network,
    instance,
    user,
  }) as { tz: string } | undefined;
  return row?.tz;
}

export function setUserTz(row: UserTzRow): void {
  must(setUserTzStmt).run(row);
}
