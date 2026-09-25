'use strict';
/* IndexedDB 持久化：标签页全部关闭后重开不丢数据 */
const DB_NAME = 'crdt-whiteboard';
const STORE = 'snapshots';
const KEY = 'doc';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveSnapshot(data) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(data, KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    console.warn('snapshot save failed', err);
  }
}

export async function loadSnapshot() {
  try {
    const db = await openDB();
    const data = await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return data;
  } catch (err) {
    console.warn('snapshot load failed', err);
    return null;
  }
}
