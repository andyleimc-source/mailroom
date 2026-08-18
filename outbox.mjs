// 发信总账 —— 「谁以 Andy 名义、在哪个会话里、凭什么、发了什么给谁」。
//
// ⚠⚠ 2026-08-12 之前这件事散在三处：mailroom 日志有一行、那个任务的 inbox.md 有一条、
//   🟢 那档进 autosend.jsonl。三处都不记「哪个会话发的」，于是 Andy 挂着 loop 眼前一片
//   安静的时候，另外三个会话可能已经以他名义发了五条。这个文件就是那份汇总。
//
// ⚠ 这里**没有任何业务判断**，纯读写。判档位、判要不要拒发，全在 bin/send.mjs。
//   账本一旦开始判断，就成了第二道门 —— 而两道门迟早对不上。
//
// ⚠ 写失败绝不许拦发送（消息已经出去了，拦也没用），但必须让调用方打出来：
//   没有账的发送等于没人管。

import { appendFileSync, existsSync, readFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { stateDir, localIso } from './lib.mjs';

// ⚠ 跟 stateDir() 一样是**函数**不是常量：测试靠 MAILROOM_STATE 换目录，
//   模块加载时求值会把真实的 ~/.mailroom 绑死，测试就会往真账本里写。
export function outboxFile() { return join(stateDir(), 'outbox.jsonl'); }
function legacyFile() { return join(stateDir(), 'autosend.jsonl'); }

// ⚠ 读不到 / 读坏了一律当空，照常继续。账本坏掉不该把发送链卡死；
//   代价是 🟢 的频次门会放行得更松，那道门真正的硬条件在 autosend.mjs 的另外 5 条上。
export function readOutbox() {
  const f = outboxFile();
  if (!existsSync(f)) return [];
  try {
    return readFileSync(f, 'utf-8').split('\n')
      .map((l) => l.trim()).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function appendOutbox(entry) {
  mkdirSync(stateDir(), { recursive: true });
  appendFileSync(outboxFile(), `${JSON.stringify(entry)}\n`, 'utf-8');
}

// 唯一的写入口。⚠ chars 由这里算，不让调用方填 —— 调用方手上有原文也有补完声明的
//   版本，让它自己填迟早两边填的不是同一份。
export function logSent({
  session = '', sessionId = '', filed = '', channel = '', to = '', accountId = '',
  seg = '', tier = '', why = '', text = '', result = 'sent',
  // ⚠ 2026-08-18 补：账本以前不记附件——查账看不出这条到底带没带文件，
  //   群里那次「正文发了、附件漏了」的事故事后翻账本一个字都看不出来。
  //   file 是调用方给的本地路径（没带附件就留空），fileResult 是附件那一步
  //   的结果（'sent' / 'failed' / 'none'），不跟正文的 result 混在一起——
  //   正文和附件是两次独立的调用，各自的成败要能分开查。
  file = '', fileResult = 'none',
} = {}) {
  const body = String(text || '');
  const entry = {
    at: localIso(),
    session: String(session || '手工'),
    sessionId: String(sessionId || ''),
    filed: String(filed || ''),
    channel: String(channel || ''),
    to: String(to || ''),
    accountId: String(accountId || ''),
    seg: String(seg || ''),
    tier: String(tier || ''),
    why: String(why || ''),
    chars: [...body.trim()].length,
    text: body,
    result: String(result || 'sent'),
    file: String(file || ''),
    fileResult: String(fileResult || 'none'),
  };
  appendOutbox(entry);
  return entry;
}

// 一行账的 result 该怎么标给人看。
//
// ⚠⚠ 2026-08-13 修的 Critical：`bin/fetch.mjs` 的兜底汇报当时压根不看 result，
//   标题却写「别的会话以 Andy 名义**发出去了** N 条」。外部客户邮件走的是
//   connect/mail.mjs 那道**只存草稿**的物理门，一个字都没到对方那儿 —— 报成已发，
//   Andy 会以为客户收到了，然后那封信永远躺在草稿箱里没人管。
//   （send.mjs 和 bin/send.mjs 里都用 ⚠⚠ 写着这条：草稿绝不许报成已发出。）
// ⚠ 标记只在这一处定：`mailroom out` 和收消息时的兜底汇报共用它。抄成两份的话，
//   哪天加一种 result（比如「发了但附件失败」），必有一边不认得。
//   这不是业务判断（不改任何流程），只是 result 这一栏的显示口径。
export function resultFlag(result) {
  const r = String(result || 'sent');
  if (r === 'draft') return '📝草稿';
  if (r === 'failed') return '⚠失败';
  return '';
}

export function recentOutbox({ now = new Date(), hours = 24, rows = null } = {}) {
  const floor = now.getTime() - hours * 3600 * 1000;
  return (rows || readOutbox()).filter((r) => {
    const t = Date.parse((r && r.at) || '');
    return Number.isFinite(t) && t >= floor;
  });
}

// autosend.jsonl → outbox.jsonl 的一次性迁移。
// ⚠ 幂等靠**改名**，不靠标记位：原文件改成 .bak 之后 existsSync 就是假，第二遍空跑。
//   留 .bak 不真删 —— 迁移写错了还能回去看原始数据。
// ⚠ 老账里没有的字段（channel / text / session）就空着，别编：账本里一个编出来的
//   「私信」比空字段更害人。
// ⚠ 所有行先在内存里拼成一整块，**一次 appendFileSync 写完**再 renameSync ——
//   幂等只靠「整体改名」这一个动作。要是逐行边转边写，写到一半（磁盘满/权限）
//   抛错，rename 就不会跑，老文件留在原地；下次重试会把已经成功写进去的那批
//   再写一遍，账本就翻倍了。一次写完，要么全进要么一行都不进，跟 rename 是不是
//   跑了保持一致。
export function migrateAutosendOnce() {
  const old = legacyFile();
  if (!existsSync(old)) return 0;
  try {
    const rows = readFileSync(old, 'utf-8').split('\n')
      .map((l) => l.trim()).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    const lines = rows.map((r) => JSON.stringify({
      at: r.at || '',
      session: '',
      sessionId: '',
      filed: r.file || '',
      channel: '',
      to: r.who || '',
      accountId: r.accountId || '',
      seg: r.seg || '',
      tier: '🟢',
      why: r.why || '',
      chars: Number(r.chars) || 0,
      text: '',
      result: 'sent',
    }));
    if (lines.length) {
      mkdirSync(stateDir(), { recursive: true });
      appendFileSync(outboxFile(), lines.map((l) => `${l}\n`).join(''), 'utf-8');
    }
    renameSync(old, `${old}.bak`);
    return lines.length;
  } catch {
    // 迁移失败不许拦任何东西：老账留在原地，下次再试。
    return 0;
  }
}
