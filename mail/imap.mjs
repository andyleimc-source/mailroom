// IMAP/SMTP 传输层。node 这一侧是**薄壳**：只负责起 python3、喂 JSON、分级报错。
// MIME 解析、IMAP/SMTP 协议全在 mail/imap.py 里（python3 标准库现成的，
// 纯 node 要自己写四百行解析加字符集转换）。
//
// ⚠ 本文件是传输层，不是闸。没有、也永远不许有授权判断和身份声明——那两样在 send.mjs。
// ⚠ 授权码不经过 node：python 自己从钥匙串读，命令行参数里不出现，ps 也看不到。

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertNoRealIO, BIN, MailAuthError, log } from '../lib.mjs';

// brief 定的 Produces 里 MailAuthError 是本文件的导出之一（后续任务 import
// 这里的，不是直接 import lib.mjs）——只在内部 use 不算数，得显式 re-export。
export { MailAuthError };

const PY = fileURLToPath(new URL('./imap.py', import.meta.url));
const TIMEOUT_MS = 120000;

// 账号 → python 要的载荷。⚠ **账号一律从第二个参数 `{ account }` 传**，只有这一条路：
//   多留一条「也能从第一个参数传」的兼容路，就是这个仓库反复吃亏的「两套判据」——
//   将来改动只改到其中一条，另一条静默走老行为。
export function toPythonAccount(acc) {
  if (!acc || typeof acc !== 'object') return null;
  const id = acc.id || '';
  return {
    id,
    address: acc.address || '',
    keychainService: acc.keychainService || (id ? `mailroom-${id}` : ''),
    imap: {
      host: (acc.imap && acc.imap.host) || '',
      port: (acc.imap && acc.imap.port) || 993,
    },
    smtp: {
      host: (acc.smtp && acc.smtp.host) || '',
      port: (acc.smtp && acc.smtp.port) || 465,
      ssl: acc.smtp && acc.smtp.ssl !== undefined ? acc.smtp.ssl : true,
    },
  };
}

function defaultRun(payload) {
  // ⚠ 这里是真 IO：smtp_send 真发信、mark_read 真改已读标志，都不可撤销，
  //   跟 lib.mjs 的 hap() 一样必须过这道闸——测试忘了注入 run 就地抛错，
  //   不许真的碰到 IMAP/SMTP 服务器。
  assertNoRealIO(`mail imap ${payload.op}`);
  const r = spawnSync(BIN.python3, [PY], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    timeout: TIMEOUT_MS,
  });
  if (r.error) throw new Error(`python3 起不来：${r.error.message}`);
  const out = (r.stdout || '').trim();
  if (!out) throw new Error(`imap.py 没有输出（退出码 ${r.status}）：${(r.stderr || '').slice(0, 300)}`);
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`imap.py 的输出不是 JSON：${out.slice(0, 300)}`);
  }
}

// ⚠ 这里是「取数出错一律往上抛」那条规矩的落点。
//   认证失败抛 MailAuthError（上层据此停下来喊 Andy），其余抛普通 Error（上层记 lost、
//   回滚水位线、下一轮重收）。**绝不许把任何一种变成「零封新邮件」返回。**
function call(payload, run) {
  const res = (run || defaultRun)(payload);
  if (!res || typeof res !== 'object') {
    throw new Error(`imap.py 没给回结果对象（op=${payload.op}）：${String(res).slice(0, 120)}`);
  }
  // ⚠ 保守判断：只有 ok === true 才算成功。不是 `res.ok === false` 才算失败——
  //   那样一个连 ok 键都没有的畸形回包（比如助手改坏了漏写 ok）会被当成成功放行。
  if (res.ok !== true) {
    if (res.auth) throw new MailAuthError(res.error || '邮箱认证失败');
    throw new Error(res.error || `imap.py 执行失败（op=${payload.op}）：返回对象里 ok 不是 true`);
  }
  return res;
}

export function imapFetch({ sinceUid = '', uidValidity = '', limit = 50, account, run } = {}) {
  const pyAcc = toPythonAccount(account);
  const res = call({
    op: 'fetch', since_uid: String(sinceUid || ''), uid_validity: String(uidValidity || ''), limit,
    account: pyAcc,
  }, run);
  const uv = res.uidValidity || '';
  return {
    uidValidity: uv,
    lastUid: res.lastUid || '',
    baseline: !!res.baseline,
    // ⚠⚠ 每封信都挂上这一轮的 uidValidity。IMAP 的 UID **只在同一个 uidValidity 里唯一**：
    //   服务端重建邮箱（uidValidity 变）之后编号会从头再来，同一个自然月内新邮件的
    //   `mail-mingdao-<uid>` 就可能跟旧邮件的记录 id 撞车，而 archive() 是按 id 去重的——
    //   撞上就把**新邮件**当成重复静默丢弃，归档里连一条都不留（inbox.md 里那份是
    //   截断过的，长信的后半截就此没了）。normalize.mjs 拿它拼进记录 id。
    //   ⚠ m.id 本身不动：标已读（imapMarkRead）传回给 python 的就是它，改了就标不上。
    messages: (res.messages || []).map((m) => ({ ...m, uidValidity: uv })),
  };
}

export function imapMarkRead(uids, { account, run } = {}) {
  if (!uids || !uids.length) return { ok: true };
  return call({ op: 'mark_read', uids: uids.map(String), account: toPythonAccount(account) }, run);
}

export function imapSaveDraft({ subject, html, to = [], cc = [], inReplyTo = '', references = '' }, { account, run } = {}) {
  const pyAcc = toPythonAccount(account);
  const res = call({
    op: 'save_draft', subject, html, to, cc,
    in_reply_to: inReplyTo, references,
    account: pyAcc,
  }, run);
  log(`草稿已写入「${res.folder || '草稿箱'}」`);
  return res;
}

export function smtpSend({ subject, html, to = [], cc = [], inReplyTo = '', references = '' }, { account, run } = {}) {
  const pyAcc = toPythonAccount(account);
  return call({
    op: 'smtp_send', subject, html, to, cc,
    in_reply_to: inReplyTo, references,
    account: pyAcc,
  }, run);
}
