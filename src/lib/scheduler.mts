'use strict';

// Per-reminder timeout registry. SQLite is the durable schedule; these
// timeouts are only the runtime trigger and are regenerated from the
// database on every startup. (No tick loop — see the module plan.)

import { log } from '@eeveebot/libeevee';

// Node's setTimeout caps at 2^31-1 ms (~24.8 days): anything longer fires
// immediately. Far-future reminders arm a capped timeout and re-arm on
// wake until the real due time arrives.
const MAX_TIMEOUT_MS = 2_147_483_647;

const timers = new Map<string, NodeJS.Timeout>();
let fireHandler: ((id: string) => void) | null = null;

export function setFireHandler(handler: (id: string) => void): void {
  fireHandler = handler;
}

// Arm (or re-arm) the timeout for a reminder id. Safe to call repeatedly.
export function armTimer(id: string, nextDueAt: string): void {
  clearTimer(id);
  const dueMs = Date.parse(nextDueAt);
  if (Number.isNaN(dueMs)) {
    log.error('Refusing to arm timer with unparseable due date', {
      producer: 'reminders',
      id,
      nextDueAt,
    });
    return;
  }
  const delay = Math.max(0, Math.min(dueMs - Date.now(), MAX_TIMEOUT_MS));
  const timer = setTimeout(() => {
    timers.delete(id);
    const remaining = dueMs - Date.now();
    if (remaining > 0) {
      // Woke from a capped timeout with time still to burn: re-arm.
      armTimer(id, nextDueAt);
      return;
    }
    if (fireHandler) {
      fireHandler(id);
    } else {
      log.error('Timer fired with no fire handler registered', {
        producer: 'reminders',
        id,
      });
    }
  }, delay);
  timers.set(id, timer);
}

export function clearTimer(id: string): void {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
}

export function clearAllTimers(): void {
  for (const timer of timers.values()) {
    clearTimeout(timer);
  }
  timers.clear();
}

export function armedCount(): number {
  return timers.size;
}
