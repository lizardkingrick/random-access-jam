// @ts-check
/**
 * IndexedDB wrapper for the track library. Each record stores the ORIGINAL
 * audio Blob (decoded buffers are huge — they're re-decoded on demand) plus
 * lightweight metadata used to populate the wheel.
 *
 * @typedef {{
 *   id: string,
 *   title: string,
 *   artist: string,
 *   type: string,
 *   size: number,
 *   duration: number,
 *   color: string,
 *   demo: boolean,
 *   loop: boolean,
 *   addedAt: number,
 *   blob: Blob,
 * }} TrackRecord
 */

const DB_NAME = 'raj-library';
const DB_VERSION = 1;
const STORE = 'tracks';

/** @type {Promise<IDBDatabase> | null} */
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open the track library.'));
  });
  return dbPromise;
}

/**
 * @template T
 * @param {IDBRequest<T>} req
 * @returns {Promise<T>}
 */
function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** @param {IDBTransactionMode} mode */
async function tx(mode) {
  const db = await open();
  return db.transaction(STORE, mode).objectStore(STORE);
}

/** All tracks, demos first, then oldest-added first. @returns {Promise<TrackRecord[]>} */
export async function getAllTracks() {
  const store = await tx('readonly');
  const all = /** @type {TrackRecord[]} */ (await promisify(store.getAll()));
  return all.sort((a, b) => Number(b.demo) - Number(a.demo) || a.addedAt - b.addedAt);
}

/** @param {string} id @returns {Promise<TrackRecord | undefined>} */
export async function getTrack(id) {
  const store = await tx('readonly');
  return promisify(store.get(id));
}

/**
 * Persist a track. Rethrows QuotaExceededError with a friendly message.
 * @param {TrackRecord} record
 */
export async function putTrack(record) {
  const store = await tx('readwrite');
  try {
    await promisify(store.put(record));
  } catch (err) {
    if (err instanceof DOMException && err.name === 'QuotaExceededError') {
      throw new Error('Storage is full — remove some tracks from the library and try again.');
    }
    throw err;
  }
}

/** @param {string} id */
export async function deleteTrack(id) {
  const store = await tx('readwrite');
  await promisify(store.delete(id));
}

/** Remove every non-demo track. */
export async function clearLibrary() {
  const all = await getAllTracks();
  const store = await tx('readwrite');
  await Promise.all(all.filter((t) => !t.demo).map((t) => promisify(store.delete(t.id))));
}
