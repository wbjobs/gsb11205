import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDoc, applyOp, makeBegin, makeSeg, makeEnd, makeUndo, makeClear,
  isHidden, gc, serialize, mergeSnapshot, snapshotEffects,
  GC_MAX_STROKES, MAX_POINTS_PER_STROKE,
} from '../js/crdt.js';

function drawStroke(doc, id, nPts = 5) {
  const ops = [];
  const pts = [];
  for (let i = 0; i < nPts; i++) pts.push(i, i);
  ops.push(makeBegin(doc, { id, layer: 0, color: '#000', size: 2 }));
  ops.push(makeSeg(doc, id, pts));
  ops.push(makeEnd(doc, id));
  for (const op of ops) applyOp(doc, op);
  return ops;
}

function visibleIds(doc) {
  return [...doc.strokes.values()].filter((s) => !isHidden(doc, s)).map((s) => s.id).sort();
}

test('concurrent drawing from 4 tabs loses no strokes', () => {
  const sites = ['a', 'b', 'c', 'd'];
  const docs = Object.fromEntries(sites.map((s) => [s, createDoc(s)]));
  const allOps = [];
  // each site draws 500 strokes; ops interleaved across replicas
  for (const s of sites) {
    for (let i = 0; i < 500; i++) allOps.push(...drawStroke(docs[s], `${s}:${i}`, 4));
  }
  // shuffle delivery order deterministically
  const shuffled = [...allOps].sort((x, y) => ((x.id || '').charCodeAt(0) * 31 + (x.from || 0)) - ((y.id || '').charCodeAt(0) * 31 + (y.from || 0)));
  const replica = createDoc('replica');
  for (const op of shuffled) if (op.site !== 'replica') applyOp(replica, op);
  assert.equal(replica.strokes.size, 2000);
  assert.equal(visibleIds(replica).length, 2000);
  for (const s of sites) assert.equal(docs[s].strokes.size, 500);
});

test('undo only undoes own strokes, concurrent undos converge', () => {
  const a = createDoc('a');
  const b = createDoc('b');
  const opsA = drawStroke(a, 'a:0');
  const opsA2 = drawStroke(a, 'a:1');
  const opsB = drawStroke(b, 'b:0');
  // exchange
  for (const op of [...opsA, ...opsA2]) applyOp(b, op);
  for (const op of opsB) applyOp(a, op);
  // both undo simultaneously
  const undoA = makeUndo(a); // should target a:1 (own last)
  const undoB = makeUndo(b); // should target b:0
  assert.equal(undoA.id, 'a:1');
  assert.equal(undoB.id, 'b:0');
  // apply in opposite orders on the two replicas
  applyOp(a, undoA); applyOp(a, undoB);
  applyOp(b, undoB); applyOp(b, undoA);
  assert.deepEqual(visibleIds(a), ['a:0']);
  assert.deepEqual(visibleIds(b), ['a:0']);
  // duplicate undo delivery is idempotent
  applyOp(a, undoA);
  assert.deepEqual(visibleIds(a), ['a:0']);
});

test('undo never touches the other tab\'s strokes', () => {
  const a = createDoc('a');
  const b = createDoc('b');
  const opsB = drawStroke(b, 'b:0');
  for (const op of opsB) applyOp(a, op);
  // 'a' has drawn nothing itself: undo must be a no-op
  assert.equal(makeUndo(a), null);
  assert.deepEqual(visibleIds(a), ['b:0']);
});

test('out-of-order and duplicate segments self-heal', () => {
  const doc = createDoc('x');
  applyOp(doc, makeBegin(doc, { id: 'x:0', layer: 0, color: '#000', size: 2 }));
  // seg with from=2 arrives before from=0
  applyOp(doc, { t: 'seg', id: 'x:0', site: 'x', from: 2, pts: [2, 2, 3, 3] });
  assert.equal(doc.strokes.get('x:0').points.length, 0); // buffered
  const fx = applyOp(doc, { t: 'seg', id: 'x:0', site: 'x', from: 0, pts: [0, 0, 1, 1] });
  assert.deepEqual(doc.strokes.get('x:0').points, [0, 0, 1, 1, 2, 2, 3, 3]);
  // duplicate delivery ignored
  applyOp(doc, { t: 'seg', id: 'x:0', site: 'x', from: 0, pts: [0, 0, 1, 1] });
  applyOp(doc, { t: 'seg', id: 'x:0', site: 'x', from: 2, pts: [2, 2, 3, 3] });
  assert.deepEqual(doc.strokes.get('x:0').points, [0, 0, 1, 1, 2, 2, 3, 3]);
  assert.ok(fx.some((e) => e.e === 'seg'));
});

test('seg before begin is buffered and drained on begin', () => {
  const doc = createDoc('x');
  applyOp(doc, { t: 'seg', id: 'x:9', site: 'y', from: 0, pts: [1, 1] });
  const fx = applyOp(doc, { t: 'begin', id: 'x:9', site: 'y', layer: 0, color: '#000', size: 2, lamport: 5 });
  assert.deepEqual(doc.strokes.get('x:9').points, [1, 1]);
  assert.ok(fx.some((e) => e.e === 'seg'));
});

test('clear hides existing strokes on that layer only, not future ones', () => {
  const doc = createDoc('a');
  drawStroke(doc, 'a:0');            // layer 0
  const s1 = makeBegin(doc, { id: 'a:1', layer: 1, color: '#000', size: 2 });
  applyOp(doc, s1);                // layer 1
  const clear = makeClear(doc, 0);
  applyOp(doc, clear);
  assert.deepEqual(visibleIds(doc), ['a:1']);
  // stroke begun after the clear stays visible
  drawStroke(doc, 'a:2');
  assert.deepEqual(visibleIds(doc), ['a:1', 'a:2']);
  // clear is idempotent
  applyOp(doc, clear);
  assert.deepEqual(visibleIds(doc), ['a:1', 'a:2']);
});

test('undo arriving before begin still hides the stroke', () => {
  const doc = createDoc('r');
  applyOp(doc, { t: 'undo', id: 'y:0', site: 'y' });
  const fx = applyOp(doc, { t: 'begin', id: 'y:0', site: 'y', layer: 0, color: '#000', size: 2, lamport: 3 });
  const up = fx.find((e) => e.e === 'upsert');
  assert.equal(up.stroke.hidden, true);
  assert.equal(visibleIds(doc).length, 0);
});

test('gc bounds memory by dropping hidden strokes', () => {
  const doc = createDoc('a');
  for (let i = 0; i < GC_MAX_STROKES + 500; i++) drawStroke(doc, `a:${i}`, 2);
  // undo half of them
  let undone = 0;
  for (let i = 0; i < GC_MAX_STROKES + 500 && undone < 2000; i += 3) {
    applyOp(doc, { t: 'undo', id: `a:${i}`, site: 'a' });
    undone++;
  }
  const fx = gc(doc);
  assert.ok(fx.length === 1);
  assert.ok(doc.strokes.size <= GC_MAX_STROKES);
  // visible strokes are never collected
  const visible = visibleIds(doc).length;
  assert.ok(visible > GC_MAX_STROKES - 2500);
});

test('points per stroke are capped', () => {
  const doc = createDoc('a');
  applyOp(doc, makeBegin(doc, { id: 'a:0', layer: 0, color: '#000', size: 2 }));
  const big = [];
  for (let i = 0; i < MAX_POINTS_PER_STROKE + 1000; i++) big.push(i, i);
  applyOp(doc, { t: 'seg', id: 'a:0', site: 'a', from: 0, pts: big });
  assert.equal(doc.strokes.get('a:0').points.length, MAX_POINTS_PER_STROKE * 2);
});

test('serialize/merge roundtrip converges and is idempotent', () => {
  const a = createDoc('a');
  const b = createDoc('b');
  for (let i = 0; i < 100; i++) {
    const ops = drawStroke(a, `a:${i}`, 3);
    for (const op of ops) applyOp(b, op);
  }
  applyOp(a, makeUndo(a)); // a undoes own last
  // b learns of the undo only via a's snapshot
  mergeSnapshot(b, JSON.parse(serialize(a)));
  assert.deepEqual(visibleIds(b), visibleIds(a));
  // merging twice changes nothing
  mergeSnapshot(b, JSON.parse(serialize(a)));
  assert.deepEqual(visibleIds(b), visibleIds(a));
  // late joiner: fresh replica from snapshot renders full state
  const c = createDoc('c');
  mergeSnapshot(c, JSON.parse(serialize(a)));
  const fx = snapshotEffects(c);
  assert.equal(fx[0].e, 'reset');
  assert.equal(fx.length - 1, a.strokes.size);
});

test('tab close and reopen restores all strokes (persistence path)', () => {
  const tab1 = createDoc('tab1');
  for (let i = 0; i < 50; i++) drawStroke(tab1, `tab1:${i}`, 3);
  const saved = serialize(tab1);           // what the worker writes to IndexedDB
  const tab2 = createDoc('tab2');          // "reopened" tab
  mergeSnapshot(tab2, JSON.parse(saved));
  assert.equal(tab2.strokes.size, 50);
  assert.deepEqual(visibleIds(tab2), visibleIds(tab1));
});
