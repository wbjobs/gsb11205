'use strict';
/*
 * CRDT 核心（Web Worker 内运行）
 * - 笔迹 = CRDT 对象，id = `${actor}:${seq}`，全局唯一
 * - 可见性 = LWW-Register（lamport 时间戳），undo/redo 即写可见性位
 * - 增量同步 = chunk op（流式点集）+ vis op（可见性翻转）
 * - 内存控制 = 点数抽稀（主线程）+ 已删除笔迹点数据 GC + 笔迹总数上限
 */

const FLUSH_MS = 30;              // op 批量广播间隔（远小于 200ms 延迟要求）
const SNAPSHOT_DEBOUNCE_MS = 2000;
const MAX_STROKES = 12000;        // 内存水位：超过则 GC 已删除笔迹的点数据
const HARD_MAX_STROKES = 16000;   // 硬上限：连墓碑一起回收最旧的已删除笔迹
const MAX_UNDO = 200;

const actor = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
let lamport = 0;
let seq = 0;
let currentLocalId = null;

/** Map<id, {id, actor, layer, color, size, tool, points:number[], ts, vis, visTs, live, gc}> */
const strokes = new Map();
const ownUndoStack = [];
const ownRedoStack = [];
const pendingOps = [];
const dirtyLayers = new Set();

let flushTimer = null;
let snapshotTimer = null;

function nextTs() { return ++lamport; }
function observe(ts) { if (ts > lamport) lamport = ts; }
function post(msg) { self.postMessage(msg); }

function serializeStroke(s) {
  return {
    id: s.id, layer: s.layer, color: s.color, size: s.size, tool: s.tool,
    points: Float32Array.from(s.points), ts: s.ts,
  };
}

function layerStrokes(layer) {
  return [...strokes.values()]
    .filter(s => s.layer === layer && s.vis && !s.live)
    .sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))
    .map(serializeStroke);
}

function allLayerData() {
  const out = {};
  for (const s of strokes.values()) {
    if (!s.vis || s.live) continue;
    (out[s.layer] || (out[s.layer] = [])).push(s);
  }
  for (const k of Object.keys(out)) {
    out[k].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
    out[k] = out[k].map(serializeStroke);
  }
  return out;
}

function queueOp(op) { pendingOps.push(op); scheduleFlush(); }

function scheduleFlush() {
  if (flushTimer === null) {
    flushTimer = setTimeout(flush, FLUSH_MS);
  }
}

function flush() {
  flushTimer = null;
  if (pendingOps.length) post({ type: 'ops', ops: pendingOps.splice(0) });
  if (dirtyLayers.size) {
    const layers = {};
    for (const id of dirtyLayers) layers[id] = layerStrokes(id);
    dirtyLayers.clear();
    post({ type: 'rebuild', layers });
  }
  postStats();
  scheduleSnapshot();
}

function postStats() {
  let bytes = 0, visible = 0;
  for (const s of strokes.values()) {
    bytes += s.points.length * 8 + 160;
    if (s.vis) visible++;
  }
  post({ type: 'stats', strokes: strokes.size, visible, bytes });
}

function scheduleSnapshot() {
  if (snapshotTimer !== null) return;
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    post({ type: 'snapshot', data: serialize() });
  }, SNAPSHOT_DEBOUNCE_MS);
}

function serialize() {
  return {
    actor, lamport,
    strokes: [...strokes.values()].map(s => ({
      id: s.id, actor: s.actor, layer: s.layer, color: s.color, size: s.size,
      tool: s.tool, points: s.points, ts: s.ts, vis: s.vis, visTs: s.visTs,
    })),
  };
}

function mergeSnapshot(data) {
  if (!data) return;
  observe(data.lamport || 0);
  for (const raw of data.strokes || []) {
    const existing = strokes.get(raw.id);
    if (existing) {
      if (raw.visTs > existing.visTs) { existing.visTs = raw.visTs; existing.vis = raw.vis; }
      dirtyLayers.add(existing.layer);
    } else {
      strokes.set(raw.id, {
        id: raw.id, actor: raw.actor, layer: raw.layer, color: raw.color,
        size: raw.size, tool: raw.tool, points: raw.points || [],
        ts: raw.ts, vis: raw.vis !== false, visTs: raw.visTs || raw.ts, live: false,
      });
      dirtyLayers.add(raw.layer);
    }
  }
  rebuildUndoStack();
  gc();
}

function rebuildUndoStack() {
  ownUndoStack.length = 0;
  ownRedoStack.length = 0;
  const mine = [...strokes.values()]
    .filter(s => s.actor === actor && s.vis)
    .sort((a, b) => a.ts - b.ts);
  for (const s of mine) ownUndoStack.push(s.id);
  while (ownUndoStack.length > MAX_UNDO) ownUndoStack.shift();
}

/* ---------- op 应用（幂等，可重放） ---------- */

function applyChunk(op, isLocal) {
  let s = strokes.get(op.id);
  if (!s) {
    s = {
      id: op.id, actor: op.actor, layer: op.layer, color: op.color, size: op.size,
      tool: op.tool, points: [], ts: op.ts, vis: true, visTs: op.ts, live: true,
    };
    strokes.set(op.id, s);
  }
  if (op.start === s.points.length) {
    for (let i = 0; i < op.points.length; i++) s.points.push(op.points[i]);
  } else if (op.start > s.points.length) {
    return; // 缺口（乱序），BroadcastChannel 有序，正常不会触发
  }
  if (op.done && s.live) {
    s.live = false;
    gc();
    post({ type: 'commit', stroke: serializeStroke(s) });
  } else if (!op.done && !isLocal) {
    post({ type: 'live', stroke: serializeStroke(s) });
  }
}

function applyVis(op) {
  const s = strokes.get(op.id);
  if (!s) return;
  if (op.ts > s.visTs) {
    s.visTs = op.ts;
    s.vis = op.visible;
    dirtyLayers.add(s.layer);
  }
}

function applyOp(op, isLocal) {
  observe(op.ts || 0);
  if (op.t === 'chunk') applyChunk(op, isLocal);
  else if (op.t === 'vis') applyVis(op);
}

/* ---------- 本地动作 ---------- */

function localChunk(msg) {
  const { points, done, meta } = msg;
  let s;
  if (meta) {
    const id = `${actor}:${++seq}`;
    s = {
      id, actor, layer: meta.layer, color: meta.color, size: meta.size,
      tool: meta.tool, points: [], ts: nextTs(), vis: true, visTs: lamport, live: true,
    };
    strokes.set(id, s);
    currentLocalId = id;
  } else {
    s = currentLocalId ? strokes.get(currentLocalId) : null;
  }
  if (!s || !s.live) return;
  const start = s.points.length;
  for (let i = 0; i < points.length; i++) s.points.push(points[i]);
  queueOp({
    t: 'chunk', id: s.id, actor, layer: s.layer, color: s.color, size: s.size,
    tool: s.tool, start, points, done, ts: s.ts,
  });
  if (done) {
    s.live = false;
    currentLocalId = null;
    ownUndoStack.push(s.id);
    if (ownUndoStack.length > MAX_UNDO) ownUndoStack.shift();
    ownRedoStack.length = 0;
    gc();
    post({ type: 'commit', stroke: serializeStroke(s) });
    scheduleFlush();
  }
}

function undo() {
  while (ownUndoStack.length) {
    const id = ownUndoStack.pop();
    const s = strokes.get(id);
    if (s && s.vis) {
      const t = nextTs();
      s.vis = false; s.visTs = t;
      dirtyLayers.add(s.layer);
      ownRedoStack.push(id);
      queueOp({ t: 'vis', id, ts: t, visible: false, actor });
      scheduleFlush();
      return;
    }
  }
}

function redo() {
  while (ownRedoStack.length) {
    const id = ownRedoStack.pop();
    const s = strokes.get(id);
    if (s && !s.vis) {
      const t = nextTs();
      s.vis = true; s.visTs = t;
      dirtyLayers.add(s.layer);
      ownUndoStack.push(id);
      queueOp({ t: 'vis', id, ts: t, visible: true, actor });
      scheduleFlush();
      return;
    }
  }
}

/* ---------- 内存控制 ---------- */

function gc() {
  if (strokes.size <= MAX_STROKES) return;
  const deleted = [...strokes.values()]
    .filter(s => !s.vis && !s.live)
    .sort((a, b) => a.visTs - b.visTs);
  let reclaimed = 0;
  for (const s of deleted) {
    if (strokes.size <= MAX_STROKES) break;
    if (s.points.length) { s.points = []; s.gc = true; reclaimed++; }
  }
  if (strokes.size > HARD_MAX_STROKES) {
    for (const s of deleted) {
      if (strokes.size <= HARD_MAX_STROKES) break;
      strokes.delete(s.id);
    }
  }
  if (reclaimed) postStats();
}

/* ---------- 消息入口 ---------- */

self.onmessage = (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      if (msg.snapshot) mergeSnapshot(msg.snapshot);
      post({ type: 'ready', actor, layers: allLayerData() });
      postStats();
      break;
    case 'local-chunk': localChunk(msg); break;
    case 'undo': undo(); break;
    case 'redo': redo(); break;
    case 'remote-ops':
      for (const op of msg.ops) applyOp(op, false);
      scheduleFlush();
      break;
    case 'merge-snapshot':
      mergeSnapshot(msg.data);
      scheduleFlush();
      break;
    case 'snapshot-request':
      post({ type: 'snapshot', data: serialize() });
      break;
    case 'rebuild-all':
      post({ type: 'rebuild', layers: allLayerData() });
      break;
  }
};
