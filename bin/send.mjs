#!/usr/bin/env node
// ⚠⚠ 全系统唯一的发送入口。整个仓库只有这个文件会把 MAILROOM_ROLE 设成 approval-desk，
//   也就是说：**只有这条命令跑起来，send.mjs 才肯发东西**。
//
// 「那颗按钮」现在是 Claude Code 的权限确认框。这条命令在权限设置里永远是 ask，
// Andy 每发一条都要亲手点一次同意。所以正文是**整段写在命令行参数里**的，不是引用一个
// 草稿 id —— 就为了让他在那个确认框里直接看见收件人和内容，不用回头翻对话。
// 改成 `--draft <id>` 之类的写法等于把内容从他眼前拿走，别这么改。
//
// ⚠ 这条命令绝不许被自动化调用、绝不许进免确认名单、绝不许由别的脚本 spawn。
//   配套还有一条同样重要：`hap chat send*` / `hap post*` 得在 deny 名单里。
//   少了那一条，模型绕开本文件直接敲 hap 就发出去了 —— 那正是 2026-08-08 的事故
//   （3 条以 Andy 名义发给同事的消息绕过审批台直接发了，明道云没有撤回接口）。
//
// ✅ 2026-08-12 那条配套装上了 8 条：`~/.claude/settings.json` 的 `permissions.deny` 里
//   列了 chat send-to-* / send-file-to-* / post create·comment·update /
//   worksheet record add-discussion。⚠⚠ `hap task *` 当时漏了 —— 别写成一直都有。
//   2026-08-13 任务评论接进 mailroom 的同一天，补上了 `hap task comment`，现在是 9 条。
//   ⚠ `hap task create` / `hap task charge` **是故意没进 deny 的，不是漏了**：派活（建任务）
//   这一轮没有收进 mailroom，`bin/send.mjs` 不会建任务 —— 把 `task create` 堵死等于把派活
//   彻底堵死，无路可走。那条继续靠全局 CLAUDE.md 的规矩拦着（任务描述开头自己写身份声明），
//   代码不焊。看到这条别顺手「补全」，那是取舍不是遗漏。
//   ⚠⚠ 在 2026-08-12 之前 deny 是空的，而全局 `defaultMode` 是 `bypassPermissions` —— 也就是说本文件
//   注释里写的「那颗按钮」（权限确认框）**根本不会弹**，唯一真正拦得住的是两步确认码
//   加 Andy 在对话里那句「发」。deny 是硬拦截，bypassPermissions 下照样生效（实测过）。
//   删 deny 名单 = 把这道门整个拆掉，别删。
//   ⚠ deny 匹配的是**我敲的那行命令**，不是 node 起的子进程 —— 所以本文件内部调 hap 不受影响。
//
// ⚠⚠ 2026-08-18 T157 开了目前唯一一个「绕过本文件直接发群消息」的例外：dailymd 里
//   `projects/P11-nocoly-sea-marketing/tasks/T157-.../scripts/weekly-post.mjs`，
//   跑在腾讯云硅谷服务器的 crontab 上，每周一发一条假期播报到 Nocoly Pioneer 群。
//   获批理由三条，**新开口子必须同时满足，不满足就不该抄这个例外**：
//   1. 正文 100% 由固定模板 + 人工审过的静态 JSON 数据拼出，运行时不调任何模型
//   2. 收件人恒为同一个群，不会变
//   3. 幂等：state.json 记最后播报的 ISO 周号，同周不重发（明道云没有撤回接口）
//   详见 `assets/docs/authority.md` 对应那行和 `assets/stacks/holiday-sync/facts.md`。
//
// ⚠⚠ 2026-08-12 Andy 把「每条都要我点头」松成三档（他的原话：不是所有东西都需要我确认的）：
//   🟢 自动发   —— `--auto "<判成🟢的理由>"`。**必须同时**满足 6 条客观死条件（见 autosend.mjs
//                  的 cageCheck），少一条当场拒发。内容是不是纯回执由模型判，但只在笼子里算数。
//                  每一条都写进 `~/.mailroom/autosend.jsonl`，含理由。
//   🟡 发完报备 —— 不带 `--auto` 的普通发送，行为一个字没变，发完在对话里说一声。
//   🔴 他点头   —— 两步确认码。主动私信（`--to`）、主动在任务下留言（`--task`）**和群消息**走这档。
// ⚠ 群消息后来才纳入 🔴（以前 `--seg` 回群是直接发的）：群受众广、传得远，
//   而 🔴 那一档本来就写着「群消息」，不焊进代码的话这一档只是一句口号。
//
// 用法：
//   node bin/send.mjs --seg <段id> --text "要发的正文"
//   node bin/send.mjs --seg <段id> --text "..." --auto "对方问文件在哪，照实答，无承诺"
//   node bin/send.mjs --seg <段id> --text "..." --formal-name    # 称呼门 + 自称门的唯一绕过口
//
// 主动发起一条明道云私信（不是给「回复」用的）：
//   node bin/send.mjs --to 韩梅 --text "..."                    # 第一步：只预览，打出确认码
//   node bin/send.mjs --to 韩梅 --text "..." --confirm <码>      # 第二步：Andy 点头后才真发
//   附加：--account-id <id> 重名时指名道姓 · --filed P12-xxx/T61-xxx 落回哪个任务的 inbox.md
//        --off-hours 非工作时段的显式出口
//        --skip-recheck 跳过发送前的重收（见下面那道闸门，别随手加）
//        --file <本地路径> 正文之后再发一个文件（明道云私信/群消息才有；邮件那条路不支持）
//
// 主动在某个任务下留一条评论（2026-08-13 加）：
//   node bin/send.mjs --task <taskId> --text "..." [--account-id <任务负责人>] [--filed ...]
//   node bin/send.mjs --task <taskId> --text "..." --confirm <码>
// ⚠ 为什么要这个入口：`--seg` 只能**回**任务里已经有人 @ 我的那条评论。「我派了个活、
//   想去任务下问一句进度」在段库里没有段可回，唯一的出路就成了直接敲 `hap task comment`
//   —— 而那条命令在 deny 名单里（正是要堵的形状）。补的是入口，不是第二条路。
// ⚠ 受众是这个任务的**全体参与人**，比私信广，所以恒为 🔴，没有 --auto 的口子；
//   「别在休息时间打扰」那道门也跟主动私信一样管着它。
// ⚠ 附件也进确认码：换了文件 = 换了要发的东西，Andy 得重新看一眼。
// ⚠ 两步是**故意**的，见 dm.mjs 的 confirmToken：确认码由收件人 + 真正要发的正文算出，
//   改一个字就对不上，Andy 在对话里看到的那一版和发出去的那一版被钉成同一份。
//
// 主动在一条动态下留一条评论（2026-08-16 加）：
//   node bin/send.mjs --post <动态id> --text "..." [--account-id <发帖人id>] [--filed ...]
//   node bin/send.mjs --post <动态id> --text "..." --confirm <码>
// ⚠ 为什么要这个入口：`--seg` 只能**回**动态评论区里已经有人 @ 我的那条评论。「老板发了个
//   进展帖，我们想去底下跟一条总结」在段库里没有段可回，唯一的出路就成了直接敲
//   `hap post comment` —— 而那条命令在 deny 名单里（正是要堵的形状）。补的是入口，不是第二条路。
// ⚠ 受众是这条动态能看到的所有人（可能整个明道全体群），比私信广得多，所以恒为 🔴，
//   没有 --auto 的口子；「别在休息时间打扰」那道门也跟任务评论一样管着它。
// ⚠ 只覆盖「主动发起」这条路。`--seg` 回复动态评论区里已经 @ 我的那条评论，走的还是
//   原来的档位（跟改动前一样，不在这次范围内），见 dm.mjs synthPost 顶部注释。
//
// 主动往一个群发一条消息（不是回群里已经收到的消息）（2026-08-17 加）：
//   node bin/send.mjs --group <群id 或群名> --text "..." [--filed ...]
//   node bin/send.mjs --group <群id 或群名> --text "..." --confirm <码>
// ⚠ 为什么要这个入口：`--seg` 只能**回**一条群里已经收到的消息。「往群里发一条公示，
//   没人先发起过」在段库里没有段可回，唯一的出路就成了直接敲 `hap chat send-to-group`
//   —— 而那条命令在 deny 名单里（正是要堵的形状）。补的是入口，不是第二条路。
// ⚠ 受众是整个群，比私信、比任务评论都广，恒为 🔴（跟 --seg 回群消息一个待遇——
//   那条路早就是 🔴 了，见上面 2026-08-12 那条备注），没有 --auto 的口子；
//   「别在休息时间打扰」那道门也管着它。
// ⚠ 群名找不到、或对上多个候选一律拒发，不猜——跟人名解析（resolveRecipient）同一个道理。
//
// 身份声明会自动补在开头（`enforceAgentPrefix`），不用自己写。

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { dailymdRoot, log, ownerName } from '../lib.mjs';
import { precheckSend, sendReply, typeOf } from '../send.mjs';
import {
  resolveRecipient, synthDm, synthTask, synthRecord, synthPost, synthGroup, synthFeed,
  confirmToken, offHours,
} from '../dm.mjs';
import { cageCheck } from '../autosend.mjs';
// ⚠ 只拿 replyViaOf / listGroups 这两个纯判定 / 只读函数，不碰 sendVia ——
//   发送这条路照旧只经 send.mjs。test/connect.test.mjs ① 盯着谁调 sendVia。
import { replyViaOf, listGroups } from '../connect/hap.mjs';
// ⚠ 只 import logSent 一个：老账本的一次性迁移归 bin/fetch.mjs 和 bin/outbox-report.mjs，
//   发送这条路上一行迁移代码都不该有（这里以前挂着一个 migrateAutosendOnce，全文没有调用点）。
import { logSent } from '../outbox.mjs';
import { whoAmI, loopSession } from '../session.mjs';
import { recheckBeforeSend } from '../recheck.mjs';
import { boostHeartbeat } from '../heartbeat.mjs';
import * as store from '../store.mjs';

// 只有这两个通道值得把心跳踩热——「私信」「群消息」是即时通讯节奏，
// 「动态评论」「任务评论」「记录讨论」「邮件」本来就是慢节奏，见 send() 里的调用点。
const HEARTBEAT_CHANNELS = new Set(['私信', '群消息']);

function parseArgs(argv) {
  const out = {
    seg: '', text: '', formalName: false,
    to: '', accountId: '', filed: '', confirm: '', offHours: false, file: '', files: [], auto: '',
    skipRecheck: false, why: '', task: '', post: '', group: '', at: [],
    feed: '', orgId: '', shareOrg: false, cardTitle: '', cardDesc: '', cardHint: '',
    record: '', worksheet: '', row: '', appId: '', viewId: '', replyId: '', recordName: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--seg') out.seg = String(argv[++i] || '');
    else if (a === '--text') out.text = String(argv[++i] || '');
    else if (a === '--formal-name') out.formalName = true;
    else if (a === '--to') out.to = String(argv[++i] || '');
    // 主动在某个任务下留一条评论（不是回复已收到的通知）。
    else if (a === '--task') out.task = String(argv[++i] || '');
    // 主动在某条动态下留一条评论（不是回复动态评论区已经 @ 我们的那条）。
    else if (a === '--post') out.post = String(argv[++i] || '');
    // 主动往某个群发一条消息（不是回群里已经收到的消息）。
    else if (a === '--group') out.group = String(argv[++i] || '');
    // 主动往群里发「动态承载正文 + 群卡片引流」（长内容的正规形态，不刷屏）。
    else if (a === '--feed') out.feed = String(argv[++i] || '');
    else if (a === '--org-id') out.orgId = String(argv[++i] || '');
    // 显式要全公司可见才加；不加就只发那一个群（默认收窄，见 2026-08-19 全公司误发）。
    else if (a === '--share-org') out.shareOrg = true;
    else if (a === '--card-title') out.cardTitle = String(argv[++i] || '');
    else if (a === '--card-desc') out.cardDesc = String(argv[++i] || '');
    else if (a === '--card-hint') out.cardHint = String(argv[++i] || '');
    // 群消息真正生效的 @ 提醒（可重复），不是正文里的 [aid] 标记——那是动态/评论用的语法。
    else if (a === '--at') out.at.push(String(argv[++i] || '').trim());
    // 主动在某张工作表的某条记录下留讨论。
    else if (a === '--record') out.record = String(argv[++i] || '');
    else if (a === '--worksheet' || a === '--ws') out.worksheet = String(argv[++i] || '');
    else if (a === '--row') out.row = String(argv[++i] || '');
    else if (a === '--app-id') out.appId = String(argv[++i] || '');
    else if (a === '--view-id') out.viewId = String(argv[++i] || '');
    else if (a === '--reply-id') out.replyId = String(argv[++i] || '');
    else if (a === '--record-name') out.recordName = String(argv[++i] || '');
    else if (a === '--account-id') out.accountId = String(argv[++i] || '');
    else if (a === '--filed') out.filed = String(argv[++i] || '');
    else if (a === '--confirm') out.confirm = String(argv[++i] || '');
    else if (a === '--off-hours') out.offHours = true;
    else if (a === '--skip-recheck') out.skipRecheck = true;
    else if (a === '--file') {
      const val = String(argv[++i] || '');
      if (val) {
        out.files.push(val);
        out.file = val;
      }
    }
    // ⚠ 理由是**跟着值给**的，不是布尔开关：`--auto` 后面必须跟一句话，
    //   写不出理由的就不该判成 🟢。日志里查的正是这句话。
    else if (a === '--auto') out.auto = String(argv[++i] || '');
    else if (a === '--why') out.why = String(argv[++i] || '');
  }
  return out;
}

// `--filed P12-mpc2026/T61-2026-08-04-xxx` → { project, task }，只给项目也行。
// ⚠ 这里只拆字符串，**不检查目录存不存在**：真正的落点由 send.mjs 的 inboxDirFor 用
//   tree.resolve() 去磁盘上找，找不到就当没落点（绝不 mkdir 造假任务目录）。
function parseFiled(s) {
  const raw = String(s || '').trim().replace(/^\/+|\/+$/g, '');
  if (!raw) return null;
  const [project, task] = raw.split('/');
  if (!project) return null;
  return task ? { project, task } : { project };
}

// 档位。⚠ 算在一处，别散落到判断里 —— 散开写迟早出现「记账记的是 🟡、
//   走的却是 🔴 的流程」这种对不上。
export function tierOf({
  auto = '', wantDm = false, isGroup = false, isTask = false, isRecord = false, isPost = false,
} = {}) {
  if (auto) return '🟢';
  if (wantDm || isGroup || isTask || isRecord || isPost) return '🔴';
  return '🟡';
}

// 这一条要不要 --why。
// ⚠ 只有 🟡 要：🟢 的理由走 --auto（已经必填），🔴 走两步确认码（Andy 本人背书），
//   存草稿的那封信一个字都没出去、最终是他自己点的发送。
export function needWhy({ tier = '', isDraft = false } = {}) {
  return tier === '🟡' && !isDraft;
}

// 称呼门：**这一路唯一一次读通讯录**，返回 { error, people }。照搬老审批台那份，
// 一个字都别改松，两个洞是 2026-08-08 评审实跑复现出来的：
//   ⚠⚠ `checkCallName` 读不到通讯录时返回 0 条违规 —— 0 条 = 放行，是 fail-open。
//      宁可拒发也不许静默放行。
//   ⚠⚠ `lib.mjs` 的 `contacts()` 模块级缓存里 `[]` 是 truthy，「第一次用到时恰好
//      读不到」会把空表缓存住，而门自己重新读文件、看到文件好好的就放行。
//      所以这里读到的名单要**显式传下去**（opts.people → sendReply → checkCallName），
//      一条路只读一次，两处不再分家。
export function callNameGate(dailymd) {
  const root = dailymdRoot();
  if (dailymd !== root) {
    return {
      error: `拒绝发送：这次发送针对的是 ${dailymd}，而称呼门读的通讯录在 ${root}，`
        + '两边不是同一个库。（读不到人就一条违规都查不出来，等于门大开——宁可拒发。）',
      people: null,
    };
  }
  const file = join(root, 'contactmd/contacts.json');
  try {
    const list = JSON.parse(readFileSync(file, 'utf-8'));
    if (Array.isArray(list) && list.length) return { error: null, people: list };
  } catch { /* 落到下面统一拒发 */ }
  return {
    error: `拒绝发送：读不到通讯录（${file}），称呼门失效。`
      + '（这道门读不到人就一条违规都查不出来，等于门大开——宁可拒发。）',
    people: null,
  };
}

// 喂给 sendReply 的 opts。**只显式挑字段，绝不 `{...args}`。**
// ⚠ people 只从 callNameGate() 刚读到的那份名单来。这个函数的键集合被
//   test/send.test.mjs 钉着，多一个键就是多一条夹带的路。
export function sendOptsFor(dailymd, formalName, people) {
  const opts = { dailymd, allowFormalName: formalName === true };
  if (people !== undefined && people !== null) opts.people = people;
  return opts;
}

// 把这次的命令原样拼回去，只多一个 --confirm。⚠ 打全的理由：Andy 点头之后
// 重跑的必须是**一模一样**的那条命令，凭记忆重敲很容易漏掉 --filed 或改动正文，
// 而正文一改确认码就对不上（那时的报错反而看不懂）。
function fileSizeLabel(p) {
  try {
    const mb = statSync(p).size / 1024 / 1024;
    return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(mb * 1024))} KB`;
  } catch {
    return '大小未知';
  }
}

function replayCommand(argv, token) {
  const q = (s) => (/^[\w./:@-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "'\\''")}'`);
  return `node bin/send.mjs ${argv.map(q).join(' ')} --confirm ${token}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // 主动在某张工作表的某条记录下留言：`--record <wsId>/<rowId>` 或 `--worksheet <wsId> --row <rowId>`
  const wantRecord = !!args.record || (!!args.worksheet && !!args.row);
  const wantTask = !!args.task;
  const wantPost = !!args.post;
  const wantGroup = !!args.group;
  const wantFeed = !!args.feed;
  const wantDm = !!args.to
    || (!wantRecord && !wantTask && !wantPost && !wantGroup && !wantFeed && !!args.accountId);

  if (wantFeed && (args.seg || args.to || wantRecord || wantTask || wantPost || wantGroup)) {
    console.log('拒绝发送：--feed（动态+群卡片）和 --seg / --to / --record / --task / --post / --group 只能给一个。');
    return 1;
  }

  if (wantRecord && (args.seg || args.to || args.task || wantPost || wantGroup)) {
    console.log('拒绝发送：--record（主动在记录讨论下留言）和 --seg / --to / --task / --post / --group 只能给一个。');
    return 1;
  }
  if (wantTask && (args.seg || args.to || wantRecord || wantPost || wantGroup)) {
    console.log('拒绝发送：--task（主动在任务下留言）和 --seg / --to / --record / --post / --group 只能给一个。');
    return 1;
  }
  if (wantPost && (args.seg || args.to || wantRecord || wantTask || wantGroup)) {
    console.log('拒绝发送：--post（主动在动态下留言）和 --seg / --to / --record / --task / --group 只能给一个。');
    return 1;
  }
  if (wantGroup && (args.seg || args.to || wantRecord || wantTask || wantPost)) {
    console.log('拒绝发送：--group（主动往群里发消息）和 --seg / --to / --record / --task / --post 只能给一个。');
    return 1;
  }
  if (wantDm && (args.seg || wantTask || wantRecord || wantPost || wantGroup)) {
    console.log('拒绝发送：--to（主动发起私信）和 --seg / --task / --record / --post / --group 只能给一个。');
    return 1;
  }
  if ((!args.seg && !wantDm && !wantTask && !wantRecord && !wantPost && !wantGroup && !wantFeed) || !args.text.trim()) {
    // ⚠ 附件那一行放在用法块**第一行**：2026-08-14 有人只读了 --help 的前几十行就判定
    //   「这脚本不支持附件」，跑去另一台 Mac 找实现，还多问了机主一轮。能力清单被截断
    //   在哪儿，就等于不存在——最容易被漏的那条要排最前面。
    console.log('附件：任何一条命令都能加 --file <本地路径>');
    console.log('　　　（明道云私信/群消息/任务评论/记录讨论/动态评论都行，正文里提到附件类词又没给 --file 会被当场拦下；');
    console.log('　　　　只有邮件那条路不支持，传了会直接拒发）');
    console.log('');
    console.log('用法：node bin/send.mjs --seg <段id> --text "正文" [--formal-name]');
    console.log(`　　　node bin/send.mjs --seg <段id> --text "正文" --why "凭什么不问 ${ownerName()} 就发"   # 🟡 回私信/评论等要带这个`);
    console.log('　　　node bin/send.mjs --seg <段id> --text "正文" --auto "判成🟢的理由"   # 🟢 自动发');
    console.log('　　　node bin/send.mjs --to <人名> --text "正文" [--account-id <id>] [--filed P0X-xxx/T0X-xxx]');
    console.log('　　　　（主动私信分两步：先跑一次看预览拿确认码，再带 --confirm <码> 真发）');
    console.log('　　　node bin/send.mjs --task <taskId> --text "正文" [--account-id <任务负责人>] [--filed ...]');
    console.log('　　　　（主动在任务下留言，受众是任务全体参与人，同样走 🔴 两步确认码）');
    console.log('　　　node bin/send.mjs --record <worksheetId>/<rowId> --text "正文" [--reply-id <id>] [--account-id <对方id>] [--filed ...]');
    console.log('　　　　（主动在记录讨论下留言，同样走 🔴 两步确认码）');
    console.log('　　　node bin/send.mjs --post <动态id> --text "正文" [--account-id <发帖人id>] [--filed ...]');
    console.log('　　　　（主动在一条动态下留言，不是回复动态评论区已经 @ 我们的那条，同样走 🔴 两步确认码）');
    console.log('　　　node bin/send.mjs --group <群id 或群名> --text "正文" [--filed ...]');
    console.log('　　　　（主动往群里发一条消息，不是回群里已经收到的消息，同样走 🔴 两步确认码）');
  console.log('　　　node bin/send.mjs --feed <群id 或群名> --text "正文" --org-id <组织id> --card-title "卡片标题" [--card-desc "预览文案"] [--share-org]');
  console.log('　　　　（长内容的正规形态：动态承载正文 + 群聊卡片引流，同样走 🔴 两步确认码；不加 --share-org 就只发那一个群）');
    return 1;
  }
  // ⚠ 文件不存在要在**预览之前**就拦下：不然 Andy 看完预览点了同意，正文发出去了，
  //   附件那一步才发现路径打错——对方收到半截，而消息撤不回来。
  for (const f of args.files) {
    if (!existsSync(f)) {
      console.log(`拒绝发送：--file 指的文件不存在：${f}`);
      return 1;
    }
  }
  // ⚠⚠ 2026-08-18 事故：往某个群发 icon 包，正文写了「包」「打包」，
  //   命令却漏了 --file——发出去只有文字，附件根本没到群里，Andy 当场发现。
  //   这道闸不判断「这段话真的在承诺附件」（那是语义活，判不准），只做一件死
  //   条件的事：正文里出现这几个词、又没给 --file，就当场拦下来问一句，
  //   宁可多拦、也别再让「正文说了有个包，实际没有包」发出去。
  //   词单宁可宽：命中了但其实没打算带附件，改一下正文措辞就过，成本远低于
  //   漏发一次。
  const ATTACHMENT_WORDS = /(附件|压缩包|安装包|资源包|图标包|icon\s*包|见附件|见下方文件|已打包|打包一份|给你发|发你|发过去|发给你|随信附上)/i;
  if (!args.files.length && ATTACHMENT_WORDS.test(args.text)) {
    const hit = args.text.match(ATTACHMENT_WORDS)[0];
    console.log(`拒绝发送：正文里出现「${hit}」这类词，但没给 --file——多半是想带附件却忘了传参数。`);
    console.log('   真要带附件，加 --file <本地路径> 重发；确实不带附件，把正文里这处措辞改掉再发。');
    return 1;
  }
  // ⚠⚠ 2026-08-28 事故：给某同事发动态评论，正文自己写了「@某同事 ...」，
  //   命令又给了 --account-id —— connect/hap.mjs 会再拼一个真正生效的
  //   `[aid]<id>[/aid]` 标记，发出去 UI 上就是「@某同事 @某同事」两个 @。
  //   hap.mjs 里本来有一段「正文开头是对方人名就替换掉」的兜底，但它依赖 item.who，
  //   而 --post/--account-id 这条路 who 是空的（通讯录里那位同事没有 md_account_id，
  //   查也查不出名字），兜底整段不生效。
  //   这里做死条件拦截，不猜名字：**正文开头写了字面 @，同时又会自动生成 @ 标记**，
  //   就当场拦下——@ 是自动加的，正文里不该再写一遍。动态评论没有撤回接口，
  //   宁可拦下来重敲一次，也别再发出去一条带两个 @ 的。
  const LITERAL_AT_LEAD = /^\s*@\S/;
  const willAutoMention = (wantPost || wantTask || wantRecord) && !!args.accountId;
  if (willAutoMention && LITERAL_AT_LEAD.test(args.text)) {
    console.log('拒绝发送：正文开头写了字面 @，但这条路的 @ 是根据 --account-id 自动生成的');
    console.log('   （动态评论/任务评论/记录讨论都用 [aid] 标记，服务端才会推通知、UI 才会高亮）。');
    console.log('   两个 @ 会同时出现。把正文开头那个 @xxx 删掉重发，@ 交给 --account-id 生成。');
    return 1;
  }
  // ⚠ `--auto` 后面必须真有一句理由。写成 `--auto --text ...` 会把下一个参数吃掉，
  //   所以顺手把「理由看起来像个参数」也拦了。
  if (process.argv.includes('--auto') && (!args.auto.trim() || args.auto.startsWith('--'))) {
    console.log('拒绝发送：--auto 后面要跟一句判成 🟢 的理由（写不出理由的就不该自动发）。');
    return 1;
  }
  if (process.argv.includes('--why') && (!args.why.trim() || args.why.startsWith('--'))) {
    console.log(`拒绝发送：--why 后面要跟一句理由（写不出理由 = 这条不该是 🟡，降到 🔴 让 ${ownerName()} 看一眼）。`);
    return 1;
  }
  if (args.auto && (wantDm || wantTask || wantRecord || wantPost || wantGroup || wantFeed)) {
    console.log('拒绝发送：--auto 只用于回复（--seg）。主动发起私信 / 任务留言 / 记录讨论 / 动态评论 / 群消息一律走 🔴 两步确认码。');
    return 1;
  }

  const dailymd = dailymdRoot();
  let item;
  let gate;
  let dmTo = null;

  if (wantDm) {
    // ⚠ 通讯录必须先读：resolveRecipient 要用**跟称呼门同一份**名单（一条路只读一次）。
    gate = callNameGate(dailymd);
    if (gate.error) {
      console.log(gate.error);
      return 1;
    }
    try {
      dmTo = args.accountId
        // --account-id 是重名时的指名道姓出口。名字仍从通讯录反查，称呼门要按人判。
        ? {
          accountId: args.accountId,
          name: (gate.people.find((c) => c.md_account_id === args.accountId) || {}).name
            || args.to || '',
          from: '--account-id',
        }
        : resolveRecipient(args.to, { people: gate.people });
    } catch (e) {
      console.log(String((e && e.message) || e));
      return 1;
    }
    item = synthDm({ accountId: dmTo.accountId, name: dmTo.name, filed: parseFiled(args.filed) });
  } else if (wantTask) {
    // ⚠ 通讯录同样先读（理由跟私信那条一样：称呼门要用同一份名单）。
    gate = callNameGate(dailymd);
    if (gate.error) {
      console.log(gate.error);
      return 1;
    }
    // 任务负责人只用来给称呼门认人：给了 --account-id 就按那个人判，没给就退回全表判定
    // （checkCallName 对 kind:'user' 但 name 为空的收件人本来就是「拿不准一律关门」）。
    const owner = args.accountId
      ? (gate.people.find((c) => c.md_account_id === args.accountId) || {})
      : {};
    item = synthTask({
      taskId: args.task,
      name: owner.name || '',
      accountId: args.accountId,
      filed: parseFiled(args.filed),
    });
  } else if (wantPost) {
    // ⚠ 通讯录同样先读（理由跟任务那条一样：称呼门要用同一份名单）。
    gate = callNameGate(dailymd);
    if (gate.error) {
      console.log(gate.error);
      return 1;
    }
    // 找被 @ / 评论回复的对象：--account-id / --to / --at / 正文首词称呼
    let poster = null;
    if (args.accountId) {
      poster = gate.people.find((c) => c.md_account_id === args.accountId) || { md_account_id: args.accountId, name: '' };
    } else if (args.to) {
      poster = gate.people.find((c) => c.name === args.to || c.nickname === args.to || c.en_name === args.to || (Array.isArray(c.aliases) && c.aliases.includes(args.to))) || null;
      if (!poster) {
        try {
          const res = resolveRecipient(args.to, { people: gate.people });
          poster = { md_account_id: res.accountId, name: res.name };
        } catch { /* ignore */ }
      }
    } else if (args.at && args.at.length) {
      const atKw = args.at[0];
      poster = gate.people.find((c) => c.name === atKw || c.nickname === atKw || c.en_name === atKw || (Array.isArray(c.aliases) && c.aliases.includes(atKw)) || c.md_account_id === atKw) || null;
      if (!poster) {
        try {
          const res = resolveRecipient(atKw, { people: gate.people });
          poster = { md_account_id: res.accountId, name: res.name };
        } catch { /* ignore */ }
      }
    } else {
      const match = args.text.match(/^@?([a-zA-Z\u4e00-\u9fa5]+)[，,：:\s]/);
      if (match) {
        const word = match[1];
        poster = gate.people.find((c) => c.name === word || c.nickname === word || c.en_name === word || (Array.isArray(c.aliases) && c.aliases.includes(word))) || null;
      }
    }
    const targetAccountId = (poster && poster.md_account_id) || args.accountId || '';
    const mentionAccountIds = (args.at && args.at.length)
      ? args.at.map((a) => {
          const p = gate.people.find((c) => c.name === a || c.nickname === a || c.md_account_id === a || c.en_name === a || (Array.isArray(c.aliases) && c.aliases.includes(a)));
          return (p && p.md_account_id) || a;
        })
      : (targetAccountId ? [targetAccountId] : []);

    item = synthPost({
      postId: args.post,
      name: (poster && poster.name) || args.to || '',
      accountId: targetAccountId,
      filed: parseFiled(args.filed),
      replyCommentId: args.replyId,
      replyAccountId: targetAccountId,
      mentionAccountIds,
    });
  } else if (wantRecord) {
    gate = callNameGate(dailymd);
    if (gate.error) {
      console.log(gate.error);
      return 1;
    }
    let wid = args.worksheet;
    let rid = args.row;
    if (args.record) {
      const parts = args.record.split(/[/,: ]+/).filter(Boolean);
      if (parts.length >= 2) {
        wid = wid || parts[0];
        rid = rid || parts[1];
      } else if (parts.length === 1 && !wid) {
        wid = parts[0];
      }
    }
    const peer = args.accountId
      ? (gate.people.find((c) => c.md_account_id === args.accountId) || {})
      : (args.to ? (gate.people.find((c) => c.name === args.to || c.nickname === args.to) || {}) : {});
    item = synthRecord({
      worksheetId: wid,
      rowId: rid,
      appId: args.appId,
      viewId: args.viewId,
      replyId: args.replyId,
      recordName: args.recordName,
      name: peer.name || args.to || '',
      accountId: peer.md_account_id || args.accountId || '',
      filed: parseFiled(args.filed),
    });
  } else if (wantGroup) {
    gate = callNameGate(dailymd);
    if (gate.error) {
      console.log(gate.error);
      return 1;
    }
    // 群 id 是明道云的 uuid 形状（8-4-4-4-12），直接给的就不用查；否则当群名去
    // `hap chat list` 里筛（category='group'）反查，跟人名解析同一个道理：
    // 查不到、或对上多个候选一律拒发，不猜。
    const raw = String(args.group || '').trim();
    let groupId = '';
    let groupName = '';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
      // 直接给的是群 id：不用查网络确认群名。群名只用来给人看，查不到就留空，
      // 不为了一个显示用的名字多打一次 hap（也不让这条路在明道云掉线时白白失败）。
      groupId = raw;
    } else {
      const cands = listGroups().filter((g) => g.name === raw);
      if (!cands.length) {
        console.log(`拒绝发送：找不到群「${raw}」（只能从 hap chat list 里筛得到「最近有来往的群」，`
          + '查不到就用 --group <群id> 直接指定）。');
        return 1;
      }
      if (cands.length > 1) {
        console.log(`拒绝发送：「${raw}」对上了 ${cands.length} 个群，不猜。用 --group <群id> 指定：\n`
          + cands.map((g) => `    ${g.name}  --group ${g.groupId}`).join('\n'));
        return 1;
      }
      groupId = cands[0].groupId;
      groupName = cands[0].name;
    }
    item = synthGroup({
      groupId, groupName, filed: parseFiled(args.filed), mentionAccountIds: args.at,
    });
  } else if (wantFeed) {
    gate = callNameGate(dailymd);
    if (gate.error) {
      console.log(gate.error);
      return 1;
    }
    // 群解析跟 --group 一模一样（id 直用 / 群名反查 / 查不到或多个一律拒发）。
    const raw = String(args.feed || '').trim();
    let groupId = '';
    let groupName = '';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
      groupId = raw;
    } else {
      const cands = listGroups().filter((g) => g.name === raw);
      if (!cands.length) {
        console.log(`拒绝发送：找不到群「${raw}」（只能从 hap chat list 里筛得到「最近有来往的群」，`
          + '查不到就用 --feed <群id> 直接指定）。');
        return 1;
      }
      if (cands.length > 1) {
        console.log(`拒绝发送：「${raw}」对上了 ${cands.length} 个群，不猜。用 --feed <群id> 指定：\n`
          + cands.map((g) => `    ${g.name}  --feed ${g.groupId}`).join('\n'));
        return 1;
      }
      groupId = cands[0].groupId;
      groupName = cands[0].name;
    }
    if (!args.cardTitle.trim()) {
      console.log('拒绝发送：--feed 必须给 --card-title（群里那张卡片的标题）。'
        + '只发动态不发卡片 = 群成员收不到消息提醒，等于没发到群。');
      return 1;
    }
    // ⚠ 2026-09-01 补：card_msg（卡片预览文案）是 hap-send-card.mjs 的必填参数，
    //   传空字符串会被它的参数校验拒收，导致「卡片这步没做」——而这个失败之前完全
    //   没往上冒（见下面 cardError 那道闸），看起来跟发成了一模一样。不强制要求
    //   --card-desc，改成没给就从正文自动截一段，别让人漏传就悄悄少发一半。
    const autoCardDesc = args.cardDesc.trim() || args.text.replace(/\s+/g, ' ').trim().slice(0, 60);
    item = synthFeed({
      groupId,
      groupName,
      orgId: args.orgId,
      shareOrg: args.shareOrg,
      cardTitle: args.cardTitle,
      cardDesc: autoCardDesc,
      cardHint: args.cardHint,
      filed: parseFiled(args.filed),
      mentionAccountIds: (args.at && args.at.length)
        ? args.at.map((a) => {
            const p = gate.people.find((c) => c.name === a || c.nickname === a || c.md_account_id === a || c.en_name === a || (Array.isArray(c.aliases) && c.aliases.includes(a)));
            return (p && p.md_account_id) || a;
          })
        : [],
    });
  } else {
    // ⚠ 这条分支一个字没动（找段 → 读通讯录的先后也没动）。
    item = (store.segments() || []).find((s) => s && s.id === args.seg);
    if (!item) {
      console.log(`找不到这个段：${args.seg}（先跑一次 bin/fetch.mjs 看看还在不在）`);
      return 1;
    }
    gate = callNameGate(dailymd);
    if (gate.error) {
      console.log(gate.error);
      return 1;
    }
  }

  // 先预检、把要发的样子完整打出来。⚠ 这不是第二道门（判定跟 sendReply 用的是同一对
  //   函数），只是让最后这一眼看得清楚：真正的门在下面 sendReply 里，一个字没松。
  const pre = precheckSend(args.text, item, sendOptsFor(dailymd, args.formalName, gate.people));
  if (pre.empty) {
    console.log('拒绝发送：补完身份声明之后正文没剩下任何内容。');
    return 1;
  }
  console.log(`发给：${item.who || '(群)'}　经由：${item.sourceLabel || item.sourceType || ''}`
    + (dmTo ? `　（主动发起 · 收件人由 ${dmTo.from} 解析 · ${dmTo.accountId}）` : ''));
  console.log(pre.agentPrefix.draft
    // 外部收件人 → 只会存草稿，正文不补身份声明（草稿是 Andy 本人点的发送）
    ? '草稿正文（外部收件人，只存草稿、不补身份声明）：'
    : '实际发出去的正文：');
  console.log(pre.agentPrefix.body);
  // ⚠⚠ 2026-08-18 事故：附件当时只有私信（user）/ 群消息（group）两条通道的 sendVia 真会调
  //   sendFile() 补发第二条文件消息；记录讨论 / 任务评论这两条通道的底层命令
  //   （`hap worksheet record add-discussion` / `hap task comment`）当时也没有附件能力，
  //   opts.filePath 传过去是白传，这里却照样打印「附件（正文之后单独发一条）」——
  //   预览说了会发，实际上文件从没到过对方那儿。给 Victor 补发任务讨论区那次就是这么漏的。
  //   当天补了 hap-cli：两个命令都加上了 `--attach`（复合命令，upload+post 一次调用），
  //   record.mjs 的 sendVia 也接上了。
  //
  // ⚠⚠ 第二次事故（同一天）：这道闸当时查的是 item.kind，但 --seg 送进来的段身上
  //   只有 sourceType、没有 kind（见 send.mjs typeOf() 的注释：「候选上叫 kind，段上叫
  //   sourceType」）——item.kind 是 undefined，闸直接放行，回一条动态评论段的附件照样
  //   被静默丢掉，跟上面这段注释想防的事一模一样，只是从「主动 --post」换成了「--seg 回复」
  //   这条腿。现在改用 typeOf(item)，跟 sendReply 内部判断走同一个函数，不许各判一次。
  //   邮件那条路（connect/mail.mjs 的 sendVia）也一并补进闸——它从来没读过 opts.filePath，
  //   SKILL.md 早写了「邮件不支持」，代码却没拦，--file 传了也是静默丢。
  //
  // ⚠ 2026-08-18 又补：`hap post comment` 补上了 `--attach`（hap-cli 那边同一天做的，
  //   跟 task/record 一个套路），动态评论从「真做不到」降级成「跟 mail 一样只是这里
  //   不许」——现在唯一真做不到的只剩邮件（connect/mail.mjs 完全没有附件通道）。
  const kind = typeOf(item);
  const NO_ATTACHMENT_SUPPORT = new Set(['mail']); // 只剩邮件这一条真做不到
  const fileChannelOk = !NO_ATTACHMENT_SUPPORT.has(kind);
  if (args.files.length && !fileChannelOk) {
    console.log(`\n拒绝发送：--file 指的这条通道（${item.sourceLabel || kind}）不支持带附件——`
      + '邮件这条路的适配器从不读附件参数，传了也会被静默丢弃。'
      + '要带图，要么改用私信（--to 或 --seg 一条私信段），要么先把正文发出去，'
      + '再另起一条私信把附件发过去，两条路都告诉 Andy 分开发了。');
    return 1;
  }
  // 记录讨论 / 任务评论 / 动态评论都是**一次调用**里 upload+post 一起做的复合命令
  // （跟私信/群消息「正文一条、附件另起一条」不是一回事），预览用词要跟上，
  // 别误导成两条消息。
  const isCompositeAttach = kind === 'post'
    || (kind === 'notice' && (replyViaOf(item) === 'record' || replyViaOf(item) === 'task'));
  if (args.files.length) {
    for (const f of args.files) {
      console.log(isCompositeAttach
        ? `附件（跟正文一起发这一条）：${f}　${fileSizeLabel(f)}`
        : `附件（正文之后单独发一条）：${f}　${fileSizeLabel(f)}`);
    }
  }
  if (!pre.callName.ok) console.log(`⚠ 称呼门：${pre.callName.message}`);
  if (!pre.selfThirdPerson.ok) console.log(`⚠ 自称门：${pre.selfThirdPerson.message}`);

  // ---------- 这条是「群」、「任务评论」、「记录讨论」还是「主动发起的动态评论」：客观事实，算在一处 ----------
  const isGroup = pre.to.kind === 'group';
  // 任务评论 / 记录讨论归 🔴：受众较广，比私信需要更多确认。
  const isTaskComment = replyViaOf(item) === 'task';
  const isRecordComment = replyViaOf(item) === 'record';
  // 主动发起的动态评论（--post）同样归 🔴：受众是这条动态能看到的所有人，不比群窄。
  // ⚠ 只标 --post 这条主动路径，不动既有 --seg 回复动态评论区的那条分支——见 dm.mjs
  //   synthPost 顶部注释，范围收在这次要补的入口上，不顺手改既有行为。
  const isPostComment = wantPost;

  // ---------- 🟢 自动发：先过笼子 ----------
  //
  // ⚠⚠ 这不是「让模型自己决定要不要问 Andy」。笼子里那 6 条是**客观死条件**，
  //   模型的语义判断（这句是不是纯回执）只在全部通过之后才算数。少一条当场拒发，
  //   并且把违规**全列出来** —— 让人一眼看出该降到 🟡 还是这条根本不该自动发。
  if (args.auto) {
    const cage = cageCheck({
      initiated: wantDm,
      to: pre.to,
      rawText: args.text,
      isDraft: pre.agentPrefix.draft,
      formalName: args.formalName,
      people: gate.people,
      isTaskComment,
    });
    if (!cage.ok) {
      console.log('\n拒绝自动发送（🟢 的笼子没关严，下面每一条都得成立）：');
      cage.violations.forEach((s) => console.log(`  · ${s}`));
      console.log(`→ 去掉 --auto，把正文拿给 ${ownerName()} 看一眼再发（🟡），或按上面的提示走 🔴。`);
      return 1;
    }
    // 称呼门/自称门在 sendReply 里照样会拦，但自动发这条路**不给第二次机会**：
    // 预检就红了还硬发，等于把「有人会看见上面那行警告」当成了门。
    if (!pre.callName.ok || !pre.selfThirdPerson.ok) {
      console.log('\n拒绝自动发送：预检已经红了（见上面的 ⚠）。自动发这条路没人在旁边看着，先改对再说。');
      return 1;
    }
  }

  // ---------- 档位 + 「凭什么发这一条」 ----------
  const tier = tierOf({
    auto: args.auto, wantDm, isGroup, isTask: isTaskComment, isRecord: isRecordComment, isPost: isPostComment,
  });

  const toId = (isTaskComment && item.target && item.target.taskId)
    || (isRecordComment && item.target && `${item.target.worksheetId}:${item.target.rowId}`)
    || (isPostComment && item.target && item.target.postId)
    || pre.to.accountId
    || (item.target && item.target.groupId) || '';
  if (needWhy({ tier, isDraft: pre.agentPrefix.draft }) && !args.why.trim()) {
    console.log(`\n拒绝发送：这条是 🟡（对内、有实质内容、发完报备），必须带 --why "<凭什么不问 ${ownerName()} 就发>"。`);
    console.log(`→ 补上理由重跑；写不出理由说明这条该走 🔴，让 ${ownerName()} 看一眼再发。`);
    return 1;
  }

  // ---------- 🔴 这一档：Andy 那一眼（两步确认码） ----------
  //
  // 五种走这儿：主动发起私信（`--to`）、群消息、任务评论、记录讨论、主动发起的动态评论。
  if (wantDm || isGroup || isTaskComment || isRecordComment || isPostComment) {
    const key = wantDm
      ? dmTo.accountId
      : String((item.target && item.target.groupId)
        || (isTaskComment && item.target && item.target.taskId)
        || (isRecordComment && item.target && `${item.target.worksheetId}:${item.target.rowId}`)
        || (isPostComment && item.target && item.target.postId)
        || item.id || '');
    // ① Andy 的那一眼。⚠ 没带对确认码就**只预览不发**，退出码 0 —— 这不是失败，是设计。
    const filesTag = args.files.length
      ? args.files.map((f) => `\n\x00file:${f}`).join('')
      : (args.file ? `\n\x00file:${args.file}` : '');
    const expect = confirmToken(key, pre.agentPrefix.body + filesTag);
    if (args.confirm !== expect) {
      if (args.confirm) {
        console.log(`\n⚠ 确认码对不上（给的是 ${args.confirm}，这段正文算出来是 ${expect}）。`
          + `正文或收件人跟预览那次不一样了 —— 重新让 ${ownerName()} 看一眼上面这一版再发。`);
      }
      console.log(`\n📋 还没有发出去。上面这段给 ${ownerName()} 过目，他点头之后再跑：`);
      console.log(`  ${replayCommand(process.argv.slice(2).filter((a, i, arr) => a !== '--confirm' && arr[i - 1] !== '--confirm'), expect)}`);
      return 0;
    }
    // ② 别在休息时间打扰人（全局 CLAUDE.md）。放在确认码之后：预览任何时候都能看，
    //    被挡的只有真发这一下。显式出口 --off-hours。
    const off = ((!wantDm && !wantTask && !wantRecord && !wantPost && !wantGroup && !wantFeed) || args.offHours) ? '' : offHours();
    if (off) {
      console.log(`\n拒绝发送：${off}，不在工作日 09:00–19:00 里。`
        + '主动找同事挑上班时间发（对方秒回不代表没打扰）。真有急事加 --off-hours。');
      return 1;
    }
  }

  // ---------- 最后一道闸门：再收一轮，看这条线上有没有新消息 ----------
  //
  // ⚠⚠ 放在这儿是**故意**的：只在真要发的那一下拦，不拦预览。
  //   🔴 那一档的流程于是变成：预览 → Andy 说「发」 → 带 --confirm 重跑 → **这里重收一轮** →
  //   有新消息就拦下来重新拟。事故（2026-08-12 Ops Team，见 recheck.mjs 顶部）正是卡在
  //   「拟稿」和「他点头」之间的那几分钟，拦在预览那一步是拦不住的。
  //
  // 拦下之后怎么继续：看完新消息，要么改正文重新预览，要么正文不用改就**重跑同一条命令**
  //   ——那些消息这一轮已经收进来了，第二次跑就不再算新，自然放行。
  // ⚠ 下面两个 await 各自挂了一个 .catch：只负责在错误上贴一下这条是谁、发去哪、
  //   哪一档（如果还没被贴过）再原样往外抛，不改判定、不改错误信息——为的是文件底部
  //   那个失败记账能多知道一点，不然账上「发之前崩了」和「可能已经发出去了」会长得
  //   一模一样。item / dmTo / tier / toId 这时都已经确定，不会是 undefined。
  //
  // ⚠⚠ tier 和 accountId 非贴不可（2026-08-13 补）：失败那行账原来只有 session/to/
  //   seg/result/why，于是 ① `mailroom out` 里看不出这条走哪条通道、发的什么；
  //   ② stage='unknown'（**可能已经投出去了**）那一条因为 tier/accountId 都是空，
  //   不计入 🟢 的频次门（autosend.recentCount 按 accountId 数、只数 🟢），
  //   那个人的额度白白多出一条。
  // ⚠ channel 贴的是**这条段的来源标签**（适配器 describe() 给的，如「明道云 · 任务通知」），
  //   不是 sendVia 成功后返回的通道名——后者只有真发出去才知道。绝不在这儿另写一份
  //   「段 → 通道」的映射：那就是第二份判定，这个仓库最怕的形状。账上有 ⚠失败 的
  //   标记在旁边，看得出这一栏是「本来要发去哪」。
  const tagError = (e) => {
    if (!e || typeof e !== 'object') return;
    if (e.to === undefined) e.to = item.who || (dmTo && dmTo.name) || '';
    if (e.seg === undefined) e.seg = item.id || '';
    if (e.tier === undefined) e.tier = tier;
    if (e.accountId === undefined) e.accountId = toId;
    if (e.channel === undefined) e.channel = item.sourceLabel || item.sourceType || '';
    if (e.body === undefined) e.body = pre.agentPrefix.body;
  };
  if (!args.skipRecheck) {
    const rc = await recheckBeforeSend(item, { dailymd }).catch((e) => {
      tagError(e);
      throw e;
    });
    if (!rc.ok) {
      console.log('');
      if (rc.fresh.length) {
        console.log(`⛔ 还没发出去：${rc.reason}（这条线上新到 ${rc.fresh.length} 条，是你拟这段话之后才有的）`);
        for (const m of rc.fresh) {
          const at = String(m.at || '').slice(11, 16);
          console.log(`  · ${at} ${m.who || ''}：${String(m.text || '').replace(/\s+/g, ' ').slice(0, 200)}`);
        }
        console.log('→ 先按最新情况重新判断：要改正文就重新预览；确认照发就重跑同一条命令（这些消息已经收进来了，不会再拦第二次）。');
      } else {
        console.log(`⛔ 还没发出去：${rc.reason}`);
        console.log('→ 修好再发。确实要在这种情况下硬发，加 --skip-recheck（会在日志里留痕）。');
      }
      return 1;
    }
    if (rc.got) console.log(`（发送前重收了一轮：${rc.got} 条新消息，都不在这条线上）`);
  } else {
    console.log('⚠ 跳过了发送前的重收（--skip-recheck）：这段话基于的可能是过期的消息。');
    log('⚠ send --skip-recheck：', item.id || '', String(args.text).slice(0, 80));
  }

  // ⚠⚠ 全仓库唯一一处。放在这儿而不是模块顶层：import 这个文件不该产生任何副作用。
  process.env.MAILROOM_ROLE = 'approval-desk';
  const r = await sendReply(
    item,
    args.text,
    { source: 'approval-desk-button' },
    sendOptsFor(dailymd, args.formalName, gate.people),
    { filePath: args.files[0] || args.file || '', filePaths: args.files },
  ).catch((e) => {
    tagError(e);
    throw e;
  });

  // ⚠ 传输层抛错分两种，别把它们混成「没发出去」：`hap()` 超时或非零退出时消息
  //   **可能已经投出去了**。走到这儿是成功路径，如实报成功；抛错的分支见下面 catch，
  //   那里一律提醒「先去明道云看一眼再决定要不要重发」——明道云没有撤回接口。
  // ⚠⚠ 草稿绝不许报成「已发出」：外部收件人的邮件只会存进 Andy 自己的草稿箱
  //   （connect/mail.mjs 里那道物理门），一个字都还没到对方那儿。报成已发的话，
  //   他会以为客户收到了，然后这封信就永远躺在草稿箱里没人管。
  if (r.draft) {
    console.log(`📝 还没发出去：${r.to}`);
    if (r.link) console.log(`   ${r.link}`);
  } else if (r.cardError) {
    // ⚠⚠ 2026-09-01 事故：这条 cardError 以前只塞在返回对象里没人读，上面照样打
    //   「✓ 已发出（动态+群卡片 → ...）」——卡片那步实际失败（真实案例：card_msg 传了
    //   空字符串，hap-send-card.mjs 参数校验直接拒收），群里只进了一条不带卡片提醒的
    //   动态，跟直接发普通动态没区别，但账面上显示成功，Andy 是从群里肉眼没看到卡片
    //   才发现的。这道闸必须显式报「半成功」，不能让 cardError 字段死在返回值里。
    console.log(`⚠ 动态已发出，但群卡片这步失败了，群里收不到提醒（${r.channel} → ${r.to}）：`);
    console.log(`   ${r.cardError}`);
    console.log('   别重发一条新动态（对方会收到两条正文）。排查好卡片凭据/参数后，'
      + `直接用 scripts/hap-send-card.mjs 补发卡片，url 填 ${r.url || '<动态详情页>'}`);
  } else {
    console.log(`✓ 已发出（${r.channel} → ${r.to}）`);
    if (r.deliveryWarning) {
      // ⚠ 卡片 spawnSync 退出码是 0，但原地核实（post.mentioned_users / 群聊消息流
      //   type=5 卡片）发现跟预期对不上——比「卡片这步直接报错」更隐蔽的一种半成功，
      //   照样得显式亮出来，不能因为「工具没报错」就吞掉。
      console.log(`   ⚠ 但核实的时候发现：${r.deliveryWarning}`);
    }
    // 心跳只该被「对方可能马上回」的通道踩热：私信、群消息。
    // 动态评论/任务评论/记录讨论本来就是慢节奏——发一条评论不代表对方会秒回，
    // 踩热了也只是让轮询空转。邮件同理（不在这两个之列）。
    if (HEARTBEAT_CHANNELS.has(r.channel)) {
      try {
        boostHeartbeat({ reason: `外发消息（${r.channel} → ${r.to}）` });
      } catch { /* 心跳加速异常不阻断主流程 */ }
    }
  }
  // ⚠⚠ 留痕。放在**发出之后**，而且失败绝不许抛：消息已经在对方那儿了，为了写不进
  //   一行账把成功报成失败，会让人再发一次（对方收到两条，而明道云没有撤回接口）。
  //   但写不进去必须**打出来** —— 没有账的发送等于没人管。
  // ⚠ 无条件记，不只记 🟢：2026-08-12 之前只有自动发那一档进账，于是「别的会话发了
  //   什么」这件事整个是黑的。
  // ⚠⚠ whoAmI() 和下面「该戴谁」那段一起收进这个 try：这条「绝不许抛」的保证不能
  //   只挂在 session.mjs 内部把异常都吞掉这个实现细节上——那天它改成读不到就抛，
  //   这里也不能连累「消息已经发出去了」变成一句报错。
  try {
    const me = whoAmI();
    logSent({
      session: me.name,
      sessionId: me.sessionId,
      filed: r.filed ? r.filed.dir : '',
      channel: r.channel,
      to: r.to,
      accountId: toId,
      seg: item.id || '',
      tier,
      why: args.auto || args.why || '',
      text: r.body,
      // ⚠ 2026-09-01 补：卡片失败/核实有出入不许记成跟全须全尾的 'sent' 一样——
      //   账本一旦把半成功记成全成功，这条 bug 复发时连账都查不出来。
      result: r.draft ? 'draft' : (r.cardError || r.deliveryWarning ? 'partial' : 'sent'),
      cardResult: item.kind === 'feed'
        ? (r.cardError ? 'failed' : (r.deliveryWarning ? 'unverified' : (r.card ? 'sent' : 'none')))
        : undefined,
      // ⚠ file 用 args.file（这次命令有没有给这个参数），不是 r.file——r.file 只在
      //   附件真发出去了才有值，成败判断走 fileResult。没给 --file 就留空，账上
      //   一眼能分清「这条没打算带附件」和「带了但没发成」。
      file: args.files.join(';') || args.file || '',
      fileResult: !args.files.length ? 'none' : (r.fileError ? 'failed' : 'sent'),
    });
    if (args.auto) {
      console.log(`   🟢 这条是自动发的（理由：${args.auto}）—— 记得在对话里跟 ${ownerName()} 报一声。`);
    }

    // 挂着 loop 的那个会话在的话，当场戴它一下 —— 账本是兜底（要等下一轮 fetch 才顶到
    // 眼前），SendMessage 是即时的。脚本自己发不了 SendMessage（那是模型的工具），
    // 所以这里只负责**把该戴谁打出来**，跟 dailymd 的 notify-owning-sessions.mjs 一个套路。
    const loop = loopSession();
    if (loop && loop.sessionId !== me.sessionId) {
      console.log(`\n⚡ 去 SendMessage 戴一下 ${loop.name}（正文照抄下面这行）：`);
      console.log(`  已以 ${ownerName()} 名义发出 [${r.channel} · ${r.to} · ${tier}]：`
        + `${String(r.body).replace(/\s+/g, ' ').slice(0, 120)}`);
    }
  } catch (e) {
    console.log(`   ⚠ 这条已经发出去了，但没记进总账：${String((e && e.message) || e)}`);
  }
  // ⚠ 附件是第二条消息，成败单独报。正文已经在对方那儿了，绝不许因为附件失败
  //   就把整件事说成没发出去——那会让人再按一次，对方收到两条正文。
  if (r.fileError) {
    console.log(`⚠ 正文已经发出去了，但附件没发成功：${r.fileError}`);
    console.log('   别重发正文（对方会收到两条）。只补附件：hap chat send-file-to-one -t <accountId> --file <路径>');
  } else if (r.files && r.files.length) {
    for (const f of r.files) console.log(`   附件已发出：${f}`);
  } else if (r.file) {
    console.log(`   附件已发出：${r.file}`);
  }
  // ⚠ r.filed 是 { dir, segId, level }，直接拼字符串会打成 [object Object]
  if (r.filed) {
    console.log(`   已记进 ${r.filed.dir}`);
    // 落在项目目录或 P00-misc = 没落到具体任务上。如实说，别让人以为归得很准——
    // 他看到这行才知道要不要把这一块挪走。
    if (r.filed.level === 'project') {
      console.log('   ⚠ 只落到项目一级（这个段还没归到具体任务），要挪就改这个文件。');
    } else if (r.filed.level === 'misc') {
      console.log('   ⚠ 这条没有落点，兜底记进了 P00-misc。'
        + '主动私信下次加 --filed P0X-xxx/T0X-xxx 就能直接落对地方。');
    }
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((e) => {
      const msg = String((e && e.message) || e);
      log('⚠ 发送失败：', msg);
      console.log(`⚠ 发送失败：${msg}`);
      // ⚠ 传输层的错不代表没发出去。别让 Andy 凭这行字直接重发。
      // ⚠⚠ 这里认的码必须跟 send.mjs 打的那个**一模一样**：它标的是 'unknown'
      //   （见 send.mjs 里 stage 那两级的说明）。这里原来写的是 'transport'，
      //   两边对不上，于是这句最要紧的提醒**一次都没打印过**。
      if (e && e.stage === 'unknown') {
        console.log('⚠⚠ 这个错发生在传输那一步，消息**可能已经发出去了**。'
          + '先去明道云／邮箱看一眼再决定要不要重发——明道云没有撤回接口。');
      }
      // ⚠ 失败也要进账：账本要能回答「这条到底发没发出去」，只记成功等于把
      //   stage='unknown' 那一类（可能已经投出去了）从账上抹掉。
      // ⚠ why 里带上 stage：不然「发之前就崩了（没有 stage）」和「传输层不明、
      //   可能已经发出去了（stage=unknown）」在账上长得一模一样——而后者正是这段
      //   要防的场景。to / seg / tier / accountId / channel / 正文全从错误对象上读
      //   （main() 里那个 tagError 会顺手贴上），这里只做防御性读取，读不到就留空，
      //   绝不能让记账本身因为这些新加的读取再抛一次。
      // ⚠⚠ tier 和 accountId 不许缺：stage='unknown' 那一条**可能已经投出去了**，
      //   两栏空着就不计入 🟢 的频次门（autosend.recentCount 按 accountId 数、
      //   只数 🟢），那个人 24 小时的额度白白多一条。
      try {
        const stageTag = e && e.stage ? `[stage=${e.stage}] ` : '';
        logSent({
          session: whoAmI().name,
          sessionId: whoAmI().sessionId,
          channel: (e && e.channel) || '',
          to: (e && e.to) || '',
          accountId: (e && e.accountId) || '',
          seg: (e && e.seg) || '',
          tier: (e && e.tier) || '',
          text: (e && e.body) || '',
          result: 'failed',
          why: `${stageTag}${msg}`.slice(0, 200),
        });
      } catch { /* 账写不进去不许再抛，这里已经在错误处理里了 */ }
      process.exitCode = 1;
    });
}
