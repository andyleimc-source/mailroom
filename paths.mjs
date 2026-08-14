// 最底层的路径解析。**只认环境变量和 HOME，绝不认配置文件**——
// config.mjs 要靠 stateDir() 才能找到配置文件放哪，所以这一层必须在配置之前就成立。
// 抽出来单独一个文件就是为了断掉 lib.mjs ↔ config.mjs 的循环引用。
//
// ⚠⚠ 一律是函数不是常量，理由见 lib.mjs 顶上那段：模块加载那一刻定死的值，
//   会让同一进程里的第二份测试复用第一份的目录，隔离形同虚设。

import { homedir } from 'node:os';
import { join } from 'node:path';

export function stateDir() {
  return process.env.MAILROOM_STATE || join(homedir(), '.mailroom');
}

// 知识库根目录的**兜底**值。真正的取值顺序在 lib.mjs 的 dailymdRoot()：
// 环境变量 > 配置文件 knowledgeBase.root > 这里。
export function defaultKbRoot() {
  return join(homedir(), 'coding/dailymd');
}
