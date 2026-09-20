#!/usr/bin/env node
// mailroom compact —— 给知识库里的 inbox.md 瘦身 + 轮转。
// 逻辑全在 ../scripts/compact-inbox.mjs，这里只负责取知识库根目录。
//
// ⚠ 默认只看不动。真改要 --write，而且**跑之前先确认没有别的会话在写这个仓库**：
//   inboxmd 的 appendSegment 是读-改-写，撞上一次 mailroom tick 就会丢段。

import { knowledgeBase } from '../config.mjs';
import { run } from '../scripts/compact-inbox.mjs';

const { root } = knowledgeBase();
if (!root) {
  console.error('配置里没有 knowledgeBase.root，先跑一次 mailroom setup。');
  process.exit(2);
}
process.exit(run(process.argv.slice(2), root));
