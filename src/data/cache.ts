import { ANALYSIS_VERSION, type Analysis } from "../core/model";

/** IndexedDB cache of finished analyses, keyed by repo@sha(+path). Works in the worker and the page. */
const DB = "code-blueprint";
const STORE = "analyses";
const MAX_ENTRIES = 8;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => db.close();
      }),
  );
}

export const cacheKey = (owner: string, repo: string, sha: string, path?: string) => `${owner}/${repo}@${sha}${path ? ":" + path : ""}`.toLowerCase();

export async function readCache(key: string): Promise<Analysis | undefined> {
  try {
    const value = await run<Analysis | undefined>("readonly", (s) => s.get(key) as IDBRequest<Analysis | undefined>);
    return value && value.version === ANALYSIS_VERSION ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function writeCache(key: string, analysis: Analysis): Promise<void> {
  try {
    await run("readwrite", (s) => s.put(analysis, key));
    const keys = await run<IDBValidKey[]>("readonly", (s) => s.getAllKeys());
    if (keys.length > MAX_ENTRIES) {
      const all = await run<Analysis[]>("readonly", (s) => s.getAll());
      const order = keys.map((k, i) => ({ k, at: all[i]?.createdAt ?? 0 })).sort((a, b) => a.at - b.at);
      for (const { k } of order.slice(0, keys.length - MAX_ENTRIES)) await run("readwrite", (s) => s.delete(k));
    }
  } catch {
    // Quota or private mode: caching is best-effort.
  }
}
