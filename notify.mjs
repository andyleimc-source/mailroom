// 把消息投进「正在管那个任务的会话」的信箱。
//
// 脚本本体在 dailymd 那边（scripts/notify-owning-sessions.mjs —— 只有它认得会话登记表
// 和 .state 目录），这儿只负责喊一声。归位（bin/file.mjs）和收消息（bin/fetch.mjs 报
// 续聊那一步）两条路都用它，别再各抄一份。
//
// ⚠ 投递是锦上添花：脚本不在、跑挂了、超时，都只在日志里留一行，绝不影响主链。
// ⚠ 这里只写本地文件，没有任何发送能力（发送只在 bin/send.mjs）。

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { log } from './lib.mjs';

export function notifyOwningSessions(routed, dailymd) {
  if (!Array.isArray(routed) || !routed.length) return;
  const script = join(dailymd, 'scripts', 'notify-owning-sessions.mjs');
  if (!existsSync(script)) return;
  try {
    const args = [script, JSON.stringify(routed)];
    // 自己这个会话就是刚判定 / 刚收这一轮的那个，别投给自己。
    const me = process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID;
    if (me) args.push('--exclude', me);
    const out = execFileSync(process.execPath, args, { encoding: 'utf-8', timeout: 10000 }).trim();
    if (out) console.log(out);
  } catch (e) {
    log('投递给在管的会话失败（不影响主链）：', String((e && e.message) || e).slice(0, 300));
  }
}
