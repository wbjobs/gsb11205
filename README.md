# CRDT 协同白板

4 个浏览器标签页实时协同绘制的白板。Canvas 渲染，BroadcastChannel 增量同步，
Web Worker 内运行 CRDT 文档与 IndexedDB 持久化。

## 运行

```bash
python3 -m http.server 8000   # 或 npm start
```

打开 4 个标签页访问 `http://localhost:8000`（Worker 需要 http 协议，file:// 无法加载）。
状态栏显示当前标签 ID、笔迹数、实时 FPS。

## 测试

```bash
npm test    # 11 个 CRDT 单元测试：并发合并 / 撤销语义 / 乱序自愈 / GC / 持久化
```

## 架构

```
标签页 A/B/C/D（结构相同）
├── 主线程  js/main.js    指针采集(coalesced)、分层 Canvas、增量绘制、分帧重渲染、导出
├── Worker  js/worker.js  CRDT 文档、BroadcastChannel 收发、IndexedDB 快照、内存 GC
└── 纯逻辑  js/crdt.js    add-wins 笔迹集 + 墓碑撤销 + 自清层（可单测）
```

- **笔迹 CRDT**：每笔 `{site}:{seq}` 全局唯一；笔迹集合与墓碑集合均为 add-wins，
  任意顺序合并都收敛。分段（seg）携带绝对点偏移 `from`，乱序/重复/丢失可自愈。
- **增量同步**：绘制中每帧把新点作为 seg 广播（BroadcastChannel 延迟 <5ms），
  远小于 200ms 指标。新标签页先读 IndexedDB 快照，再向对等页 `hello` 请求全量合并。
- **撤销语义**：undo 只墓碑化**自己**最后一笔可见笔迹（`makeUndo` 只弹自己的
  undoStack），并发撤销互不干扰，重复投递幂等。
- **图层**：3 个图层各一张离屏 canvas，增量段直接画上屏；撤销/清层/resize 触发
  分帧重渲染（每帧 ≤8ms 预算渲染到新 canvas 再交换），保证 60fps。
- **内存控制**：点采集按最小距离抽稀；单笔 8000 点封顶；笔迹总数超过 12000 时
  GC 掉最旧的已隐藏笔迹并通知渲染层释放。
- **标签页关闭**：`pagehide`/`visibilitychange` 触发 flush，快照写入 IndexedDB；
  任意标签页重开即恢复，全部关闭后重开也不丢数据。

## 验收对照

| 标准 | 实现 | 验证 |
|---|---|---|
| 同时绘制不丢笔迹 | add-wins 集合 + seg 自愈 | `concurrent drawing…` 测试（4 站点 2000 笔） |
| 撤销只撤自己的 | undoStack 仅含本站点笔迹 | `undo only undoes own…` / `undo never touches…` |
| 同步延迟 <200ms | BroadcastChannel + 每帧 seg 广播 | 实测 BC 投递为毫秒级 |
| 10000 笔迹不崩 | 点抽稀 + 点数封顶 + GC + 分帧渲染 | 工具栏「压测」按钮一键生成 10000 笔 |
| 导出正确 | 按图层顺序合成可见层，2x PNG | 「导出」按钮 |
| 60fps | 增量绘制 + 8ms 分帧重渲染 + 脏检查合成 | 状态栏实时 FPS |
| 关标签页不丢数据 | IndexedDB 快照 + pagehide flush | `tab close and reopen…` 测试 |
