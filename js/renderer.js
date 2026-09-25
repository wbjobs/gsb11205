'use strict';
/*
 * 渲染器：每个图层一张位图缓存，完成的笔迹增量画进缓存；
 * 每帧只做「合成可见图层 + 绘制进行中笔迹」，与笔迹总数无关 -> 稳定 60fps。
 */
export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.layers = [];            // {id, name, visible, cache, cacheCtx}
    this.localLive = null;       // 本地进行中的笔迹
    this.remoteLive = new Map(); // id -> stroke（远端进行中的笔迹）
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = 0;
    this.height = 0;
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
    for (const layer of this.layers) {
      layer.cache.width = this.canvas.width;
      layer.cache.height = this.canvas.height;
    }
  }

  addLayer(id, name) {
    const cache = document.createElement('canvas');
    cache.width = this.canvas.width;
    cache.height = this.canvas.height;
    this.layers.push({ id, name, visible: true, cache, cacheCtx: cache.getContext('2d') });
  }

  removeLayer(id) {
    const i = this.layers.findIndex(l => l.id === id);
    if (i >= 0) this.layers.splice(i, 1);
  }

  hasLayer(id) { return this.layers.some(l => l.id === id); }

  setVisible(id, visible) {
    const layer = this.layers.find(l => l.id === id);
    if (layer) layer.visible = visible;
  }

  drawStroke(ctx, s) {
    const pts = s.points;
    if (!pts || pts.length < 2) return;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalCompositeOperation = s.tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.size;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(pts[0], pts[1]);
    if (pts.length === 2) {
      ctx.lineTo(pts[0] + 0.01, pts[1] + 0.01);
    } else {
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
    }
    ctx.stroke();
    ctx.restore();
  }

  commit(stroke) {
    this.remoteLive.delete(stroke.id);
    const layer = this.layers.find(l => l.id === stroke.layer);
    if (layer) this.drawStroke(layer.cacheCtx, stroke);
  }

  rebuild(layersData) {
    for (const [id, strokes] of Object.entries(layersData)) {
      const layer = this.layers.find(l => l.id === id);
      if (!layer) continue;
      layer.cacheCtx.save();
      layer.cacheCtx.setTransform(1, 0, 0, 1, 0, 0);
      layer.cacheCtx.clearRect(0, 0, layer.cache.width, layer.cache.height);
      layer.cacheCtx.restore();
      for (const s of strokes) this.drawStroke(layer.cacheCtx, s);
    }
  }

  frame() {
    const { ctx, canvas } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const layer of this.layers) {
      if (layer.visible) ctx.drawImage(layer.cache, 0, 0);
    }
    for (const s of this.remoteLive.values()) this.drawStroke(ctx, s);
    if (this.localLive) this.drawStroke(ctx, this.localLive);
  }
}
