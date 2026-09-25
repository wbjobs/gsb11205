'use strict';
/* 导出：白底合成所有可见图层 -> PNG 下载 */
export function exportPNG(renderer) {
  const out = document.createElement('canvas');
  out.width = renderer.canvas.width;
  out.height = renderer.canvas.height;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  for (const layer of renderer.layers) {
    if (layer.visible) ctx.drawImage(layer.cache, 0, 0);
  }
  out.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `whiteboard-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, 'image/png');
}
