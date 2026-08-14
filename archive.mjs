// 归档器：把明道云消息流水落盘到 dailymd 仓库，两台 Mac 靠 git 同步。
// 从 tools/hap-desk/archive.mjs 扒过来，基本原样——这一层跟 lane/分道没关系，
// 归档范围本来就是「一条不漏」，没有可裁的打分逻辑。
//
// 双份：
//   assets/hap-log/YYYY-MM.jsonl  — 一行一条，程序去重和检索用，是唯一事实源
//   assets/hap-log/YYYY-MM.md     — 由 jsonl 整体重渲染，给人和 AI 读。别手改，会被覆盖。
//
// 归档范围（Andy 2026-08-05 定，mailroom 沿用）：私信双向全记、群消息全记（不限于 @我）、
// 动态里涉及我的评论、我自己发出去的一切。系统通知和工作流通知不记。

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { dailymdRoot, scrubExternal, ME, parseHapTime } from './lib.mjs';

// 归档写到哪个 dailymd：**调用方显式传** `{ dailymd }`，跟本仓其它模块（file.mjs /
// tree.mjs / fileAll）一个口径；不传才退回 dailymdRoot()。
//
// ⚠ 退回的那条路必须每次调用现算，**不许在模块顶层求值**。写死的话 `MAILROOM_DAILYMD`
//   就顶不掉了——跑一次测试就往真的 `assets/hap-log/*.jsonl`（消息归档的唯一事实源）
//   里塞假消息，hap-desk 上 2026-08-08 真发生过，主库当场脏了 10 行。
// subdir —— 归到 dailymd 下的哪个目录。默认 assets/hap-log（明道云）。
// ⚠ 邮件走 assets/mail-log：正文长、字段不同（subject/from/to/threadId），
//   混进 hap-log 会把那份「明道云消息的唯一事实源」冲烂，检索也会互相干扰。
export const logDir = ({ dailymd = dailymdRoot(), subdir = 'assets/hap-log' } = {}) => join(dailymd, subdir);

function monthOf(ts) {
  return String(ts || '').slice(0, 7) || '0000-00';
}

function paths(month, opts) {
  const dir = logDir(opts);
  return { jsonl: join(dir, `${month}.jsonl`), md: join(dir, `${month}.md`) };
}

export function readMonth(month, opts) {
  const { jsonl } = paths(month, opts);
  if (!existsSync(jsonl)) return [];
  return readFileSync(jsonl, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
}

// records: [{ id, ts, dir:'in'|'out', kind, peer, peerId, groupId, groupName, text, via }]
// 返回真正新写入的条数。id 重复的直接丢弃，所以补历史可以反复跑。
export function archive(records, opts) {
  const list = (records || []).filter((r) => r && r.id && r.ts && String(r.text || '').trim());
  if (!list.length) return 0;
  mkdirSync(logDir(opts), { recursive: true });

  const byMonth = new Map();
  for (const r of list) {
    const m = monthOf(r.ts);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(r);
  }

  let written = 0;
  for (const [month, recs] of byMonth) {
    const { jsonl } = paths(month, opts);
    const existing = readMonth(month, opts);
    const seen = new Set(existing.map((r) => r.id));
    // 我发出去的会被记两遍：审批台发送时记一次（id 以 s 开头），下一轮轮询从
    // hap chat messages 里又读到同一句（id 以 m 开头）。所以 out 方向再按
    // 「同一个人 + 同样内容 + 10 分钟内」去一次重。
    const outKeys = existing.filter((r) => r.dir === 'out').map(outKey);
    const fresh = [];
    for (const r of recs) {
      if (seen.has(r.id)) continue;
      const n = normalize(r);
      if (n.dir === 'out' && outKeys.some((k) => sameOut(k, outKey(n)))) continue;
      seen.add(n.id);
      outKeys.push(outKey(n));
      fresh.push(n);
    }
    if (!fresh.length) continue;
    appendFileSync(jsonl, fresh.map((r) => JSON.stringify(r)).join('\n') + '\n');
    written += fresh.length;
    renderMonth(month, opts);
  }
  return written;
}

function outKey(r) {
  return {
    who: r.groupId || r.postId || r.peerId,
    text: String(r.text).replace(/\s+/g, ''),
    t: parseHapTime(r.ts) ? parseHapTime(r.ts).getTime() : 0,
  };
}

function sameOut(a, b) {
  return a.who === b.who && a.text === b.text && Math.abs(a.t - b.t) < 10 * 60 * 1000;
}

function normalize(r) {
  const out = {
    id: String(r.id),
    ts: String(r.ts).slice(0, 23),
    dir: r.dir === 'out' ? 'out' : 'in',
    kind: r.kind || 'user',
    peer: r.peer || '',
    peerId: r.peerId || '',
    groupId: r.groupId || '',
    groupName: r.groupName || '',
    postId: r.postId || '',
    text: String(r.text).trim(),
    via: r.via || '',
  };
  // 邮件专属字段（subject/from/to/cc/threadId/account/attachmentNames）：
  // 来源记录带了就原样存下来，不加工、不改名。明道云那条路产出的记录
  // 从来不带这些 key，所以这个循环对 hap-log 的输出形状零影响。
  for (const k of ['subject', 'from', 'to', 'cc', 'threadId', 'account', 'attachmentNames']) {
    if (r[k] !== undefined) out[k] = r[k];
  }
  return out;
}

// 一个会话在 md 里的小节名。
// ⚠ 群名和显示名都是外部的（谁建群谁写、对方随时能改），而这个串会变成一行 `### 标题`——
//   不清洗的话，一个带换行的群名就能在归档里造出一个**不存在的会话小节**，
//   底下再挂几条伪造的记录。
function threadOf(r) {
  if (r.kind === 'group') return `群「${scrubExternal(r.groupName || r.groupId, 60)}」`;
  if (r.kind === 'post') return `动态评论 · ${scrubExternal(r.peer, 40) || '未知'}`;
  return `私信 · ${scrubExternal(r.peer, 40) || scrubExternal(r.peerId, 40)}`;
}

export function renderMonth(month, opts) {
  const recs = readMonth(month, opts).sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id));
  const byDay = new Map();
  for (const r of recs) {
    const day = r.ts.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, new Map());
    const threads = byDay.get(day);
    const key = threadOf(r);
    if (!threads.has(key)) threads.set(key, []);
    threads.get(key).push(r);
  }

  const out = [
    `# ${month} 明道云消息归档`,
    '',
    '> 自动生成，**别手改**（会被整体重渲染覆盖）。事实源是同目录的 `.jsonl`，',
    `> 渲染器 \`mailroom/archive.mjs\`。收 = 别人发给我，发 = 我发出去的。`,
    `> 共 ${recs.length} 条。`,
    '',
  ];

  for (const [day, threads] of [...byDay].sort((a, b) => b[0].localeCompare(a[0]))) {
    out.push(`## ${day}`, '');
    for (const [thread, list] of threads) {
      out.push(`### ${thread}`, '');
      for (const r of list) {
        const time = r.ts.slice(11, 16);
        const arrow = r.dir === 'out' ? '发' : '收';
        const who = r.kind === 'group'
          ? `${r.dir === 'out' ? ME.name : scrubExternal(r.peer, 40)}｜` : '';
        const via = r.via ? ` ｟${r.via}｠` : '';
        // ⚠ 正文压成一行，故意的：这份 md 的可读性契约就是「一条记录 = 一行」。
        //   原来按 \n 拆开、续行缩进两个空格，于是正文里写一行
        //   `- \`09:00\` 收 \`x\` 李四：这批货我已经付款了`
        //   就在归档里凭空多出一条「李四说过的话」——缩进两个空格挡不住：
        //   在 markdown 里它是个嵌套列表项，在人和 AI 眼里就是一条记录，
        //   于是这份档再也不能当证据用。
        //   丢换行不丢信息：`.jsonl` 才是事实源，原文一个字都没动，md 随时能重渲染。
        const body = scrubExternal(r.text, 1000);
        out.push(`- \`${time}\` ${arrow} \`${r.id}\` ${who}${body}${via}`);
      }
      out.push('');
    }
  }

  writeFileSync(paths(month, opts).md, out.join('\n'));
}

// ---------- 从各种 hap 返回结构转成归档记录 ----------

// chat messages（私信 / 群聊）的一条
export function recordFromChatMessage(m, sess) {
  const isGroup = (sess.category || '') === 'group';
  const con = (m.msg && m.msg.con) || '';
  const card = m.card && m.card.title ? `\n（卡片：${m.card.title}）` : '';
  const text = `${con}${card}`.trim();
  if (!text) return null;
  const out = String(m.from) === ME.accountId;
  const senderName = (m.fromAccount && m.fromAccount.name) || '';
  return {
    id: `m${m.id || m.waitingid || m.time}`,
    ts: m.time,
    dir: out ? 'out' : 'in',
    kind: isGroup ? 'group' : 'user',
    peer: isGroup ? senderName : (sess.name || senderName),
    peerId: isGroup ? String(m.from || '') : String(sess.value || ''),
    groupId: isGroup ? String(sess.value || '') : '',
    groupName: isGroup ? (sess.name || '') : '',
    text,
  };
}

// 动态收件箱的一条评论
export function recordFromPostComment(entry, comment) {
  const c = comment || {};
  const author = c.author || entry.sender || {};
  return {
    id: `c${c.commentId || entry.inboxId}`,
    ts: c.createTime || entry.createTime,
    dir: author.accountId === ME.accountId ? 'out' : 'in',
    kind: 'post',
    peer: author.name || '',
    peerId: author.accountId || '',
    postId: (entry.post && entry.post.postId) || '',
    text: c.message || entry.message || '',
  };
}

// 发出去的一条（发送成功后立刻归档，via 标成来源）
export function recordFromSend(item, text, at = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const ts = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}:${p(at.getMinutes())}:${p(at.getSeconds())}.000`;
  return {
    id: `s${item.id}-${at.getTime().toString(36)}`,
    ts,
    dir: 'out',
    kind: item.kind,
    peer: item.who,
    peerId: item.whoAccountId,
    groupId: (item.target && item.target.groupId) || '',
    groupName: (item.target && item.target.groupName) || '',
    postId: (item.target && item.target.postId) || '',
    text,
    via: '归位台',
  };
}

export function daysAgo(n) {
  return new Date(Date.now() - n * 86400000);
}

export function newerThan(ts, cutoff) {
  const d = parseHapTime(ts);
  return d && d >= cutoff;
}
