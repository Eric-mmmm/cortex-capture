// queue.js - the upload queue as plain data and pure functions.
// No DOM, no IndexedDB, no fetch: the browser parts are injected
// (see drainQueue) so the rules can be tested with `node --test`.
//
// An item looks like:
//   { id, captureId, createdAt, name, mimeType, kind: 'text'|'binary',
//     text, blob, label, hidden, status, attempts, nextAttempt,
//     sendingSince, lastError, serverId, sentAt }
// status: 'queued' -> 'sending' -> 'sent'   (or 'failed' -> 'sending' -> ...)
//
// GOLDEN RULE: an item only becomes 'sent' when the server answered ok.
// Every other outcome keeps the item in the queue.

export const STALE_SENDING_MS = 2 * 60 * 1000; // a 'sending' item older than this is assumed dead (app was closed)

export function createItem({ id, captureId, name, mimeType, kind, text = null, blob = null, label = '', hidden = false }, now) {
  return {
    id, captureId: captureId || id, createdAt: now, name, mimeType, kind, text, blob, label, hidden,
    status: 'queued', attempts: 0, nextAttempt: 0, sendingSince: null, lastError: '', serverId: '', sentAt: null,
  };
}

/** Wait before retry number `attempts`: 15 s, 30 s, 1 min ... capped at 30 min. */
export function backoffMs(attempts) {
  const n = Math.max(1, attempts);
  return Math.min(15000 * 2 ** (n - 1), 30 * 60 * 1000);
}

export function startSending(item, now) {
  return { ...item, status: 'sending', sendingSince: now };
}

/** Success: the server said ok. The heavy payload is dropped; the row stays as history. */
export function markSent(item, serverResult, now) {
  return {
    ...item, status: 'sent', sentAt: now, sendingSince: null, lastError: '',
    serverId: (serverResult && serverResult.id) || '', text: null, blob: null,
  };
}

/** Failure: keep everything, count the attempt, schedule the next try. */
export function markFailed(item, error, now) {
  const attempts = item.attempts + 1;
  return {
    ...item, status: 'failed', attempts, sendingSince: null,
    lastError: String(error || 'unknown error').slice(0, 300),
    nextAttempt: now + backoffMs(attempts),
  };
}

/** "Send now": make every unsent item due immediately. */
export function forceRetry(item) {
  return item.status === 'sent' ? item : { ...item, nextAttempt: 0 };
}

export function isPending(item) {
  return item.status !== 'sent';
}

export function pendingCount(items) {
  return items.filter(isPending).length;
}

/** Items that should be tried now, oldest first. */
export function dueItems(items, now) {
  return items
    .filter((it) => {
      if (it.status === 'queued' || it.status === 'failed') return it.nextAttempt <= now;
      if (it.status === 'sending') return it.sendingSince !== null && now - it.sendingSince > STALE_SENDING_MS;
      return false;
    })
    .sort((a, b) => a.createdAt - b.createdAt || (a.hidden ? 1 : 0) - (b.hidden ? 1 : 0));
}

/** Soonest time any waiting item becomes due (or null). Used to schedule a timer. */
export function nextDueAt(items) {
  const times = items.filter((i) => i.status === 'queued' || i.status === 'failed').map((i) => i.nextAttempt);
  return times.length ? Math.min(...times) : null;
}

/** The newest `n` visible captures (sidecar files are hidden). */
export function recentCaptures(items, n = 3) {
  return items.filter((i) => !i.hidden).sort((a, b) => b.createdAt - a.createdAt).slice(0, n);
}

/** Ids of old 'sent' rows to delete so the history does not grow forever. */
export function sentToPrune(items, keep = 12) {
  return items.filter((i) => i.status === 'sent').sort((a, b) => b.createdAt - a.createdAt).slice(keep).map((i) => i.id);
}

/**
 * Try to upload everything that is due.
 *
 *   store: { list(): Promise<item[]>, put(item): Promise<void> }
 *   send:  async (item) => { ok, id?, error? }   // throws on network trouble
 *
 * - A thrown error means "network problem": mark failed and stop (we are
 *   probably offline, no point hammering).
 * - { ok:false } means the server refused (wrong token, bad payload): mark
 *   failed and continue with the next item.
 * - Nothing is ever deleted here.
 */
export async function drainQueue({ store, send, now = () => Date.now(), force = false, onChange = () => {} }) {
  const result = { sent: 0, failed: 0, offline: false };
  const all = await store.list();
  const due = dueItems(force ? all.map(forceRetry) : all, now());
  for (const item of due) {
    const sending = startSending(item, now());
    await store.put(sending);
    onChange();
    let answer;
    try {
      answer = await send(sending);
    } catch (err) {
      await store.put(markFailed(sending, (err && err.message) || 'network error', now()));
      result.failed += 1;
      result.offline = true;
      onChange();
      break;
    }
    if (answer && answer.ok === true) {
      await store.put(markSent(sending, answer, now()));
      result.sent += 1;
    } else {
      await store.put(markFailed(sending, (answer && answer.error) || 'server refused', now()));
      result.failed += 1;
    }
    onChange();
  }
  return result;
}
