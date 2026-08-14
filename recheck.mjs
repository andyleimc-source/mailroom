// 发送前的最后一道闸门：**再收一轮，看这条线上有没有新消息**。
//
// ⚠⚠ 曾经的真事故（Ops Team 群）：
//   收到创始人「这个素材可以部分用于官网首页 @我」，我们据此拟稿；
//   那条回复发出去，说的是「用在官网首页」。
//   可就在这中间的几分钟，创始人在同一个群里已经说了「未来就是线上的另一个地址」
//   ——我们手上那份是几分钟前的旧快照，压根不知道。
//   回复发出去才发现说岔了，而明道云没有撤回接口。
//
//   根因不是判断错，是**信息过期**：loop 15 分钟拉一次，拟稿到点头之间可能隔着好几分钟，
//   这段时间群里聊了什么，发送的人是瞎的。所以拦在发送前重收一轮，不是可选项。
//
// 判据只看**同一条线**（同群 / 同一个人的私信 / 同一封邮件的线程），别的线有新消息不拦——
// 拿一条无关私信去挡一封邮件，只会让人学会习惯性绕过这道门。
//
// 失败一律 fail-closed（拒发）：拉不到 = 不知道有没有新消息 = 跟「有新消息」同等对待。
// 显式出口是 `--skip-recheck`，用在明道云掉线但要发邮件这类场合，且会在输出里留痕。

import { acquireLock, releaseLock, runOnce } from './run.mjs';
import { dailymdRoot } from './lib.mjs';
import * as defaultStore from './store.mjs';

// 这条消息属于哪条「线」。
// ⚠ 不复用 segment.mjs 的 lineKey：那个还把 30 分钟时间窗算进去（同一个群隔一天是两段），
//   而这里要的恰恰是「不管分了几段，只要是同一个群/同一个人/同一个邮件线程就算同线」。
// ⚠⚠ 后来补 task / record 两条（终审逮到的）：任务评论这条通道一接上来，
//   通知就成了这道门最该管的形状 —— 任务评论归 🔴，恰恰是「拟稿 → 他点头」中间隔着
//   几分钟的那个事故形状（Ops Team 那次就是这么说岔的）。而这里原来没有
//   task 分支，通知一律退成 `{kind:'seg'}`，只比段 id；同一个任务下别人在这几分钟里
//   新发的评论会落进**另一个段**，这道门判不出同线、直接放行。record（记录讨论）
//   是同一个病，一起修。
//   ⚠ 认线的字段跟 segment.mjs 的 convId 保持一致（record 优先于 task，跟
//   fetch.noticeReplyTarget 挑落点的顺序一样），两处别各认各的。
export function lineOf(item) {
  const t = (item && item.target) || {};
  const st = item && item.sourceType;
  if (st === 'group' && t.groupId) return { kind: 'group', key: String(t.groupId) };
  if (st === 'user' && item.whoAccountId) return { kind: 'user', key: String(item.whoAccountId) };
  if (st === 'mail' && (t.threadId || t.messageId)) {
    return { kind: 'mail', key: String(t.threadId || t.messageId) };
  }
  if (st === 'notice' && t.worksheetId && t.rowId) {
    return { kind: 'record', key: `${t.worksheetId}:${t.rowId}` };
  }
  if (st === 'notice' && t.taskId) return { kind: 'task', key: String(t.taskId) };
  // 动态评论、日程提醒、认不出落点的通知这些认不出稳定的线，退回「就这一段」——
  // 宁可拦得窄，也别把一堆不相干的段算成同线，那样每次发送都会被无关消息挡下。
  return { kind: 'seg', key: String((item && item.id) || '') };
}

export function sameLine(seg, line) {
  if (!seg || !line) return false;
  const t = seg.target || {};
  switch (line.kind) {
    case 'group': return seg.sourceType === 'group' && String(t.groupId || '') === line.key;
    case 'user': return seg.sourceType === 'user' && String(seg.whoAccountId || '') === line.key;
    case 'mail': return seg.sourceType === 'mail'
      && (String(t.threadId || '') === line.key || String(t.messageId || '') === line.key);
    // ⚠ 同一个任务/同一条记录讨论下的段，不管被 30 分钟窗口切成了几段，都算同线。
    case 'task': return seg.sourceType === 'notice' && String(t.taskId || '') === line.key;
    case 'record': return seg.sourceType === 'notice'
      && !!t.worksheetId && !!t.rowId && `${t.worksheetId}:${t.rowId}` === line.key;
    default: return String(seg.id || '') === line.key;
  }
}

// 这条线上现在已知的所有消息 id。
export function msgIdsOnLine(segs, line) {
  const out = new Set();
  for (const seg of segs || []) {
    if (!sameLine(seg, line)) continue;
    for (const m of seg.msgs || []) if (m && m.id != null) out.add(String(m.id));
  }
  return out;
}

// 认证失败会不会瞎掉**这条线**。明道云掉线不影响邮件那条路，反之亦然——
// 一律拒发的话，一个来源坏了会把另一个来源也锁死。
export function authBlocks(item, authErrors) {
  const kind = (item && item.sourceKind) || '';
  for (const a of authErrors || []) {
    const k = String((a && a.kind) || '');
    if (kind === 'mingdao' && (k === 'mingdao' || k === 'hap')) return a;
    // 邮件来源的 kind 是账号代号（配置里 mail.accounts[].id），认不准就宁可拦下。
    if (kind === 'mail' && k !== 'hap') return a;
  }
  return null;
}

// 拿锁。loop 那边可能正在收一轮，等它跑完再收，别硬闯（两边同时收会踩水位线）。
async function withLock(fn, { tries = 6, waitMs = 1500, sleep } = {}) {
  const nap = sleep || ((ms) => new Promise((r) => { setTimeout(r, ms); }));
  for (let i = 0; i < tries; i++) {
    if (acquireLock()) {
      try { return await fn(); } finally { releaseLock(); }
    }
    if (i < tries - 1) await nap(waitMs);
  }
  return { lockBusy: true };
}

/**
 * 发送前再收一轮。
 * 返回 { ok, fresh, reason, got }：
 *   ok=true  → 这条线上没有新消息，可以发。
 *   ok=false → fresh 是这条线上新到的消息（可能为空，那时 reason 说明为什么还是拦）。
 */
export async function recheckBeforeSend(item, {
  dailymd = dailymdRoot(),
  store = defaultStore,
  runner = runOnce,
  lock = withLock,
} = {}) {
  const line = lineOf(item);
  const before = msgIdsOnLine(store.segments() || [], line);

  let r;
  try {
    r = await lock(() => runner({ dailymd, deferJudge: true }));
  } catch (e) {
    return { ok: false, fresh: [], got: 0, reason: `收一轮没跑起来：${String((e && e.message) || e)}` };
  }
  if (r && r.lockBusy) {
    return { ok: false, fresh: [], got: 0, reason: '另一轮 mailroom 正在收消息，等它跑完再发（重跑这条命令即可）。' };
  }

  const errs = (r && r.authErrors && r.authErrors.length)
    ? r.authErrors
    : ((r && r.authError) ? [{ kind: 'mingdao', message: r.authError }] : []);
  const blocked = authBlocks(item, errs);
  if (blocked) {
    return {
      ok: false,
      fresh: [],
      got: (r && r.got) || 0,
      reason: `${blocked.kind} 认证失败，这一轮没能确认有没有新消息：`
        + `${String(blocked.message || '').slice(0, 200)}`,
    };
  }

  const fresh = [];
  for (const seg of store.segments() || []) {
    if (!sameLine(seg, line)) continue;
    for (const m of seg.msgs || []) {
      if (!m || m.id == null || before.has(String(m.id))) continue;
      fresh.push({ id: String(m.id), at: m.at, text: m.text, who: seg.who, sourceLabel: seg.sourceLabel });
    }
  }
  fresh.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));

  if (fresh.length) {
    return { ok: false, fresh, got: (r && r.got) || 0, reason: '这条线上有新消息' };
  }
  return { ok: true, fresh: [], got: (r && r.got) || 0, reason: '' };
}
