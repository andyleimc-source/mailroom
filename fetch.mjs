// 明道云取数与规范化：从 tools/hap-desk/classify.mjs 扒过来，只留「拉消息」和「拉出来的东西
// 整理成 candidate 形状」这两件事。**所有 lane / 分道 / 打分 / 优先级逻辑删干净**——
// 旧版本这里还要判「这条该进 reply 道还是 noise 道」，判完才决定要不要让 Andy 看见；
// mailroom 不这样干：来什么收什么，一条不丢，归到哪个项目/任务、值不值得回，
// 全部下放给 file.mjs 里整批交给 claude 判断（这样任何一条消息都不会在拉取这一层被
// 静默过滤掉，出了漏判也能从 candidate 一路查到底，不用先怀疑是不是被分类器吃了）。
//
// 因为这层，以前 classify.mjs 里这些东西被砍掉，没有带过来：
//   mentionsMe / hitsKeyword / hitsList / classifyPostInbox 的 noisy 判定 / muteLane / loadLanes
//   —— 都是「这条算不算该回」的打分逻辑，一并删除；打分交给下游 AI 判断。
//   群消息也不再只挑「@我」的那几条，freshMsgs 里除我自己发的之外全部进 candidate，
//   避免出现"群里说了但没 @我，于是从来没人看见"的漏判。

import { hap, log, ME, parseHapTime, localIso } from './lib.mjs';

// 重新导出：旧版本 ME/parseHapTime 也从取数这层能拿到，避免调用方还要另外记一条
// 「这两个其实在 lib.mjs」——candidate 相关的代码习惯性从 fetch.mjs 找东西。
export { ME, parseHapTime };

// ⚠ 走 localIso 不走 toISOString：HAP 给的时间本来就是本地时间，转成 UTC 存进去，
//   inbox.md 那边按字符串切片一渲染就整整早 8 小时（见 lib.mjs localIso 的注释）。
function isoOrRaw(s) {
  const d = parseHapTime(s);
  return d ? localIso(d) : String(s || '');
}

function msgText(m) {
  const con = (m.msg && m.msg.con) || '';
  if (m.card && m.card.title) return `${con}\n（卡片：${m.card.title}）`.trim();
  return con;
}

// 会话第一次进监听（半年没说过话的人今天来了一句）时没有水位线，兜底只收最近这么久的。
// ⚠ 旧版本这个数字读自 settings()（审批台设置页可调），那套设置系统跟着 lane 一起被裁掉了，
//   mailroom 没有设置页，直接写死默认值——这不是打分逻辑，是防止倒历史的安全阀，留着。
const FIRST_SEEN_WINDOW_MIN = 20;

// ---------- 取数出错一律往上抛 ----------
//
// ⚠⚠ 本文件原来三处都是裸 `catch { return []; }`，那是老系统「收消息链死了两天
//   一直在丢消息」的模子本身：401、25 秒超时、代理抖动、CLI 非零退出，全被吞成
//   「这个会话零条新消息」。而水位线早在 `chat list` 一成功就被 watch.mjs 推过去了，
//   poll.mjs 的 lostWhy / finished 都不置位 —— 不回滚、不推 Bark、界面上照常显示
//   「刚刚收过一轮」，整套 restoreWatch 机器在这条路上一次都不会触发。
//
// 现在：出错就抛。401 抛的是 HapAuthError（lib.hap 抛的，原样往上传，别包起来，
// 包了 `instanceof` 就断了，上层认不出这是「全局掉线，整轮停下来喊 Andy 登录」）；
// 其余带上「哪个会话/哪个类目」的上下文再抛，日志里那句原文就是全部排查信息。
function rethrowFetch(e, what) {
  log(`⚠ 取数失败（${what}）：`, String((e && e.message) || e).slice(0, 300));
  throw e;
}

// 拉一个会话上次之后的新消息（双向都要，归档要记我自己发的）。
//
// ⚠ 踩过的坑：prevTime 是「上次看到这个会话时的水位线」，来自 hap-watch 的 seen 表。
//   一个会话第一次进监听时它是空的，如果直接 `if (!cut) return true` 会把 hap 给的
//   最近 25 条**全部**当成新消息——看到的就是一整段几个月前的聊天记录混着今天这一句。
//   没有水位线时改成时间窗兜底：只收最近 firstSeenWindowMin 分钟的；窗内一条都没有
//   （watch 的基线偏旧）就只收最新那一条——触发这次变化的本来就是它。
export function fetchFreshMessages(sess, prevTime, n = 25) {
  const category = sess.category || '';
  const args = category === 'group'
    ? ['--group-id', String(sess.value)]
    : ['--with-user', String(sess.value)];
  let msgs;
  try {
    msgs = hap(['chat', 'messages', ...args, '-n', String(n)]);
  } catch (e) {
    rethrowFetch(e, `会话 ${sess.name || ''}(${sess.value})`);
  }
  if (!Array.isArray(msgs)) return [];
  const sorted = [...msgs].sort((a, b) => String(a.time).localeCompare(String(b.time)));

  const mark = parseHapTime(prevTime);
  const cut = mark || new Date(Date.now() - FIRST_SEEN_WINDOW_MIN * 60000);
  const fresh = sorted.filter((m) => {
    const t = parseHapTime(m.time);
    return t && t > cut;
  });
  if (fresh.length || mark) return fresh;
  return sorted.slice(-1);
}

// 动态收件箱：拉一次，同时给归档器和归位层用。
export function fetchPostInbox(n = 20) {
  try {
    const res = hap(['chat', 'messages', '--category', 'post', '-n', String(n)]);
    return (res && res.list) || [];
  } catch (e) {
    return rethrowFetch(e, '动态收件箱');
  }
}

// 系统类收件箱（workflow / task / hr / app …）的中文名，给界面显示用。
// ⚠ 这份映射旧版本住在 lib.mjs 的 lanes.json 里（`notice_categories`），那是可配置的
//   lane 系统的一部分，被整个裁掉了。这几个类目本身不是「打分」，是明道云 `chat list`
//   固定给的分类值，写死在这儿：既不依赖 lane 配置，connect/hap.mjs 也能直接复用，
//   不用两边各自维护一份类目表。
export const NOTICE_NAMES = {
  workflow: '工作流', task: '任务', calendar: '日程', kc: '知识',
  hr: '人事', app: '应用', system: '系统',
};
export const NOTICE_CATEGORIES = Object.keys(NOTICE_NAMES);

// 通知类的收件箱明细。
//
// ⚠ 为什么非拉这一趟：`chat list` 给的通知只有一句正文，没有「回给谁」。
//   曾经踩到过：一位同事在任务里 @我，审批台给出了草稿却没有发送键，
//   因为那条队列数据的 target 是空的，系统根本不知道回哪去。
//   `chat messages --category X` 才带 sender / worksheetId / rowId / viewId，
//   有了它才谈得上「hap 里来的都能回」。
export function fetchNoticeInbox(category, n = 20) {
  try {
    const res = hap(['chat', 'messages', '--category', category, '-n', String(n)]);
    return (res && Array.isArray(res.list)) ? res.list : [];
  } catch (e) {
    return rethrowFetch(e, `${category} 通知收件箱`);
  }
}

// HTML 正文里的 @人：知识库 / 系统通知那几类不给 sender 字段，人埋在 <a data-accountid> 里。
function mentionedAccount(html) {
  const m = /data-accountid=["']([0-9a-f-]{36})["'][^>]*>@([^<]+)</i.exec(String(html || ''));
  return m && m[1] !== ME.accountId ? { accountId: m[1], name: m[2].trim() } : null;
}

// 一条通知明细 → 回复目标。四种结局，缺一不可：
//   record —— 应用里的记录讨论（有 worksheetId+rowId），能原地回到那条讨论下面
//   task   —— 任务里的评论 / @我（有 taskId），能回到这个任务下面（另起一条评论）
//   dm     —— 只认得出是谁发的（没有 taskId 的任务通知、加群通知…），回不到原处，退而私信本人
//   null   —— 日程提醒 / 流程报错 / HR 生日这种，机器发的，真没有可回复的对象
export function noticeReplyTarget(entry) {
  if (!entry) return null;
  const sender = (entry.sender && entry.sender.accountId)
    ? { accountId: entry.sender.accountId, name: entry.sender.name || '' }
    : mentionedAccount(entry.message);
  if (entry.worksheetId && entry.rowId) {
    return {
      via: 'record',
      who: sender,
      target: {
        worksheetId: entry.worksheetId,
        rowId: entry.rowId,
        viewId: entry.viewId || '',
        appId: entry.appId || '',
        replyId: entry.inboxId || '',       // 回在对方那条讨论下面，不是另起一条
        recordName: (entry.comment && entry.comment.recordName) || '',
      },
    };
  }
  // 任务里的评论 / @我。
  // ⚠ 顺序在 record 之后：两个 id 都在时 record 能原地回到对方那条讨论下面，更准。
  // ⚠⚠ 早期这一档不存在，注释里写着「任务讨论 hap CLI 没有写接口」——
  //   那句话已经过期了（`hap task comment` 实测存在）。没有 taskId 的任务通知
  //   （实测有，只带 sourceId）照旧退 dm，不猜。
  if (entry.taskId) {
    return {
      via: 'task',
      who: sender,
      target: {
        taskId: entry.taskId,
        recordName: (entry.comment && entry.comment.recordName) || '',
      },
    };
  }
  if (sender) return { via: 'dm', target: { accountId: sender.accountId }, who: sender };
  return null;
}

// 一个会话 + 它这轮的新消息（+ 通知类还要配上收件箱明细）→ candidate，或 null（这轮它没有
// 新内容）。candidate 形状渠道无关：{ sourceKind, kind, who, whoAccountId, target, msgs }，
// msgs 是 [{id, at, text}] 数组，at 是 ISO 字符串——由 segment.mjs 按时间聚段。
//
// ⚠ 旧版本叫 classifyChatSession，会在这里判「群里有没有 @我」「是不是屏蔽名单」，
//   算完了打上 lane 才决定进不进队列。这些全部删掉：群里所有人说的话（除了我自己发的）
//   原样进 msgs，值不值得回交给下游 AI 判断，不在这一层悄悄扔掉。
export function normalizeSession(sess, freshMsgs, noticeEntry = null) {
  const category = sess.category || '';

  // 系统 / 工作流 / 任务 / 日程 / HR / 应用：不是对话，`chat list` 只给最新一句。
  if (NOTICE_CATEGORIES.includes(category)) {
    const text = ((sess.msg && sess.msg.con) || '').trim();
    if (!text) return null;
    const rt = noticeReplyTarget(noticeEntry);
    const from = (noticeEntry && noticeEntry.sender) || (rt && rt.who) || null;
    return {
      sourceKind: 'mingdao',
      kind: 'notice',
      noticeCategory: category,
      channel: `${NOTICE_NAMES[category] || category}通知`,
      // 显示名优先用真人——一整列都写「任务」看不出是谁找我
      who: (from && from.name) || NOTICE_NAMES[category] || category,
      whoAccountId: (from && from.accountId) || '',
      // 发送那层靠 replyVia 决定「回记录讨论」还是「退而私信本人」。
      // ⚠⚠ 必须**同时**写进 target：聚段（segment.toSegments）只搬白名单里的几个字段
      //   + target 整块，顶层的字段到了段上就没了，而 sendVia 收到的正是段 ——
      //   2026-08-10 之前通知类回复一律抛「这条通知没有可回复的对象」就是这么来的（T111）。
      //   顶层这份**别删**：test/connect.test.mjs 断言的是候选顶层的 replyVia，
      //   存量段（改动前落盘的 segments.json）身上也只有顶层这一份。
      replyVia: rt ? rt.via : null,
      target: rt ? { ...rt.target, replyVia: rt.via } : {},
      inboxId: (noticeEntry && noticeEntry.inboxId) || '',
      msgs: [{
        id: `notice-${category}-${sess.time || text.slice(0, 40)}`,
        at: isoOrRaw(sess.time),
        text,
      }],
    };
  }

  if (category !== 'user' && category !== 'group') return null;   // post 走单独通道

  // 我自己发的不入队；机器人发的照样入队（不再按屏蔽名单过滤）
  const incoming = (freshMsgs || []).filter(
    (m) => String(m.from) !== ME.accountId && msgText(m).trim(),
  );
  if (!incoming.length) return null;

  const toMsg = (m) => ({
    id: String(m.id || m.waitingid || m.time),
    at: isoOrRaw(m.time),
    text: msgText(m),
  });

  if (category === 'group') {
    const gid = String(sess.value || '');
    const last = incoming[incoming.length - 1];
    const sender = last.fromAccount || {};
    return {
      sourceKind: 'mingdao',
      kind: 'group',
      who: sender.name || '未知',
      whoAccountId: String(last.from || ''),
      target: { groupId: gid, groupName: sess.name || '' },
      msgs: incoming.map(toMsg),
    };
  }

  // 1对1 私信
  const peerId = String(sess.value || '');
  const who = sess.name || (sess.from && sess.from.name) || peerId;
  return {
    sourceKind: 'mingdao',
    kind: 'user',
    who,
    whoAccountId: peerId,
    target: { accountId: peerId },
    msgs: incoming.map(toMsg),
  };
}
