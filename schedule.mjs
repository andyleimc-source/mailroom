// 定时发送队列 —— 「Andy 已经点过头，但现在不该发」的那些消息，排到点上再发。
//
// 为什么要有这个：主动找同事的消息卡在工作日 09:00–19:00 那道门上（dm.mjs 的
// offHours）。周六拟好的稿子，要么硬闯 --off-hours，要么只能靠人记着周一再跑一遍
// —— 第二条实际等于忘掉。这个队列把「周一再跑一遍」交给主力机上的 launchd。
//
// ⚠⚠ 这里**没有任何发送能力，也没有任何判断**：到点了就把当初那条 bin/send.mjs 原样
//   跑一遍。所有的闸（身份声明、称呼、档位、确认码、工作时段、发前重收一轮）仍然只在
//   bin/send.mjs 里。队列一旦开始自己判断，就成了第二道门 —— 而两道门迟早对不上。
//
// ⚠ 队列只住在**主力机**的 ~/.mailroom 下（topology.primaryHost），不进 git。理由跟收发
//   水位线一样：两台机器各存一份，同一条消息会被各发一遍，而明道云没有撤回接口。别的
//   机器通过 bin/mailroom 的 ssh 转发把 schedule 命令送过来。

import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, unlinkSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, basename } from 'node:path';

import { stateDir, localIso } from './lib.mjs';

export function queueDir() { return join(stateDir(), 'scheduled'); }

// 附件快照目录。⚠ 别让队列直接指向 git 仓库里的文件：到点那一刻仓库可能已经被改过、
//   或者在另一台机器上还没同步过来，发出去的就不是 Andy 点头的那一份了。
export function attachDir() { return join(queueDir(), 'att'); }

// 已消费台账。⚠ 这是防重发的**唯一**依据，跟队列文件分开放：即使队列文件删除失败，
//   下一轮也不会再发一遍。宁可漏发（日志里看得见）也不重发（撤不回来）。
function doneFile() { return join(stateDir(), 'schedule-done.jsonl'); }

function sha256(p) { return createHash('sha256').update(readFileSync(p)).digest('hex'); }

// 「2026-08-17 09:30」和「2026-08-17T09:30」都收，一律按本机时区解释。
// ⚠ 不接受省略日期的写法（「09:30」）：定时发送写错一天的代价是发到同事眼前，
//   不值得为图省事留这个口子。
export function parseAt(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0, 0);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function readQueue() {
  const dir = queueDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try { return { ...JSON.parse(readFileSync(join(dir, f), 'utf-8')), _file: join(dir, f) }; } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

export function readDone() {
  const f = doneFile();
  if (!existsSync(f)) return [];
  try {
    return readFileSync(f, 'utf-8').split('\n').map((l) => l.trim()).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

export function markDone(entry) {
  mkdirSync(stateDir(), { recursive: true });
  appendFileSync(doneFile(), `${JSON.stringify(entry)}\n`, 'utf-8');
}

export function writeEntry(entry) {
  mkdirSync(queueDir(), { recursive: true });
  const f = join(queueDir(), `${entry.id}.json`);
  writeFileSync(f, `${JSON.stringify(entry, null, 2)}\n`, 'utf-8');
  return f;
}

export function removeEntry(id) {
  const f = join(queueDir(), `${id}.json`);
  if (!existsSync(f)) return false;
  unlinkSync(f);
  return true;
}

// 附件在排队那一刻按内容指纹钉死，同时留一份存档。
//
// ⚠ argv 里的 --file 路径**保持原样不动**：bin/send.mjs 把 --file 算进了确认码，
//   路径一改确认码就对不上，到点那一下会变成只预览不发。所以这里只记指纹、留存档，
//   不动路径。存档是给「到点发现原文件被改了」时留的证据和补救材料。
export function snapshotAttachment(id, src) {
  mkdirSync(join(attachDir(), id), { recursive: true });
  const dst = join(attachDir(), id, basename(src));
  writeFileSync(dst, readFileSync(src));
  return { path: src, sha256: sha256(dst), snapshot: dst };
}

// ⚠ 到点了先验一遍附件还是不是排队时那一份。对不上就**不发**：Andy 点头的是当初
//   那份内容，不是「同名文件此刻长什么样」。
export function fileStillMatches(entry) {
  if (!entry.file) return true;
  try { return existsSync(entry.file.path) && sha256(entry.file.path) === entry.file.sha256; } catch { return false; }
}

export function argOf(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? String(argv[i + 1] || '') : '';
}

// 走 🔴 那三条路（主动私信 / 任务评论 / 记录讨论）的，必须已经带着确认码进队列
// —— 也就是 Andy 已经看过这一版正文了。队列不负责替他点头。
export function needsConfirm(argv) {
  return argv.includes('--to') || argv.includes('--task') || argv.includes('--record') || argv.includes('--post');
}

export function makeId(at, argv) {
  const who = argOf(argv, '--to') || argOf(argv, '--task') || argOf(argv, '--record')
    || argOf(argv, '--post') || argOf(argv, '--seg') || 'send';
  const t = localIso(at).slice(0, 16).replace(/[-:T]/g, '');
  const h = createHash('sha256').update(argv.join(' ')).digest('hex').slice(0, 6);
  return `${t}-${who.replace(/[^\w.-]/g, '') || 'x'}-${h}`;
}
