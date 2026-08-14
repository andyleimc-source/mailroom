#!/usr/bin/env node
// probe.mjs: 轻量探针 —— 只做增量拉取与聚段，不启动 LLM。
//
// 退出码：
//   0 = 探针完成，没有新待判消息（0 AI 消耗，耗时 ~1-2s）
//   2 = 探针探测到有新消息待判（需要调起 agy 进行 AI 分类与回复）
//   1 = 出错（如 hap 认证失败）

import { pathToFileURL } from 'node:url';
import { dailymdRoot, log } from '../lib.mjs';
import { acquireLock, releaseLock, runOnce } from '../run.mjs';
import { authAdvice } from './fetch.mjs';
import { recordRun, isDue, readHeartbeat, formatStatus } from '../heartbeat.mjs';

async function main() {
  if (!isDue()) {
    const state = readHeartbeat();
    console.log(`心跳未到期，跳过探针：${formatStatus(state)}`);
    return 0;
  }

  if (!acquireLock()) {
    console.log('上一轮还在跑，跳过本轮探针。');
    return 0;
  }

  try {
    const dailymd = dailymdRoot();
    const r = await runOnce({ dailymd, deferJudge: true });

    const errs = r.authErrors && r.authErrors.length
      ? r.authErrors
      : (r.authError ? [{ kind: 'mingdao', message: r.authError }] : []);
    const advice = authAdvice(errs);
    for (const l of advice.lines) console.log(l);
    if (advice.stop) return 1;

    // 记录本轮探针运行（推算下一次 nextRunAt）
    const hb = recordRun();

    if (!r.pending || !r.pending.length) {
      console.log(`✓ 探针完成：无新待判消息（下一轮心跳：${hb.zone}）`);
      return 0;
    }

    console.log(`⚡ 探针发现 ${r.pending.length} 段新消息待判，需唤醒 AI 处理`);
    return 2;
  } finally {
    releaseLock();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((e) => {
      const msg = String((e && e.stack) || e).slice(0, 600);
      log('⚠ 探针出错：', msg);
      console.log(`⚠ 探针出错：${msg}`);
      process.exitCode = 1;
    });
}
