// 自动回复的笼子 —— 「哪一条我可以不问 Andy 就直接发」。
//
// 2026-08-12 Andy 定的三档，这个文件只实现最松的那一档（🟢）：
//   🟢 自动发   —— 不问他。**必须同时**满足下面 7 条客观条件，本文件逐条验。
//                 （2026-08-13 补第 7 条「任务评论」，前 6 条是 Andy 拍的，一个字没动。）
//   🟡 发完报备 —— 现在的行为（`bin/send.mjs` 直接发），发完在对话里说一声。
//   🔴 他点头   —— 两步确认码。主动私信（`--to`）、群消息、任务评论走这档。
//
// ⚠⚠ 这个文件**不判内容**。「这句话是不是纯回执」是语义判断，脚本做不了，那部分归模型
//   （规矩写在 `skill/SKILL.md`）。这里做的是**焊死一个笼子**：模型的语义判断只能在笼子
//   里面生效，笼子外面一条都不许自动发。所以这几条全是机器能验的死条件，没有一条留给解释。
//
// ⚠ 为什么值得做这件事：原来「每条都要 Andy 那句发」在实际里被稀释成了「模型自己看着办」
//   （确认框在 bypassPermissions 下不弹，见 send.mjs 顶部）。与其留一条名存实亡的规矩，
//   不如把真正低风险的那一小撮明确放开、其余收紧，并且**每一条自动发的都留痕**。
//
// ⚠ 留痕不是可选项。写不进账本也不许拦发送（消息已经出去了），但写不进去
//   这件事必须打出来 —— 没有日志的自动发送等于没人管。

import { readOutbox } from './outbox.mjs';
import { ownerName } from './lib.mjs';
import { policy } from './config.mjs';
import { offHours } from './dm.mjs';

// 笼子的三个数。**这是你自己拍板的边界**，在 ~/.mailroom/config.json 的 policy 里改，
// 别在代码里顺手调——改这三个数等于放宽「什么情况下可以不问你就发」。
// ⚠ 现取不缓存：setup 写完配置后当前进程就该看到新值。
export function autoMaxChars() { return policy().autoMaxChars; }        // 正文原文（不含自动补的身份声明）
export function autoWindowHours() { return policy().autoWindowHours; }
export function autoMaxPerWindow() { return policy().autoMaxPerWindow; } // 同一个人、同一个窗口内，自动发不超过这么多条

// 同一个收件人在窗口内已经自动发了几条。
// ⚠ 按 accountId 数，不按人名：改个称呼不该重置计数。
// ⚠⚠ 只数 tier === '🟢'。2026-08-12 起 🟢🟡🔴 记在同一本账（outbox.jsonl）里，
//   不筛档位的话，🟡 发几条就能把 🟢 的额度吃光 —— 那道门管的是「自动发不许变成
//   替他聊天」，跟他过目过的 🟡 没关系。
export function recentCount(accountId, { now = new Date(), rows = null } = {}) {
  const acc = String(accountId || '');
  if (!acc) return 0;
  const list = rows || readOutbox();
  const floor = now.getTime() - autoWindowHours() * 3600 * 1000;
  return list.filter((r) => {
    if (!r || String(r.accountId || '') !== acc) return false;
    if (String(r.tier || '') !== '🟢') return false;
    const t = Date.parse(r.at || '');
    return Number.isFinite(t) && t >= floor;
  }).length;
}

// 收件人是不是本地通讯录里认得的同事。
// ⚠ 只认 `md_account_id` 精确相等：这一档只放开明道云私信，认不出的人一律不自动发。
//   （通讯录里 322 人只有 41 个带 md_account_id —— 认不出就是认不出，不猜。）
function knownColleague(accountId, people) {
  const acc = String(accountId || '');
  if (!acc) return false;
  return (Array.isArray(people) ? people : [])
    .some((c) => c && String(c.md_account_id || '') === acc);
}

// ---------- 笼子 ----------
//
// 返回 { ok, violations: [句子] }。**一条都不许缺**：ok 只在 violations 为空时为真。
// ⚠ 违规是**全部列出来**而不是碰到第一条就返回：不然模型改一条跑一次，
//   来回四五轮，反而更容易在中途放弃规矩直接走 🟡。
//
// initiated     —— 这次是不是主动发起（`--to`）。主动开口一律不自动，不管内容多轻。
// isDraft       —— 适配器会存草稿（外部邮件）。草稿轮不到这一档，走它自己那条路。
// isTaskComment —— 这条回的是明道云任务里的评论（2026-08-13 加的第 7 条，见下）。
export function cageCheck({
  initiated = false,
  to = {},
  rawText = '',
  isDraft = false,
  formalName = false,
  people = null,
  isTaskComment = false,
  now = new Date(),
  rows = null,
} = {}) {
  const v = [];
  const text = String(rawText || '').trim();

  if (initiated) {
    v.push('这是主动发起的私信，不是回复对方。只回不主动 —— 主动开口一律走 🔴 两步确认码。');
  }
  if (to.kind === 'group') {
    v.push('这是群消息。群里受众广、传得远，只能走 🔴。');
  }
  // ⚠⚠ 2026-08-13 补的第 7 条（终审逮到的洞）：bin/send.mjs 的 🔴 名单是
  //   `wantDm || isGroup || isTaskComment`，而这个笼子当时只排「主动发起」和「群」。
  //   于是任务评论段带 `--auto` 能过笼子 → 账上记成 🟢、实际却走 🔴 的确认码，
  //   还白占掉那个人 24 小时里的 🟢 额度。理由跟群一样：受众是这个任务的**全体
  //   参与人**，比私信广。⚠ 只补这一条，上面那 6 条是 Andy 拍板的边界，别顺手动。
  if (isTaskComment) {
    v.push('这是任务里的评论。受众是这个任务的全体参与人，比私信广，只能走 🔴。');
  }
  if (isDraft) {
    v.push('这条会被存成草稿（外部收件人的邮件），不归自动发这一档。');
  }
  if (formalName) {
    v.push(`带了 --formal-name（称呼门/自称门的绕过口）。绕过门的事永远要 ${ownerName()} 点头。`);
  }
  if (!knownColleague(to.accountId, people)) {
    v.push(`收件人在 contacts.json 里认不出来（accountId=${to.accountId || '空'}）。`
      + '只对通讯录里带 md_account_id 的同事自动发。');
  }
  if ([...text].length > autoMaxChars()) {
    v.push(`正文 ${[...text].length} 字，超过 ${autoMaxChars()} 字。`
      + `长回复说明有实质内容，实质内容要 ${ownerName()} 看一眼。`);
  }
  const off = offHours(now);
  if (off) {
    v.push(`${off}，不在工作日 09:00–19:00 里。休息时间一条都不自动发。`);
  }
  const n = recentCount(to.accountId, { now, rows });
  if (n >= autoMaxPerWindow()) {
    v.push(`${autoWindowHours()} 小时内已经自动发给这个人 ${n} 条（上限 ${autoMaxPerWindow()} 条）。`
      + `再往下就不是回执了，是在替 ${ownerName()} 聊天。`);
  }

  return { ok: v.length === 0, violations: v };
}
