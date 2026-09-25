# CRDT 协同白板

Canvas + BroadcastChannel + CRDT + Web Worker 实现的多标签页协同白板。

## 运行

```bash
cd A
python3 -m http.server 8000
# 打开 4 个标签页：http://localhost:8000
```

（Worker 与 ES Module 要求 http(s) 协议，不能用 file:// 直接打开。）

## 架构

```
标签页 A/B/C/D（各自独立）
├── js/main.js        输入采集（coalesced pointer events + 点抽稀）、UI、压测
├── js/renderer.js    每图层一张位图缓存，帧循环只做合成 -> 与笔迹数无关的 60fps
├── js/sync.js        BroadcastChannel：增量 ops 广播 + hello/snapshot 全量对齐
├── js/store.js       IndexedDB 快照持久化（防抖 2s + pagehide/visibilitychange）
├── js/exporter.js    白底合成可见图层 -> PNG 下载
└── worker/crdt-worker.js  CRDT 文档（唯一事实源）
```

**CRDT 设计**
- 笔迹 id = `${actor}:${seq}`，全局唯一，天然去重、合并幂等。
- 可见性 = LWW-Register（lamport 时间戳）：undo/redo 只是写可见性位，并发撤销可安全合并。
- 增量同步 = `chunk` op（流式点集，40ms 一批）+ `vis` op（可见性翻转），30ms 批量广播。
- 新标签页：`hello` → 现有标签页回快照 → CRDT 合并（幂等，多份快照重复应用安全）。

**撤销语义**：每个标签页只持有自己 actor 的 undo 栈，undo 只对自己的笔迹发 `vis:false`，永远撤不掉别人的笔迹；刷新后 undo 栈从快照重建。

**内存控制**
- 输入侧点抽稀（1.5px 阈值）+ Float32Array 传输。
- 笔迹数 > 12000 时回收已删除笔迹的点数据（保留墓碑）；> 16000 时回收最旧墓碑。
- undo 栈上限 200。

**性能**：完成的笔迹增量画进图层位图缓存；每帧仅合成 3~6 张位图 + 进行中笔迹，渲染耗时与笔迹总数无关。撤销/重做触发对应图层按 (ts, id) 确定性重放重建。

## 验收对照

| 标准 | 实现 | 验证 |
|---|---|---|
| 同时绘制不丢笔迹 | CRDT 幂等合并，chunk op 带 start 序号 | 双 tab 交叉同步后快照零分叉（冒烟测试） |
| 撤销只撤自己的 | undo 栈仅含本 actor 笔迹 | 冒烟测试：undo op 目标全为本 tab id |
| 同步延迟 < 200ms | 40ms 点批 + 30ms op 批 + BroadcastChannel（~1ms） | 状态栏实时显示 EMA 延迟 |
| 10000 笔迹不崩 | 点抽稀 + GC + 位图缓存 | 「压测 10k」按钮；逻辑测试 350ms/4.8MB |
| 导出正确 | 白底 + 按序合成可见图层 | 「导出」按钮下载 PNG |
| 60fps | 帧循环只合成位图 | 状态栏实时 FPS |
| 标签页关闭不丢数据 | IndexedDB 快照 + pagehide 强制保存 | 关闭全部标签页重开，笔迹恢复 |

## 冒烟测试

```bash
node /tmp/crdt-smoke.mjs   # CRDT 合并/撤销/10k 笔迹/GC 逻辑测试
```
