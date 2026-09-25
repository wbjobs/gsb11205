'use strict';
/*
 * 增量同步：BroadcastChannel。
 * - ops：增量 op 批量广播（含 sentAt 用于延迟测量）
 * - hello/snapshot：新标签页全量对齐（CRDT 合并幂等，多份快照可安全重复应用）
 */
const CHANNEL = 'crdt-whiteboard-v1';

export class Sync {
  constructor({ onOps, onHello, onSnapshot }) {
    this.bc = new BroadcastChannel(CHANNEL);
    this.nonce = crypto.randomUUID();
    this.bc.onmessage = (e) => {
      const m = e.data;
      if (!m || m.from === this.nonce) return;
      if (m.kind === 'ops') onOps(m.ops, m.sentAt);
      else if (m.kind === 'hello') onHello(m.from);
      else if (m.kind === 'snapshot' && m.to === this.nonce) onSnapshot(m.data);
    };
  }
  hello() { this.bc.postMessage({ kind: 'hello', from: this.nonce }); }
  sendOps(ops) { this.bc.postMessage({ kind: 'ops', from: this.nonce, ops, sentAt: Date.now() }); }
  sendSnapshot(to, data) { this.bc.postMessage({ kind: 'snapshot', from: this.nonce, to, data }); }
  close() { this.bc.close(); }
}
