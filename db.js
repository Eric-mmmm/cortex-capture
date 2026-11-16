// db.js - tiny IndexedDB wrapper. Used by the page AND the service worker,
// so it must not touch the DOM or localStorage.
//
// Two stores:
//   items - the upload queue (and a short history of sent items)
//   meta  - small key/value data, e.g. the Apps Script URL + token copy that
//           the service worker needs (workers cannot read localStorage).

const DB_NAME = 'cortex-capture';
const DB_VERSION = 1;

let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('items', { keyPath: 'id' });
        db.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

/** Run one request inside a transaction and wait until the transaction commits. */
async function run(storeName, mode, makeRequest) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const request = makeRequest(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(request ? request.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const items = {
  list: () => run('items', 'readonly', (s) => s.getAll()),
  put: (item) => run('items', 'readwrite', (s) => s.put(item)),
  remove: (id) => run('items', 'readwrite', (s) => s.delete(id)),
  /** Save several items in ONE transaction: all of them or none. */
  async putMany(list) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('items', 'readwrite');
      list.forEach((item) => tx.objectStore('items').put(item));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  },
};

export async function getMeta(key) {
  const row = await run('meta', 'readonly', (s) => s.get(key));
  return row ? row.value : undefined;
}

export const setMeta = (key, value) => run('meta', 'readwrite', (s) => s.put({ key, value }));
