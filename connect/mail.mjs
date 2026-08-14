// 邮件适配器：两个邮箱（ms365 的 work、网易的 mingdao）的收和发都住在这儿。
// 契约跟 connect/hap.mjs 一样：kind / pull / sendVia / describe（外加 logSubdir）。
//
// ⚠ 本文件是传输编排层，不是闸。没有、也永远不许有身份声明和称呼门——那两样在 send.mjs。

import { MailAuthError, log } from '../lib.mjs';
import { accounts, accountById, isExternalRecipients } from '../mail/accounts.mjs';
import { toCandidate, toRecord } from '../mail/normalize.mjs';
import { graphFetch, graphMarkRead, graphSaveDraft, graphSend } from '../mail/graph.mjs';
import { imapFetch, imapMarkRead, imapSaveDraft, smtpSend } from '../mail/imap.mjs';

export const kind = 'mail';
export const logSubdir = 'assets/mail-log';

export function describe(item) {
  const a = accountById((item && item.account) || '');
  return a ? `邮件 · ${a.label}` : '邮件';
}

const seenKey = (id) => `mail-seen-${id}`;
const PENDING_READ = 'mail-pending-read';

// 落后多久就不补了，直接快进到「今天往前数这么多天」。
//
// ⚠ 为什么要有这道闸：正常路径是「终端没开就不收，下次开机按水位线一次性补回来」——
//   出门几天回来该看到这几天的信，这条对。但水位线要是落后到几个月（首轮基线建歪、
//   或者机器长期没开），补历史就变成一轮 49 封往前爬几十轮，几个小时都收不到今天的信。
//   Andy 的要求很明确：挂起就是看最新的邮件，历史等他专门说了再单独补。
const MAX_CATCHUP_DAYS = 7;

// 水位线太旧就往前推，返回真正要用的 since。推了会留声，别让它悄悄跳过一段。
function clampSince(since, accLabel) {
  if (!since) return since;
  const cutoff = Date.now() - MAX_CATCHUP_DAYS * 86400 * 1000;
  const at = Date.parse(since);
  if (!Number.isFinite(at) || at >= cutoff) return since;
  const next = new Date(cutoff).toISOString(); // utc-ok: 水位线（$filter 查询条件），不是给人看的时间
  log(`⚠ ${accLabel} 水位线停在 ${since}，落后超过 ${MAX_CATCHUP_DAYS} 天，`
    + `直接快进到 ${next}（跳过的历史邮件还在邮箱里，要补另说）`);
  return next;
}

// 上一轮取到的那批，这一轮开头才标已读。
//
// ⚠⚠ 为什么押到下一轮：pull 返回之后，主干才归档、聚段、落盘 —— pull 自己无从知道
//   那几步成没成。在 pull 里标已读，等于「还没落盘就宣布处理完了」，一旦落盘失败，
//   邮件在邮箱里已读、在 dailymd 里没有，人和机器都再也看不见它。
//   押到下一轮开头 = 上一轮整轮干净收尾的实锤——这份实锤现在由 run.mjs 保证：
//   只有它确认 segments.json 真的写盘成功，才会调 pull() 返回值里的 `commit`，
//   `mail-pending-read` 才会跟着水位线一起落盘（见下面 pull() 里的说明）。
async function flushPendingRead(store, io) {
  const pending = store.stateGet(PENDING_READ, {}) || {};
  const left = { ...pending };
  for (const acc of accounts()) {
    const ids = pending[acc.id] || [];
    if (!ids.length) continue;
    try {
      if (acc.transport === 'graph') await (io.graphMarkRead || graphMarkRead)(ids, { account: acc });
      else (io.imapMarkRead || imapMarkRead)(ids, { account: acc });
      left[acc.id] = [];
    } catch (e) {
      // 标已读失败不影响收信，下一轮再试。⚠ 但要留声，别让它悄悄攒着。
      log(`⚠ ${acc.id} 标已读没成（下一轮再试）：`, String((e && e.message) || e).slice(0, 200));
    }
  }
  store.stateSet(PENDING_READ, left);
}

// 待标已读要用并集、不能整份覆盖：上一轮 flushPendingRead 标某个账号没成功
// （比如网络抖动），那批 id 还留在 state 里；这一轮又取到了新邮件——如果直接
// `pending[acc.id] = 这一轮的 ids`，上一轮没标成的那批就被顶掉了，永远没有
// 恢复路径（消息本身没丢，只是会一直挂着未读状态）。
function addPendingRead(store, accId, ids) {
  const pending = store.stateGet(PENDING_READ, {}) || {};
  const merged = [...new Set([...(pending[accId] || []), ...ids])];
  store.stateSet(PENDING_READ, { ...pending, [accId]: merged });
}

// 收一个账号。
//
// ⚠⚠ 水位线的提交时机分两种：
//   · 首轮建基线——当场提交（store.stateSet 直接调，不经过 commits）。这一步没有
//     任何候选、没有「消息还没落盘」的风险；反过来押到 commit() 里的话，只要这一轮
//     因为别的原因没被 run.mjs 调 commit()（比如同一轮另一个账号 authError、或者
//     后面 saveAll 写盘失败），下一轮 since/lastUid 还是空的，会重新把整个收件箱
//     当基线扫一遍，永远建不成基线、永远收不到候选。
//   · 正常收信（水位线推进 + mail-pending-read）——包成闭包塞进 commits，不在这里
//     直接落盘。是不是真的提交，由 pull() 的调用方（run.mjs）在确认这一轮的
//     candidates/records 已经安全落盘之后才决定，见 pull() 里的大段说明。
async function pullOne(acc, store, io, out, commits) {
  const key = seenKey(acc.id);
  const seen = store.stateGet(key, null);
  const fresh = [];

  if (acc.transport === 'graph') {
    const since = clampSince((seen && seen.lastReceived) || '', acc.label);
    const seenIds = (seen && seen.ids) || [];
    // ⚠ seenIds 必须原样传回去：graphFetch 用 ge（含等于）过滤器防止同秒边界漏收，
    //   靠 seenIds 做二次去重去掉已经处理过的。不传回去，同秒到达的边界邮件
    //   会一轮一轮当成新邮件重复冒出来。
    const r = await (io.graphFetch || graphFetch)({ since, seenIds, top: 50, account: acc });
    if (!since) {
      // 首轮只建基线：不建的话第一次会把整个收件箱倒出来。当场提交，见上面的说明。
      store.stateSet(key, {
        lastReceived: r.lastReceived || new Date().toISOString(), // utc-ok: 水位线
        ids: r.seenIds || seenIds,
      });
      out.firstRunAccounts.push(acc.id);
      return;
    }
    fresh.push(...r.messages);
    const nextState = { lastReceived: r.lastReceived || since, ids: r.seenIds || seenIds };
    commits.push(() => store.stateSet(key, nextState));
  } else {
    const r = (io.imapFetch || imapFetch)({
      sinceUid: (seen && seen.lastUid) || '',
      uidValidity: (seen && seen.uidValidity) || '',
      limit: 50,
      account: acc,
    });
    if (r.baseline) {
      // 首轮 / uidValidity 变了要重新建基线：当场提交，理由同上。
      store.stateSet(key, { uidValidity: r.uidValidity, lastUid: r.lastUid });
      out.firstRunAccounts.push(acc.id);
      return;
    }
    commits.push(() => store.stateSet(key, { uidValidity: r.uidValidity, lastUid: r.lastUid }));
    fresh.push(...r.messages);
  }

  for (const m of fresh) {
    out.candidates.push(toCandidate(m, acc));
    out.records.push(toRecord(m, acc));
  }
  if (fresh.length) {
    const ids = fresh.map((m) => String(m.id));
    commits.push(() => addPendingRead(store, acc.id, ids));
    log(`${acc.label} 收到 ${fresh.length} 封新邮件`);
  }
}

export async function pull({ io = {}, store } = {}) {
  const out = {
    candidates: [], records: [], firstRun: false, noNews: false,
    authError: null, lost: [], firstRunAccounts: [],
  };
  if (!store) throw new Error('邮件适配器要 store（水位线读写）');

  await flushPendingRead(store, io);

  // ⚠⚠ 水位线（非首轮）和 mail-pending-read 不在这里落盘，攒进 commits，
  // 包成 out.commit 带回去，**由调用方（run.mjs）决定什么时候调**。
  //
  // 早先的版本试过「pull() 自己判断——这一轮没有 authError 就在返回前提交」，
  // 复核时发现这堵不住更宽的那个洞：pull() 返回之后，run.mjs 还要归档、聚段、
  // 把 segments.json 真正写盘（`saveAll`），这几步都可能失败，而失败的时候
  // `out.authError` 仍然是 null——按旧版逻辑水位线照样会被提交，这批邮件就变成
  // 「水位线已经翻过去、但一个字都没有落进 segments.json/inbox.md」，永久消失
  // 且没有任何报错。跟当年 hap-watch 「chat list 一成功就把新基线写盘，比归档/
  // 聚段/落盘都早」那个模子一模一样，只是换了个水位线的名字。
  //
  // 所以提交权必须交给 run.mjs：它确认 saveAll 真的把这一批写盘成功了，才会调
  // 这里返回的 `commit()`。`pull()` 自己不再替这件事拿主意——包括「本轮有没有
  // authError」这一条也不例外：只要 commit() 没被调用，这些账号的水位线就
  // 原地不动，下一轮会把同一批重新收一次（graph 侧靠 seenIds 去重、imap 侧靠
  // sinceUid 不变重新拉取，run.mjs 那边的 dropSeen/msgKey 和 archive 的 id
  // 去重挡住重复入段、重复归档）。
  const commits = [];

  for (const acc of accounts()) {
    try {
      await pullOne(acc, store, io, out, commits);
    } catch (e) {
      if (e instanceof MailAuthError) {
        // ⚠ 一个账号掉线不拖累另一个：如实上报 authError，但循环继续。
        out.authError = out.authError || `${acc.label}：${String(e.message).slice(0, 200)}`;
        log(`⚠ ${acc.label} 认证失败，这个账号这一轮不处理：`, String(e.message).slice(0, 200));
        continue;
      }
      // ⚠ 「跳过一个账号」不等于「这个账号没有新邮件」：必须记 lost，
      //   主干据此回滚水位线、下一轮重收。绝不静默吞。
      out.lost.push(`${acc.label} 取信失败：${String(e.message).slice(0, 150)}`);
      log(`⚠ ${acc.label} 取信出错，这一轮跳过：`, String(e.message).slice(0, 200));
    }
  }

  if (out.firstRunAccounts.length === accounts().length) out.firstRun = true;
  if (!out.candidates.length && !out.firstRun && !out.lost.length && !out.authError) out.noNews = true;

  // 没有账号有待提交的水位线改动时，commit 也还是给一个函数（调了什么都不干）——
  // run.mjs 只用 `typeof got.commit === 'function'` 判断「这个适配器要不要走这条
  // 提交流程」，不该因为这一轮恰好没有改动就让它多判一层「有没有这个字段」。
  out.commit = () => { for (const c of commits) c(); };
  return out;
}

// ---------- 发 ----------
//
// ⚠⚠ 这一段唯一要看懂的事：**external 为真时，代码根本走不到 graphSend / smtpSend。**
//   不是「判断一下再决定发不发」，是外部那条分支里压根没有发送函数的调用。
//   Andy 全局开着 bypassPermissions，权限确认框不弹 —— 靠确认框拦是拦不住的，
//   所以这道门做成物理的：外部邮件的最终结果只能是「一份躺在他自己草稿箱里的草稿」。
//   test/mail-send.test.mjs 里有两条断言盯着：数调用点个数，以及把 external 那对
//   花括号之间的源码抠出来，确认里面连这两个函数名都不出现。
//
// body 已经过 send.mjs 的身份声明和称呼门，这里只做格式转换，不加工内容。

// 对外签名。**只给「外部收件人 + 这个账号配了签名」加，内部同事不加。**
// 签名正文在配置里（mail.accounts[].signature，HTML 字符串或字符串数组），
// 没配就不加 —— 这个仓库不该内置任何一家公司的落款。
function signatureFor(acc) {
  const raw = acc && acc.signature;
  if (!raw) return '';
  return Array.isArray(raw) ? raw.join('\n') : String(raw);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function textToHtml(s) {
  return esc(s).split(/\n{2,}/).map((p) => `<p>${p.split('\n').join('<br>')}</p>`).join('\n');
}

// ⚠ Graph 用 Message.body 时**不会**自动带原文（PATCH 进去的正文把 createReply 生成的
//   那份原文引用整个覆盖掉），回复必须自己把原文引进来，否则对方收到的是一句没头没尾的话。
// ⚠ 引的是段里**最后一封**：一个段可能攒了同一个人连着来的好几封，要回的是最新那封。
function quoteOriginal(item) {
  const t = item.target || {};
  const msgs = item.msgs || [];
  // ⚠ msgs 的正文是 mail/normalize.mjs 拼的，开头本来就有一行「主题：…」，
  //   跟下面手写的那行会重复，剥掉。只剥开头那一行，正文一个字不动。
  const orig = ((msgs[msgs.length - 1] || {}).text || '').replace(/^主题：[^\n]*\n+/, '');
  const from = t.from || t.whoAddress || item.whoAddress || '';
  return [
    '<br>',
    '<blockquote style="border-left:3px solid #E0E5EC;margin:0;padding-left:12px;color:#555">',
    `<p>发件人：${esc(item.who)} &lt;${esc(from)}&gt;<br>`,
    `主题：${esc(t.subject || '')}</p>`,
    textToHtml(orig.slice(0, 1000)),
    '</blockquote>',
  ].join('\n');
}

function replySubject(item) {
  const s = String((item.target && item.target.subject) || '').trim();
  return /^re:/i.test(s) ? s : `RE: ${s}`;
}

// 这封回复实际会发给谁。
//
// ⚠ Reply-To 优先于 From —— 邮件客户端的「回复」就是这个语义，Outlook 的
//   `/reply` 接口在服务端也是这么选的。我们跟它保持一致，门验的才是真正的收件人。
// 回给一个人，不回给原信的全部收件人（cc 是有意丢掉的）。
function recipientsOf(item) {
  const it = item || {};
  const t = it.target || {};
  const rt = (t.replyTo || []).filter(Boolean);
  if (rt.length) return rt;
  const from = t.from || t.whoAddress || it.whoAddress || '';
  return from ? [from] : [];
}

// 这封回复算不算「发给外部」。**sendVia 和 deliveryMode 共用这一个函数** ——
// 两份判定迟早对不上，而对不上的后果是「以为在存草稿，其实发出去了」。
//
// ⚠⚠ 三个判据里任一说外部就是外部：
//   ① 段上带来的 external（Task 2 在收信时按**原信收件人** to+cc+bcc 算的）。
//      缺字段、老段、手改过的段一律当外部——拿不准就关门，代价只是多存一份草稿。
//   ② 这封回复的**实际收件人**（Reply-To 或 From）。①里没有发件人自己：
//      客户单独发一封给 me@acme.com 时原信收件人全是内部的，
//      只信①就会以 Andy 本人名义直发给客户。
//   ③ From 本身。②取的是 Reply-To，可 Outlook 的 `/reply` 到底选 Reply-To 还是 From
//      是**服务端**说了算的（见 sendVia 里那段说明），所以两个都得验过才敢直发。
export function isExternalReply(item) {
  const it = item || {};
  const t = it.target || {};
  const flagged = (t.external !== undefined ? t.external : it.external) !== false;
  if (flagged) return true;
  const from = t.from || t.whoAddress || it.whoAddress || '';
  return isExternalRecipients({ to: recipientsOf(it), cc: from ? [from] : [] });
}

// 这一条会被「发出去」还是「只存草稿」。
//
// ⚠ send.mjs 靠它决定要不要补身份声明：草稿是 **Andy 本人**点的发送，不是 Claude 发的，
//   不该带「我是 Andy 的 AI Agent」。它跟 sendVia 走同一个 isExternalReply，
//   test/mail-send.test.mjs 有一条拿真代码跑一遍、钉死两处不许分家。
// ⚠ 只回答「发还是存」，认不出账号之类的错留给 sendVia 去抛——它不该有第二个出错口。
export function deliveryMode(item) {
  return isExternalReply(item) ? 'draft' : 'send';
}

// 把一段话回给它的来处。
//
// item 是**段**（不是候选）：顶层的 external / account / whoAddress 在聚段那一步就掉了，
// 只有 target 原样带过来 —— 所以下面一律以 target 为准、顶层只做兜底。
// （mail/normalize.mjs 里那段注释是这件事的另一半。）
export async function sendVia(item, body, opts = {}) {
  const io = opts.io || {};
  const it = item || {};
  const t = it.target || {};

  const accId = t.account || it.account || '';
  const acc = accountById(accId);
  if (!acc) {
    // ⚠ 压根还没碰传输层 = **确定**一个字都没发出去，可以放心重试。
    //   不打这个标记的话 send.mjs 会一律判成 'unknown'，Andy 就不敢重试一件确定没发生的事。
    const e = new Error(`认不出这封邮件属于哪个账号：${accId || '(空)'}`);
    e.stage = 'pre-send';
    throw e;
  }

  const to = recipientsOf(it);

  // 判据在 isExternalReply 里，一处定义两处用（deliveryMode 用的是同一个）。
  const external = isExternalReply(it);

  const subject = replySubject(it);
  const sig = external ? signatureFor(acc) : '';
  const signature = sig ? `\n${sig}` : '';
  const html = `${textToHtml(body)}${signature}${quoteOriginal(it)}`;

  if (external) {
    // ⚠ 这条分支里出的错一律标 pre-send：这里最坏的结果只是「草稿箱里少了一份草稿」，
    //   一个字都到不了对方那儿。不标的话 send.mjs 会一律判成 'unknown'，
    //   Andy 看到「消息可能已经发出去了、别重发」就不敢重试一件**确定没发生**的事。
    try {
      if (acc.transport === 'graph') {
        const r = await (io.graphSaveDraft || graphSaveDraft)(
          { replyToId: t.messageId, subject, html, to, cc: [] }, { account: acc },
        );
        return {
          channel: '邮件草稿',
          to: `${it.who}（草稿已放进你的 Outlook 草稿箱，去点发送）`,
          link: r.webLink || '',
          draft: true,
        };
      }
      const r = await (io.imapSaveDraft || imapSaveDraft)({
        subject, html, to, cc: [], inReplyTo: t.messageIdHeader || '', references: t.messageIdHeader || '',
      }, { account: acc });
      return {
        channel: '邮件草稿',
        to: `${it.who}（草稿已放进邮箱「${r.folder || '草稿箱'}」，去点发送）`,
        link: '',
        draft: true,
      };
    } catch (e) {
      e.stage = 'pre-send';
      throw e;
    }
  }

  // 到这里 external 一定是 false —— 收件人全是内部同事，直发。
  if (acc.transport === 'graph') {
    await (io.graphSend || graphSend)({ replyToId: t.messageId, subject, html, to, cc: [] }, { account: acc });
  } else {
    await (io.smtpSend || smtpSend)({
      subject, html, to, cc: [],
      inReplyTo: t.messageIdHeader || '', references: t.messageIdHeader || '',
    }, { account: acc });
  }
  return { channel: '邮件', to: `${it.who} <${to[0] || ''}>` };
}
