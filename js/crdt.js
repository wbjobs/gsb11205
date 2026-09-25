// Pure CRDT logic for the collaborative whiteboard.
// No DOM / worker APIs here so it can be unit-tested under Node.

export const MAX_POINTS_PER_STROKE = 8000; // memory control: cap points per stroke
export const GC_MAX_STROKES = 12000;       // memory control: GC hidden strokes beyond this

export function createDoc(site) {
  return {
    site,
    lamport: 0,
    gen: 0,
    strokes: new Map(),    // id -> {id, site, layer, color, size, lamport, points:[x0,y0,...], done}
    pending: new Map(),    // id -> Map<fromPointIndex, flatPts>  (out-of-order segments)
    tombstones: new Set(), // undone stroke ids (add-wins set)
    clears: new Map(),     // clearId -> {id, layer, lamport}
    undoStack: [],         // own stroke ids, for local undo
  };
}

function tick(doc, lamport = 0) {
  doc.lamport = Math.max(doc.lamport, lamport) + 1;
  return doc.lamport;
}

export function isHidden(doc, stroke) {
  if (doc.tombstones.has(stroke.id)) return true;
  for (const c of doc.clears.values()) {
    if (c.layer === stroke.layer && c.lamport >= stroke.lamport) return true;
  }
  return false;
}

// ---- op constructors -------------------------------------------------------

export function makeBegin(doc, { id, layer, color, size }) {
  return { t: 'begin', id, site: doc.site, layer, color, size, lamport: tick(doc) };
}

export function makeSeg(doc, id, pts) {
  const s = doc.strokes.get(id);
  const from = s ? s.points.length / 2 : 0;
  return { t: 'seg', id, site: doc.site, from, pts };
}

export function makeEnd(doc, id) {
  return { t: 'end', id, site: doc.site };
}

// Local undo: only ever tombstones the caller's OWN strokes.
export function makeUndo(doc) {
  while (doc.undoStack.length) {
    const id = doc.undoStack[doc.undoStack.length - 1];
    const s = doc.strokes.get(id);
    if (!s || isHidden(doc, s)) { doc.undoStack.pop(); continue; }
    return { t: 'undo', id, site: doc.site };
  }
  return null;
}

export function makeClear(doc, layer) {
  const lamport = tick(doc);
  return { t: 'clear', id: `${doc.site}:${lamport}`, site: doc.site, layer, lamport };
}

// ---- op application --------------------------------------------------------

// applyOp is idempotent and order-tolerant. Returns render effects:
//   {e:'upsert', stroke}  {e:'seg', id, pts}  {e:'layer', layer}  {e:'end', id}
export function applyOp(doc, op) {
  switch (op.t) {
    case 'begin': {
      tick(doc, op.lamport);
      if (doc.strokes.has(op.id)) return [];
      const stroke = {
        id: op.id, site: op.site, layer: op.layer,
        color: op.color, size: op.size, lamport: op.lamport,
        points: [], done: false,
      };
      doc.strokes.set(op.id, stroke);
      if (op.site === doc.site) doc.undoStack.push(op.id);
      const effects = [{ e: 'upsert', stroke: { ...stroke, hidden: isHidden(doc, stroke) } }];
      const drained = drainPending(doc, stroke);
      if (drained.length) effects.push({ e: 'seg', id: stroke.id, pts: drained });
      return effects;
    }
    case 'seg': {
      const s = doc.strokes.get(op.id);
      if (!s) { bufferPending(doc, op.id, op.from, op.pts); return []; }
      const appended = appendSeg(doc, s, op.from, op.pts);
      return appended.length ? [{ e: 'seg', id: s.id, pts: appended }] : [];
    }
    case 'end': {
      const s = doc.strokes.get(op.id);
      if (s && !s.done) { s.done = true; return [{ e: 'end', id: s.id }]; }
      return [];
    }
    case 'undo': {
      if (doc.tombstones.has(op.id)) return [];
      doc.tombstones.add(op.id);
      const s = doc.strokes.get(op.id);
      return s ? [{ e: 'layer', layer: s.layer }] : [];
    }
    case 'clear': {
      if (doc.clears.has(op.id)) return [];
      tick(doc, op.lamport);
      doc.clears.set(op.id, { id: op.id, layer: op.layer, lamport: op.lamport });
      return [{ e: 'layer', layer: op.layer }];
    }
  }
  return [];
}

function bufferPending(doc, id, from, pts) {
  let m = doc.pending.get(id);
  if (!m) { m = new Map(); doc.pending.set(id, m); }
  if (!m.has(from)) m.set(from, pts);
}

function appendSeg(doc, s, from, pts) {
  const have = s.points.length / 2;
  if (from > have) { bufferPending(doc, s.id, from, pts); return []; }
  const skip = have - from;              // points we already have (duplicate overlap)
  const fresh = pts.slice(skip * 2);
  if (!fresh.length) return [];
  const room = MAX_POINTS_PER_STROKE * 2 - s.points.length;
  const take = room > 0 ? fresh.slice(0, room) : [];
  s.points.push(...take);
  const drained = drainPending(doc, s);
  return take.concat(drained);
}

function drainPending(doc, s) {
  const m = doc.pending.get(s.id);
  if (!m) return [];
  const out = [];
  let have = s.points.length / 2;
  while (m.has(have)) {
    const pts = m.get(have);
    m.delete(have);
    const room = MAX_POINTS_PER_STROKE * 2 - s.points.length;
    const take = room > 0 ? pts.slice(0, room) : [];
    s.points.push(...take);
    out.push(...take);
    have = s.points.length / 2;
  }
  if (!m.size) doc.pending.delete(s.id);
  return out;
}

// ---- memory control --------------------------------------------------------

// Drops hidden (undone / cleared) strokes once the doc grows past `max`.
// Safe: an undo op is always emitted after its begin op by the same site, and
// per-sender ordering holds, so no replica can see an undo for a stroke it
// does not yet have.
export function gc(doc, max = GC_MAX_STROKES) {
  if (doc.strokes.size <= max) return [];
  const hidden = [...doc.strokes.values()]
    .filter((s) => isHidden(doc, s))
    .sort((a, b) => a.lamport - b.lamport);
  const removeCount = Math.min(hidden.length, doc.strokes.size - max + 1000);
  if (removeCount <= 0) return [];
  const ids = [];
  for (let i = 0; i < removeCount; i++) {
    const s = hidden[i];
    doc.strokes.delete(s.id);
    doc.tombstones.delete(s.id);
    doc.pending.delete(s.id);
    const ui = doc.undoStack.indexOf(s.id);
    if (ui >= 0) doc.undoStack.splice(ui, 1);
    ids.push(s.id);
  }
  return [{ e: 'gc', ids }];
}

// ---- snapshot / merge (persistence + late-join sync) -----------------------

export function serialize(doc) {
  return JSON.stringify({
    site: doc.site,
    lamport: doc.lamport,
    gen: doc.gen,
    strokes: [...doc.strokes.values()],
    tombstones: [...doc.tombstones],
    clears: [...doc.clears.values()],
    undoStack: doc.undoStack.filter((id) => doc.strokes.has(id)),
  });
}

// Union-merge a snapshot into the doc. Idempotent; safe to apply many times.
export function mergeSnapshot(doc, snap) {
  doc.lamport = Math.max(doc.lamport, snap.lamport || 0);
  doc.gen = Math.max(doc.gen, snap.gen || 0);
  for (const s of snap.strokes || []) {
    if (!doc.strokes.has(s.id)) doc.strokes.set(s.id, s);
  }
  for (const id of snap.tombstones || []) doc.tombstones.add(id);
  for (const c of snap.clears || []) {
    if (!doc.clears.has(c.id)) doc.clears.set(c.id, c);
  }
  for (const id of snap.undoStack || []) {
    if (doc.strokes.has(id) && !doc.undoStack.includes(id)) doc.undoStack.push(id);
  }
}

// Full-state effects so a renderer can rebuild its mirror from scratch.
export function snapshotEffects(doc) {
  const effects = [{ e: 'reset' }];
  for (const s of doc.strokes.values()) {
    effects.push({ e: 'upsert', stroke: { ...s, hidden: isHidden(doc, s) } });
  }
  return effects;
}
