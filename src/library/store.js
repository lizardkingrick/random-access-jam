// @ts-check
/**
 * IndexedDB wrapper for the track library.
 *
 * v2 schema: one record = one STEM SET. Any subset of the 4 roles is allowed;
 * original audio Blobs are stored per stem (decoded buffers are huge — they're
 * re-decoded/conformed on demand).
 *
 * Migration v1→v2: old single-file tracks become a stem set with their blob as
 * the "lead" stem (bpm/key default until the user edits or auto-detect runs).
 * Old demo records are deleted — demos are regenerated as proper stem sets.
 *
 * @typedef {'vocals' | 'drums' | 'bass' | 'lead'} StemRole
 *
 * @typedef {{
 *   id: string,
 *   title: string,
 *   artist: string,
 *   sourceBpm: number,
 *   sourceKey: string,        // e.g. "A minor"
 *   bars: number,             // loop length in bars (4/4 assumed)
 *   stems: Partial<Record<StemRole, { blob: Blob }>>,
 *   color: string,
 *   demo: boolean,
 *   addedAt: number,
 * }} TrackRecord
 */

const DB_NAME = 'raj-library';
const DB_VERSION = 2;
const STORE = 'tracks';

/** @type {Promise<IDBDatabase> | null} */
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
        return;
      }
      // v1 → v2: rewrite records inside the upgrade transaction.
      const tx = /** @type {IDBTransaction} */ (req.transaction);
      const store = tx.objectStore(STORE);
      store.openCursor().onsuccess = (ev) => {
        const cursor = /** @type {IDBCursorWithValue} */ (
          /** @type {IDBRequest} */ (ev.target).result
        );
        if (!cursor) return;
        const old = cursor.value;
        if (old && !old.stems) {
          if (old.demo) {
            cursor.delete(); // demos are regenerated as stem sets
          } else {
            /** @type {TrackRecord} */
            const migrated = {
              id: old.id,
              title: old.title,
              artist: old.artist ?? 'Your library',
              sourceBpm: 120,
              sourceKey: 'C major',
              bars: 16,
              stems: { lead: { blob: old.blob } },
              color: old.color ?? '#35c9ff',
              demo: false,
              addedAt: old.addedAt ?? Date.now(),
            };
            cursor.update(migrated);
          }
        }
        cursor.continue();
      };
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

/** All stem sets, demos first, then oldest-added first. @returns {Promise<TrackRecord[]>} */
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
 * Persist a stem set. Rethrows QuotaExceededError with a friendly message.
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

/** Roles present on a record, in canonical order. @param {TrackRecord} record */
export function rolesOf(record) {
  return /** @type {StemRole[]} */ (
    ['vocals', 'drums', 'bass', 'lead'].filter((r) => record.stems[/** @type {StemRole} */ (r)])
  );
}
