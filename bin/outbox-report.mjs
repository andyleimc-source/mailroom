#!/usr/bin/env node
// 翻发信总账：谁以 Andy 名义发了什么、凭什么发。
//
//   node bin/outbox-report.mjs        # 最近 24 小时
//   node bin/outbox-report.mjs 72     # 最近 72 小时
//
// ⚠ 这条命令绝不能有发送能力，也绝不改状态。它只读 outbox.jsonl。

import { pathToFileURL } from 'node:url';

import { recentOutbox, migrateAutosendOnce, resultFlag } from '../outbox.mjs';
import { ownerName } from '../lib.mjs';

function main() {
  migrateAutosendOnce();
  // ⚠ 不能用 `|| 24`：传 0 会被当 falsy 退回 24，「我就要看最近 0 小时」这个
  //   明确输入就被吞了。只有真没传/传的不是数字才退回默认值。
  const argHours = Number(process.argv[2]);
  const hours = Number.isFinite(argHours) ? argHours : 24;
  const rows = recentOutbox({ hours });
  if (!rows.length) {
    console.log(`最近 ${hours} 小时没有以 ${ownerName()} 名义发出去的消息。`);
    return 0;
  }
  console.log(`最近 ${hours} 小时发出去 ${rows.length} 条：`);
  for (const r of rows) {
    const at = String(r.at || '').slice(5, 16);
    // ⚠ 标记从 outbox.resultFlag 来，别在这儿另写一份（bin/fetch.mjs 的兜底汇报
    //   共用同一个函数——两处各写一份迟早对不上，那正是 2026-08-13 修的那条）。
    const flag = resultFlag(r.result);
    console.log(`  ${at}　${r.tier || '  '}　${r.channel || ''} → ${r.to || ''}`
      + `　[${r.session || '手工'}]${flag ? `　${flag}` : ''}`);
    console.log(`      ${String(r.text || '').replace(/\s+/g, ' ').slice(0, 100)}`);
    if (r.why) console.log(`      凭什么：${r.why}`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
