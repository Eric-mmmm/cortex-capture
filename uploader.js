// uploader.js - the browser side of uploading: reads the saved settings,
// POSTs each due item to Apps Script, and lets lib/queue.js decide what the
// result means. Runs in the page and in the service worker.

import * as db from './db.js';
import { drainQueue, sentToPrune } from './lib/queue.js';
import { buildPayload, parseResponse } from './lib/protocol.js';
import { blobToBase64 } from './lib/b64.js';

const TIMEOUT_MS = 90 * 1000;

/** The URL + token copy kept in IndexedDB for the service worker. */
export const getConfig = async () => (await db.getMeta('config')) || { url: '', token: '' };
export const saveConfig = (config) => db.setMeta('config', { url: config.url, token: config.token });

/** Upload one item. Throws on network errors; returns {ok,...} when the server answered. */
async function sendOne(item, config) {
  const payload = await buildPayload(item, config.token, blobToBase64);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(config.url, {
      method: 'POST',
      // text/plain keeps this a "simple" request: no CORS preflight (Apps Script cannot answer one).
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow', // Apps Script answers through a redirect
      credentials: 'omit',
      signal: controller.signal,
    });
    return parseResponse(res.status, await res.text());
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send everything that is due. `force` ignores the retry delay ("Send now").
 * Only one drain runs at a time across the page and the service worker
 * (Web Locks); the server's name check makes an accidental double send harmless anyway.
 */
export async function drain({ force = false, onChange } = {}) {
  const config = await getConfig();
  if (!config.url || !config.token) return { sent: 0, failed: 0, offline: false, notConfigured: true };

  const work = async () => {
    const result = await drainQueue({
      store: db.items,
      send: (item) => sendOne(item, config),
      force,
      onChange,
    });
    for (const id of sentToPrune(await db.items.list())) await db.items.remove(id);
    return result;
  };

  if (self.navigator && navigator.locks) {
    return navigator.locks.request('cortex-drain', { ifAvailable: true }, async (lock) => (
      lock ? work() : { sent: 0, failed: 0, offline: false, busy: true }
    ));
  }
  return work();
}
