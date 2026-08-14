// 适配器注册表。从 tools/hap-desk/connect/index.mjs 扒过来，砍掉 ensureDefaultConnector——
// 那是老架构的多租户预留（PRD 决策 D-4，二期第二个成员进空间时用得上的 connector 归属
// 记录），mailroom 一期只服务 Andy 一个人一个明道云账号，不需要这层。
//
// 接第二个消息源 = 「往 ADAPTERS 里加一行 + 加一个文件」，不用改一圈——
// 每个适配器只要三个函数：
//   pull()            → 一批渠道无关的 candidate
//   sendVia(msg,text) → 把一段话发回它的来处（纯传输，闸在 send.mjs）
//   describe(msg)     → 给人看的来源标签

import * as hap from './hap.mjs';
import * as mail from './mail.mjs';

// 'mingdao' 是 candidate.sourceKind 里的值，'hap' 是历史上 connector.kind 里的值——
// 同一个适配器两个名字，两边都认，免得存量数据对不上。
const ADAPTERS = { mingdao: hap, hap, mail };

export function adapterFor(kind) {
  const a = ADAPTERS[kind || 'mingdao'];
  if (!a) throw new Error(`没有 ${kind} 这个消息源适配器`);
  return a;
}

export function listAdapters() { return ['mingdao', 'mail']; }
