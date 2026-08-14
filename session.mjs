// 「我是哪个 AI 会话」「挂着定时轮询的那个会话是谁」。
//
// ⚠⚠ 会话身份**绝不由调用方填**。填的那一刻账本就成了自证材料 —— 一个会话想赖账
//   只要少填一个参数。身份只能来自**进程环境变量**（是谁起的这个进程，赖不掉），
//   以及 harness 自己维护的 ID ↔ 名字对照表。
//
// 认哪些 harness：见下面 HARNESSES。加一个新的只要在那张表里加一行。
//   只有 Claude Code 有 ID ↔ 名字的对照表（~/.claude/sessions/<pid>.json，dailymd 的
//   scripts/notify-owning-sessions.mjs 查名字用的是同一张表）；别的 harness 没有，
//   名字就退成 `<harness>-<ID前6位>`，够在总账里分清是哪一次跑的。
//
// ⚠ 认不出一律记「手工」，**绝不拒发**：Andy 自己在别的终端敲命令时就没有那个环境变量，
//   拒发等于把本人挡在门外。

import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { stateGet, stateSet } from './store.mjs';

// ⚠ 函数不是常量，理由同 stateDir()：测试要靠 MAILROOM_SESSIONS 顶掉真实目录。
export function sessionsDir() {
  return process.env.MAILROOM_SESSIONS || join(homedir(), '.claude', 'sessions');
}

// 整张表。⚠ 单个文件坏掉（写到一半、手改过）不许拖垮整张表：坏的跳过，好的照读。
function allRows() {
  let files = [];
  try {
    files = readdirSync(sessionsDir()).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const j = JSON.parse(readFileSync(join(sessionsDir(), f), 'utf-8'));
      if (j && j.sessionId && j.name) out.push(j);
    } catch { /* 坏一行不影响其余 */ }
  }
  return out;
}

// 进程还在不在。⚠ EPERM 也算活着：那是「进程存在但不归我管」，不是「没有这个进程」。
function alive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return !!(e && e.code === 'EPERM');
  }
}

// 认得出的 harness。顺序 = 优先级。
//   named: 有没有 ID ↔ 名字对照表（只有 Claude Code 有）。
// ⚠ MAILROOM_SESSION_ID 放第一位是给「本表还没收录的 harness」留的逃生口：
//   在那个 CLI 的启动包装里 export 一下就能进总账，不用等这份代码更新。
const HARNESSES = [
  { id: 'MAILROOM_SESSION_ID', tag: 'sess', named: false },
  { id: 'CLAUDE_CODE_SESSION_ID', tag: 'cc', named: true },
  { id: 'CLAUDE_SESSION_ID', tag: 'cc', named: true },
  { id: 'ANTIGRAVITY_CONVERSATION_ID', tag: 'agy', named: false },
  // ⚠ codex 这两条是**留给以后的**：0.147 实测它不往工具环境里导出任何会话 ID
  //   （二进制里只有 CODEX_HOME / CODEX_NON_INTERACTIVE 这类，没有会话号）。
  //   现在想让 codex 跑的那一轮在总账里认得出来，只能在包装脚本里自己 export
  //   MAILROOM_SESSION_ID。哪天它加了，这两行就自动生效。
  { id: 'CODEX_SESSION_ID', tag: 'codex', named: false },
  { id: 'CODEX_THREAD_ID', tag: 'codex', named: false },
];

export function whoAmI() {
  for (const h of HARNESSES) {
    const id = String(process.env[h.id] || '');
    if (!id) continue;
    // 有对照表的（Claude Code）查名字；查不到说明那个会话没登记，退「手工」，
    // 保持老行为不变——总账里「手工」的含义一直是「认不出是谁跑的」。
    if (h.named) {
      const hit = allRows().find((r) => r.sessionId === id);
      return { sessionId: id, name: (hit && hit.name) || '手工' };
    }
    // 没对照表的：名字自己造一个，够区分「哪一次跑的」就行。
    const custom = String(process.env.MAILROOM_SESSION_NAME || '');
    return { sessionId: id, name: custom || `${h.tag}-${id.replace(/-/g, '').slice(0, 6)}` };
  }
  return { sessionId: '', name: '手工' };
}

// ⚠⚠ 「挂着 loop 的那个会话」= 跑 bin/fetch.mjs 的那个会话，不是「cwd 在 mailroom 仓库
//   里的会话」。`loop 15m mailroom` 跟当前目录无关，Andy 可能在 dailymd 甚至别处起它 ——
//   按 cwd 匹配既会漏掉真正在跑 loop 的那个，又会把「碰巧在 mailroom 目录里改代码」的
//   会话误认成它，然后把发信通报戴到一个根本没在收发的会话上。
export function rememberLoopSession() {
  const me = whoAmI();
  if (!me.sessionId) return;   // 手工跑的 fetch 没有会话可戴，别记
  stateSet('loopSession', { sessionId: me.sessionId, name: me.name });
}

// ⚠ 只对 Claude Code 有意义：查的是它那张会话表，别的 harness 不在表里，一律返回 null。
//   这不是缺陷 —— 定时器（launchd/cron）起的那种轮询每轮跑完进程就没了，
//   压根不存在一个「一直挂在那儿等着被戴」的会话，返回 null 正是对的。
//   那些 harness 下发信通报靠的是总账（`mailroom out`）和项目信箱，不靠当场戴。
export function loopSession() {
  const s = stateGet('loopSession', null);
  if (!s || !s.sessionId) return null;
  const hit = allRows().find((r) => r.sessionId === s.sessionId);
  if (!hit || !alive(hit.pid)) return null;   // 会话关了就别去戴它
  return { sessionId: hit.sessionId, name: hit.name };
}
