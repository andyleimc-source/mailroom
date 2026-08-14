#!/usr/bin/env node
// heartbeat CLI: 供 launchd / shell 脚本判断心跳状态与执行动作
//
// 用法：
//   node bin/heartbeat.mjs is-due      # exit 0 = 到点了/该跑了，exit 1 = 还没到
//   node bin/heartbeat.mjs boost [理由] # 激活心跳加速（置入热区 1m）
//   node bin/heartbeat.mjs record-run  # 记录本轮已跑，推算下一次 nextRunAt
//   node bin/heartbeat.mjs status      # 打印当前心跳状态与分区

import { isDue, boostHeartbeat, recordRun, formatStatus, readHeartbeat } from '../heartbeat.mjs';

const cmd = process.argv[2] || 'status';

if (cmd === 'is-due') {
  const due = isDue();
  process.exitCode = due ? 0 : 1;
} else if (cmd === 'boost') {
  const reason = process.argv.slice(3).join(' ') || '命令行手动激活';
  const state = boostHeartbeat({ reason });
  console.log(`✓ 心跳加速已激活：${state.zone}（${reason}）`);
} else if (cmd === 'record-run') {
  const state = recordRun();
  console.log(`✓ 本轮运行已记录，下一次心跳间隔：${state.currentIntervalSec}s（${state.zone}）`);
} else if (cmd === 'status') {
  const state = readHeartbeat();
  console.log(`心跳状态：${formatStatus(state)}`);
} else {
  console.error(`未知子命令：${cmd}。可用：is-due, boost, record-run, status`);
  process.exitCode = 1;
}
