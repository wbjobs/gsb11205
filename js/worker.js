// Sync worker: owns the authoritative CRDT doc for this tab.
// - BroadcastChannel: op-based incremental sync with other tabs (<200ms)
// - IndexedDB: debounced snapshot persistence so closing tabs loses nothing
// - GC: bounds memory when stroke count grows large

import {
  createDoc, applyOp, makeBegin, makeSeg, makeEnd, makeUndo, makeClear,
  gc, serialize, mergeSnapshot, snapshotEffects,
} from './crdt.js';

const BC_NAME = 'crdt-whiteboard-v1';
const HELLO_WAIT_MS = 200;

let doc = null;
let bc = null;
let db = null;
let ready = false;
const preReadyOps = [];
let persistTimer = null;

self.onmessage = (e) => {
  const m = e.data;
  if (m.t === 'init') { init(m.site); return; }
  if (!doc) return;
  switch (m.t) {
    case 'begin': applyLocal(makeBegin(doc, m)); break;
    case 'seg': applyLocal(makeSeg(doc, m.id, m.pts)); break;
    case 'end': applyLocal(makeEnd(doc, m.id)); break;
    case 'undo': {
      const op = makeUndo(doc);
      if (op) applyLocal(op);
      break;
    }
    case 'clear': applyLocal(makeClear(doc, m.layer)); break;
    case 'stress': ingestStress(m.strokes); break;
    case 'flush': persistNow(); break;
  }
};

async function init(site) {
  doc = createDoc(site);
  bc = new BroadcastChannel(BC_NAME);
  bc.onmessage = onBc;
  try {
    db = await openDb();
    const saved = await idbGet();
    if (saved) mergeSnapshot(doc, JSON.parse(saved));
  } catch { /* persistence unavailable; sync still works */ }
  bc.postMessage({ t: 'hello', site: doc.site });
  setTimeout(() => {
    ready = true;
    for (const op of preReadyOps) applyRemote(op);
    preReadyOps.length = 0;
    self.postMessage({ t: 'ready', effects: snapshotEffects(doc) });
  }, HELLO_WAIT_MS);
}

function onBc(e) {
  const m = e.data;
  if (m.t === 'hello') {
    if (ready) bc.postMessage({ t: 'state', to: m.site, snap: serialize(doc) });
    return;
  }
  if (m.t === 'state') {
    if (m.to === doc.site && !ready) {
      try { mergeSnapshot(doc, JSON.parse(m.snap)); } catch { /* ignore */ }
    }
    return;
  }
  if (m.t === 'batch') {
    for (const op of m.ops) {
      if (op.site === doc.site) continue;
      if (!ready) { preReadyOps.push(op); continue; }
      applyRemote(op);
    }
    return;
  }
  if (m.site === doc.site) return;
  if (!ready) { preReadyOps.push(m); return; }
  applyRemote(m);
}

function applyLocal(op) {
  const effects = applyOp(doc, op);
  bc.postMessage(op);
  if (effects.length) self.postMessage({ t: 'effects', effects });
  afterMutation();
}

function applyRemote(op) {
  const effects = applyOp(doc, op);
  if (effects.length) self.postMessage({ t: 'effects', effects });
  afterMutation();
}

function afterMutation() {
  const gcEffects = gc(doc);
  if (gcEffects.length) self.postMessage({ t: 'effects', effects: gcEffects });
  schedulePersist();
}

// Bulk stroke ingestion (stress test / import). Broadcasts in chunks so a
// single message never gets too large.
function ingestStress(strokes) {
  const ops = [];
  let effects = [];
  for (const st of strokes) {
    const id = `${doc.site}:g${doc.gen++}`;
    for (const op of [
      makeBegin(doc, { id, layer: st.layer, color: st.color, size: st.size }),
      makeSeg(doc, id, st.points),
      makeEnd(doc, id),
    ]) {
      const fx = applyOp(doc, op);
      ops.push(op);
      if (fx.length) effects = effects.concat(fx);
    }
    if (ops.length >= 600) { bc.postMessage({ t: 'batch', ops: ops.splice(0) }); }
    if (effects.length >= 800) {
      self.postMessage({ t: 'effects', effects });
      effects = [];
    }
  }
  if (ops.length) bc.postMessage({ t: 'batch', ops });
  if (effects.length) self.postMessage({ t: 'effects', effects });
  afterMutation();
}

// ---- persistence -----------------------------------------------------------

function schedulePersist() {
  if (persistTimer || !db) return;
  persistTimer = setTimeout(() => { persistTimer = null; persistNow(); }, 1500);
}

function persistNow() {
  if (!db) return;
  try { idbPut(serialize(doc)); } catch { /* best effort */ }
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('crdt-whiteboard', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet() {
  return new Promise((resolve) => {
    try {
      const req = db.transaction('kv').objectStore('kv').get('doc');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

function idbPut(value) {
  try {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, 'doc');
  } catch { /* best effort */ }
}
