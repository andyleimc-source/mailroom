#!/usr/bin/env node
// 把 Claude 判好的落点写进 inbox.md。
//
// 用法（判定文本从命令行参数或 stdin 进来，两条路等价）：
//   node bin/file.mjs '[{"segIndex":0,"project":"P00-misc",...}]'
//   node bin/file.mjs < verdicts.json
//
// ⚠⚠ 这条命令**不重新判定、也不重新收消息**。它只是把一段判定文本交给原来那条
//   归位管线，管线里那几道校验一个都没绕过：解析不出来整批退回 P00-misc、
//   任务号查不到就降级、绝不照着一个不存在的路径写文件。
//   **别在这儿加任何近路**（比如「模型说了 project 就直接 mkdir」）——
//   照着幻觉写等于凭空造出一个 Andy 永远找不到的任务目录。
//
// ⚠ 这条命令绝不能有发送能力。发送只在 bin/send.mjs。

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { dailymdRoot } from '../lib.mjs';
import { notifyOwningSessions } from '../notify.mjs';
import { fileNow } from '../run.mjs';

function readStdin() {
  try {
    // 0 = stdin。没有管道进来时读会抛 EAGAIN/EOF，当成空处理。
    return readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

async function main() {
  const arg = process.argv.slice(2).filter((a) => a !== '--').join(' ').trim();
  const text = arg || readStdin().trim();
  if (!text) {
    console.log('没收到判定内容。把 bin/fetch.mjs 让你判的那个 JSON 数组传进来。');
    return 1;
  }
  const r = await fileNow(text, { dailymd: dailymdRoot() });
  if (!r.todo) {
    console.log('没有等着判落点的段——可能已经归过位了，或者这一轮本来就没新消息。');
    return 0;
  }
  console.log(`归位完成：落到任务 ${r.filed} 段、拿不准 ${r.unsure} 段、丢弃 ${r.dropped} 段。`);
  notifyOwningSessions(r.routed, dailymdRoot());
  if (r.unsure) {
    console.log('「拿不准」的落在项目目录的 inbox.md 里，下一轮不会再判——'
      + '要挪位置直接改文件，或者告诉我挪到哪。');
  }
  return 0;
}

// ⚠ 入口守卫别删（理由同 bin/fetch.mjs）。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((e) => {
      const msg = String((e && e.stack) || e).slice(0, 600);
      log('⚠ 归位没跑起来：', msg);
      console.log(`⚠ 归位没跑起来：${msg}`);
      process.exitCode = 1;
    });
}
