// 明道云（HAP）适配器——这个消息源的收和发都住在这儿。
// 从 tools/hap-desk/connect/hap.mjs 扒过来，去掉对老 classify.mjs 分道逻辑的依赖，
// 只留取数；stateGet/stateSet 改成从参数注入，不再直接 import store.mjs。
//
// ⚠ 本文件是**传输层**，不是闸。
//   `sendVia` 里没有、也永远不许有授权判断和身份声明——那两样都在 send.mjs：
//     · 断言只该有一处。两处等于没有：哪天有人在别处调 sendVia，
//       两处都会以为「另一处会挡」。
//     · 身份声明同理，两处会补出两句。
//   `test/connect.test.mjs` 里有测试盯着这件事（grep 全仓库谁调了 sendVia、
//   grep 适配器里有没有 enforceAgentPrefix）。
//
// ⚠ 只走 hap CLI。401 一律由 lib.hap 抛 HapAuthError，让上层停下来喊 Andy 跑
//   `hap auth login`，**不许换通道兜底**（mdymcp 已退役）。

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hap, BIN, HapAuthError, log, ME, parseHapTime, localIso, dailymdRoot,
} from '../lib.mjs';
import {
  fetchFreshMessages, fetchPostInbox, fetchNoticeInbox, normalizeSession,
  NOTICE_CATEGORIES,
} from '../fetch.mjs';
import { recordFromChatMessage, recordFromPostComment } from '../archive.mjs';
import { config } from '../config.mjs';

export const kind = 'mingdao';

// 动态/评论的网页地址前缀。SaaS 默认是官方站点，私有部署的填自己的地址
// （config.json 的 hap.webBase）。⚠ 只用来拼给人点的链接，取数一律走 hap CLI。
function webBase() {
  const raw = config().hap?.webBase || 'https://www.mingdao.com';
  return String(raw).replace(/\/+$/, '');
}

// 给人看的来源标签。界面上「明道云 · 私信」那半截就是它。
export function describe(item) {
  if (item.kind === 'user') return '明道云 · 私信';
  if (item.kind === 'group') {
    const t = item.target || {};
    return `明道云 · 群「${t.groupName || t.groupId || '未知'}」`;
  }
  if (item.kind === 'post') return '明道云 · 动态评论';
  if (item.kind === 'notice') return `明道云 · ${item.channel || '通知'}`;
  return '明道云';
}

// 发送这条路的超时——**故意还是 120 秒，也故意还是同步的**。
//
// ⚠⚠ 别顺手跟着 lib.hap 的默认超时（25 秒）一起调下来，也别把它挪到后台去。
//   「发没发出去必须当场知道」是「唯一发送出口」那条铁律的一部分：
//   明道云没有撤回接口，发送的结果只有同步等才拿得到。动它的边界要 Andy 先拍板。
export const SEND_TIMEOUT_MS = 120000;

// 「这条通知该回到哪儿」—— record / task / dm / null。**全系统唯一一处判定。**
//
// ⚠⚠ 先读 target 再退回顶层：item 是**段**，而聚段只把 target 整块带过来，顶层的
//   replyVia 早就掉了（T111：通知类回复曾一律抛「没有可回复的对象」）。顶层这一路是给
//   存量段兜底的（改动前落盘的 segments.json 只有顶层那份），别删。
// ⚠⚠ 为什么非要导出给 bin/send.mjs 用：任务评论归 🔴（受众是任务全体参与人），
//   而 2026-08-13 之前 bin/send.mjs 自己又写了一份 `(target.replyVia || item.replyVia)`，
//   这边是 `??`。今天两份结论一致，但改一处另一处不会跟着改 —— 这个仓库反复踩的正是
//   「两份判定迟早对不上」。所以判定只留这一处，那边 import 过去调。
// ⚠ 判「有没有写」用的是「非 null 且非空串」，既不是 `??` 也不是 `||`：
//   `??` 会把空串当成一个有效落点（于是 record/task/dm 全不匹配，一路掉到最后
//   抛「没有可回复的对象」，等于哑掉存量段顶层那份）；`||` 又会把 0 之类的值一起吞掉。
//   空串不是落点，明确当「没写」处理，退回顶层那份。
export function replyViaOf(item) {
  const has = (v) => v != null && v !== '';
  const t = (item && item.target) || {};
  if (has(t.replyVia)) return t.replyVia;
  if (has(item && item.replyVia)) return item.replyVia;
  return null;
}

// 把一段话发回它的来处。
// body 已经过 send.mjs 的身份声明处理，这里原样发，不再加工。
// opts.io.hap 是给测试注入假传输层用的（跟 pull 的 io.hap 同一个约定）——
// ⚠ 只是换掉「怎么把命令交出去」，判断逻辑一个字都不许挪到调用方去；生产不传，走真 hap。
export function sendVia(item, body, opts = {}) {
  const call = (opts.io && opts.io.hap) || hap;

  // 附件是**正文之后的第二条消息**，不是把正文塞进文件消息的说明里。
  // 两个原因：① 身份声明得先到对方眼前，别让一个文件先蹦出来；
  // ② 正文和附件是两次投递，成败要分开如实报——正文发出去了、附件没成，
  //    绝不许整体报失败让 Andy 再按一次（明道云没有撤回接口，重发 = 对方收两条）。
  const sendFile = (args, out) => {
    if (!opts.filePath) return out;
    try {
      call(args.concat(['--file', opts.filePath]), { json: false, timeout: SEND_TIMEOUT_MS });
      return { ...out, file: opts.filePath };
    } catch (e) {
      return { ...out, file: opts.filePath, fileError: String((e && e.message) || e) };
    }
  };

  if (item.kind === 'user') {
    call(['chat', 'send-to-one', '-t', item.target.accountId, '-m', body], { json: false, timeout: SEND_TIMEOUT_MS });
    return sendFile(
      ['chat', 'send-file-to-one', '-t', item.target.accountId],
      { channel: '私信', to: item.who },
    );
  }

  if (item.kind === 'group') {
    const args = ['chat', 'send-to-group', '-g', item.target.groupId, '-m', body];
    // 群里回谁就 @ 谁，让对方收到提醒；主动发群消息时用 target.mentionAccountIds（可多个）
    const mentions = (item.target.mentionAccountIds && item.target.mentionAccountIds.length)
      ? item.target.mentionAccountIds
      : (item.whoAccountId ? [item.whoAccountId] : []);
    for (const id of mentions) args.push('--at', id);
    call(args, { json: false, timeout: SEND_TIMEOUT_MS });
    return sendFile(
      ['chat', 'send-file-to-group', '-g', item.target.groupId],
      { channel: '群消息', to: item.target.groupName || item.target.groupId },
    );
  }

  // 通知类。三种落点，fetch.noticeReplyTarget 已经算好了是哪一种：
  //   record —— 应用里的记录讨论，能原地回在对方那条下面
  //   task   —— 任务里的评论/@我，回到这个任务下面（另起一条评论）
  //   dm     —— 回不到原处（没有 taskId 的任务通知…），退而私信本人
  if (item.kind === 'notice') {
    const t = item.target || {};
    const via = replyViaOf(item);
    if (via === 'record') {
      // ⚠ 2026-08-18 补：`hap worksheet record add-discussion --attach` 是**一次调用**里
      //   先传后发的复合命令（跟 `task comment --attach` 一个套路），不是私信/群消息那种
      //   「正文一条、附件另起一条」的两段式，所以直接把 --attach 拼进同一个 args，
      //   不走 sendFile()。文件不存在/上传失败会让整条 call() 直接抛，属于 pre-send 失败
      //   （还没吐给 Discussion.AddDiscussion），调用方按现有逻辑处理即可。
      const args = ['worksheet', 'record', 'add-discussion', t.worksheetId, t.rowId, '-m', body];
      if (t.appId) args.push('--app-id', t.appId);
      if (t.viewId) args.push('--view-id', t.viewId);
      if (t.replyId) args.push('--reply-id', t.replyId);
      if (opts.filePath) args.push('--attach', opts.filePath);
      call(args, { json: false, timeout: SEND_TIMEOUT_MS });
      return { channel: '记录讨论', to: t.recordName || t.rowId, file: opts.filePath || undefined };
    }
    // 任务评论。⚠ 不传 --reply-id：收件箱条目的 inboxId 是不是讨论 id 没验证过，
    //   而这个文件的规矩是「认不出落点就明说，绝不瞎猜一个 id 发出去」。
    //   代价是回复会是这个任务下的一条新评论，不是挂在对方那条下面。
    //
    // ⚠⚠ 2026-08-17 补两个坑：
    //   ① `hap task comment` 原生支持 `--attach <path>`，upload+post 是同一次调用
    //      （--help 原话「Composite: files are uploaded first, then the comment is
    //      posted」）。task 没有独立的「发文件」子命令，所以这里**不能**走 user/group
    //      那套「先发正文、sendFile() 再发第二条」的模式——必须把 --attach 塞进同一条
    //      `task comment` 命令，附件才真的会跟着上传。此前这里完全没传 opts.filePath，
    //      附件被静默丢了，Andy 发现「附件并没有上传到任务评论区」才补上。
    //   ② 任务评论不像群消息有 `--at` 参数，@人要在正文里写 `[aid]<accountId>[/aid]`
    //      （见 assets/stacks/hap-feed/facts.md），服务端才会真推送通知、渲染成 @姓名。
    //      此前只把 whoAccountId 用来给称呼门判断收件人，从没真正 @ 过对方。
    if (via === 'task') {
      const mention = t.accountId || item.whoAccountId;
      const withMention = mention ? `${body}\n\n[aid]${mention}[/aid]` : body;
      const args = ['task', 'comment', t.taskId, '-m', withMention];
      if (opts.filePath) args.push('--attach', opts.filePath);
      call(args, { json: false, timeout: SEND_TIMEOUT_MS });
      return { channel: '任务评论', to: item.who || t.recordName || t.taskId, file: opts.filePath || undefined };
    }
    if (via === 'dm') {
      call(['chat', 'send-to-one', '-t', t.accountId, '-m', body], { json: false, timeout: SEND_TIMEOUT_MS });
      return sendFile(
        ['chat', 'send-file-to-one', '-t', t.accountId],
        { channel: '私信', to: item.who },
      );
    }
    // ⚠ 认不出落点就明说，绝不瞎猜一个 accountId 发出去
    throw new Error('这条通知没有可回复的对象。');
  }

  if (item.kind === 'post') {
    // ⚠ 2026-08-18 补：`hap post comment --attach` 跟 `task comment --attach` 一个套路
    //   （复合命令，upload+post 一次调用），不走 sendFile() 那种「正文一条、附件另起
    //   一条」的两段式。此前这条命令没有 --attach，动态评论一律拒收附件；hap-cli
    //   加上之后这里跟着接上，不再需要在 bin/send.mjs 的 NO_ATTACHMENT_SUPPORT 里
    //   挡它。
    const args = ['post', 'comment', item.target.postId, '-m', body];
    if (item.target.replyCommentId) {
      args.push('--reply-id', item.target.replyCommentId);
      if (item.target.replyAccountId) args.push('--reply-account-id', item.target.replyAccountId);
    }
    if (opts.filePath) args.push('--attach', opts.filePath);
    call(args, { json: false, timeout: SEND_TIMEOUT_MS });
    return { channel: '动态评论', to: item.who, file: opts.filePath || undefined };
  }

  throw new Error(`未知的消息类型：${item.kind}`);
}

// 明道云的群列表——频道选择器一类场景用。
//
// ⚠ `hap group` 底下只有 create / info / add-member / remove-member，**没有 list**。
//   所以群列表只能从 `chat list` 里筛（category='group'）——拿到的是
//   「Andy 最近有来往的群」，不是他所在的全部群。这是当前 CLI 能给的最好结果。
export function listGroups({ limit = 100 } = {}) {
  const sessions = hap(['chat', 'list', '-n', String(limit)]);
  if (!Array.isArray(sessions)) return [];
  const out = new Map();
  for (const s of sessions) {
    if ((s.category || '') !== 'group' || !s.value) continue;
    out.set(String(s.value), { groupId: String(s.value), name: s.name || String(s.value) });
  }
  return [...out.values()];
}

// ---------- 收 ----------
//
// ⚠ 这一段里没有、也永远不许有任何发送分支。

// 变化检测直接复用 skill hap-watch 的 watch.mjs（不重写基线/去重那套逻辑）。
// ⚠ watch.mjs 内部走 `hap` 走 PATH，launchd 的 PATH 里没有 /opt/homebrew/bin 这些，
//   所以 spawn 它的时候必须显式补 PATH。
// ⚠⚠ state 名字用 'mailroom'，跟 hap-desk 的 'hapdesk' 分开——两套按计划要并行跑一段
//   时间（老的还在线上），共用同一个基线文件会导致谁先跑完谁「消费」掉新消息标记，
//   另一套就会误判成「没有新动静」而漏收。
// ⚠⚠ 2026-08-12 事故：这里原来写死 `~/.claude/skills/hap-watch/watch.mjs`，当天 skill
//   从全局收进 dailymd 仓库（commit 086e3f2f），路径当场失效——明道云这一路整个收不到，
//   而报告里只有邮件，看着像「今天没人找你」。所以路径必须**按候选找**，别再写死一个。
const WATCH_CANDIDATES = [
  process.env.MAILROOM_WATCH_MJS,
  fileURLToPath(new URL('../hap/watch.mjs', import.meta.url)),
  join(dailymdRoot(), '.claude/skills/hap-watch/watch.mjs'),
  join(homedir(), '.claude/skills/hap-watch/watch.mjs'),
].filter(Boolean);
const WATCH_STATE_NAME = 'mailroom';

function resolveWatchMjs() {
  return WATCH_CANDIDATES.find((p) => existsSync(p)) || null;
}

function defaultRunWatch() {
  const watchMjs = resolveWatchMjs();
  if (!watchMjs) {
    return {
      code: 1,
      out: '',
      err: `找不到 hap-watch/watch.mjs，找过：${WATCH_CANDIDATES.join('、')}`,
    };
  }
  const r = spawnSync(BIN.node, [watchMjs, '--state', WATCH_STATE_NAME, '--wide', '--limit', '40'], {
    encoding: 'utf-8',
    timeout: 120000,
    env: { ...process.env, PATH: `${dirname(BIN.hap)}:${dirname(BIN.node)}:/usr/bin:/bin:/usr/sbin:/sbin` },
  });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

// 把 `chat list` 给的那条通知会话，对回收件箱明细里的具体一条。
//
// ⚠ 不能按时间对：会话时间带毫秒（17:26:02.021），收件箱明细是秒级且常差 1 秒（17:26:01）。
//   按正文对最稳——会话正文是「同事: 正文」，明细里只有「正文」，所以用 includes。
//   都对不上就退回最新一条：触发这轮变化的本来就是它。
function matchNoticeEntry(sess, cache, fetch) {
  const category = sess.category || '';
  if (!cache.has(category)) cache.set(category, fetch(category));
  const list = cache.get(category);
  if (!list.length) return null;
  const text = ((sess.msg && sess.msg.con) || '').trim();
  const hit = list.find((e) => {
    const m = String(e.message || '').trim();
    return m && (text.includes(m.slice(0, 40)) || m.includes(text.slice(0, 40)));
  });
  return hit || list[0];
}

// 收一轮，返回渠道无关的 candidates + 要归档的 records。
//
// io 只用来在测试里顶掉最外面那两个 IO（watch 和 hap CLI）。store 用来注入
// stateGet/stateSet（不再直接 import store.mjs，测试不用真的碰 ~/.mailroom）。
// ⚠ 别把整个 pull 都注入掉——README 里那条坑：「测试注入了假的外部调用，
//   就测不到那句调用本身写错了」。所以里面的编排逻辑是真跑的。
// cfg 留在签名里但当前不用——分道逻辑已经删掉，判定通知类别用的是 fetch.mjs 里
// 写死的 NOTICE_CATEGORIES，不再靠外部配置；留着这个参数位只是为了跟接口文档对齐，
// 以后真要加可配置项（比如屏蔽名单）能直接接进来，不用改调用方的签名。
export function pull({ cfg = {}, prevSeen = {}, io = {}, store } = {}) {
  const runWatch = io.runWatch || defaultRunWatch;
  const call = io.hap || hap;
  const fetchNotice = io.fetchNoticeInbox || fetchNoticeInbox;
  const stateGet = (store && store.stateGet) || (() => undefined);
  const stateSet = (store && store.stateSet) || (() => {});
  // lost —— 这一轮**有东西没取到**。每条是一句人话（哪个会话/哪个收件箱怎么错的）。
  // ⚠⚠ 这一栏不是日志，是给 poll.mjs 置 lostWhy 用的：只要它非空，这一轮就不算
  //   干净收尾，水位线必须回滚，下一轮把这批会话再收一次（msgKey 去重挡得住重复入段）。
  //   老代码把取数失败吞成「这个会话零条新消息」，而水位线早就推过去了 —— 消息永久消失。
  const out = {
    candidates: [], records: [], firstRun: false, noNews: false, authError: null, lost: [],
  };

  const w = runWatch();
  if (w.code === 1) {
    if (/not logged in|token is missing|invalid, or expired|未登录/i.test(w.err + w.out)) {
      // ⚠ 401 当结果报上去，让调用方去 Bark 喊 Andy 跑 hap auth login。
      //   这里绝不换通道兜底——mdymcp 已退役，历史上就是这么被绕过去的。
      out.authError = w.err || w.out;
    } else {
      // ⚠⚠ 别只写日志就返回空结果：那样这一轮看着跟「明道云没新消息」一模一样，
      //   汇报里只剩邮件，Andy 会以为没人找他（曾因该逻辑导致漏收同事私信）。
      //   记进 lost → 上层打 ⚠、水位线回滚、下一轮整批重收。
      log('watch.mjs 出错：', (w.err || w.out).slice(0, 300));
      out.lost.push(`明道云取数没跑起来：${(w.err || w.out).replace(/\s+/g, ' ').slice(0, 200)}`);
    }
    return out;
  }

  if (!Object.keys(prevSeen).length) {
    // 首轮只建基线：动态收件箱也一起标记已读，否则第一次会把历史评论全倒出来
    try {
      const res = call(['chat', 'messages', '--category', 'post', '-n', '20']);
      stateSet('seen-post', { ids: ((res && res.list) || []).map((e) => e.inboxId).filter(Boolean) });
    } catch (e) {
      // ⚠ 别静默吞：这一步没成的话动态收件箱就没有基线，下一轮会把**整个历史**评论
      //   当成新的倒出来（这正是「首轮只建基线」要防的事）。
      log('⚠ 首轮动态基线没建成，下一轮可能把历史评论当成新的：', String((e && e.message) || e).slice(0, 200));
    }
    out.firstRun = true;
    return out;
  }

  // ⚠⚠ watch.mjs 的退出码只当**提示**，不当判据。
  //   它的水位线文件 `~/.hap-watch/mailroom.json` 是全局共享的：任何人跑一次
  //   `watch.mjs --state mailroom`（别的会话直接用 hap-watch skill 查「对方回了没」、
  //   拿别的 MAILROOM_STATE 跑一遍 fetch，都算）就把「有新消息」这个标记**消费掉**了，
  //   而消费者不一定是 mailroom。这时候它给我们退 3，我们要是直接信，这条消息就永远收不到。
  //   2026-08-13 真炸过：Alice 17:36 回的私信，17:40 和 17:41 两轮都报「无新动静」，
  //   人问起来才发现——而那是一条在等的回复。
  // 所以：照样拉一次 `chat list`，拿**我们自己记的**水位线（prevSeen）去比。
  //   代价是安静的那些轮多一次 API 调用，换掉整整一类「别人替我们把消息标成已读」。
  if (w.code === 3) log('watch 说没新动静，还是照自己的水位线核一遍');
  else log('有新动静：', w.out.replace(/\n/g, ' ').slice(0, 200));

  const sessions = call(['chat', 'list', '-n', '40']);
  // 这一轮看到的全量水位线，交给调用方在**干净收尾时**存进 mailroom 自己的状态里
  // （见 run.mjs 的 `watch-seen`）。存自己那份，才不受上面那个共享文件被别人推动的影响。
  out.seen = {};
  for (const s of (Array.isArray(sessions) ? sessions : [])) {
    if (s.value && s.time) out.seen[String(s.value)] = s.time;
  }
  const fresh = (Array.isArray(sessions) ? sessions : []).filter(
    (s) => s.value && s.time && prevSeen[String(s.value)] !== s.time,
  );
  if (!fresh.length) { out.noNews = true; return out; }

  let postTouched = false;
  const noticeCache = new Map();
  for (const s of fresh) {
    if (s.category === 'post' || String(s.value) === 'post') { postTouched = true; continue; }
    const isNotice = NOTICE_CATEGORIES.includes(s.category || '');
    if (!isNotice && s.category !== 'user' && s.category !== 'group') continue;
    try {
      // 通知类正文 `chat list` 已经给了，但「回给谁」只有收件箱明细里有——得多拉一趟。
      // 每个分类一轮只拉一次，缓存住（同一分类下一般也就一条新的）。
      const noticeEntry = isNotice ? matchNoticeEntry(s, noticeCache, fetchNotice) : null;
      // 通知类不是对话，不用再按会话拉消息
      const msgs = isNotice ? [] : fetchFreshMessages(s, prevSeen[String(s.value)]);
      // 归档一条不漏：不再按屏蔽名单过滤——那是删掉的 lane 逻辑的一部分。
      for (const m of msgs) {
        const rec = recordFromChatMessage(m, s);
        if (rec) out.records.push(rec);
      }
      const item = normalizeSession(s, msgs, noticeEntry);
      if (item) out.candidates.push(item);
    } catch (e) {
      if (e instanceof HapAuthError) throw e;
      // ⚠ 「跳过一条」不等于「这一条没有新消息」。取数失败的会话必须记进 lost，
      //   否则它的水位线就这么过去了 —— 这正是要堵的那个洞。
      const what = `${s.name || ''}(${s.value})`;
      log('会话取数/规范化出错，这一轮跳过：', what, String(e.message).slice(0, 200));
      out.lost.push(`会话 ${what}：${String(e.message).slice(0, 120)}`);
    }
  }

  if (postTouched) {
    const seenPost = new Set((stateGet('seen-post', { ids: [] }) || { ids: [] }).ids || []);
    // ⚠ 取不到就整块跳过，尤其**不许**往下走到 stateSet('seen-post')：
    //   已读水位一推，这些评论就永远看不见了。
    let inbox;
    try {
      inbox = fetchPostInbox();
    } catch (e) {
      if (e instanceof HapAuthError) throw e;
      log('动态收件箱取数出错，这一轮跳过：', String(e.message).slice(0, 200));
      out.lost.push(`动态收件箱：${String(e.message).slice(0, 120)}`);
      return out;
    }
    for (const entry of inbox) {
      const comment = ((entry.post && entry.post.comments) || [])
        .find((c) => c.commentId === entry.inboxId);
      const rec = recordFromPostComment(entry, comment);
      if (rec && rec.text.trim()) out.records.push(rec);
    }
    // 动态评论没有单独的 classify 函数了——只是把收件箱明细整理成 candidate，
    // 不再判「跟我有没有关系」（旧版本 classifyPostInbox 干的事），一条不漏地交给
    // file.mjs 那层的 AI 判断值不值得回。
    for (const entry of inbox) {
      if (!entry.inboxId || seenPost.has(entry.inboxId)) continue;
      const sender = entry.sender || {};
      if (sender.accountId === ME.accountId) continue;
      const post = entry.post || {};
      const comment = (post.comments || []).find((c) => c.commentId === entry.inboxId) || null;
      const message = (comment && comment.message) || entry.message || '';
      if (!message.trim()) continue;
      const at = parseHapTime((comment && comment.createTime) || entry.createTime);
      out.candidates.push({
        sourceKind: 'mingdao',
        kind: 'post',
        who: sender.name || '未知',
        whoAccountId: sender.accountId || '',
        target: {
          postId: post.postId || '',
          replyCommentId: (comment && comment.commentId) || '',
          replyAccountId: sender.accountId || '',
          postUrl: post.postId ? `${webBase()}/feeddetail?itemID=${post.postId}` : '',
        },
        msgs: [{
          id: `c${(comment && comment.commentId) || entry.inboxId}`,
          at: at ? localIso(at) : '',
          text: message,
        }],
      });
    }
    for (const e of inbox) if (e.inboxId) seenPost.add(e.inboxId);
    stateSet('seen-post', { ids: [...seenPost].slice(-200) });
  }

  return out;
}
