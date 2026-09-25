// Main thread: pointer capture, layered canvas rendering, UI.
// Rendering strategy for 60fps with 10k+ strokes:
//   - incremental segment draws go straight onto per-layer canvases
//   - undo/clear/resize trigger chunked re-renders into a fresh canvas
//     (<=8ms per frame), swapped in when complete
//   - compositing only happens when something is dirty

const LAYER_COUNT = 3;
const COLORS = ['#1e1e1e', '#e03131', '#1971c2', '#2f9e44', '#f08c00', '#9c36b5'];
const SIZES = [2, 4, 8];
const MIN_POINT_DIST = 1.0;   // css px; point simplification for memory
const FRAME_BUDGET_MS = 8;    // chunked re-render budget per frame
const BULK_EFFECTS = 64;      // above this, rebuild layers instead of incremental draws

const dpr = Math.min(window.devicePixelRatio || 1, 2);
const tabId = Math.random().toString(16).slice(2, 10);
document.title = `白板 ${tabId.slice(0, 4)}`;

let strokeSeq = 0;
let activeLayer = 0;
let activeColor = COLORS[0];
let activeSize = SIZES[1];

// ---- canvases --------------------------------------------------------------

const display = document.getElementById('board');
const dctx = display.getContext('2d');
const layers = [];            // {canvas, ctx} per layer
const layerVisible = [true, true, true];
let W = 0, H = 0;

for (let i = 0; i < LAYER_COUNT; i++) layers.push(makeLayerCanvas());

function makeLayerCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, W * dpr);
  canvas.height = Math.max(1, H * dpr);
  return { canvas, ctx: canvas.getContext('2d') };
}

// ---- stroke mirror (render-side copy of the doc) ---------------------------

const mirror = new Map();     // id -> {id, layer, color, size, points, drawn, hidden, done}
let compositeDirty = true;
const renderJobs = [];        // {layer, canvas, ctx, ids, idx, extra:Set}

// ---- worker ----------------------------------------------------------------

const worker = new Worker('js/worker.js', { type: 'module' });
worker.postMessage({ t: 'init', site: tabId });
worker.onmessage = (e) => {
  const m = e.data;
  if (m.t === 'ready') {
    applyEffects(m.effects);
    setStatus('已同步');
  } else if (m.t === 'effects') {
    applyEffects(m.effects);
  }
};

function applyEffects(effects) {
  const bulk = effects.length > BULK_EFFECTS;
  const bulkLayers = new Set();
  for (const fx of effects) {
    switch (fx.e) {
      case 'reset':
        mirror.clear();
        for (let l = 0; l < LAYER_COUNT; l++) queueLayerRender(l);
        break;
      case 'upsert': {
        const st = fx.stroke;
        const existing = mirror.get(st.id);
        if (existing) {
          if (existing.hidden !== st.hidden) {
            existing.hidden = st.hidden;
            queueLayerRender(st.layer);
          }
        } else {
          const s = { ...st, drawn: 0 };
          mirror.set(st.id, s);
          if (bulk) bulkLayers.add(st.layer);
          else if (!s.hidden && s.points.length) drawStrokeNew(s);
        }
        break;
      }
      case 'seg': {
        const s = mirror.get(fx.id);
        if (!s) break;
        // locally drawn strokes are already mirrored from pointer input
        if (s.local) break;
        s.points.push(...fx.pts);
        if (bulk) bulkLayers.add(s.layer);
        else if (!s.hidden) drawStrokeNew(s);
        break;
      }
      case 'layer':
        queueLayerRender(fx.layer);
        break;
      case 'gc':
        for (const id of fx.ids) mirror.delete(id);
        break;
    }
  }
  if (bulk) for (const l of bulkLayers) queueLayerRender(l);
}

// ---- drawing ---------------------------------------------------------------

function strokeToCtx(ctx, s, fromIdx) {
  const p = s.points;
  const n = p.length / 2;
  if (n === 0) return;
  ctx.strokeStyle = ctx.fillStyle = s.color;
  ctx.lineWidth = s.size * dpr;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (n === 1) {
    ctx.beginPath();
    ctx.arc(p[0] * dpr, p[1] * dpr, (s.size * dpr) / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const start = Math.max(0, fromIdx - 1);
  ctx.beginPath();
  ctx.moveTo(p[start * 2] * dpr, p[start * 2 + 1] * dpr);
  for (let i = start + 1; i < n; i++) ctx.lineTo(p[i * 2] * dpr, p[i * 2 + 1] * dpr);
  ctx.stroke();
}

function drawStrokeNew(s) {
  const total = s.points.length / 2;
  if (s.drawn >= total) return;
  const job = renderJobs.find((j) => j.layer === s.layer);
  if (job) job.extra.add(s.id);
  strokeToCtx(layers[s.layer].ctx, s, s.drawn);
  s.drawn = total;
  compositeDirty = true;
}

function queueLayerRender(layer) {
  if (renderJobs.some((j) => j.layer === layer)) return;
  const fresh = makeLayerCanvas();
  const ids = [];
  for (const s of mirror.values()) {
    if (s.layer === layer && !s.hidden) ids.push(s.id);
  }
  renderJobs.push({ layer, canvas: fresh.canvas, ctx: fresh.ctx, ids, idx: 0, extra: new Set() });
}

function processRenderJobs() {
  if (!renderJobs.length) return;
  const deadline = performance.now() + FRAME_BUDGET_MS;
  while (renderJobs.length) {
    const job = renderJobs[0];
    while (job.idx < job.ids.length && performance.now() < deadline) {
      const s = mirror.get(job.ids[job.idx++]);
      if (s && !s.hidden) strokeToCtx(job.ctx, s, 0);
    }
    if (job.idx < job.ids.length) break; // out of budget, continue next frame
    renderJobs.shift();
    layers[job.layer] = { canvas: job.canvas, ctx: job.ctx };
    // sync drawn counts with what the fresh canvas actually contains
    for (const s of mirror.values()) {
      if (s.layer === job.layer) s.drawn = s.points.length / 2;
    }
    // strokes that changed mid-job: redraw fully onto the swapped-in canvas
    for (const id of job.extra) {
      const s = mirror.get(id);
      if (s && !s.hidden) { s.drawn = 0; drawStrokeNew(s); }
    }
    compositeDirty = true;
    if (performance.now() >= deadline) break;
  }
}

function composite() {
  dctx.fillStyle = '#ffffff';
  dctx.fillRect(0, 0, display.width, display.height);
  for (let l = 0; l < LAYER_COUNT; l++) {
    if (layerVisible[l]) dctx.drawImage(layers[l].canvas, 0, 0);
  }
  compositeDirty = false;
}

// ---- pointer input -----------------------------------------------------------

let drawing = null; // {id, lastX, lastY, pending:[]}

function evPos(e) {
  const r = display.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

display.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || drawing) return;
  display.setPointerCapture(e.pointerId);
  const [x, y] = evPos(e);
  const id = `${tabId}:${strokeSeq++}`;
  const s = {
    id, site: tabId, layer: activeLayer, color: activeColor, size: activeSize,
    points: [x, y], drawn: 0, hidden: false, done: false, local: true,
  };
  mirror.set(id, s);
  drawStrokeNew(s);
  drawing = { id, lastX: x, lastY: y, pending: [] };
  worker.postMessage({ t: 'begin', id, layer: activeLayer, color: activeColor, size: activeSize });
});

display.addEventListener('pointermove', (e) => {
  if (!drawing) return;
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  const s = mirror.get(drawing.id);
  for (const ev of events) {
    const [x, y] = evPos(ev);
    const dx = x - drawing.lastX;
    const dy = y - drawing.lastY;
    if (dx * dx + dy * dy < MIN_POINT_DIST * MIN_POINT_DIST) continue;
    drawing.lastX = x;
    drawing.lastY = y;
    s.points.push(x, y);
    drawing.pending.push(x, y);
  }
  if (s.points.length / 2 > s.drawn) drawStrokeNew(s);
});

function endStroke() {
  if (!drawing) return;
  flushPendingSeg();
  worker.postMessage({ t: 'end', id: drawing.id });
  const s = mirror.get(drawing.id);
  if (s) s.done = true;
  drawing = null;
}
display.addEventListener('pointerup', endStroke);
display.addEventListener('pointercancel', endStroke);

function flushPendingSeg() {
  if (drawing && drawing.pending.length) {
    worker.postMessage({ t: 'seg', id: drawing.id, pts: drawing.pending.splice(0) });
  }
}

// ---- main loop ---------------------------------------------------------------

let frames = 0;
let lastFpsT = performance.now();
let fps = 0;

function loop(t) {
  requestAnimationFrame(loop);
  flushPendingSeg();
  processRenderJobs();
  if (compositeDirty) composite();
  frames++;
  if (t - lastFpsT >= 500) {
    fps = Math.round((frames * 1000) / (t - lastFpsT));
    frames = 0;
    lastFpsT = t;
    updateStatus();
  }
}

// ---- resize --------------------------------------------------------------------

function resize() {
  W = display.clientWidth;
  H = display.clientHeight;
  display.width = Math.max(1, W * dpr);
  display.height = Math.max(1, H * dpr);
  for (let l = 0; l < LAYER_COUNT; l++) {
    layers[l] = makeLayerCanvas();
    queueLayerRender(l);
  }
  compositeDirty = true;
}
window.addEventListener('resize', resize);

// ---- UI ------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);

function buildToolbar() {
  const colorsEl = $('#colors');
  COLORS.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'swatch' + (i === 0 ? ' active' : '');
    b.style.background = c;
    b.title = c;
    b.onclick = () => {
      activeColor = c;
      colorsEl.querySelectorAll('.swatch').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
    };
    colorsEl.appendChild(b);
  });

  const sizesEl = $('#sizes');
  SIZES.forEach((sz, i) => {
    const b = document.createElement('button');
    b.textContent = ['细', '中', '粗'][i];
    b.className = i === 1 ? 'active' : '';
    b.onclick = () => {
      activeSize = sz;
      sizesEl.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
    };
    sizesEl.appendChild(b);
  });

  const layersEl = $('#layers');
  for (let l = 0; l < LAYER_COUNT; l++) {
    const b = document.createElement('button');
    b.textContent = `L${l + 1}`;
    b.className = l === 0 ? 'active' : '';
    b.onclick = () => {
      activeLayer = l;
      layersEl.querySelectorAll('.layer-btn').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
    };
    b.classList.add('layer-btn');
    const eye = document.createElement('button');
    eye.textContent = '👁';
    eye.className = 'eye';
    eye.title = '显示/隐藏图层（仅本地）';
    eye.onclick = () => {
      layerVisible[l] = !layerVisible[l];
      eye.classList.toggle('off', !layerVisible[l]);
      compositeDirty = true;
    };
    layersEl.appendChild(b);
    layersEl.appendChild(eye);
  }

  $('#undo').onclick = () => worker.postMessage({ t: 'undo' });
  $('#clear').onclick = () => {
    if (confirm(`清空图层 L${activeLayer + 1}？（对所有标签页生效）`)) {
      worker.postMessage({ t: 'clear', layer: activeLayer });
    }
  };
  $('#export').onclick = exportPng;
  $('#stress').onclick = runStress;
}

function exportPng() {
  const scale = 2; // export at 2x for crispness
  const out = document.createElement('canvas');
  out.width = Math.max(1, W * scale);
  out.height = Math.max(1, H * scale);
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  for (let l = 0; l < LAYER_COUNT; l++) {
    if (layerVisible[l]) ctx.drawImage(layers[l].canvas, 0, 0, out.width, out.height);
  }
  out.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `whiteboard-${Date.now()}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, 'image/png');
}

async function runStress() {
  const total = 10000;
  setStatus('压力测试进行中…');
  const batch = [];
  for (let i = 0; i < total; i++) {
    const pts = [];
    let x = Math.random() * W;
    let y = Math.random() * H;
    const steps = 10 + ((Math.random() * 30) | 0);
    for (let k = 0; k < steps; k++) {
      x += (Math.random() - 0.5) * 40;
      y += (Math.random() - 0.5) * 40;
      pts.push(x, y);
    }
    batch.push({
      layer: i % LAYER_COUNT,
      color: COLORS[i % COLORS.length],
      size: SIZES[i % SIZES.length],
      points: pts,
    });
    if (batch.length === 200) {
      worker.postMessage({ t: 'stress', strokes: batch.splice(0) });
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  if (batch.length) worker.postMessage({ t: 'stress', strokes: batch });
  setStatus('已同步');
}

let statusText = '同步中…';
function setStatus(t) { statusText = t; updateStatus(); }
function updateStatus() {
  $('#status').textContent =
    `标签 ${tabId.slice(0, 4)} · ${statusText} · 笔迹 ${mirror.size} · ${fps} fps · 图层 L${activeLayer + 1}`;
}

// ---- persistence hooks ---------------------------------------------------------

window.addEventListener('pagehide', () => worker.postMessage({ t: 'flush' }));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') worker.postMessage({ t: 'flush' });
});

// ---- boot ------------------------------------------------------------------------

buildToolbar();
resize();
requestAnimationFrame(loop);
