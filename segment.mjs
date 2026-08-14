// 把一批原始消息聚成「段」。
//
// ⚠⚠ 归位的单位是「一段对话」，不是「一条消息」——同事在明道云私信里常常连发好几条
//   （「你好」/「仓库地址我发你」/ 链接 /「权限我明天开」），一条条拆开落盘读起来是碎的，
//   读不出来龙去脉；而且判断次数从 4 次降到 1 次，AI 猜错的机会也少 4 倍。
//   见 PLAN.md「数据模型」一节和 Task 4。

import { hashId, log } from './lib.mjs';

// ---------- 会话标识 ----------
//
// 「同一条线」怎么认：私信用 whoAccountId，群用 target.groupId，动态用 target.postId，
// 通知用 target 里能定位的那个 id —— 都取不到就退回 who（宁可退化成按人名聚，也别不聚）。
//
// ⚠⚠ 通知（notice）必须能把「任务 A / 任务 B / 记录 X」分开，绝不许一律退回 who。
//   2026-08-13 终审实跑的活 bug：noticeId / id / eventId 这三个字段**通知的 target 里
//   一个都没有**（fetch.noticeReplyTarget 的 task 分支只放 taskId/recordName，record
//   分支只放 worksheetId/rowId），于是所有通知一律按「谁发的」聚成一条线；而
//   toSegments 里 `bucket.target = c.target` 取的是最新那个 —— 同一个人在任务 A、
//   任务 B 各评论一次，并成 1 段、target.taskId 是 B；隔 2 小时切成两段，**两段的
//   taskId 都是 B**。回「任务 A 那一段」会把评论发进任务 B，发给一整组不相干的人。
//   ⚠⚠ 两步确认码挡不住它：预览只打「发给：某某　经由：明道云 · 任务通知」，
//   确认码的 key 用的正是那个已经串了的 taskId，看不出任何异常。
//   所以 record（worksheetId+rowId）和 task（taskId）都要进 convId，顺序跟
//   fetch.noticeReplyTarget 挑落点的顺序一致（record 更准，排前面）。
//   带 `record:` / `task:` 前缀：rowId 和 taskId 都是明道云的 id，万一撞车就是
//   把一条记录讨论和一个任务并成一条线 —— 前缀不要钱，别省。
//
// ⚠⚠ 邮件必须走 threadId，绝不许落到 default 的 who（= 发件人**显示名**）。
//   评审实跑的活 bug：同一轮两封邮件显示名都叫「通知」，一封来自
//   crm-notify@corp-mail.com（内部）、一封来自客户 sales@client-corp.com —— 按显示名
//   聚成了 1 段，段的 target 取到内部那封，于是 deliveryMode 判成 'send'，
//   回复被**直发**给了内部那个地址，还把客户原文整段引了进去。
//   threadId 由 mail/normalize.mjs 填（Graph 的 conversationId / IMAP 的
//   References 首条或 Message-ID），取不到才退回这封信自己的 messageId ——
//   退到 messageId 最坏也只是「同一线程被拆成几段」，比并错线安全得多。
function convId({ sourceType, whoAccountId, who, target }) {
  const t = target || {};
  switch (sourceType) {
    case 'user': return whoAccountId || who;
    case 'group': return t.groupId || who;
    case 'post': return t.postId || who;
    // ⚠ 用 `||` 不用 `??`：空串跟「没有这个字段」是一回事（都定位不到任何东西），
    //   `??` 会把 `''` 当成一个有效的会话 id，于是 target 里带个空 taskId 的两条
    //   通知又并回同一条线上去 —— 正是这一条要修的形状。
    case 'notice': return t.noticeId || t.id || t.eventId
      || (t.worksheetId && t.rowId ? `record:${t.worksheetId}:${t.rowId}` : '')
      || (t.taskId ? `task:${t.taskId}` : '')
      || who;
    case 'mail': return t.threadId || t.messageId || who;
    default: return who;
  }
}

// 这条线属于哪个邮箱账号。⚠ 只认 target.account：顶层的 `account` 在 toSegments
//   那一步就掉了（段里只留 target），两边取值不一致的话 mergeInto 就再也匹配不上
//   toSegments 刚建的那条线。明道云的 target 没有这个字段，一律是空串，行为不变。
function accountOf(item) {
  const t = (item && item.target) || {};
  return t.account || (item && item.account) || '';
}

// candidate 上字段叫 kind，段上叫 sourceType——这里统一接受两种形状，
// 取哪个都行，谁传了就用谁。
// ⚠ 分隔符必须是可打印字符（这里用 `::`），别用 `\x00` 之类的控制字节——
//   之前踩过坑：一个真实的 NUL 字节混进源码，git 就把整个 segment.mjs 当成二进制文件，
//   diff/blame/grep 全废，对一个会反复迭代的核心文件是实打实的维护成本。
//
// ⚠⚠ 账号（accountOf）也是线的一部分：同一个人 30 分钟内分别发到你的两个邮箱
//   两个邮箱，不并成一段。并了的话段的 target 只能属于其中一个账号，回信要么用
//   ms365 的 replyToId 去回一封 IMAP 的信（Graph 必然 404，stage='unknown'，
//   Andy 会被告知「可能已经发出去了，别急着重发」），要么反过来。
//   明道云的候选没有 account，这一栏恒为空串，聚段行为一个字不变。
function lineKey(item) {
  const sourceType = item.sourceType || item.kind;
  return [
    item.sourceKind, sourceType, accountOf(item),
    convId({
      sourceType, whoAccountId: item.whoAccountId, who: item.who, target: item.target,
    }),
    item.who,
  ].join('::');
}

// 一条消息的去重键：**这条线** + 消息 id。轮询器靠它认出「这条消息上一轮已经收过了」。
//
// ⚠ 故意不含 who（lineKey 含）：群里的 who 是「这批消息里最后一位发言人」，
//   同一条消息在下一轮可能挂在另一个人名下，键跟着变就漏判成新消息，
//   于是同一句话入两次段、inbox.md 里出现两块。
// ⚠ 也故意不是「光按 msgId」：不同来源/不同会话的 id 撞车时会把别人的新消息误判成
//   收过了——那是真丢消息，比重复严重得多。
// ⚠ 「不含 who」这个承诺对 notice / default 两个分支**不完全成立**：认得出落点的通知
//   （记录讨论 / 任务评论）2026-08-13 起走 record:/task: 前缀，但认不出落点的那些
//   （日程提醒、加群通知、只带 sourceId 的任务通知）convId 仍然退回 who。
//   目前靠 fetch.mjs 给通知造的 msgId 里嵌了会话时间戳
//   （`notice-<category>-<time>`）兜住——同一条通知两轮拿到的 id 一样，去重仍然有效。
//   哪天通知的 id 换成别的形状，这两个分支要一起重看。
export function msgKey(item, msg) {
  const sourceType = item.sourceType || item.kind;
  return [
    item.sourceKind, sourceType,
    convId({
      sourceType, whoAccountId: item.whoAccountId, who: item.who, target: item.target,
    }),
    String((msg && msg.id) ?? ''),
  ].join('::');
}

// ---------- 时间解析：脏数据不许被无声无息地合并 ----------
//
// ⚠⚠ `at` 缺失或格式错时 `new Date(bad).getTime()` 是 NaN，`相减`也是 NaN。
//   如果直接拿这个 NaN 去跟 windowMs 比大小——不管用 `>` 还是 `<=`——NaN 参与的比较
//   恒为 false，很容易在某个分支上被悄悄当成「跟前后消息很近」而并进了不相干的对话里，
//   且不留任何痕迹（归位器无人值守，没人会发现）。
//   规矩：解析不出来就响亮地记一句日志（带上消息 id 和原始 at 值），然后**当作超窗处理**——
//   宁可多断一段，也别把脏数据并进别人的对话。
function timeMs(msg, context) {
  const t = new Date(msg && msg.at).getTime();
  if (Number.isNaN(t)) {
    log(`⚠ segment.mjs: 消息 at 解析失败，id=${(msg && msg.id) ?? '?'} at=${JSON.stringify(msg && msg.at)}（${context}），当作超窗处理`);
    return null;
  }
  return t;
}

// 按 at 排序，解析失败的（timeMs 返回 null）一律排到最后——它们之间、以及它们跟任何
// 合法时间的消息之间，间隔都按超窗处理（见下面 toSegments/mergeInto 里的 gap 计算），
// 不参与「相邻间隔 ≤ windowMin」的合并判断。
function sortByAt(msgs, context) {
  const withTime = msgs.map((m) => ({ m, t: timeMs(m, context) }));
  withTime.sort((a, b) => {
    if (a.t === null && b.t === null) return 0; // 都解析失败，维持原相对顺序（Array#sort 是稳定排序）
    if (a.t === null) return 1;
    if (b.t === null) return -1;
    return a.t - b.t;
  });
  return withTime;
}

// ---------- toSegments ----------
//
// candidate 形状（适配器给的）：
//   { sourceKind, kind, who, whoAccountId, target, msgs:[{id,at,text}], sourceLabel? }
// sourceLabel 是适配器 describe() 的结果，调用方（poll.mjs）负责挂上去，这里原样带过来。
export function toSegments(candidates, { windowMin = 30 } = {}) {
  const windowMs = windowMin * 60 * 1000;

  // 先按「同一条线」分桶——同一条线的消息哪怕被适配器拆成了两个 candidate
  // （比如分两批拉取），也得先合到一起再按时间切段，不能按 candidate 的边界切，
  // 否则「相邻间隔」会被 candidate 的拉取批次打乱。
  const buckets = new Map(); // lineKey -> { meta..., msgs:[] }
  for (const c of candidates || []) {
    const sourceType = c.kind;
    const key = lineKey(c);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        sourceKind: c.sourceKind,
        sourceType,
        convId: convId({
          sourceType, whoAccountId: c.whoAccountId, who: c.who, target: c.target,
        }),
        sourceLabel: c.sourceLabel,
        who: c.who,
        whoAccountId: c.whoAccountId,
        target: c.target,
        msgs: [],
      };
      buckets.set(key, bucket);
    }
    // target/sourceLabel 理论上同一条线不会变，兜底取最新遇到的那个 candidate 的值
    if (c.target !== undefined) bucket.target = c.target;
    if (c.sourceLabel !== undefined) bucket.sourceLabel = c.sourceLabel;
    for (const m of c.msgs || []) bucket.msgs.push(m);
  }

  const segments = [];
  for (const bucket of buckets.values()) {
    // ⚠ 消息不保证有序（适配器给的顺序不一定按时间），聚段前必须先排序，
    //   否则「相邻间隔」算出来是错的。解析失败的 at 交给 sortByAt 兜底处理。
    const withTime = sortByAt(bucket.msgs, '聚段排序');

    let run = [];
    let runLastT = null; // 当前 run 里最后一条消息的时间（ms），null = 解析失败
    const flush = () => {
      if (!run.length) return;
      const firstAt = run[0].at;
      const lastAt = run[run.length - 1].at;
      segments.push({
        id: hashId(bucket.sourceKind, bucket.sourceType, bucket.convId, bucket.who, firstAt),
        sourceKind: bucket.sourceKind,
        sourceType: bucket.sourceType,
        sourceLabel: bucket.sourceLabel,
        who: bucket.who,
        whoAccountId: bucket.whoAccountId,
        target: bucket.target,
        msgs: run,
        firstAt,
        lastAt,
        filed: null,
        dropped: false,
        waiting: null,
      });
      run = [];
    };
    for (const { m, t } of withTime) {
      if (run.length) {
        // 只有两边的时间都解析成功才能算出真实间隔；只要有一边解析失败就当超窗，
        // 强制断开——不让脏数据悄悄并进别人的对话。
        const gap = (t !== null && runLastT !== null) ? t - runLastT : Infinity;
        if (gap > windowMs) flush(); // 超窗，先把攒的这段收了再开新的
      }
      run.push(m);
      runLastT = t;
    }
    flush();
  }

  // 段之间按 firstAt 排一下，输出顺序稳定可预期，不依赖 Map 迭代顺序的偶然一致。
  // firstAt 解析失败的段（极少见，整段第一条消息 at 就是坏的）排到最后，同样不参与判断。
  segments.sort((a, b) => {
    const ta = new Date(a.firstAt).getTime();
    const tb = new Date(b.firstAt).getTime();
    if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
    if (Number.isNaN(ta)) return 1;
    if (Number.isNaN(tb)) return -1;
    return ta - tb;
  });
  return segments;
}

// ---------- mergeInto ----------
//
// existing 是库里已有的段（可能已经归位了）。对每个 fresh 段：
// 同一条线上、且距该线最新一段的 lastAt ≤ windowMin，就把消息追加进那一老段并沿用它的
// filed（"同一条线上后续消息自动跟进同一段，不再重新判断"）；超窗就作为新段返回，
// 等 Task 5 的归位器去判断。
//
// ⚠ 追加进老段时 lastAt 要更新，filed 不许被清空，id 不许变——这三条是数据模型的硬约束。
//
// ⚠⚠ 第四条（2026-08-10 补）：**target 也要跟着新消息走**。
//   老代码只 push msgs、只更新 lastAt，target 永远停在建段那一封上。后果是回信回错人：
//   同一条线上后来的那封邮件被追加进老段，而 sendVia / deliveryMode 读的是段的
//   target ——于是拿着**旧那封**的 messageId / external / replyTo 去回**新那封**。
//   实跑过的样子：老段的 target 是内部同事那封（external=false）→ 客户的新邮件
//   追加进来 → 判成「内部收件人，直发」→ graphSend 发到内部地址，还把客户原文引了进去，
//   命令行如实报「✓ 已发出」。
//   取的是 `{ ...老 target, ...新 target }` 而不是整体替换：
//     · 邮件的 target 每个键 mail/normalize.mjs 都必给（messageId/threadId/external/
//       replyTo/account/subject/from/to/cc/…），所以对邮件来说等价于整体替换，
//       没有旧值残留的余地；
//     · 明道云那边是纯保险：能并进同一段的前提是 lineKey 相等，而 lineKey 里已经含了
//       群的 groupId / 动态的 postId / 通知的 noticeId / 私信的 whoAccountId，
//       也就是说这些定位字段**本来就一样**，覆盖也是覆盖成同样的值；
//       万一某一轮的候选 target 少带了个字段（比如 groupName 没取到），
//       展开合并会保住老值，整体替换则会把它抹掉。
//   who / whoAccountId / sourceKind / sourceType 不动：它们是 lineKey 的组成部分，
//   能并到一起就说明它们本来就相等。
export function mergeInto(existing, fresh, { windowMin = 30 } = {}) {
  const windowMs = windowMin * 60 * 1000;
  // 浅拷贝一层：不改动调用方传进来的 existing/fresh 对象本身，返回的是一份新列表。
  // toSegments 对 candidates 兜了 `|| []`，这里对 existing/fresh 做同样的兜底——
  // 防御力要一致，不能一个函数抗 undefined 一个不抗。
  const result = (existing || []).map((s) => ({ ...s, msgs: [...s.msgs] }));

  for (const f of (fresh || [])) {
    const key = lineKey(f);
    // 同一条线上可能有多段（比如老的一段早归位了、这次又续上），
    // 挑 lastAt 最新的那一段作为「这条线现在续到哪了」的候选延续对象。
    // lastAt 解析失败的候选不被优先选中（除非它是唯一匹配），避免脏数据干扰选择。
    let best = null;
    let bestT = null;
    for (const s of result) {
      if (lineKey(s) !== key) continue;
      // ⚠⚠ 已丢弃的段是**死段**，绝不许当延续对象（评审实跑复现的活 bug）：
      //   某同事发「[OK]」被判丢弃 → 8 分钟后他发「客户合同今天必须签」→ 并进那个
      //   已丢弃的段。而 file.mjs 对 dropped 的段是直接 collect、连判定都不进
      //   （file.mjs:580 那句 `if (seg.dropped) { collect(seg); continue; }`），
      //   于是交给 claude 的段数 = 0，任何 inbox.md 里都没有这句话 —— 消息就这么没了。
      //   跳过它，新消息自成一段，照常进待判定队列。
      if (s.dropped) continue;
      const t = timeMs({ at: s.lastAt, id: s.id }, 'mergeInto 挑选延续段');
      if (!best || (t !== null && (bestT === null || t > bestT))) {
        best = s;
        bestT = t;
      }
    }
    const fT = timeMs({ at: f.firstAt, id: f.id }, 'mergeInto 判断是否超窗');
    // best 或 fresh 段的时间有一个解析失败，就没法算出真实间隔，一律当超窗处理。
    const gap = (best && fT !== null && bestT !== null) ? fT - bestT : Infinity;
    if (best && gap <= windowMs) {
      // 追加进老段：id/filed 原样不动，更新消息、lastAt 和 target（见上面第四条）。
      best.msgs.push(...f.msgs);
      best.msgs = sortByAt(best.msgs, 'mergeInto 追加后重排').map((x) => x.m);
      best.lastAt = best.msgs[best.msgs.length - 1].at;
      if (f.target) best.target = { ...(best.target || {}), ...f.target };
    } else {
      result.push({ ...f, msgs: [...f.msgs] });
    }
  }
  return result;
}
