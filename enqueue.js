// enqueue.js - glue between the pure builders (lib/capture.js) and
// IndexedDB. Used by the page and by the service worker (share target).
// Every capture is written to IndexedDB FIRST; uploading happens later.

import * as db from './db.js';
import { createItem } from './lib/queue.js';
import { buildTextCapture, buildBinaryCapture } from './lib/capture.js';

const newId = () => (self.crypto && self.crypto.randomUUID
  ? self.crypto.randomUUID()
  : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

/** Names already used by queued or recently sent items (to avoid collisions). */
async function takenNames() {
  return new Set((await db.items.list()).map((i) => i.name));
}

/** Save a text capture. via: 'speak' | 'type' | 'log' | 'share'. */
export async function enqueueText({ text, via, tags = [], now = new Date() }) {
  const { file } = buildTextCapture({ text, via, tags, now, taken: await takenNames() });
  const item = createItem({ id: newId(), name: file.name, mimeType: file.mimeType, kind: 'text', text: file.text, label: file.label }, now.getTime());
  await db.items.putMany([item]);
  return item;
}

/**
 * Save a photo / recording / shared file (a Blob or File), plus an optional
 * caption sidecar. Both rows are saved in one transaction.
 */
export async function enqueueBinary({ blob, label, caption = '', tags = [], originalName = '', now = new Date() }) {
  const parts = buildBinaryCapture({
    label, mimeType: blob.type, originalName: originalName || blob.name || '', caption, tags, now, taken: await takenNames(),
  });
  const id = newId();
  const t = now.getTime();
  const rows = [createItem({
    id, captureId: id, name: parts.file.name, mimeType: parts.file.mimeType, kind: 'binary', blob, label: parts.file.label,
  }, t)];
  if (parts.sidecar) {
    rows.push(createItem({
      id: newId(), captureId: id, name: parts.sidecar.name, mimeType: parts.sidecar.mimeType,
      kind: 'text', text: parts.sidecar.text, hidden: true,
    }, t));
  }
  await db.items.putMany(rows);
  return rows[0];
}
