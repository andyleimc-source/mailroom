// 发送器 —— 全系统唯一往外发的地方。
//
// ⚠ 硬边界（改这个文件前先把这段读完）：
//   1. 永不自动发送。这个函数只允许由 `bin/send.mjs` 调用。
//   2. 收消息 / 归位那条链里不许 import 本文件，也不许出现任何 hap ... send。
//   3. 下面的 role 断言就是为了让「自动发送」这条路在运行时也走不通：
//      只有 bin/send.mjs 会把 MAILROOM_ROLE 设成 approval-desk。
//   最坏情况是一条都没发出去，绝不漏发一条。
//
// ⚠⚠ 2026-08-09：网页审批台砍掉了，「那颗按钮」搬进 Claude Code 的**权限确认框**。
//   闸门本身一个字没松，只是换了个锚点——原来是「只有网页后端进程有资格」，
//   现在是「只有 bin/send.mjs 这条命令有资格，而这条命令被设成每次都要 Andy 点同意」。
//   ⚠⚠ 但是——2026-08-09 现状：Andy 全局设的是 `defaultMode: bypassPermissions`，
//   **确认框根本不弹**。也就是说这条命令今天是模型自己就能跑的，「Andy 亲手点一下」
//   这一环眼下是空的。他知道，是他拍板先这样。别把这件事忘了，也别在别处写成
//   「有人把关」——本文件下面那些门（role 断言 / 称呼门 / 身份声明）都是实的，
//   唯独最后那一下人工确认不是。
//   要焊死的时候，两条一起加才算数：
//     ① `bin/send.mjs` 设成 ask（且先确认 ask 能压过 bypassPermissions），
//        或者更硬的办法：把它整个放进 deny，改由 Andy 自己在输入框敲 `!` 跑；
//     ② `hap chat send*` / `hap post*` 进 deny —— 没有这一条，模型绕开本文件
//        直接敲 hap 就发出去了，那正是 2026-08-08 的事故。
//   环境变量名和 approval-desk 这个值沿用旧的没改：改名要动的地方比收益多，
//   而这个文件是全仓库最不该为了好听去动的一个。「审批台」在本仓库里从此指那个确认框。
//
// ⚠ 各渠道的命令住在 `connect/<kind>.mjs` 的 `sendVia` —— **闸没搬**。
//   断言和身份声明留在这一层，适配器是纯传输。为什么不放进适配器：
//   断言只该有一处，两处等于没有（各自以为另一处会挡）；身份声明两处会补出两句。
//   `test/connect.test.mjs` 里有 grep 测试盯着「除了这里没人调 sendVia」
//   和「适配器里没有 enforceAgentPrefix」；`test/send.test.mjs` 里还有一条盯着
//   「除了 bin/send.mjs 没人 import 本文件」。
//
// ⚠⚠ 2026-08-08 的事故：3 条以 Andy 名义发给同事的消息**绕过审批台**直接发了，
//   根因就是「发送有第二条路」。所以不管草稿是终端产的、网页手打的、还是将来
//   邮件/微信来的，都必须经过同一个按钮走到这个函数。
//
// 从 tools/hap-desk/send.mjs 扒过来，裁掉了两样东西：
//   · `authrule` 那条分支——按类授权是老架构的东西，这次砍了。`APPROVAL_SOURCES`
//     只剩 `approval-desk-button` 一个，`authorized-rule` 一律不认。
//   · 环境变量 `HAPDESK_ROLE` 改成 `MAILROOM_ROLE`（值仍是 `approval-desk`）。

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  log, dailymdRoot, hashId, localIso,
  enforceAgentPrefix, stripAgentDeclaration, checkCallName, callNameError, hasAgentDeclaration,
  checkSelfThirdPerson, selfThirdPersonError, ownerName, inTest } from './lib.mjs';
import { knowledgeBase } from './config.mjs';
import { adapterFor } from './connect/index.mjs';
import { appendSegment } from './inboxmd.mjs';
import { resolve as resolveTask } from './tree.mjs';

// 批准的形态。⚠⚠ **只有这一种，别再加第二种**。
//   approval-desk-button —— Andy 当场按的那一下（现在是权限确认框里的那次同意）。
//   老 hap-desk 里还有个 `authorized-rule`（他批过的应答类规则 + 延迟队列），
//   msgfiler 明确砍掉了：那条路是「不用他按也能发」，正是本文件要堵的东西。
const APPROVAL_SOURCES = new Set(['approval-desk-button']);

// ---------- 测试钩子：网络上传不进来 ----------
//
// ⚠⚠ `people` 和 `adapter` 换掉的正好是这个文件两道门要保护的东西：
//   `people: []` 等于把称呼门关掉（一条违规都查不出来），`adapter` 等于换掉整个传输层。
//   它们本来摊在 `opts` 顶层，只靠一句注释挡着「别把请求体整个摊进来」——
//   而这个文件存在的全部理由就是「文档里的规则拦不住人」。所以硬化两层：
//     ① 挪进 `opts.__test`（这个名字不会有人从网页表单里瞎猜出来）；
//     ② 只在 `MAILROOM_TEST === '1'` 时才被认——审批台进程不设这个变量，
//        Task 10 就算写成 `sendReply(item, text, ok, { ...req.body })` 也伪造不出东西。
//
// ⚠ 防「同一条草稿被双击/重试发两次」的那一层不在这个文件，也做不到在这个文件：
//   必须在**发之前**占住草稿（发送 token 绑 draftId、进程内 Map、用掉即焚），
//   老网页版靠进程内的令牌 Map 做这件事。现在不需要了：`bin/send.mjs` 是一次性进程，
//   跑完就退，天然发不了第二次；真要重发得再过一次权限确认框，那时 Andy 自己看得见。
// ⚠ 判据用 inTest()，跟全库其它护栏同一套。以前这里只认 MAILROOM_TEST==='1'，
//   而 `node --test` 只给 NODE_TEST_CONTEXT —— 于是直接跑 node --test 时注入的假通讯录
//   被静默忽略，测试转而读本机真实通讯录才绿。护栏的判据不许有第二套。
function hooks(opts) {
  if (!inTest()) return {};
  return (opts && opts.__test) || {};
}

// 这一次判称呼用哪份通讯录。
//
// ⚠⚠ `opts.people` 是**调用方那道预检刚读到的那一份**，由 `bin/send.mjs` 显式传下来
//   —— 一条路只读一次通讯录。
//   不这么做的话，门自己读文件、`checkCallName` 走 lib.mjs 的模块级缓存，两处分家：
//   `contacts()` 里 `[]` 是 truthy，「第一次用到时恰好读不到」会把空表**永久**缓存进
//   这个常驻进程，而门看到文件好好的就放行 —— 2026-08-08 评审实跑，「金总您好」
//   查出 0 条违规、一路发了出去。
//
// ⚠ 空名单 = 一条违规都查不出来 = 门大开。**当场拒发**，不许静默放行：
//   这条同时也把「哪天有人写成 `sendReply(item, text, ok, {...req.body})`」堵死 ——
//   请求体里塞 `people: []` 得到的是拒发，不是放行。
function peopleFor(opts) {
  const hooked = hooks(opts).people;
  if (hooked !== undefined) return hooked;
  const p = opts && opts.people;
  if (p === undefined) return undefined;   // 没传：checkCallName 走它自己的默认表
  if (!Array.isArray(p) || !p.length) {
    throw new Error('拒绝发送：传进来的通讯录是空的，称呼门一条违规都查不出来（等于门大开）。'
      + '（先确认 contactmd/contacts.json 读得到再发。）');
  }
  return p;
}

function assertHumanApproved(approval) {
  if (process.env.MAILROOM_ROLE !== 'approval-desk') {
    throw new Error('拒绝发送：本进程不是发送入口。唯一发送入口是 bin/send.mjs，'
      + `它只会在 ${ownerName()} 于 Claude Code 的权限确认框按下同意之后才跑起来。`);
  }
  if (!approval || !APPROVAL_SOURCES.has(approval.source)) {
    throw new Error('拒绝发送：缺少批准标记。');
  }
}

// ⚠ 称呼硬门。跟上面的审批断言同一个道理：规则光写在文档里没用，得让路过必检。
//   2026-08-07 就是照着「金总您好」发出去的，而规则那时已经写在 contactmd/CONTACTMD.md 里了。
//   拦下来**不自动改写**：改写等于替 Andy 决定，而正式场合本名才是对的。
//
//   allowFormalName 什么时候用：对外正式邮件、合同/法律文本、要写全名的自我介绍、
//   转述第三方原话。日常私信、群聊、给同事的消息一律不许用这个出口 —— 那正是这道门要挡的。
//
// 报错带 code='CALLNAME'，前端认这个码才弹「就按原文发」的确认框。
//
// ⚠ 第一个参数叫 `raw` 不叫 `body`，是**故意**的：这道门查的是补声明**之前**的原文
//   （理由见 sendReply 里那段注释）。原来这个形参叫 `body`，名字正好引导下一个人
//   顺手把实参也改成 body —— 2026-08-08 评审就是这么发现的：改成 body 之后 23 条测试照样全绿。
function assertProperCallName(raw, allowFormalName, to, people) {
  if (allowFormalName) return;
  const vios = checkCallName(raw, people, { to });
  if (!vios.length) return;
  const err = new Error(callNameError(vios));
  err.code = 'CALLNAME';
  throw err;
}

// ⚠ 自称硬门。同一个道理：正文里把 Andy 写成第三人称（「Andy 想跟你聊」），
//   收件人那边是 Andy 本人的账号在说话，读起来就是有毛病。2026-08-12 拦的就是这个。
//   跟称呼门一样**不自动改写** —— 改成第一人称要动句子，那是写的人的活，不是门的活。
//   绕过口是 allowFormalName（对外正式邮件署名、转述别人提到 Andy 的原话）。
//   报错带 code='SELF3P'。
function assertNotThirdPersonSelf(raw, allowFormalName) {
  if (allowFormalName) return;
  const hits = checkSelfThirdPerson(raw);
  if (!hits.length) return;
  const err = new Error(selfThirdPersonError(hits));
  err.code = 'SELF3P';
  throw err;
}

// 段上这个字段叫 `sourceType`，适配器认的却是候选上的 `kind`（见 segment.mjs 顶部注释：
// 「candidate 上字段叫 kind，段上叫 sourceType」）。
// ⚠ 不补这一下的话，拿一个段去调 sendVia 会一路 fallthrough 抛「未知的消息类型：undefined」——
//   而审批台送进来的正是段。补在这里而不是改适配器：适配器是照候选写的，两边都认反而更糊涂。
// ⚠ 取值顺序跟 segment.mjs 的 lineKey/msgKey 一致（`sourceType || kind`）。今天两个字段
//   不会同时出现，但两处优先级相反的话，哪天真同时出现了就得两边对账。
function typeOf(item) {
  const it = item || {};
  return it.sourceType || it.kind || '';
}

// 这条要发给谁 —— 称呼门要按收件人判，不能只看正文。
// 群消息认不出单个收件人，如实标成 group，门那边会退回全表判定（拿不准一律关门）。
function recipientOf(item) {
  const it = item || {};
  if (typeOf(it) === 'group' || (it.target && it.target.groupId)) return { kind: 'group' };
  return {
    kind: 'user',
    name: it.who || '',
    accountId: it.whoAccountId || (it.target && it.target.accountId) || '',
    // 邮件段认人靠邮箱：发件人就是我们要回给的那个人。
    // ⚠ target 优先：聚段之后段上只剩 target，顶层的 whoAddress 掉了（见 mail/normalize.mjs）。
    email: (it.target && (it.target.whoAddress || it.target.from)) || it.whoAddress || '',
  };
}

// 「这段话补完身份声明之后，还剩不剩实质内容」。
// ⚠ precheckSend 的 empty 和 sendReply 的拒发用的就是这一个函数，别在任一边另写判断。
function noSubstance(text) {
  return !stripAgentDeclaration(enforceAgentPrefix(String(text || ''))).trim();
}

// ---------- 这一条是「发出去」还是「存成草稿」 ----------
//
// ⚠⚠ 这里**不猜**：只认适配器显式导出的 `deliveryMode(item)`。没有这个函数的适配器
//   （明道云那条路）一律按 'send'，行为一个字不变。
//   为什么要知道：**草稿不补身份声明**。Andy 定的「内部同事带，外部客户不带」，
//   道理也自洽 —— 草稿是他**本人**点的发送，不是 Claude 发的，本来就不需要声明。
// ⚠ 这不是第二道「发不发得出去」的门：真正决定发还是存的是适配器的 sendVia，
//   这里只决定正文长什么样。邮件适配器里两者共用同一个 isExternalReply，
//   test/mail-send.test.mjs 有一条拿真代码跑一遍钉死它们不许分家。
// ⚠ 取值只有 'draft' 才算数，其余（包括适配器抽风返回别的）一律当 'send' ——
//   补声明是**保守**方向：多一句声明不会让邮件跑到不该去的人那儿。
function draftMode(adapter, item) {
  return !!(adapter && typeof adapter.deliveryMode === 'function'
    && adapter.deliveryMode(item) === 'draft');
}

// 真正吐给传输层的那一版正文。
// ⚠ 判定一行都没改：直发这条路跟以前完全一样（enforceAgentPrefix + trim）。
function bodyFor(raw, isDraft) {
  return isDraft ? String(raw || '').trim() : enforceAgentPrefix(raw).trim();
}

// precheckSend 要跟真发用同一个适配器，才不会在「补不补声明」上跟实际行为对不上。
// ⚠ 这里**不许抛错**（预检只标不拦），认不出消息源就退回没有 deliveryMode 的形态。
function adapterForPrecheck(item, opts) {
  try {
    return hooks(opts).adapter || adapterFor(item && item.sourceKind);
  } catch {
    return null;
  }
}

// ---------- 预检：同样两道门，但**不抛错** ----------
//
// 给「还没发出去的草稿」用（待发区里的条目）。
// ⚠⚠ 这不是第二道门，**一行判定逻辑都没有重写** —— 它调的就是下面 sendReply 用的
//   同一对函数（checkCallName / enforceAgentPrefix）。两份判定 = 迟早对不上，
//   而且会出现「预检说没问题、发的时候被拦」这种最伤信任的行为。
//   （test/send.test.mjs 里有一条测试拿同一批文本同时喂给两边，钉死它们不许漂移。）
// ⚠ 为什么只标不拦：草稿本来就还没发，拦一条还没发的东西没有任何意义 ——
//   要的是让 Andy 在按发送**之前**就看见问题在哪。真发那一步的门一个字没松：
//   称呼不对照样在 sendReply 里抛 CALLNAME，绕过它仍然只有审批台上那颗「就按原文发」。
// ⚠ 通讯录走 peopleFor()：生产路径上是审批台那道门刚读到的那一份（`opts.people`），
//   假通讯录只能从 `opts.__test.people` 进来，且只在 MAILROOM_TEST==='1' 时被认
//   （理由见上面 hooks()）。两条路都读不到才退回 lib 里那份 contacts.json。
export function precheckSend(text, item, opts = {}) {
  const raw = String(text || '');
  // ⚠ 跟 sendReply 用**同一个** peopleFor()，两边不许各读各的。
  const people = peopleFor(opts);
  const to = recipientOf(item || {});
  const vios = checkCallName(raw, people, { to });
  const selfHits = checkSelfThirdPerson(raw);
  // 界面上这几样要分得开：没实质内容 / 称呼有问题 / 自称成了第三人称 / 会被补一句声明。
  // ⚠⚠ empty 必须跟 sendReply 的拒发条件**同源**，这正是这两个函数存在的意义。
  //   2026-08-08 复审逮到的漂移：empty 只判 `!raw.trim()`，于是
  //   `precheckSend('我是 Andy 的 AI Agent，以下内容已经过 Andy 本人审核。')`
  //   在界面上显示「没问题」，而同一段文本 sendReply 抛「补完声明之后正文没剩下任何内容」。
  //   现在两边都走 noSubstance()。
  const empty = noSubstance(raw);
  const bypassed = !!opts.allowFormalName;
  // 这一条会被存成草稿吗（存草稿就不补声明）——用跟真发**同一个**判据，见 draftMode()。
  const isDraft = draftMode(adapterForPrecheck(item, opts), item);
  return {
    to,
    empty,
    callName: {
      // allowFormalName 是界面上那颗「就按原文发」。预检要跟着反映它，
      // 否则勾了绕过、预检还红着，跟 sendReply 的实际行为对不上。
      ok: bypassed || !vios.length,
      bypassed,
      vios,
      message: vios.length ? callNameError(vios) : '',
    },
    // 自称门（把 Andy 写成第三人称）。⚠ 跟称呼门一样，判定函数与 sendReply 同源，
    //   这里只是提前把结论摆到眼前，一行判定都不重写。
    selfThirdPerson: {
      ok: bypassed || !selfHits.length,
      bypassed,
      hits: selfHits,
      message: selfHits.length ? selfThirdPersonError(selfHits) : '',
    },
    agentPrefix: {
      // 补是一定会补的（门在 sendReply 里），这里只是告诉人「发出去会变成什么样」。
      // ⚠ 草稿那条路不补：`body` 必须跟 sendReply 真吐出去的那一版一致，
      //   否则命令行上打出来的「实际发出去的正文」是假的（有测试钉着两边不许漂移）。
      already: hasAgentDeclaration(raw),
      draft: isDraft,
      body: bodyFor(raw, isDraft),
    },
  };
}

// ---------- 发出去的那一条，落回任务时间线 ----------
//
// ⚠ 落点取自这条消息**所属那个段**的归位结果（seg.filed）——发出去的回复跟它回的那条
//   消息读起来必须在同一个文件里，不然任务目录里只剩半边对话。
// ⚠ 目录必须是磁盘上真有的：tree.resolve() 找不到就往上退一级，**绝不照着一个路径
//   mkdir 造出假任务目录**（appendSegment 会 mkdir -p，写下去就凭空多一个假任务）。
// ⚠⚠ 逐级降落，最后一级是 P00-misc —— Andy 2026-08-12 的要求：**发出去的每一条都必须
//   落盘**。原来「没落点就只写日志」意味着主动私信（--to 不给 --filed）、回一条被丢弃
//   或还没归位的段，发出去的话在知识库里一个字都不留，这条消息的寿命就等于当前会话。
//   宁可落在 P00-misc 让他事后挪，也不许发完了无痕。
// 返回 { dir, level }。level 是「落得准不准」：task = 正落在那条消息所属的任务里，
// project / misc 都是降级，调用方要如实告诉人，好让他把这一块挪回正确的位置。
function inboxDirFor(item, dailymd) {
  const f = (item && item.filed) || null;
  if (f && f.project) {
    // ① 归到了具体任务，且那个目录真在
    if (f.task) {
      const t = resolveTask({ dailymd, project: f.project, task: f.task });
      if (t) return { dir: t, level: 'task' };
    }
    // ② 退到项目目录（只归到项目的段，或任务号是编的／任务已被搬走）
    const p = join(dailymd, 'projects', f.project);
    if (existsSync(p)) return { dir: p, level: 'project' };
  }
  // ③ 兜底：常驻杂事项目
  const misc = join(dailymd, 'projects', knowledgeBase().fallbackProject);
  return existsSync(misc) ? { dir: misc, level: 'misc' } : null;
}

// 写一块「我发出去的」进 inbox.md。字段形状照 inboxmd.renderBlock 的约定：
//   who 写成「我 → 李雷」，sentLabel 有值就在块头多渲染一行 `> 已发 · <sentLabel>`；
//   draft 为真时那一行是 `> 草稿 · …` —— 外部邮件只是躺进了用户自己的草稿箱，
//   渲染成「已发」他一周后翻时间线就会以为客户早就收到了。
function recordSent(item, body, r, dailymd) {
  const spot = inboxDirFor(item, dailymd);
  if (!spot) {
    // 走到这儿说明连 projects/P00-misc 都不在（dailymd 路径指错了）——这时候
    // 只能写日志，绝不许 mkdir 一个出来，那是在给知识库造假骨架。
    log(`⚠ 这条已经发出去了，但连兜底的 projects/P00-misc 都找不到，`
      + `没写进 inbox.md：seg=${(item && item.id) || '?'} dailymd=${dailymd}`);
    return null;
  }
  const { dir, level } = spot;
  if (level !== 'task') {
    log(`⚠ 发出去的这条没落在具体任务上（level=${level}），记进了 ${dir}：`
      + `seg=${(item && item.id) || '?'}`);
  }
  const at = localIso();
  // 同一次发送写一块。⚠ 带上时间戳：同一个段可能被回复很多次，id 撞了的话
  //   appendSegment 的幂等替换会把上一条回复整块覆盖掉。
  const id = hashId('sent', (item && item.id) || '', at, body);
  // ⚠ 草稿这一栏取 r.channel（「邮件草稿」）而不是段的来源标签（「邮件 · 某账号」）：
  //   块头那行原来一律是 `> 已发 · <via> · 审批台`，写成「已发 · 邮件 · 某账号」会让人
  //   以为这封已经发出去了。现在草稿那一行的第一个词已经是「草稿」（见下面的 draft），
  //   这里再留一份「邮件草稿」的字样，是给老块和纯文本检索兜底。
  const via = (r.draft ? r.channel : (item && item.sourceLabel)) || r.channel || '';
  appendSegment(dir, {
    id,
    who: `我 → ${r.to}`,
    // ⚠ 只认适配器给的回执：草稿是 sendVia 在 external 分支里返回的（那条分支物理上
    //   够不着 graphSend/smtpSend），所以 r.draft 为真 = 这封信一个字都还没到对方那儿。
    draft: !!r.draft,
    // ⚠ 标题行不再重复渲染来源标签（下面那行「已发 · …」已经带了），免得同一句话出现两遍
    sourceLabel: '',
    sentLabel: `${via}${via ? ' · ' : ''}审批台`,
    firstAt: at,
    lastAt: at,
    // 存**对方实际收到的那一版**（已补身份声明），不是发之前的草稿原文
    msgs: [{ id, at, text: body }],
  });
  return { dir, segId: id, level };
}

// ---------- 唯一出口 ----------
//
// item      —— 要回复的那个段（PLAN 数据模型里的 Segment）
// text      —— Andy 在权限确认框里看到并同意发出的那段话（正文整段写在命令行里，
//              就是为了让他在那个框里看得见收件人和内容）
// approval  —— 只认 { source:'approval-desk-button' }
// opts      —— allowFormalName: 称呼门的唯一绕过口（界面上的「就按原文发」）
//              dailymd:         落回哪个库，默认 dailymdRoot()
//              __test:          { people, adapter } —— 只在 MAILROOM_TEST==='1' 时被认，
//                               见上面 hooks()。⚠ adapter 尤其要紧：测试里不注入的话
//                               会真打 hap CLI，而 `hap chat send-to-one` 对任何 accountId
//                               都回 `Message sent.`——跑一次测试就是真往同事那儿发一条。
//
// 返回 { channel, to, body, filed }。body 是真正吐给适配器、对方实际收到的那一版正文
// （已经过 enforceAgentPrefix 补齐身份声明）——调用方手上只有「发之前」的原文，
// 要记录/同步这条消息一律用返回的 body，别拿原文顶替。
// ⚠ 为什么是 async：邮件适配器的 sendVia 是异步的（Graph 走 HTTP）。
//   ⚠⚠ 上面那几道门**一行判定都没改**，而且它们全都在第一个 await **之前**跑完——
//   也就是说 assertHumanApproved / 称呼门 / 身份声明仍然是**同步**执行的，
//   进程环境变量（MAILROOM_ROLE / MAILROOM_TEST）在这期间不会被别的 await 插进来改掉。
// ⚠ 附件走**第五个参数**，不塞进 opts：opts 的键集合被 callname-gate 那条测试钉死了
//   （「多一个键就是多一条夹带的路」）。附件是要发出去的东西，不是门的配置，
//   分开传才看得见。
export async function sendReply(item, text, approval, opts = {}, payload = {}) {
  let body;
  let adapter;
  // ⚠⚠ 这个 try 只干一件事：给抛出去的错**打个 stage 标记**，一道门的判定都没改。
  //   为什么要这个标记（2026-08-08 评审的 Important）：审批台原来把「抛错」一律当成
  //   「没发出去」，还令牌、让「发送」按钮重新可点。但传输层抛错分两种 ——
  //   `hap()` 超时或 CLI 非零退出时，**消息可能已经投出去了**，只是我们不知道。
  //   两种混为一谈的后果是：Andy 看到「没发出去」再按一次，同事收到两条，
  //   而明道云没有撤回接口。所以这里如实分成两级：
  //     stage='pre-send' —— 还没吐给传输层，**确定**一个字都没发出去，可以放心重试；
  //     stage='unknown'  —— 已经吐给传输层了，结果不明，**不许一键重发**。
  try {
    assertHumanApproved(approval);
    const raw = String(text || '');
    if (!raw.trim()) throw new Error('拒绝发送：内容为空。');
    // ⚠⚠ 兜底（2026-08-08 评审的 Critical）：补完声明之后正文一个字都不剩，
    //   对方就只会收到一句光秃秃的身份声明，而 Andy 在审批台上看到的是自己那段完整的话，
    //   事后翻 inbox.md 也看不出发生过什么。宁可拒发让他重写，也不发半句。
    //   ⚠ 判据跟剥离用的是**同一个函数**，不另写一套（跟 precheckSend 同源是一个道理）。
    if (noSubstance(raw)) {
      throw new Error('拒绝发送：补完身份声明之后正文没剩下任何内容，不发一句光秃秃的声明。');
    }
    // ⚠ 称呼要查**原文**，不能查 body：身份声明会被 enforceAgentPrefix 换掉，
    //   而 2026-08-07 那条事故正文恰好是「金总您好，我是 Andy 的 AI Agent，…」写在同一行 ——
    //   原文是 body 的超集，查它更硬。（有一条测试钉着这个句式必须抛 CALLNAME。）
    assertProperCallName(raw, opts.allowFormalName, recipientOf(item), peopleFor(opts));
    // ⚠ 同样查 raw 不查 body，理由同上：声明句里的 Andy 由 checkSelfThirdPerson 自己剥掉。
    assertNotThirdPersonSelf(raw, opts.allowFormalName);

    adapter = hooks(opts).adapter || adapterFor(item && item.sourceKind);

    // ⚠ 身份声明必须在这一步补，不能只在草拟时加 —— 草稿框是可编辑的，
    //   删掉声明照样能发。这里是全系统唯一的出口，所以门开在这里才关得住。
    // ⚠⚠ 2026-08-10：这一句从上面挪到了这里（原来紧跟在「内容为空」后面），
    //   因为要先知道适配器会**发**还是**存草稿**——存草稿不补声明（见 draftMode()）。
    //   挪动**没有改变任何一道门的判定和先后**：
    //     · 它自己不抛错；
    //     · 下面两道门（noSubstance / assertProperCallName）查的都是 `raw`，
    //       跟 body 无关（各自的注释里写着为什么必须是 raw）；
    //     · 抛错顺序仍然是 内容为空 → 剥完为空 → 称呼 → 认不出消息源。
    body = bodyFor(raw, draftMode(adapter, item));
  } catch (e) {
    e.stage = 'pre-send';
    throw e;
  }

  // ⚠ 落盘一定在发送**之后**：发不出去就绝不许在 inbox.md 里留下一条「已发」，
  //   那比没记录更糟——Andy 会以为对方收到了。
  let r;
  try {
    // payload.filePath：正文之后再发一个本地文件（只有 hap 那条路支持，见 connect/hap.mjs）。
    r = await adapter.sendVia({ ...item, kind: typeOf(item) }, body, { filePath: payload.filePath || '' });
  } catch (e) {
    // ⚠ 这里**不许**标成 pre-send：超时/非零退出跟「投递之后才失败」分不开。
    // ⚠⚠ 唯一的例外是适配器**自己已经标了**：只有它知道这一步到底碰没碰传输层
    //   （比如邮件的外部分支只存草稿，最坏结果是草稿箱里少一份，一个字都到不了对方那儿，
    //   它会标 'pre-send'）。默认值一个字没松：没标的一律还是 unknown。
    if (!e.stage) e.stage = 'unknown';
    throw e;
  }
  // ⚠ 草稿不许报成「已发送」：外部邮件走到这儿只是躺进了 Andy 自己的草稿箱，
  //   还没到任何人手上。报错了他会以为客户收到了，那比不发更糟。
  log(r.draft ? `已存草稿 ${r.channel} → ${r.to}` : `已发送 ${r.channel} → ${r.to}`);

  // ⚠⚠ 到这儿消息**已经在对方那边了**，往后任何一步失败都不许把成功报成失败：
  //   抛出去的话调用方（审批台）会当成没发出去，Andy 很可能再按一次 = 对方收到两条。
  let filed = null;
  try {
    filed = recordSent(item, body, r, opts.dailymd || dailymdRoot());
  } catch (e) {
    log('⚠ 消息已经发出去了，但没写进 inbox.md（发送本身是成功的，别重发）：',
      String((e && e.message) || e).slice(0, 300));
  }
  return { ...r, body, filed };
}
