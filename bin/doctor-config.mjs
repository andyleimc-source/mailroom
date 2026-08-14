#!/usr/bin/env node
// 给 `mailroom doctor` 用的配置探针：把「配置说了什么」翻译成几行 TSV，交给 bash 去排版。
//
// 为什么不让 bash 直接读 JSON：判据只该有一处。config.mjs 已经定义了什么算「配了」
// （sources()）、什么算「配错了」（configErrors()），bash 里再 grep 一遍 JSON 早晚对不上。
//
// 输出格式：每行 `TAG\t内容`
//   OK/ERR/WARN/SKIP —— 直接打给人看的一行
//   KB   —— 知识库根目录
//   HAP  —— 1/0，明道云那条路启没启用
//   ACC  —— 一个邮箱账号：id\taddress\ttransport\tkeychainService

import { existsSync } from 'node:fs';
import { configErrors, configExists, configPath, sources } from '../config.mjs';
import { dailymdRoot } from '../lib.mjs';
import { accounts } from '../mail/accounts.mjs';

const rows = [];
const say = (tag, ...cols) => rows.push([tag, ...cols].join('\t'));

const file = configPath();
if (!configExists()) {
  say('ERR', `还没有配置文件（${file}）。跑一次：mailroom setup`);
} else {
  const errs = configErrors();
  if (errs.length) for (const e of errs) say('ERR', e);
  else say('OK', file);
}

// ⚠ 走 dailymdRoot()，不自己拼：环境变量 > 配置 > 内置默认这套顺序只该有一处定义。
const root = dailymdRoot();
say('KB', root);

const src = sources();
say('HAP', src.hap ? '1' : '0');

for (const a of accounts()) {
  say('ACC', [a.id, a.address, a.transport, a.keychainService || `mailroom-${a.id}`].join('\t'));
}

// 两条路都没配 = 这台机器还收不了任何东西。不是错误（新装就是这样），但必须说出来。
if (!src.hap && !src.mail) {
  say('WARN', '明道云和邮箱都没配，现在一条消息都收不到。跑一次：mailroom setup');
}
if (root && !existsSync(root)) {
  say('WARN', `知识库目录不存在：${root}`);
}

process.stdout.write(`${rows.join('\n')}\n`);
