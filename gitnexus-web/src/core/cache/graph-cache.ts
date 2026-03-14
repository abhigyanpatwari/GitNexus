/**
 * IndexedDB Graph Cache
 *
 * Persists the downloaded knowledge graph across browser sessions.
 * On reconnect, if the server's commit hash matches the cached commit,
 * the graph is served from IndexedDB instead of re-downloading (~2MB+).
 *
 * Cache key: `${serverUrl}::${repoName}`
 * DB: 'gitnexus-graph-cache' / store: 'graphs'
 */

const DB_NAME = 'gitnexus-graph-cache';
const STORE_NAME = 'graphs';
const DB_VERSION = 1;

export interface CachedGraph {
  cacheKey: string;       // `${serverUrl}::${repoName}` — IDB keyPath
  serverUrl: string;
  repoName: string;
  commitHash: string;
  nodes: unknown[];
  relationships: unknown[];
  fileContents: Record<string, string>;
  cachedAt: string;       // ISO timestamp
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'cacheKey' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveGraphToCache(
  serverUrl: string,
  repoName: string,
  commitHash: string,
  nodes: unknown[],
  relationships: unknown[],
  fileContents: Record<string, string>
): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const entry: CachedGraph = {
      cacheKey: `${serverUrl}::${repoName}`,
      serverUrl,
      repoName,
      commitHash,
      nodes,
      relationships,
      fileContents,
      cachedAt: new Date().toISOString(),
    };
    const req = tx.objectStore(STORE_NAME).put(entry);
    req.onsuccess = () => { db.close(); resolve(); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

export async function loadGraphFromCache(
  serverUrl: string,
  repoName: string
): Promise<CachedGraph | null> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(`${serverUrl}::${repoName}`);
      req.onsuccess = () => { db.close(); resolve(req.result ?? null); };
      req.onerror = () => { db.close(); reject(req.error); };
    });
  } catch {
    return null;
  }
}

export async function isCacheValid(
  serverUrl: string,
  repoName: string,
  currentCommitHash: string
): Promise<boolean> {
  const cached = await loadGraphFromCache(serverUrl, repoName);
  return cached !== null && cached.commitHash === currentCommitHash;
}

export async function clearGraphCache(serverUrl?: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    if (!serverUrl) {
      const req = store.clear();
      req.onsuccess = () => { db.close(); resolve(); };
      req.onerror = () => { db.close(); reject(req.error); };
    } else {
      // Delete all entries for this serverUrl by iterating
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          if ((cursor.value as CachedGraph).serverUrl === serverUrl) {
            cursor.delete();
          }
          cursor.continue();
        } else {
          db.close();
          resolve();
        }
      };
      req.onerror = () => { db.close(); reject(req.error); };
    }
  });
}
