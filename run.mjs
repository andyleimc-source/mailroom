// 收一轮的编排（`bin/fetch.mjs` 和 `bin/file.mjs` 都调它）——**只做编排**：
//   叫适配器收一轮 → 归档 → 聚段 → 归位（写进任务目录的 inbox.md）→ 存运行态索引。
//
// ⚠ 这里没有、也永远不许有任何发送分支。发送只在 send.mjs，只由 `bin/send.mjs` 触发。
//   （test/connect.test.mjs 有一条 grep 测试盯着「本文件不许 import send.mjs」。）
//
// 判定这一步现在有两种跑法，由 `deferJudge` 切换：
//   deferJudge=false —— 传一个 judge 进来当场判完（测试走这条）。
//   deferJudge=true  —— 收+归档+聚段之后就停，把待判定的段交回给调用方。
//     真实使用走这条：判定的人是**对话里的 Claude**，不是另起一个 headless 进程。
//     ⚠ 停下来的时候段照样存盘（filed 为空），万一这个会话就此断了，下一轮
//       「捞回搁浅的段」那条规则会把它们捞回来重判——消息不会因为你关了终端就丢。
//
// ⚠⚠ 文件底部那句**入口守卫**是硬要求，别删。老 hap-desk 的 poll.mjs 底部是一句顶层
//   裸 `main()`：谁 `import` 它都会当场真跑一轮（真打 hap CLI、真写基线、真推 Bark），
//   于是**没有人敢给它写测试**。代价是一行 ReferenceError 被最外层 catch 吞成一句
//   「轮询失败」，收消息整条链死了两天一直在丢消息，而 753 条单元测试全绿。
//   现在：`runOnce` 能被 import 而不产生任何副作用，adapters / judge 可注入，
//   测试就能把整轮编排真跑一遍。
//
// ⚠ 只注入**最外层那两个** IO（适配器的 pull、判定的 claude）。中间的归档 / 聚段 /
//   归位 / 落盘全是真跑的——否则又变成「注入了假的，就测不到那句调用本身写错了」。
//
// ⚠ 每一步的错误都要带上下文 log 出来，不许 `catch {}` 吞掉，也不许拿一句
//   「轮询失败」盖掉全部。上面那两天丢消息，根因就在这条上。

import {
  existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { HapAuthError, MailAuthError, dailymdRoot, log, stateDir, ownerName } from './lib.mjs';
import * as defaultStore from './store.mjs';
import { adapterFor, listAdapters } from './connect/index.mjs';
import { archive } from './archive.mjs';
import { fileAll, parseVerdicts, rewriteFiled } from './file.mjs';
import { mergeInto, msgKey, toSegments } from './segment.mjs';
import { boostHeartbeat } from './heartbeat.mjs';

// 聚段窗口：相邻消息间隔 ≤ 这么多分钟就算同一段（同事连发四条是一件事，不是四件事）。
const WINDOW_MIN = 30;

// 上一轮看到哪了：hap-watch 的基线文件，由 connect/hap.mjs spawn 的 watch.mjs 维护。
// ⚠ 名字必须跟 connect/hap.mjs 里的 WATCH_STATE_NAME('mailroom') 对上；hap-desk 用的是
//   'hapdesk'，两套并行跑期间共用一个基线会互相「消费」掉新消息标记，另一套就漏收。
function watchStateFile() {
  return process.env.MAILROOM_WATCH_STATE || join(homedir(), '.hap-watch', 'mailroom.json');
}

// 错误转人话。⚠ 一律带上原文，别只说「出错了」——排查时那句原文才是全部信息。
function errText(e) {
  return String((e && e.message) || e).slice(0, 400);
}

// 适配器的名字，只用来写日志。⚠ 兜个底：日志里印出一个 `undefined` 比没有更误导。
function nameOf(adapter) {
  return (adapter && adapter.kind) || '未知来源';
}

// ---- 哪些来源掉线要让整轮停下 ----
//
// ⚠⚠ 明道云（'mingdao'/'hap' 是同一个适配器的两个名字）掉线 = 整轮停下、一条不处理、
//   喊 Andy 跑 `hap auth login`。这条是铁律，不许削弱、不许换通道兜底（mdymcp 已退役）。
//
// 其余来源（邮件）掉线**只影响它自己**：2026-08-10 评审实跑的问题就是这个——
//   ms365 令牌没引导过、网易授权码没进钥匙串，两台 Mac 合并当天都是这个状态，
//   每一轮邮件适配器都稳定报认证失败，于是整轮早退，**已经收到的明道云私信既不归档
//   也不入段**，而命令行给的修复动作还写死成「跑 hap auth login」——一个修不好的动作。
//   收不到邮件是一回事，因此连明道云消息一起收不到是另一回事。
export const AUTH_STOPS_ROUND = new Set(['mingdao', 'hap']);

// ---- 屏蔽规则 ----
// `mute.json`：[{ pattern: 正则字符串, kind?: 'notice'|'group'|'user'|'post', why: 人话 }]
// ⚠ 不写 kind 的规则对**所有**候选生效，包括同事的私信——真人发的话被静默吞掉，
//   排查起来只会看见「没收到」。所以规则尽量带上 kind，屏蔽播报就写 'notice'。
// 读不出来（文件没了 / JSON 坏了）就当没有规则：屏蔽失灵最多是多看几条播报，
// 而在这里抛错会把整轮收消息带崩。
// ⚠ 规则住在**状态目录**（~/.mailroom/mute.json），不在仓库里：里面全是你所在组织的
//   工作流播报名字，属于个人配置，不该跟着代码发布出去。仓库里的 mute.example.json
//   只是格式示例，不会被读。
function muteFile() { return join(stateDir(), 'mute.json'); }

function muteRules() {
  const f = muteFile();
  if (!existsSync(f)) return [];
  try {
    const list = JSON.parse(readFileSync(f, 'utf-8'));
    return Array.isArray(list) ? list.filter((r) => r && r.pattern) : [];
  } catch (e) {
    log('⚠ mute.json 读不了，这一轮不屏蔽任何消息：', errText(e));
    return [];
  }
}

// 命中就返回那条规则的 why（给日志用），没命中返回 null。
function muteHit(cand, rules = muteRules()) {
  if (!rules.length) return null;
  for (const r of rules) {
    if (r.kind && r.kind !== cand.kind) continue;
    let re;
    // 坏正则只废掉这一条规则，不连累整轮。
    try { re = new RegExp(r.pattern, 'i'); } catch { continue; }

    // 按规则的 field 属性决定匹配范围。邮件规则可以限定到特定字段，
    // 避免正文里的 "退订" "newsletter" 这种词撞进发件人地址规则。
    let testTarget;
    if (r.field === 'from') {
      // 仅匹配发件人地址。地址本身在正文里根本不出现。
      testTarget = cand.whoAddress || '';
    } else if (r.field === 'subject') {
      // 仅匹配邮件主题。
      testTarget = (cand.target && cand.target.subject) || '';
    } else {
      // 不写 field 的规则对整个候选生效：who/channel/地址/主题/正文。
      // 明道云既有规则都没写 field，这条路维持现在的行为。
      testTarget = [
        cand.who || '', cand.channel || '', cand.sourceLabel || '',
        cand.whoAddress || '', (cand.target && cand.target.subject) || '',
        ...((cand.msgs || []).map((m) => (m && m.text) || '')),
      ].join('\n');
    }

    if (re.test(testTarget)) return r.why || r.pattern;
  }
  return null;
}

export const __muteTest = { muteHit };

// 读基线原文。null = 文件还不存在（正常，还没建过基线）；undefined = 存在却读不出来
// （回滚就没得回滚了，见 restoreWatch）。
function readWatchRaw(say) {
  const file = watchStateFile();
  try {
    return readFileSync(file, 'utf-8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    say(`⚠ watch 基线读不出来（${file}），这一轮按首轮处理、也回滚不了：`, errText(e));
    return undefined;
  }
}

function seenOf(raw, say) {
  if (!raw) return {};
  try {
    return JSON.parse(raw).seen || {};
  } catch (e) {
    say(`⚠ watch 基线不是合法 JSON（${watchStateFile()}），这一轮按首轮处理：`, errText(e));
    return {};
  }
}

// ---------- 水位线回滚 ----------
//
// ⚠⚠ 这是这个文件里最要紧的一段，起因是老系统那个「消息永久消失」的模子：
//   `~/.claude/skills/hap-watch/watch.mjs` 在 `hap chat list` 一成功就**立刻**把新基线
//   写盘了，**早于** poll 这边归档/聚段/归位任何一步。也就是说水位线是先过去的：
//   这一轮只要在存好 segments 之前中断（pull 抛错、聚段抛错、轮中途冒出 401……），
//   那批会话的消息就再也不会被 watch 报成「新」——下一轮一句「无新动静」，
//   消息永久进不了 inbox.md，而且没有任何人被告知。收消息链死了两天就是这么死的。
//
// 所以：轮前拿一份基线快照，这一轮没能干净收尾就把它写回去，下一轮真的能再收一次。
// ⚠ 重收是安全的：msgKey 那层去重会把已经入过段的消息挡掉，不会重复落盘。
function restoreWatch(snapshot, say, why) {
  if (snapshot === undefined) {
    say(`⚠ 轮前没拿到 watch 基线快照，回滚不了（${why}）。`
      + '这批会话的水位线已经前推，它们进不了 inbox.md 了，原文在 assets/hap-log/');
    return;
  }
  // ⚠ 测试里没顶掉基线路径（MAILROOM_WATCH_STATE）就绝不碰真的 ~/.hap-watch/。
  if (process.env.NODE_TEST_CONTEXT && !process.env.MAILROOM_WATCH_STATE
    && !process.env.MAILROOM_ALLOW_REAL_IO) {
    say(`（测试里没顶掉 watch 基线路径，跳过回滚：${why}）`);
    return;
  }
  const file = watchStateFile();
  try {
    if (snapshot === null) { if (existsSync(file)) unlinkSync(file); } else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, snapshot);
    }
    say(`已把 watch 水位线回滚到这一轮开始前（${why}），下一轮会把这批消息再收一次`);
  } catch (e) {
    say(`⚠ watch 水位线回滚没写成（${why}）：这批会话的消息已经从水位线过去了，`
      + '进不了 inbox.md，原文在 assets/hap-log/：', errText(e));
  }
}

// ---------- 去重 ----------
//
// ⚠⚠ 这一步不能省。适配器给的是「这个会话上次之后的消息」，明道云的会话时间戳抖一下、
//   或者一条消息跨两轮都被算进来，同一条消息就会来第二次。而 mergeInto 是**照单追加**的
//   （它管的是「同一条线要不要续在老段上」，不管这条消息见没见过），
//   不在这儿挡掉的话，同一句话会在段里出现两遍、inbox.md 里也跟着重复。
function dropSeen(existing, candidates) {
  const seen = new Set();
  for (const s of existing || []) {
    for (const m of s.msgs || []) seen.add(msgKey(s, m));
  }
  const out = [];
  let skipped = 0;
  for (const c of candidates) {
    const msgs = [];
    for (const m of (c.msgs || [])) {
      const k = msgKey(c, m);
      if (seen.has(k)) { skipped++; continue; }
      seen.add(k);          // 同一轮里重复出现的（两个 candidate 带同一条）也只留一条
      msgs.push(m);
    }
    if (msgs.length) out.push({ ...c, msgs });
  }
  return { candidates: out, skipped };
}


// ---------- 存盘：写盘前重读、按段合并 ----------
//
// ⚠⚠ `segments.json` 是**两个进程**的整份读-改-写，谁都不加锁：轮询器在这一轮开头读、
//   在最后写，中间隔着最长 180 秒的 claude 判定；审批台（server.mjs）在 Andy 每一次
//   改落点 / 丢弃 / 拆段时也是整份读改写。那 1~3 分钟里他在网页上做的事，
//   会被这一轮的整份覆盖抹掉，一句日志都没有 —— 而 moveSegment 已经真把 inbox.md 里
//   那块搬到新任务了，于是索引说 T70、文件在 T88，下一轮有新消息还照旧落点再写一份。
//   前端 45 秒重拉，他会看到自己刚改的东西自己变回来。
//
// 所以写盘那一刻**重读一次**，按 segId 合并回去，而不是整份覆盖：
//   · 落点 / 丢弃 / 等回复（filed / dropped / droppedAt / waiting）—— **以人为准**。
//     这几样只有 Andy 和判定器会动，而判定器不碰「已归位」的段，冲突就一定是人改的。
//   · 消息（msgs / lastAt）—— 以这一轮为准：这一轮新收的消息只有轮询器手上有。
//     **例外**：他在窗口里「划选几条丢弃」删掉的那些（轮前有、盘上没了）要按 msgId 剔掉，
//     否则划掉的消息几分钟后自己回来，而且没有任何解释。见下面 removed 那段。
//   · 盘上有、这一轮手上没有的段 —— 原样留着（判定期间他手动拆出来的那些）。
//
// ⚠ 还剩一个够不着的角：他在判定期间把某段丢弃/改落点时，本轮的 fileAll 可能已经照
//   **旧**落点把 inbox.md 那块重写过一遍了。索引这边守住了，那一块得等下一轮按新落点重写
//   （或者他再按一次）。要彻底消掉只能给 segments.json 加真锁，那是另一件事。
const HUMAN_FIELDS = ['filed', 'dropped', 'droppedAt', 'waiting'];

function mergeBack(mine, disk, wasById, say) {
  const diskById = new Map((disk || []).filter(Boolean).map((s) => [s.id, s]));
  const out = [];
  const taken = new Set();
  for (const s of mine) {
    taken.add(s.id);
    const d = diskById.get(s.id);
    // 盘上没有 / 轮前快照里没有（这一轮自己新建的段）—— 就按这一轮这份写
    if (!d || !wasById.has(s.id)) { out.push(s); continue; }
    // 盘上这一段跟轮前读到的一模一样 = 这期间没人动过
    if (JSON.stringify(d) === wasById.get(s.id)) { out.push(s); continue; }
    // ⚠⚠ 基准只有一个：**轮前快照**。判「这一栏人有没有改过」拿盘上跟**本轮这份**比是错的 ——
    //   只要盘上这一段因为任何原因变过，循环就会把所有有差异的栏位从盘上抄回来，
    //   包括人根本没碰、而是本轮刚判出来的那一栏（复审实跑：Andy 只是把「等我回」销了账，
    //   本轮判出来的丢弃就被盘上那份 dropped=false 抄回去、静默撤销了）。
    //   「盘上 ≠ 轮前」才叫人在这个窗口里真的改过它。
    const was = JSON.parse(wasById.get(s.id));
    const same = (a, b) => JSON.stringify(a === undefined ? null : a)
      === JSON.stringify(b === undefined ? null : b);
    const next = { ...s };
    const changed = [];
    for (const k of HUMAN_FIELDS) {
      if (same(d[k], was[k])) continue;      // 盘上这一栏跟轮前一样 = 人没碰过它
      if (same(d[k], s[k])) continue;        // 本轮这份已经是同一个值，不用抄
      next[k] = d[k];
      changed.push(k);
    }

    // ⚠⚠ 「划选几条丢弃」（`POST /api/drop` 带 msgIds）改的是 `seg.msgs`，不在上面那几栏里。
    //   而 msgs 的规则是「以本轮为准」—— 他刚划掉的那几条会被原样加回来，而且上面那句
    //   say() 只在 HUMAN_FIELDS 变了时才响，于是**一句日志都没有**：他划掉几条、
    //   几分钟后自己回来了、没有任何解释。这比丢消息还伤信任。
    //
    //   两件事必须同时成立，所以按 msgId 求差集，不是整份以某一边为准：
    //     · 轮前有、盘上没了 = **人删的**，从本轮这份里也剔掉；
    //     · 剩下的照旧以本轮为准 —— 这一轮真到的新消息只有轮询器手上有，不许被挡在外面。
    const wasIds = new Set((was.msgs || []).map((m) => String(m.id)));
    const diskIds = new Set((d.msgs || []).map((m) => String(m.id)));
    const removed = [...wasIds].filter((id) => !diskIds.has(id));
    if (removed.length) {
      const kill = new Set(removed);
      const kept = (next.msgs || []).filter((m) => !kill.has(String(m.id)));
      if (kept.length) {
        next.msgs = kept;
        next.firstAt = kept[0].at;
        next.lastAt = kept[kept.length - 1].at;
      } else {
        // 全被删光了（正常路径走不到：划完整段会走「整段丢弃」那条，msgs 原样留着）。
        // 兜底一律听盘上的，绝不把人删掉的整批塞回去。
        next.msgs = d.msgs || [];
        next.firstAt = d.firstAt;
        next.lastAt = d.lastAt;
      }
      changed.push(`界面上划掉的 ${removed.length} 条消息（${removed.join(',')}）不再加回来`);
    }

    if (changed.length) {
      say(`写盘前发现界面上改过这一段（${changed.join(' / ')}），以界面为准，不覆盖：`, String(s.id));
    }
    out.push(next);
  }
  for (const d of (disk || [])) {
    if (!d || taken.has(d.id)) continue;
    out.push(d);
    say('写盘前捡回判定期间界面上新增的段（不捡就等于把它整份覆盖掉了）：', String(d.id));
  }
  return out;
}

// ---------- 存盘 ----------
//
// ⚠⚠ Task 5 传下来的硬契约：`fileAll` 返回值里的 `all` 才是归位后的最终段列表。
//   `split`（一段拆成两件事）会拆出**新的段对象**，它们不在传进去的那个数组里。
//   只存 merged 的话，拆出来的段在运行态索引里凭空消失——inbox.md 里明明有一块，
//   segments.json 里却没有，界面上翻不到、下一轮也没人认领。
//   （file.mjs 里两处注释写明了这件事，test/poll.test.mjs 有一条测试钉死它。）
function saveAll(store, merged, all, say, wasById = new Map()) {
  const byId = new Map(merged.map((s) => [s.id, s]));
  const extra = [];
  for (const s of (all || [])) {
    if (!s) continue;
    const cur = byId.get(s.id);
    if (cur === s) continue;      // 就是 merged 里那个对象（split 第一片是原地改的），已经在了
    if (cur) {
      // ⚠ 撞 id 了。split 拆出来的片用 `${父段id}-sN` 命名，父段要是被二次拆分就可能撞上
      //   已经存着的同名段。**故意不改 id 硬塞**：inbox.md 里那一块已经用这个 id 写下去了，
      //   这边换个 id 只会让两边对不上、下一轮再写出第二块。宁可响亮报出来让人看见——
      //   原来这里是 filter 静默丢掉，那才是真正危险的写法。
      say('⚠ 归位后出现 id 撞车的段，它没进 segments.json（inbox.md 里已经有这一块）：', String(s.id));
      continue;
    }
    byId.set(s.id, s);
    extra.push(s);
  }
  let next = [...merged, ...extra];
  try {
    next = mergeBack(next, store.segments(), wasById, say);
  } catch (e) {
    // ⚠ 重读失败不许把这一轮的成果扔掉：照本轮这份写下去，但要说清楚可能盖掉界面上刚改的。
    say('⚠ 写盘前重读 segments.json 没成，只能按本轮这份写（可能盖掉界面上刚改的落点）：', errText(e));
  }
  try {
    store.saveSegments(next);
    return true;
  } catch (e) {
    say('⚠ segments.json 没写成（消息已经落进 inbox.md，那份才是权威）：', errText(e));
    return false;
  }
}

// ---------- 适配器自己的水位线：只在确认这一轮真的落盘之后才提交 ----------
//
// ⚠⚠ 这是审阅 Task 6 时顺着「标已读押到下一轮」那条思路往下推发现的一个更宽的洞：
//   邮件适配器（`connect/mail.mjs`）的水位线（ms365 的 lastReceived/seenIds、网易的
//   uidValidity/lastUid）原来打算在 `pull()` 自己判断「这一轮没有 authError」就提交。
//   但 `pull()` 压根看不到它返回之后的事——归档写没写成、聚段有没有炸、
//   `saveAll` 有没有真的把 segments.json 写盘，这几步全在 `pull()` 返回之后才发生
//   （`saveAll` 抛错那条路径 `lostWhy` 会置位，但 `authError` 仍然是 `null`）。
//   照旧版写法，这批邮件就会出现「水位线已经翻过去、但一个字都没有落进
//   segments.json/inbox.md」——跟当年 hap-watch 那个「消息永久消失」的模子一模一样，
//   只是换了个水位线的名字。
//
//   所以水位线的提交权彻底交给这里：适配器只把「水位线该写成什么样」包成一个函数
//   挂在 `got.commit` 上带回来，`runOnce` 确认这一轮的成果已经安全存进
//   segments.json（`saveAll` 返回 true）之后才调它。`got.commit` 不是硬契约——
//   明道云适配器没有这个字段，靠 `typeof === 'function'` 兜底，一个字都不用改。
//   首轮建基线是唯一的例外：那一步没有任何候选、没有「消息还没落盘」的风险，
//   适配器自己会当场提交，不会等到这儿。
// 明道云那份水位线，存我们**自己**这一份。
//
// ⚠⚠ 只在「这一轮干净收尾」时调（见 runOnce 的 finally）。「收到了」和「水位线前进了」
//   必须绑在一起，否则就退回共享文件那套语义了——那套语义 2026-08-13 吃掉了 Alice 的私信
//   （见 runOnce 里 `ownSeen` 那段注释）。这一轮中途砸了就是不写，下一轮照旧从老水位线
//   重收，msgKey 去重挡得住重复入段。
// ⚠ 别图省事挪进 commitPulled：那个函数在 lostWhy 已经置位的路径上照样会跑
//   （已归位的结果不该作废），而「有东西没取到」恰恰是最不能推水位线的时候。
function commitOwnSeen(pulled, say, store) {
  if (!store || !store.stateSet) return;
  const merged = {};
  for (const { got } of pulled) Object.assign(merged, (got && got.seen) || {});
  if (!Object.keys(merged).length) return;
  try {
    store.stateSet('watch-seen', merged);
  } catch (e) {
    say('⚠ 自己那份水位线没写成（下一轮会重收，去重会挡住重复入段）：', errText(e));
  }
}

function commitPulled(pulled, say, store) {
  for (const { kind, got } of pulled) {
    if (typeof got.commit !== 'function') continue;
    try {
      got.commit();
    } catch (e) {
      // ⚠ 水位线提交本身出岔子，不该让这一轮已经归位成功的结果作废——消息已经
      //   落盘了，只是水位线没推进，下一轮会重收，去重（seenIds / msgKey）挡得住
      //   重复入段。
      say(`⚠ ${kind} 水位线提交没成（下一轮会重收，去重会挡住重复入段）：`, errText(e));
    }
  }
}

// ---------- runOnce ----------
//
// 跑一轮，返回计数。**没有副作用之外的输出，也不推送、不发消息**。
//   adapters — 消息源，测试注入假的；不给就用注册表里真的那些
//   judge    — 归位判定，测试注入假的；不给就是真跑 claude（file.mjs 的 askClaude）
//   dailymd  — 归档和 inbox.md 落在哪个库，显式传，不靠环境变量
//   store    — ~/.mailroom 下那几个 JSON 的读写，测试可换
//   prevSeen — 上一轮看到哪了；不给就自己读 hap-watch 基线
export async function runOnce({
  adapters,
  judge,
  dailymd = dailymdRoot(),
  store = defaultStore,
  tree,
  prevSeen,
  windowMin = WINDOW_MIN,
  onLog,
  deferJudge = false,
} = {}) {
  // 日志两头都发：log 进 ~/.mailroom/mailroom.log（事后查），onLog 给调用方（测试断言）。
  const say = (...parts) => {
    log(...parts);
    if (onLog) onLog(parts.join(' '));
  };
  const out = {
    got: 0,
    segmented: 0,
    filed: 0,
    dropped: 0,
    unsure: 0,
    // authError —— 第一个报认证失败的来源那句话（单值，老形状不动）。
    // authErrors —— 全部认证失败，带上是**哪个来源**：[{ kind, message }]。
    //   bin/fetch.mjs 据此给对得上的修复动作（hap 掉线喊 hap auth login，
    //   邮件掉线喊 mail-bootstrap / 补授权码），不再一律指向一个修不好的动作。
    authError: null,
    authErrors: [],
    pending: [],
  };

  const list = (adapters && adapters.length) ? adapters : listAdapters().map(adapterFor);
  // 轮前的水位线快照。⚠ 这一轮只要没干净收尾就把它写回去，见 restoreWatch 那段注释。
  const snapshot = readWatchRaw(say);
  // 水位线优先用**我们自己存的那份**（`watch-seen`），共享的 hap-watch 文件只当兜底。
  // ⚠⚠ `~/.hap-watch/mailroom.json` 是全局共享的，别的进程跑一次 watch.mjs 就把它推过去了，
  //   跟我们收没收到那批消息完全无关。2026-08-13 Alice 那条私信就是这么丢的：她 17:36 回的，
  //   到 17:41 连着两轮都报「无新动静」，因为共享文件早被别人推到 17:36 了。
  //   自己那份只在**干净收尾**时才写（见下面 stateSet('watch-seen')），所以「收到了」和
  //   「水位线前进了」这两件事是绑在一起的——这正是共享文件给不了的保证。
  const ownSeen = store && store.stateGet ? store.stateGet('watch-seen') : null;
  const seen = prevSeen
    || (ownSeen && Object.keys(ownSeen).length ? ownSeen : seenOf(snapshot, say));
  let lostWhy = '';     // 非空 = 这一轮有消息没落地，水位线必须回滚
  let finished = false; // 走到某个「我决定停在这」的出口才置位；中途抛错就是 false
  // ⚠ 提到 try 外面：finally 里 commitOwnSeen 要读它。
  const pulled = [];

  try {
    // ---- 收：每个来源收一轮 ----
    //
    // ⚠ 先全部收完再处理。401 一露头就整轮原样返回、**一条消息都不处理**——
    //   「一条都不处理」是字面意思：不归档、不聚段、不落盘。调用方（main）负责去 Bark
    //   喊 Andy 跑 `hap auth login`。⚠⚠ 绝不许换通道兜底（mdymcp 已退役，明令禁止）。
    for (const adapter of list) {
      const kind = nameOf(adapter);
      let got;
      try {
        // ⚠ 必须 await：适配器哪天写成 async（`connect/index.mjs` 的设计目标就是
        //   「加一行就接第二个源」，邮件那种十有八九是异步的），不 await 的话拿到的是
        //   一个 Promise，它照样能过下面 typeof === 'object' 那道门，
        //   records/candidates/authError 全是 undefined ——**静默零消息、不报错、不 log**。
        got = await adapter.pull({ cfg: {}, prevSeen: seen, store });
      } catch (e) {
        // ⚠ 两种认证错都收成同一个形状：认证失败该走哪条路由 kind 决定（AUTH_STOPS_ROUND），
        //   不该由「是哪一层抓到的异常」决定。（当前 connect/mail.mjs 的 pull 自己就把
        //   MailAuthError 收成了 out.authError，走不到这儿；写在这里是防它哪天改法。）
        if (e instanceof HapAuthError || e instanceof MailAuthError) {
          got = { authError: errText(e) };
        } else {
          say(`⚠ ${kind} 取数出错（这个来源这一轮跳过，水位线会回滚，下一轮再收一次）：`, errText(e));
          lostWhy = lostWhy || `${kind} 取数出错`;
          continue;
        }
      }
      if (!got || typeof got !== 'object' || typeof got.then === 'function') {
        say(`⚠ ${kind} 的 pull 没给回一个结果对象，这个来源这一轮跳过：`, String(got));
        lostWhy = lostWhy || `${kind} 的 pull 没给回结果对象`;
        continue;
      }
      if (got.authError) {
        // out.authError 保持单值（老调用方和老测试读的是它）；authErrors 多带一份
        // 「哪个来源挂的」，bin/fetch.mjs 靠它给对得上的修复动作。
        out.authError = out.authError || got.authError;
        out.authErrors.push({ kind, message: String(got.authError) });
        if (AUTH_STOPS_ROUND.has(kind)) {
          say(`⚠ ${kind} 掉线了，这一轮一条消息都不处理，等 ${ownerName()} 跑 hap auth login：`,
            String(got.authError).slice(0, 200));
          lostWhy = `${kind} 掉线（401）`;
          finished = true;
          return out;
        }
        // ⚠⚠ 邮件这类来源：只记一笔，**别的来源照常收、照常归档、照常入段**。
        //   下面三件事是这条分支安全的全部理由，改动前先想清楚：
        //   ① 水位线：这个适配器没收到的那部分**不会**被提交。邮件适配器的水位线
        //      改动是攒在 `got.commit` 闭包里的，而认证失败的那个账号在 `pullOne` 里
        //      抛在 `commits.push` **之前**，闭包里压根没有它；`commitPulled` 又只在
        //      `saveAll` 写盘成功之后才调。所以下一轮会把它原样重收。
        //   ② 不置 lostWhy：lostWhy 回滚的是**明道云**的 watch 基线，跟邮件的水位线
        //      没有半点关系。凭据缺失是稳定状态（可能连着好几天每一轮都报），置了
        //      lostWhy 等于让明道云的水位线永远原地打转、每轮把同一批会话重收一遍。
        //   ③ 邮件适配器**已经把能收的收了**（另一个账号健康的话 candidates 里有它的信），
        //      所以这里不 continue，让它跟别的来源一样往下走。整个适配器跳过的话，
        //      健康账号的邮件会被「另一个账号没凭据」无限期拖住——那正是这条要修的
        //      失败模式，只是换了一层。
        say(`⚠ ${kind} 认证失败，这个来源这一轮收不到（别的来源照常处理）。`
          + '修它：ms365 令牌跑 mailroom mail-bootstrap，网易补钥匙串里的授权码：',
        String(got.authError).slice(0, 200));
      }
      // ⚠⚠ 「这个来源整体没炸，但里面有会话没取到数」。取舍在这儿说明白
      //   （2026-08-08 评审点名要求写清楚）：
      //   lostWhy 一置位 → finally 里回滚的是**全局**水位线，也就是说单个会话取数失败
      //   会让这一轮所有会话下一轮再收一次。代价是日志吵一点、多打几趟 hap；
      //   收益是「有东西没取到」这件事一定会被重收兜住。去重（msgKey）挡得住重复入段，
      //   不会重复落进 inbox.md，所以这个代价是可以接受的。
      //   反过来（只回滚这一个会话）做不到：水位线由 watch.mjs 整份维护，
      //   mailroom 手上只有「整份快照」这一个粒度，没有按会话回退的接口。
      if (Array.isArray(got.lost) && got.lost.length) {
        say(`⚠ ${kind} 有 ${got.lost.length} 处没取到数（这一轮取到的照常处理，`
          + '水位线会回滚，下一轮整批再收一次）：', got.lost.join('；').slice(0, 400));
        lostWhy = lostWhy || `${kind} 取数失败：${String(got.lost[0]).slice(0, 120)}`;
      }
      pulled.push({ adapter, kind, got });
    }

    // ---- 归档 + 收拢候选 ----
    let candidates = [];
    for (const { adapter, kind, got } of pulled) {
      // 归档一条不漏，是消息的唯一事实源，排在归位之前：哪怕后面归位砸了，消息也还在。
      try {
        // 归档目录由适配器决定：明道云进 assets/hap-log，邮件进 assets/mail-log。
        const n = archive(got.records, { dailymd, subdir: adapter.logSubdir });
        if (n) say(`已归档 ${n} 条到 ${adapter.logSubdir || 'assets/hap-log'}`);
      } catch (e) {
        say(`⚠ ${kind} 归档没写成（这一轮继续归位，消息不会丢）：`, errText(e));
      }

      if (got.firstRun) { say(`${kind} 首轮，只建基线，不当成新消息`); continue; }
      if (got.noNews) { say(`${kind} 无新动静`); continue; }

      for (const c of (got.candidates || [])) {
        // 来源标签（「明道云 · 私信」）是适配器的事，聚段/落盘那层原样带着走。
        let sourceLabel = '';
        try {
          sourceLabel = adapter.describe ? adapter.describe(c) : '';
        } catch (e) {
          say(`⚠ ${kind} 的来源标签取不到（不影响归位）：`, errText(e));
        }
        candidates.push(sourceLabel ? { ...c, sourceLabel } : { ...c });
      }
    }
    out.got = candidates.length;

    // ---- 屏蔽 ----
    // 旧版本这层曾砍过一次（`mute-rules.json` 里一条规则都没有过，还拖着
    // 命中计数 + 跨进程锁一整套）。后来点名「短信模板审核以后别播报」，
    // 按最小形态重建：一份 `mute.json` 跟着代码走（两台 Mac 靠 git 同步），命中的
    // 候选不进段，只在日志里报个数。⚠ 别再往上加计数和常驻进程——砍掉的就是那些。
    if (candidates.length) {
      const muted = [];
      candidates = candidates.filter((c) => {
        const hit = muteHit(c);
        if (hit) muted.push(hit);
        return !hit;
      });
      if (muted.length) say(`屏蔽 ${muted.length} 条（${[...new Set(muted)].join('、')}）`);
    }

    // ---- 聚段 ----
    // ⚠ 这一轮一条新消息都没有也要往下走：下面「捞回搁浅的段」那一步得跑到。
    //   在这儿 return 的话，收件箱安静的日子里，上一轮没归成位的段会一直搁浅没人管。
    const existing = store.segments();
    const before = new Map((existing || []).map((s) => [s.id, (s.msgs || []).length]));
    // ⚠ 轮前快照要**现在**就序列化：下面 fileAll 会原地改这些对象（seg.filed = …），
    //   等到写盘那一刻再 stringify 就已经是改过的样子，「这期间有没有人动过」就判不出来了。
    const wasById = new Map((existing || []).filter(Boolean).map((s) => [s.id, JSON.stringify(s)]));
    let merged = existing || [];
    if (candidates.length) {
      const { candidates: fresh, skipped } = dropSeen(existing, candidates);
      if (skipped) say(`跳过 ${skipped} 条上一轮已经收过的消息`);
      if (!fresh.length) {
        say(`这一轮 ${out.got} 条候选全是收过的消息，没有新段`);
      } else {
        try {
          merged = mergeInto(existing, toSegments(fresh, { windowMin }), { windowMin });
          if (fresh.some((c) => c.kind === 'user' || c.sourceType === 'user' || (c.who && !/bot/i.test(c.who)))) {
            try {
              const peer = fresh.find((c) => c.who && !/bot/i.test(c.who))?.who || '真人互动';
              boostHeartbeat({ reason: `收到互动消息（来自 ${peer}）` });
            } catch { /* 忽略心跳记录异常 */ }
          }
        } catch (e) {
          // ⚠ 聚段砸了就整轮打住，这一轮不许半截落盘。消息已经归档（事实源在那儿），
          //   水位线回滚之后下一轮会把它们再收一次。
          say('⚠ 聚段这一步出岔子，这一轮不落盘（消息已归档，水位线会回滚）：', errText(e));
          lostWhy = lostWhy || '聚段出岔子';
          finished = true;
          return out;
        }
      }
    }

    // 这一轮真正新增 / 被追加了消息的段。out.segmented 只数这些，数字不虚高。
    const changed = merged.filter(
      (s) => !before.has(s.id) || before.get(s.id) !== (s.msgs || []).length,
    );
    out.segmented = changed.length;
    // 外加搁浅的段：还没归过位、也没被丢弃。上一轮归位整批砸了的话它们就卡在这儿——
    // 段已经在 segments.json 里、消息也已经进了去重集合，不捞回来就永远没人管它。
    const changedIds = new Set(changed.map((s) => s.id));
    const stranded = merged.filter((s) => !changedIds.has(s.id) && !s.filed && !s.dropped);
    if (stranded.length) say(`捞回 ${stranded.length} 个上一轮没归成位的段，这一轮重归一次`);

    const todo = [...changed, ...stranded];
    if (!todo.length) {
      // 没有新段、也没有搁浅的段要处理：这一轮要么没收到新东西，要么收到的
      // 都是 dropSeen 挡掉的重复（那些已经在更早一轮安全落盘过了）。两种情况
      // 都没有「还没确认安全落盘」的数据，水位线可以放心提交。
      commitPulled(pulled, say, store);
      finished = true;
      return out;
    }

    // ---- 交回去让对话里的 Claude 判 ----
    //
    // ⚠⚠ 这里必须**先存盘再返回**，顺序不能反。存下来的段 filed 为空，也就是上面
    //   「搁浅」那条规则认得的形态：Andy 关了终端 / 会话崩了 / 他看了一眼说「先不管」，
    //   下一轮 fetch 都会把它们原样捞回来重判。反过来先返回再存，中间任何一个岔子
    //   都等于这一轮收到的消息凭空消失——而它们已经被算进去重集合，源头不会再报第二遍。
    // ⚠ 水位线**不回滚**：消息已经归档、已经聚成段落盘了，这一轮是干净收尾的。
    //   回滚会让下一轮把同一批再收一遍，靠 dropSeen 兜着虽然不会重复落盘，但白打一趟。
    if (deferJudge) {
      // ⚠⚠ 已经归过位的老段（这一轮只是又追加了几条）**就地重写、不进待判队列**。
      //   两个理由，都是之前真炸过的：
      //   ① 打出来让人判 → 判定的 segIndex 是照这份队列数的，而 fileNow 那边的队列是
      //      `!filed && !dropped` 过滤出来的，老段不在里面 → **两边错位、判定落到别的段身上**；
      //   ② 不打出来也不重写的话，追加的那几条消息**永远进不了 inbox.md**（那一轮
      //      可能压根不会跑 file.mjs）。所以重写这一步必须在这儿做掉。
      //   重写失败（落点被 finish-task.sh 归档了）的会被清掉 filed 退回来，正好进待判队列。
      rewriteFiled(todo, { dailymd, tree, onLog });
      // ⚠⚠ 待判队列必须**照 merged 的顺序**数，不能照 todo 的顺序。
      //   todo 是 `[...changed, ...stranded]`——新收的段排在搁浅段前面，跟 segments.json
      //   里的存放顺序不一样；而 fileNow 那边是 `all.filter(!filed && !dropped)`，照存放顺序。
      //   两边集合一样、顺序不一样 → **segIndex 整体错位，判定落到别的段身上**。
      //   曾经真炸过：那一轮既有新段又有搁浅段，一位同事的反馈判去了别的项目、
      //   另一个人的任务回复判去了一封广告的落点，全批错位。
      //   （上面 ① 那条讲的是「老段该不该进队列」，这条讲的是「队列怎么排序」，是两个坑。）
      out.pending = merged.filter((s) => s && !s.filed && !s.dropped);
      // ⚠ 顺序：先重写（可能清掉 filed）再存盘，不然清掉的落点这一轮不落地。
      if (saveAll(store, merged, [], say, wasById)) commitPulled(pulled, say, store);
      else lostWhy = lostWhy || 'segments.json 没写成';
      if (!out.pending.length) {
        say(`这一轮：候选 ${out.got} 条 → 段 ${out.segmented} 个，没有等着判落点的`);
        finished = true;
        return out;
      }
      say(`这一轮：候选 ${out.got} 条 → 段 ${out.segmented} 个，${todo.length} 个等着判落点`);
      finished = true;
      return out;
    }

    // ---- 归位 ----
    let r;
    try {
      r = await fileAll(todo, { dailymd, judge, tree, onLog });
    } catch (e) {
      // fileAll 自己已经把「一段砸了不拖垮整批」兜住了，走到这儿说明整批都没跑成。
      // ⚠ 段还是要存下来：消息已经聚成段了，丢掉这份等于这一轮收到的消息凭空消失；
      //   存下来的话它们 filed 为空，下一轮会被上面「捞回搁浅的段」那条规则捞回来重归。
      say('⚠ 归位整批没跑成（段已存下，下一轮会再归一次）：', errText(e));
      if (saveAll(store, merged, [], say, wasById)) commitPulled(pulled, say, store);
      else lostWhy = lostWhy || 'segments.json 没写成';
      finished = true;
      return out;
    }

    out.filed = r.filed.length;
    out.dropped = r.dropped.length;
    out.unsure = r.unsure.length;
    if (saveAll(store, merged, r.all, say, wasById)) commitPulled(pulled, say, store);
    else lostWhy = lostWhy || 'segments.json 没写成';
    say(`这一轮：候选 ${out.got} 条 → 段 ${out.segmented} 个，`
      + `归位 ${out.filed}、拿不准 ${out.unsure}、丢弃 ${out.dropped}`);
    finished = true;
    return out;
  } finally {
    // ⚠⚠ 这一轮没干净收尾 → 把水位线退回去，否则那批会话的消息永久进不了 inbox.md
    //   （watch.mjs 在 `chat list` 一成功就把新基线写盘了，比这里早得多）。
    if (lostWhy || !finished) restoreWatch(snapshot, say, lostWhy || '这一轮中途抛错了');
    else commitOwnSeen(pulled, say, store);
  }
}

// ---------- 归位（第二步）----------
//
// `runOnce({ deferJudge: true })` 停在「段已落盘、等着判落点」，本函数接着往下走：
// 拿对话里的 Claude 给出的判定文本，走**原来那条一模一样的**归位管线写盘。
//
// ⚠⚠ 判定的人换了（headless claude 进程 → 对话里的 Claude），但校验一层都没换：
//   `parseVerdicts` 认不认得这段文本、`tree.resolve` 查不查得到这个任务号、查不到就
//   降级 P00-misc + sure=false ——全在 fileAll 里，本函数一条都没绕过。
//   **别在这儿加任何「模型说什么就写什么」的近路**：模型给个不存在的任务号是常态，
//   照着幻觉写就等于凭空造出一个 Andy 永远找不到的任务目录。
//
// ⚠ 这里不重新收消息。要判的段就是上一步存进 segments.json 里 filed 为空的那些——
//   中间隔多久都行，判到一半跑了也不怕，没判的下一轮照样捞得回来。
export async function fileNow(verdictText, {
  dailymd = dailymdRoot(),
  store = defaultStore,
  tree,
  onLog,
} = {}) {
  const say = (...parts) => {
    log(...parts);
    if (onLog) onLog(parts.join(' '));
  };
  const all = store.segments() || [];
  const wasById = new Map(all.filter(Boolean).map((s) => [s.id, JSON.stringify(s)]));
  const todo = all.filter((s) => s && !s.filed && !s.dropped);
  const out = { filed: 0, dropped: 0, unsure: 0, todo: todo.length };
  if (!todo.length) { say('没有等着判落点的段'); return out; }

  // ⚠⚠ judge 的契约是**返回解析好的判定数组**，不是返回原文——`askClaude` 最后一行
  //   就是 `return parseVerdicts(out, count)`。2026-08-09 第一版这里写成
  //   `async () => verdictText`（直接把文本丢回去），fileAll 一看不是数组，整批兜到
  //   P00-misc + sure=false，**归位功能等于全废**，而且不报错、只在日志里留一行
  //   「返回的不是数组： string」。真机第一条消息就撞上了。
  //   所以这里必须走同一个 parseVerdicts，跟 askClaude 一模一样。
  const r = await fileAll(todo, {
    dailymd,
    judge: async (_prompt, { count = 0 } = {}) => parseVerdicts(verdictText, count),
    tree,
    onLog,
  });
  out.filed = r.filed.length;
  out.dropped = r.dropped.length;
  out.unsure = r.unsure.length;

  // 这一轮**新**归位的段（含拿不准的），给「通知在管这个任务的会话」那一步用。
  // ⚠ 必须排掉往轮就已经归好位、这轮只是重写了一遍 inbox.md 的老段 ——
  //   不排的话同一条消息每轮都会往人家会话里投一次。
  //   判据：段 id 在开轮的 wasById 里（老段）就跳过；split 出来的新段 id 是新的，照投。
  const todoIds = new Set(todo.map((s) => s && s.id));
  out.routed = [...r.filed, ...r.unsure]
    .filter((s) => s && s.filed && s.filed.project)
    .filter((s) => todoIds.has(s.id) || !wasById.has(s.id))
    .map((s) => ({
      project: s.filed.project,
      task: s.filed.task || null,
      sure: !!s.filed.sure,
      who: s.who || '',
      sourceLabel: s.sourceLabel || '',
      preview: (s.msgs && s.msgs.length ? s.msgs[s.msgs.length - 1].text : '') || '',
    }));

  if (!saveAll(store, all, r.all, say, wasById)) {
    say('⚠ segments.json 没写成（消息已经落进 inbox.md，那份才是权威）');
  }
  say(`归位 ${out.filed}、拿不准 ${out.unsure}、丢弃 ${out.dropped}`);
  return out;
}

// ---------- 锁 ----------
//
// ⚠ stateDir() 是函数不是常量，锁文件路径每次现算（测试要能顶掉状态目录）。
function lockFile() { return join(stateDir(), 'poll.lock'); }

// ⚠⚠ export 出来是为了能测：锁是「装好之后第一次真跑」必经的第一步，
//   而它原来不建目录——~/.mailroom 还不存在的新机器上，第一轮必然 ENOENT 整轮空转
//   （第二轮才因为 log() 顺手建了目录而恢复）。这种「第一次装完不工作」最难查。
export function acquireLock() {
  const file = lockFile();
  // 状态目录可能压根还不存在（新机器第一次跑）。⚠ 每次现建，别在模块顶层建——
  //   那样又会把 stateDir() 的求值时机绑死在 import 那一刻。
  mkdirSync(stateDir(), { recursive: true });
  if (existsSync(file)) {
    const age = Date.now() - statSync(file).mtimeMs;
    if (age < 15 * 60 * 1000) return false;   // 上一轮还在跑（判定要等 claude），这轮让开
    log('发现超过 15 分钟的陈旧锁，抢占');
  }
  writeFileSync(file, String(process.pid));
  return true;
}

export function releaseLock() {
  try { unlinkSync(lockFile()); } catch (e) {
    log('⚠ 锁没删掉（15 分钟后会被下一轮抢占）：', errText(e));
  }
}

