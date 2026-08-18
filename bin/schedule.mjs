#!/usr/bin/env node
// 定时发送的命令行 —— 排队、看队列、撤单，以及 launchd 每 5 分钟叫一次的 run。
//
// ⚠ 这里不判断该不该发、不改正文、不加参数。到点了就把当初那条 bin/send.mjs 原样
//   跑一遍，闸全在那边。设计说明见 ../schedule.mjs 顶部。

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { log, localIso } from '../lib.mjs';
import { offHours } from '../dm.mjs';
import {
  parseAt, readQueue, readDone, markDone, writeEntry, removeEntry,
  snapshotAttachment, fileStillMatches, argOf, needsConfirm, makeId,
} from '../schedule.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

function usage() {
  console.log(`定时发送 —— 把「Andy 已经点过头、但现在不该发」的消息排到点上再发。

用法：
  mailroom schedule add --at "2026-08-17 09:30" --why "<为什么定这个点>" -- <bin/send.mjs 的全部参数>
  mailroom schedule list
  mailroom schedule rm <id>
  mailroom schedule run [--dry-run]        # launchd 每 5 分钟叫一次，平时不用手跑

要点：
  · 队列只住主力机（收发状态那台），别的机器跑 mailroom schedule 会自动 ssh 转过去。
  · 主动私信/任务评论/记录讨论必须先跑一次 bin/send.mjs 拿到 --confirm 确认码，
    带着确认码才能进队列 —— 队列不替 Andy 点头。
  · --file 附件在排队那一刻就拷进队列存档；到点前会核对内容没被改过，对不上就不发。
  · 到点那一下仍然要过 bin/send.mjs 的全部闸（工作时段、发前重收一轮…）。不在工作
    时段就继续等下一轮，不会硬闯。`);
}

function fmt(entry) {
  const to = argOf(entry.argv, '--to') || argOf(entry.argv, '--task')
    || argOf(entry.argv, '--record') || argOf(entry.argv, '--post') || argOf(entry.argv, '--seg');
  const text = argOf(entry.argv, '--text').replace(/\s+/g, ' ').slice(0, 40);
  return `  ${entry.at}  → ${to || '?'}  ${text}…\n    id ${entry.id}${entry.why ? `\n    为什么定这个点：${entry.why}` : ''}`;
}

function cmdAdd(argv) {
  const sep = argv.indexOf('--');
  if (sep < 0) { console.error('缺少 `--`：`--` 之后是原样交给 bin/send.mjs 的参数。'); return 2; }
  const own = argv.slice(0, sep);
  const send = argv.slice(sep + 1);
  const at = parseAt(argOf(own, '--at'));
  const why = argOf(own, '--why');

  if (!at) { console.error('--at 要写成 "YYYY-MM-DD HH:MM"（必须带日期，写错一天就发到同事眼前了）。'); return 2; }
  if (at.getTime() <= Date.now()) { console.error(`--at 已经过去了（${localIso(at).slice(0, 16)}）。要现在就发就别排队，直接跑 bin/send.mjs。`); return 2; }
  if (!send.length) { console.error('`--` 之后什么都没有：把整条 bin/send.mjs 的参数原样接上。'); return 2; }
  if (!why.trim()) { console.error('--why 必填：写清为什么定在这个点（「周六被工作时段门挡下，约周一早上」这种）。'); return 2; }
  if (needsConfirm(send) && !argOf(send, '--confirm')) {
    console.error('这条走 🔴（主动私信/任务评论/记录讨论），必须带 --confirm 确认码才能进队列。');
    console.error('→ 先原样跑一次 bin/send.mjs 看预览，把那段给 Andy 过目，拿到确认码再排。');
    return 2;
  }

  const id = makeId(at, send);
  let file = null;
  const fi = send.indexOf('--file');
  if (fi >= 0) {
    const src = resolve(String(send[fi + 1] || ''));
    if (!existsSync(src)) { console.error(`附件不存在：${src}`); return 2; }
    // ⚠ 只钉指纹 + 留存档，**不改 argv 里的路径**：--file 被算进了确认码，
    //   路径一改到点那一下就变成只预览不发。
    send[fi + 1] = src;
    file = snapshotAttachment(id, src);
  }

  const entry = {
    id,
    at: localIso(at).slice(0, 16).replace('T', ' '),
    why,
    argv: send,
    file,
    createdAt: localIso(),
    createdOn: process.env.MAILROOM_ORIGIN_HOST || '',
  };
  writeEntry(entry);
  console.log(`已排队：${entry.at} 发出`);
  console.log(fmt(entry));
  if (file) {
    console.log(`\n附件已按内容钉死：${file.path}`);
    console.log(`存档一份在 ${file.snapshot}；到点前会核对原文件没被改过，对不上就不发。`);
  }
  return 0;
}

function cmdList() {
  const q = readQueue();
  if (!q.length) { console.log('队列是空的。'); return 0; }
  console.log(`排着 ${q.length} 条：`);
  for (const e of q) console.log(fmt(e));
  const done = readDone().slice(-5);
  if (done.length) {
    console.log('\n最近发出去的：');
    for (const d of done) console.log(`  ${d.ranAt} ${d.ok ? '✓' : '✗'} ${d.id}${d.note ? ` — ${d.note}` : ''}`);
  }
  return 0;
}

function cmdRm(id) {
  if (!id) { console.error('要给 id（`mailroom schedule list` 里那一行）。'); return 2; }
  if (!removeEntry(id)) { console.error(`队列里没有 ${id}`); return 1; }
  console.log(`已撤单：${id}`);
  return 0;
}

function cmdRun(dry) {
  const consumed = new Set(readDone().map((d) => d.id));
  const q = readQueue();
  const now = Date.now();
  let ran = 0;

  for (const e of q) {
    if (consumed.has(e.id)) { removeEntry(e.id); continue; }
    const at = parseAt(e.at);
    if (!at || at.getTime() > now) continue;

    // ⚠ 工作时段门单独在这儿看一眼，不是靠 bin/send.mjs 去拒：那边拒了这条就算「跑过
    //   一次」，而这条其实还该等到工作时段。这里不满足就整条继续排着，下一轮再看。
    if (!e.argv.includes('--off-hours')) {
      const off = offHours();
      if (off) { log(`schedule: ${e.id} 到点了但${off}，继续等工作时段`); continue; }
    }

    if (!fileStillMatches(e)) {
      markDone({ id: e.id, ranAt: localIso(), ok: false, note: '附件内容跟排队时对不上，没发' });
      removeEntry(e.id);
      log(`schedule: ${e.id} 附件对不上，拒发`);
      continue;
    }

    if (dry) { console.log(`[dry-run] 该发了：${e.id}\n  node bin/send.mjs ${e.argv.join(' ')}`); ran++; continue; }

    // ⚠⚠ 先记账再发。发之前崩、发之后崩，两种都只可能漏发，不可能重发
    //   —— 明道云没有撤回接口，宁可日志里留一条「没发出去」让人补。
    markDone({ id: e.id, ranAt: localIso(), ok: null, note: '已发起，等结果' });
    const r = spawnSync(process.execPath, [join(REPO, 'bin', 'send.mjs'), ...e.argv], {
      cwd: REPO, encoding: 'utf-8', timeout: 180000,
    });
    const ok = r.status === 0 && !/拒绝发送|还没有发出去/.test(String(r.stdout || ''));
    markDone({
      id: e.id,
      ranAt: localIso(),
      ok,
      note: ok ? '发出去了' : `没发成：${String(r.stdout || r.stderr || '').split('\n').filter(Boolean).slice(-1)[0] || `exit ${r.status}`}`,
    });
    removeEntry(e.id);
    log(`schedule: ${e.id} ${ok ? '发出去了' : '没发成 —— 看 mailroom schedule list 最后几行'}`);
    if (r.stdout) process.stdout.write(r.stdout);
    ran++;
  }

  if (!ran) log('schedule: 这一轮没有到点的');
  return 0;
}

function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0] || 'list';
  if (sub === 'help' || sub === '-h' || sub === '--help') { usage(); return 0; }
  if (sub === 'add') return cmdAdd(argv.slice(1));
  if (sub === 'list' || sub === 'ls') return cmdList();
  if (sub === 'rm' || sub === 'cancel') return cmdRm(argv[1]);
  if (sub === 'run') return cmdRun(argv.includes('--dry-run'));
  console.error(`不认识的子命令：${sub}`);
  usage();
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
