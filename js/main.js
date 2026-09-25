'use strict';
import { Renderer } from './renderer.js';
import { Sync } from './sync.js';
import { saveSnapshot, loadSnapshot } from './store.js';
import { exportPNG } from './exporter.js';

const CHUNK_MS = 40;        // 进行中笔迹的增量同步间隔（<< 200ms）
const MIN_POINT_DIST = 1.5; // 点抽稀阈值（内存控制）

const canvas = document.getElementById('board');
const wrap = document.getElementById('canvas-wrap');
const renderer = new Renderer(canvas);
const worker = new Worker('worker/crdt-worker.js');

const state = {
  tool: 'pen',
  color: '#1a1a2e',
  size: 4,
  layers: [],
  activeLayer: null,
  layerSeq: 0,
  drawing: false,
  pendingPoints: [],
  livePoints: [],
  chunkTimer: null,
  latencyEma: 0,
};

/* ---------- 图层 ---------- */

function addLayer(name) {
  const id = `L${++state.layerSeq}`;
  const layer = { id, name: name || `图层 ${state.layerSeq}` };
  state.layers.push(layer);
  renderer.addLayer(id, layer.name);
  state.activeLayer = id;
  renderLayerPanel();
  return layer;
}

function removeLayer(id) {
  if (state.layers.length <= 1) return;
  state.layers = state.layers.filter(l => l.id !== id);
  renderer.removeLayer(id);
  if (state.activeLayer === id) state.activeLayer = state.layers[state.layers.length - 1].id;
  renderLayerPanel();
}

function renderLayerPanel() {
  const list = document.getElementById('layer-list');
  list.innerHTML = '';
  for (const layer of [...state.layers].reverse()) {
    const row = document.createElement('div');
    row.className = 'layer-row' + (layer.id === state.activeLayer ? ' active' : '');

    const vis = document.createElement('input');
    vis.type = 'checkbox';
    vis.checked = renderer.layers.find(l => l.id === layer.id)?.visible !== false;
    vis.title = '显示/隐藏';
    vis.onchange = () => renderer.setVisible(layer.id, vis.checked);

    const label = document.createElement('span');
    label.textContent = layer.name;
    label.className = 'layer-name';
    label.onclick = () => { state.activeLayer = layer.id; renderLayerPanel(); };

    const del = document.createElement('button');
    del.textContent = '×';
    del.title = '删除图层';
    del.onclick = () => removeLayer(layer.id);

    row.append(vis, label, del);
    list.appendChild(row);
  }
}

/* ---------- 同步 ---------- */

const snapshotTargets = new Set();

const sync = new Sync({
  onOps(ops, sentAt) {
    if (sentAt) {
      const latency = Date.now() - sentAt;
      state.latencyEma = state.latencyEma ? state.latencyEma * 0.8 + latency * 0.2 : latency;
    }
    worker.postMessage({ type: 'remote-ops', ops });
  },
  onHello(from) {
    snapshotTargets.add(from);
    worker.postMessage({ type: 'snapshot-request' });
  },
  onSnapshot(data) {
    worker.postMessage({ type: 'merge-snapshot', data });
  },
});

worker.onmessage = (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'ready':
      renderer.rebuild(msg.layers);
      sync.hello();
      break;
    case 'ops':
      sync.sendOps(msg.ops);
      break;
    case 'commit':
      renderer.commit(msg.stroke);
      break;
    case 'live':
      renderer.remoteLive.set(msg.stroke.id, msg.stroke);
      break;
    case 'rebuild':
      renderer.rebuild(msg.layers);
      break;
    case 'snapshot':
      saveSnapshot(msg.data);
      if (snapshotTargets.size) {
        for (const to of snapshotTargets) sync.sendSnapshot(to, msg.data);
        snapshotTargets.clear();
      }
      break;
    case 'stats':
      document.getElementById('stat-strokes').textContent = `笔迹 ${msg.visible}/${msg.strokes}`;
      document.getElementById('stat-mem').textContent = `内存 ~${(msg.bytes / 1048576).toFixed(1)}MB`;
      break;
  }
};

/* ---------- 输入 ---------- */

function canvasPoint(e) {
  const rect = canvas.getBoundingClientRect();
  return [e.clientX - rect.left, e.clientY - rect.top];
}

function pushPoint(x, y) {
  const buf = state.pendingPoints;
  const n = buf.length;
  if (n >= 2) {
    const dx = x - buf[n - 2], dy = y - buf[n - 1];
    if (dx * dx + dy * dy < MIN_POINT_DIST * MIN_POINT_DIST) return;
  }
  buf.push(x, y);
  state.livePoints.push(x, y);
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  canvas.setPointerCapture(e.pointerId);
  const [x, y] = canvasPoint(e);
  state.drawing = true;
  state.pendingPoints = [x, y];
  state.livePoints = [x, y];
  renderer.localLive = {
    id: 'local', layer: state.activeLayer, color: state.color,
    size: state.size, tool: state.tool, points: state.livePoints,
  };
  worker.postMessage({
    type: 'local-chunk',
    meta: { layer: state.activeLayer, color: state.color, size: state.size, tool: state.tool },
    points: [x, y],
    done: false,
  });
  state.chunkTimer = setInterval(() => {
    if (state.pendingPoints.length) {
      worker.postMessage({ type: 'local-chunk', points: state.pendingPoints.splice(0), done: false });
    }
  }, CHUNK_MS);
});

canvas.addEventListener('pointermove', (e) => {
  if (!state.drawing) return;
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of events) {
    const [x, y] = canvasPoint(ev);
    pushPoint(x, y);
  }
});

function endStroke(e) {
  if (!state.drawing) return;
  state.drawing = false;
  clearInterval(state.chunkTimer);
  if (e) {
    const [x, y] = canvasPoint(e);
    pushPoint(x, y);
  }
  worker.postMessage({ type: 'local-chunk', points: state.pendingPoints.splice(0), done: true });
  renderer.localLive = null;
  state.livePoints = [];
}

canvas.addEventListener('pointerup', endStroke);
canvas.addEventListener('pointercancel', () => endStroke(null));

/* ---------- 渲染循环 + FPS ---------- */

let frames = 0;
let fpsLast = performance.now();
function loop(now) {
  renderer.frame();
  frames++;
  if (now - fpsLast >= 1000) {
    document.getElementById('stat-fps').textContent = `FPS ${frames}`;
    document.getElementById('stat-latency').textContent =
      `同步延迟 ${state.latencyEma.toFixed(0)}ms`;
    frames = 0;
    fpsLast = now;
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

new ResizeObserver(() => {
  renderer.resize(wrap.clientWidth, wrap.clientHeight);
  worker.postMessage({ type: 'rebuild-all' });
}).observe(wrap);

/* ---------- UI 绑定 ---------- */

document.querySelectorAll('#color-picker button').forEach(btn => {
  btn.onclick = () => {
    state.color = btn.dataset.color;
    state.tool = 'pen';
    document.querySelectorAll('#color-picker button').forEach(b => b.classList.toggle('active', b === btn));
    document.getElementById('btn-eraser').classList.remove('active');
  };
});

document.getElementById('brush-size').oninput = (e) => { state.size = Number(e.target.value); };

document.getElementById('btn-eraser').onclick = (e) => {
  state.tool = state.tool === 'eraser' ? 'pen' : 'eraser';
  e.currentTarget.classList.toggle('active', state.tool === 'eraser');
};

document.getElementById('btn-undo').onclick = () => worker.postMessage({ type: 'undo' });
document.getElementById('btn-redo').onclick = () => worker.postMessage({ type: 'redo' });
document.getElementById('btn-export').onclick = () => exportPNG(renderer);
document.getElementById('btn-add-layer').onclick = () => addLayer();

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    worker.postMessage({ type: e.shiftKey ? 'redo' : 'undo' });
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    worker.postMessage({ type: 'redo' });
  }
});

/* ---------- 压力测试：10000 笔迹 ---------- */

document.getElementById('btn-stress').onclick = async () => {
  const total = 10000, batch = 250;
  const colors = ['#1a1a2e', '#e94560', '#0f9b8e', '#f5a623', '#4a6fa5'];
  const w = wrap.clientWidth, h = wrap.clientHeight;
  for (let i = 0; i < total; i += batch) {
    for (let j = 0; j < batch && i + j < total; j++) {
      const pts = [];
      let x = Math.random() * w, y = Math.random() * h;
      const n = 10 + (Math.random() * 40 | 0);
      for (let k = 0; k < n; k++) {
        x += (Math.random() - 0.5) * 30;
        y += (Math.random() - 0.5) * 30;
        pts.push(x, y);
      }
      worker.postMessage({
        type: 'local-chunk',
        meta: {
          layer: state.activeLayer,
          color: colors[(Math.random() * colors.length) | 0],
          size: 2 + Math.random() * 4,
          tool: 'pen',
        },
        points: pts,
        done: true,
      });
    }
    await new Promise(r => requestAnimationFrame(r));
  }
};

/* ---------- 启动 & 关闭持久化 ---------- */

addLayer('图层 1');
addLayer('图层 2');
addLayer('图层 3');
renderer.resize(wrap.clientWidth, wrap.clientHeight);

(async () => {
  const snapshot = await loadSnapshot();
  worker.postMessage({ type: 'init', snapshot });
})();

window.addEventListener('pagehide', () => {
  worker.postMessage({ type: 'snapshot-request' });
  sync.close();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') worker.postMessage({ type: 'snapshot-request' });
});
