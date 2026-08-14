#!/usr/bin/env node
// `mailroom mail-login <账号id>` —— Microsoft 365 邮箱的设备码登录。
//
// 为什么单独一条命令而不是塞进 setup：令牌会过期、密码会改、租户会撤授权，
// 这件事**要重复做**，而 setup 是一次性的。分开之后出问题时话术也指得准。
//
// IMAP 的账号不走这里：那种是把客户端授权码自己存进钥匙串（setup 会打印那条命令）。

import { pathToFileURL } from 'node:url';
import { accountById, accounts } from '../mail/accounts.mjs';
import { deviceCodeLogin } from '../mail/graph.mjs';
import { configErrors, configPath } from '../config.mjs';

export async function main(argv = []) {
  const errs = configErrors();
  if (errs.length) {
    for (const e of errs) console.error(`⚠ ${e}`);
    console.error(`配置文件：${configPath()}`);
    return 1;
  }

  const id = argv[0];
  const list = accounts().filter((a) => a.transport === 'graph');
  if (!list.length) {
    console.error('配置里没有走 Microsoft 365（transport: "graph"）的邮箱账号。');
    console.error('跑 mailroom setup 加一个，或者直接编辑 ' + configPath());
    return 1;
  }
  const acc = id ? accountById(id) : (list.length === 1 ? list[0] : null);
  if (!acc) {
    console.error(id ? `没有代号叫「${id}」的邮箱账号。` : '有多个 365 账号，要指明是哪个：');
    for (const a of list) console.error(`  mailroom mail-login ${a.id}    （${a.address}）`);
    return 1;
  }
  if (acc.transport !== 'graph') {
    console.error(`「${acc.id}」是 IMAP 账号，不走设备码登录。`);
    console.error('它要的是客户端授权码，存进钥匙串就行：');
    console.error(`  security add-generic-password -U -s ${acc.keychainService || `mailroom-${acc.id}`} -a ${acc.address} -w '<客户端授权码>'`);
    return 1;
  }

  console.log(`给 ${acc.address} 登录 Microsoft 365…`);
  try {
    const r = await deviceCodeLogin({
      account: acc,
      clientId: acc.graph?.clientId,
      tenant: acc.graph?.tenant || 'common',
      onPrompt: ({ verificationUri, userCode }) => {
        console.log('');
        console.log(`  ① 浏览器打开：${verificationUri}`);
        console.log(`  ② 输入这个码：${userCode}`);
        console.log('  ③ 用这个邮箱登录并同意授权，然后回来等一会儿');
        console.log('');
      },
    });
    console.log(`✓ 登录成功：${r.address}`);
    console.log('跑一次 mailroom doctor 确认这个账号已经是 ✓。');
    return 0;
  } catch (e) {
    console.error(`✗ ${e.message}`);
    return 1;
  }
}

// ⚠ 入口守卫：没有它，别的模块 import 这个文件会当场触发一次真登录。
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
