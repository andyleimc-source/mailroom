#!/usr/bin/env node
// 从 ms365 MCP 那份令牌缓存里借一次，建出 mailroom 自己的 ms365 令牌。
//
// 什么时候要跑：第一次装 mailroom（钥匙串里还没有 mailroom-<账号id>），或者用户
// 在 ms365 MCP 那边换了密码 / 重新登录过（refresh token 跟着变了，旧的会开始
// 401，mailroom doctor 那条 ms365 检查会报缺）。
//
// ⚠ 只读 ms365 MCP 那份缓存、拷一份出来，不改它本身——写坏了用户的 ms365 工具
//   整个就用不了了。真正的实现和这条注释见 mail/graph.mjs 顶部。

import { pathToFileURL } from 'node:url';
import { bootstrapFromMcp } from '../mail/graph.mjs';

async function main() {
  const r = bootstrapFromMcp();
  console.log(`ms365 令牌已引导：${r.address}`);
  console.log('之后 mailroom 自己刷新，不再动 ms365 MCP 那份缓存。');
  return 0;
}

// ⚠ 入口守卫别删（理由同 bin/fetch.mjs / bin/file.mjs）。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((e) => {
      console.log(`⚠ 引导没成：${String((e && e.message) || e)}`);
      process.exitCode = 1;
    });
}
