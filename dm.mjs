// 主动发起私信 —— 把「发给谁」变成一个能喂进 sendReply 的合成段。
//
// 为什么需要这个文件：
//   `bin/send.mjs` 原本只认 `--seg <段id>`，也就是**只能回复一条已经收到的消息**。
//   要主动私信一位同事（例：跟某同事对齐活动赞助归属）就没有入口 ——
//   她从没私信过 Andy，段库里只有群段、邮件段和应用通知段，没有段可回。
//   而绕过 send.mjs 直接敲 `hap chat send-to-one` 正是曾经那次事故的走法，
//   明道云没有撤回接口。所以补的是**入口**，不是第二条路。
//
// ⚠⚠ 本文件不发消息、不判授权、不补身份声明、不查称呼。
//   那四样全部留在 `send.mjs`，一个字都不许搬过来 —— 理由见那个文件顶部：
//   断言只该有一处，两处等于没有（各自以为另一处会挡）。
//   这里只干三件纯粹的事：把人名解析成 accountId、拼出段的形状、算确认码。
//   合成段会原样走完 sendReply 的每一道门，跟回复一条真实消息**没有任何区别**。

import { hap, hashId, localIso } from './lib.mjs';
import { policy } from './config.mjs';

// ---------- 收件人解析 ----------
//
// ⚠⚠ `people` 是调用方（bin/send.mjs 的 callNameGate）刚读到的那一份通讯录，
//   显式传进来 —— 一条路只读一次，跟称呼门用的是同一份。
//   不这么做的话，这里读一次、门里读一次，两处分家，正是复审逮到的那类洞。
//
// 解析顺序（先本地后远端，是**故意**的）：
//   1. 本地 contacts.json 里精确命中且带 md_account_id —— 最硬，且不打网络；
//   2. 退回 `hap contact resolve` 搜公司通讯录。
//
// ⚠ 歧义一律拒绝，绝不「取第一个」：发错人跟发错内容一样收不回来。
//   多个候选就把候选打出来，让人用 --account-id 指名道姓。
export function resolveRecipient(keyword, { people = null, io = {} } = {}) {
  const kw = String(keyword || '').trim();
  if (!kw) throw new Error('拒绝发送：没说发给谁。');

  const list = Array.isArray(people) ? people : [];
  // 本地精确命中。⚠ 只认精确相等，不做模糊包含 —— 「韩梅」不该悄悄命中「韩梅梅」。
  const local = list.filter((c) => c && c.md_account_id
    && (c.name === kw || c.nickname === kw || c.en_name === kw
      || (Array.isArray(c.aliases) && c.aliases.includes(kw))));
  if (local.length === 1) {
    return { accountId: local[0].md_account_id, name: local[0].name || kw, from: 'contacts.json' };
  }
  if (local.length > 1) {
    throw new Error(`拒绝发送：「${kw}」在本地通讯录里对上了 ${local.length} 个人`
      + `（${local.map((c) => c.name).join(' / ')}），用 --account-id 指定是哪一位。`);
  }

  const call = io.hap || hap;
  const res = call(['contact', 'resolve', kw]);
  // ⚠ 不看返回里的 `total`：实测 `hap --json contact resolve 韩梅` 给的是
  //   total=0 而 candidates 有 1 条。以数组长度为准。
  const cands = (res && Array.isArray(res.candidates)) ? res.candidates : [];
  if (!cands.length) {
    throw new Error(`拒绝发送：通讯录里找不到「${kw}」。`);
  }
  if (cands.length > 1) {
    const lines = cands.slice(0, 10).map((c) => `    ${c.name || '?'}  ${c.company || ''} ${c.profession || ''}\n      --account-id ${c.id}`);
    throw new Error(`拒绝发送：「${kw}」对上了 ${cands.length} 个人，不猜。用 --account-id 指定：\n${lines.join('\n')}`);
  }
  const c = cands[0];
  if (!c.id) throw new Error(`拒绝发送：「${kw}」解析出来的候选没有 account id。`);
  return { accountId: String(c.id), name: c.name || kw, from: 'hap contact resolve' };
}

// ---------- 合成段 ----------
//
// 拼出来的形状必须让 send.mjs 那几个函数认得出来，逐个对应：
//   typeOf()      读 sourceType || kind        → 'user'
//   recipientOf() 读 who / whoAccountId / target.accountId → 称呼门按人判
//   adapterFor()  读 sourceKind                → 'mingdao'
//   sendVia()     读 target.accountId          → chat send-to-one
//   recordSent()  读 filed / id / sourceLabel  → 落回 inbox.md
//
// ⚠ `filed` 不给就是 null：recordSent 拿不到落点只会 log 一句，**绝不会**照着
//   一个路径 mkdir 造出假任务目录（见 send.mjs 的 inboxDirFor）。
export function synthDm({ accountId, name, filed = null, at = null }) {
  const acc = String(accountId || '').trim();
  if (!acc) throw new Error('拒绝发送：收件人没有 account id。');
  const when = at || localIso();
  return {
    id: `dm-${hashId('dm', acc, when)}`,
    sourceKind: 'mingdao',
    kind: 'user',
    sourceLabel: '明道云 · 私信',
    who: String(name || '').trim(),
    whoAccountId: acc,
    target: { accountId: acc },
    filed,
  };
}

// ---------- 主动在一个任务下留言 ----------
//
// 2026-08-13 补的第二个入口，跟 synthDm 同一个道理：`--seg` 只能**回**任务里
// 已经有人 @ 我的那条评论；「我派了个活、想去任务下问一句进度」在段库里没有段可回，
// 于是唯一的出路成了 `hap task comment`，而那条命令在 deny 名单里（正是要堵的）。
// 补入口，不是补第二条路 —— 合成段照样走完 sendReply 的每一道门。
//
// 形状对应（跟 synthDm 那份注释一一对照着看）：
//   typeOf()      读 sourceType → 'notice'
//   recipientOf() 读 who / whoAccountId → 称呼门按**任务负责人**判
//   replyViaOf()  读 target.replyVia → 'task' → 🔴 档 + sendVia 走 task comment
//   lineOf()      读 sourceType==='notice' && target.taskId → 同任务算同线
//
// ⚠⚠ `sourceType` 必须是 `'notice'`，不能只写 `kind`：recheck.mjs 的 lineOf 只认
//   sourceType。写漏了这道「发送前重收」的门就退化成只比段 id，**同一个任务下别人
//   在你拟稿到点头之间新发的评论判不出同线、直接放行** —— 那正是 2026-08-12
//   Ops Team 那次说岔的形状，而任务评论的受众是任务全体参与人，比群还难收场。
//
// ⚠ 收件人（who / whoAccountId）给的是**任务负责人**，只为让称呼门按人判得准。
//   真正的受众是这个任务的全体参与人，所以这一路恒为 🔴，没有 🟢/🟡 的口子。
export function synthTask({ taskId, name, accountId = '', taskName = '', filed = null, at = null }) {
  const tid = String(taskId || '').trim();
  if (!tid) throw new Error('拒绝发送：没说要评论哪个任务（--task <taskId>）。');
  const when = at || localIso();
  return {
    id: `task-${hashId('task', tid, when)}`,
    sourceKind: 'mingdao',
    sourceType: 'notice',
    kind: 'notice',
    sourceLabel: '明道云 · 任务评论',
    who: String(name || '').trim(),
    whoAccountId: String(accountId || '').trim(),
    target: { replyVia: 'task', taskId: tid, recordName: String(taskName || '').trim() },
    filed,
  };
}

// ---------- 主动在一张工作表的某条记录下留讨论 ----------
//
// 2026-08-14 补的第三个入口：主动在某条工作表记录下添加讨论/评论（支持 --worksheet/--row 或 --record <wsId>/<rowId>）。
// 合成段走完 sendReply 的每一道门。
//
// 形状对应（跟 synthTask 一致）：
//   typeOf()      读 sourceType → 'notice'
//   recipientOf() 读 who / whoAccountId → 称呼门按对方判
//   replyViaOf()  读 target.replyVia → 'record' → 🔴 档 + sendVia 走 worksheet record add-discussion
//   lineOf()      读 sourceType==='notice' && target.worksheetId && target.rowId → 同记录算同线
export function synthRecord({
  worksheetId, rowId, appId = '', viewId = '', replyId = '', recordName = '', name = '', accountId = '', filed = null, at = null,
}) {
  const wid = String(worksheetId || '').trim();
  const rid = String(rowId || '').trim();
  if (!wid || !rid) throw new Error('拒绝发送：没说要评论哪张工作表的哪条记录（--record <worksheetId>/<rowId> 或 --worksheet <id> --row <id>）。');
  const when = at || localIso();
  return {
    id: `record-${hashId('record', wid, rid, when)}`,
    sourceKind: 'mingdao',
    sourceType: 'notice',
    kind: 'notice',
    sourceLabel: '明道云 · 记录讨论',
    who: String(name || '').trim(),
    whoAccountId: String(accountId || '').trim(),
    target: {
      replyVia: 'record',
      worksheetId: wid,
      rowId: rid,
      appId: String(appId || '').trim(),
      viewId: String(viewId || '').trim(),
      replyId: String(replyId || '').trim(),
      recordName: String(recordName || '').trim(),
    },
    filed,
  };
}

// ---------- 主动在一条动态下留一条评论 ----------
//
// 2026-08-16 补的第四个入口，跟 synthTask 同一个道理：`--seg` 只能**回**动态评论区里
// 已经有人 @ 我们、或者我们跟帖过的那条评论；主动去一条从没被 @ 过的动态下发评论
// （比如老板发到全体群的进展帖）在段库里没有段可回，唯一出路是 `hap post comment`
// —— 而那条命令在 deny 名单里。补的是入口，不是第二条路。
//
// 形状刻意贴 connect/hap.mjs pull() 给出的 organic post 候选（kind:'post' +
// target.postId），这样 describe()/sendVia() 不用为「主动发起」另写一支分支：
//   describe()    读 item.kind === 'post'  → '明道云 · 动态评论'
//   sendVia()     读 item.kind === 'post'  → hap post comment <postId> -m <body>
//   recipientOf() 落到默认的 user 分支（post 没有 group 判据），称呼门按 who 判
//
// ⚠ 受众是这条动态能看到的所有人（这次是明道全体群），比私信广得多，
//   bin/send.mjs 里恒判 🔴，没有 --auto 的口子——跟 synthTask 一个待遇。
// ⚠ lineOf()（recheck.mjs）认不出 post 的稳定线，退回按段 id 比对（窄但安全，
//   是既有、故意的取舍，见 recheck.mjs 顶部注释），这里不额外处理。
export function synthPost({ postId, name = '', accountId = '', filed = null, at = null }) {
  const pid = String(postId || '').trim();
  if (!pid) throw new Error('拒绝发送：没说要评论哪条动态（--post <动态 id>）。');
  const when = at || localIso();
  return {
    id: `post-${hashId('post', pid, when)}`,
    sourceKind: 'mingdao',
    kind: 'post',
    sourceLabel: '明道云 · 动态评论',
    who: String(name || '').trim(),
    whoAccountId: String(accountId || '').trim(),
    target: { postId: pid },
    filed,
  };
}

// ---------- 主动发一条群消息 ----------
//
// 2026-08-17 补的第五个入口：`--seg` 只能**回**一条群里已经收到的消息，主动往群里
// 发一条没人先发起过的公示（例：欢迎新客户名单公示、活动通知）在段库里没有段可回，
// 唯一出路是 `hap chat send-to-group` —— 而那条命令在 deny 名单里。补的是入口，
// 不是第二条路：合成段照样走完 sendReply 的每一道门。
//
// 形状刻意贴 connect/hap.mjs pull() 给群消息候选的样子（`kind:'group'` +
// `target.groupId/groupName`），这样 describe()/sendVia() 不用为「主动发起」
// 另写一支分支：
//   describe()     读 item.kind === 'group'         → '明道云 · 群「xxx」'
//   recipientOf()  读 typeOf(item) === 'group'       → { kind: 'group' }（称呼门退回全表判定）
//   sendVia()      读 item.kind === 'group'          → hap chat send-to-group -g <groupId>
//
// ⚠ 受众是整个群，比私信、比任务评论都广，`bin/send.mjs` 里恒判 🔴，
//   没有 --auto 的口子 —— 跟 synthTask / synthPost 一个待遇。
// ⚠ 群 id/群名解析（`hap chat list` 里筛 category='group'）留给调用方（bin/send.mjs），
//   这里只管拼段的形状，不碰网络 —— 跟 synthTask 的收件人解析放在调用方是同一个道理。
export function synthGroup({
  groupId, groupName = '', filed = null, at = null,
}) {
  const gid = String(groupId || '').trim();
  if (!gid) throw new Error('拒绝发送：没说要发到哪个群（--group <群id 或群名>）。');
  const when = at || localIso();
  return {
    id: `group-${hashId('group', gid, when)}`,
    sourceKind: 'mingdao',
    kind: 'group',
    sourceLabel: `明道云 · 群「${groupName || gid}」`,
    who: '',
    whoAccountId: '',
    target: { groupId: gid, groupName: String(groupName || '').trim() },
    filed,
  };
}

// ---------- 确认码 ----------
//
// ⚠⚠ 这是 Andy 要的那道「发之前让我审核」。为什么不用 stdin 问一句 y/n：
//   跑这条命令的往往是 Claude，它那边没有 tty，一问就卡死；而权限确认框在
//   `defaultMode: bypassPermissions` 下根本不弹（见 send.mjs 顶部那段）。
//   所以改成**两步**：第一步只预览、把要发的正文原样打出来并给一个码，
//   Andy 在对话里看过点头，第二步带着这个码才真发。
//
// 码是从**收件人 + 真正要发出去的那一版正文**算出来的（body 已补好身份声明）。
// 改一个字、换一个人，码就对不上 —— 也就是说「他看到的」和「发出去的」被钉成同一份。
// 不是防外人的密码，是防「预览之后内容被悄悄改掉」，所以短的就够。
export function confirmToken(accountId, body) {
  return hashId('dm-confirm', String(accountId || ''), String(body || '')).slice(0, 10);
}

// ---------- 别在休息时间发 ----------
//
// 全局 CLAUDE.md：代我发消息给同事只在**工作日 09:00–19:00**。
// 「对方秒回不代表没打扰」—— 规则写在文档里拦不住人，所以路过必检。
// ⚠ 这道门只管**主动发起**这条路：回复对方刚发来的消息不算打扰，`--seg` 那条路不受影响。
// 显式出口是 `--off-hours`（真有急事时用），跟称呼门的 --formal-name 一个道理。
const DAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function offHours(d = new Date()) {
  const { days, start, end } = policy().workHours || {};
  // 配置里把 workHours 整个删掉 = 不限时段（这是显式选择，不是缺省）
  if (!Array.isArray(days) || !days.length) return '';
  const day = d.getDay();          // 0=周日 6=周六
  const h = d.getHours();
  if (!days.includes(day)) return `今天是${DAY_NAMES[day]}`;
  if (h < start) return `现在才 ${h} 点`;
  if (h >= end) return `现在已经 ${h} 点`;
  return '';
}
