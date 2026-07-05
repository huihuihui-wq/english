// utils/shadowRecordingStorage.ts - 使用 IndexedDB 缓存跟读录音

const DB_NAME = 'shadow-reader-recordings';
const DB_VERSION = 1;
const STORE_NAME = 'recordings';

export interface ShadowRecording {
  id: string;
  cueId: number;
  audioBlob: Blob;
  durationMs: number;
  createdAt: number;
}

export interface ShadowRecordingMeta {
  id: string;
  cueId: number;
  durationMs: number;
  createdAt: number;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('cueId', 'cueId', { unique: false });
      }
    };
  });
}

function generateId(cueId: number): string {
  return `${cueId}-${Date.now()}`;
}

export async function saveRecording(
  cueId: number,
  audioBlob: Blob,
  durationMs: number,
): Promise<ShadowRecordingMeta> {
  const db = await openDB();
  const id = generateId(cueId);
  const record: ShadowRecording = {
    id,
    cueId,
    audioBlob,
    durationMs,
    createdAt: Date.now(),
  };

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put(record);
    request.onsuccess = () => {
      resolve({
        id,
        cueId,
        durationMs,
        createdAt: record.createdAt,
      });
    };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}

export async function getRecording(id: string): Promise<ShadowRecording | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(id);
    request.onsuccess = () => {
      resolve((request.result as ShadowRecording | undefined) || null);
    };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}

export async function deleteRecording(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}

export async function listRecordingsForCue(cueId: number): Promise<ShadowRecordingMeta[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index('cueId');
    const request = index.getAll(cueId);
    request.onsuccess = () => {
      const results = (request.result as ShadowRecording[]).map((r) => ({
        id: r.id,
        cueId: r.cueId,
        durationMs: r.durationMs,
        createdAt: r.createdAt,
      }));
      resolve(results.sort((a, b) => b.createdAt - a.createdAt));
    };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}

export async function clearAllRecordings(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}
