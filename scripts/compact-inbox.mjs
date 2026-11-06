// compact-inbox —— 给 inbox.md 瘦身 + 按时间窗轮转到 archive/。
//
// 为什么有这支脚本：到 2026-09-15，`projects/P00-misc/inbox.md` 攒到 977 段 14968 行，
// 占全部 inbox 体积的 70%，机主 的原话是「未来想查都很困难」。三个成因：
//   ① 邮件段拄了正文（BODY_MAX 当时是 2000），204 段吃掉 6104 行 = 41% 体积，
//      而那些正文在 assets/mail-log/ 里一字不少地又存了一遍；
//   ② 播报类（工作流/应用/日程/系统/人事）照单全收；
//   ③ P00-misc 是常驻兜底项目，项目级 inbox 永远不会被归档带走，只增不减。
// ①②③ 的增量已经分别在 mail/normalize.mjs、file.mjs 的判定口径里堵住了，
// 这支脚本管的是**存量**，外加装上长期的轮转闸。
//
// ⚠⚠ 三条安全线，写这支脚本时每一条都是真踩到的：
//   1. **不重建文件，只做精确子串替换。** readSegments 的正则是非贪婪的，碰到没闭合的
//      畸形块会把它和后面一段一起吞掉；整文件 parse→render 重建会把这类块吃掉内容。
//      实测 P00-misc 就有一个（开锚 977、闭锚 976）。所以：可疑块一律原样保留并报告。
//   2. **默认只看不动。** 不给 --write 就是 dry-run。
//   3. **跑之前确认没有别的会话在写这个仓库**（本仓库的 appendSegment 是读-改-写，
//      撞上一次 mailroom tick 就丢段）。调用方负责，脚本只在开头提醒。

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { readdirSync, statSync } from 'node:fs';

// inbox.md 里一条消息的正文最多留这么多字，跟 mail/normalize.mjs 的 BODY_MAX 同口径。
const BODY_MAX = 300;

// 轮转窗口：超过这么多天的段搬去 archive/。P00-misc 是兜底桶，进得最多，窗口最短。
// ⚠ 默认值一开始写的是 90 天（机主 选的「按季度」），实测数据推翻了它：14968 行
//   全部产生于最近 6 周，90 天的窗口今天一段都轮转不走。所以兜底桶单独给 30 天。
const WINDOW_DAYS = { default: 90, 'P00-misc': 30 };

// 这些来源纯粹是平台播报，机主 从不需要为它们做什么；原文在 assets/hap-log/ 里。
const NOISE_VIA = /(工作流通知|应用通知|日程通知|系统通知|人事通知)/;

// 噪音判据**只看邮件的主题行**，不看正文。
//
// ⚠⚠ 这条是写这支脚本时当场踩的：第一版拿 /(退订|取消订阅|unsubscribe)/ 扫全文，
//   dry-run 把 T332「GEO内容实习生招聘」整个清空了——BOSS直聘投来的三份简历，
//   每封底部都有一句「如不想再收到此类邮件，请点击此处取消订阅」。正规商业邮件
//   几乎都带退订链接，拿它当删除判据等于删掉一切邮件。
//   主题行是发信人对这封信的自我声明，比正文里任何一句样板话都硬。
const NOISE_SUBJECT = [
  /验证码/,
  /verification code/i,      // Apollo 之类的英文验证码，一天能来好几封
  /(DMARC|aggregate report)/i,
  /【?电子发票】?/,
  /^(订阅|newsletter)/i,
];

function subjectOf(raw) {
  const m = String(raw).match(/主题：(.*)$/m);
  return m ? m[1] : '';
}

// ---------- 小工具 ----------

function walkInbox(root) {
  const out = [];
  const stack = [join(root, 'projects')];
  while (stack.length) {
    const dir = stack.pop();
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) stack.push(p);
      else if (name === 'inbox.md') out.push(p);
    }
  }
  return out.sort();
}

// 一个 block 里出现两个开锚 = 前一段没闭合，被非贪婪正则吞进来了。一律不碰。
function isSuspicious(raw) {
  const opens = (raw.match(/<!-- seg:/g) || []).length;
  const closes = (raw.match(/<!-- \/seg -->/g) || []).length;
  return opens !== 1 || closes !== 1;
}

// ⚠ 开锚上的属性有两种写法：who / via 带引号，mine / draft 是裸值（renderBlock 写的
//   就是 `mine=${mine}`）。第一版只认带引号的那种，于是 mine 永远读成空字符串、
//   每一段都被当成「别人发来的」——测试「mine=1 的自发段一段都不许删」抓到的就是这个。
function attrOf(raw, key) {
  const line = String(raw).split('\n')[0] || '';
  const quoted = line.match(new RegExp(`\\s${key}="([^"]*)"`));
  if (quoted) return quoted[1];
  const bare = line.match(new RegExp(`\\s${key}=([^\\s>"]+)`));
  return bare ? bare[1] : '';
}

function dateOf(raw) {
  const m = String(raw).match(/^##\s+(\d{4}-\d{2}-\d{2})/m);
  return m ? m[1] : '';
}

function daysAgo(dateStr, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return -1;
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return -1;
  return Math.floor((today - d) / 86400000);
}

function projectOf(file) {
  const m = file.match(/projects\/([^/]+)\//);
  return m ? m[1] : '';
}

function windowOf(project) {
  return WINDOW_DAYS[project] ?? WINDOW_DAYS.default;
}

// projects/P0X-slug/tasks/T0X-…/inbox.md → archive/P0X-slug/tasks/T0X-…/inbox-YYYY-MM.md
function archivePathFor(file, root, month) {
  const rel = relative(root, file).replace(/^projects\//, 'archive/');
  return join(root, rel.replace(/inbox\.md$/, `inbox-${month}.md`));
}

// 被 compact 删掉的段留底在这儿。⚠ 不是 archive/：那儿镜像的是 projects 结构、
// 是给人翻的；这份是「删了什么」的账，按月一个文件，跟 hap-log 放一起。
const DROP_HEADER = `# compact 删掉的段（留底）

> 自动追加。这些段被 \`mailroom compact\` 判为噪音从 inbox.md 里清掉了。
> ⚠ **通知类消息（notice-*）不进 assets/hap-log/ 的 jsonl 归档**，这份留底是它们
> 唯一的去处，别当垃圾删。`;

function dropLogPathFor(root, date) {
  const month = /^\d{4}-\d{2}/.test(date) ? date.slice(0, 7) : 'undated';
  return join(root, 'assets', 'hap-log', `dropped-${month}.md`);
}

// ---------- 正文压缩 ----------

// 段里一条消息长这样：`- HH:MM <!-- m:ID --> 正文…（可跨多行，直到下一条 `- HH:MM <!-- m:`）`
// 只压正文，锚点、时间、消息 id 一个字节都不动。
function shrinkBody(raw, hint) {
  const lines = raw.split('\n');
  const out = [];
  let shrunk = false;
  let buf = null;          // 当前这条消息：head 是 `- HH:MM <!-- m:ID --> `，body 是正文各行

  // ⚠ 「压过没有」这个标记必须在 flush 内部就地记下。第一版是在外面写
  //   `if (buf && buf.shrunk) shrunk = true;` 再调 flush()，而 flush 会把 buf 置空——
  //   判断跑在清空之前的那一路还好，跑在之后就永远读到 null，压完了却报「没压」，
  //   于是整个 shrink 动作被静默丢弃（测试「超长邮件压到 300 字」抓到的就是这个）。
  const flush = () => {
    if (!buf) return;
    const body = buf.body.join('\n');
    // ⚠⚠ 幂等：已经压过的段不许再压一次。第一版没这道判断，第二次跑 --write 时
    //   把上一轮的「…（正文已截断，全文见 …）」当成正文又截了一刀，段尾留下
    //   `…（` `…（正文已截断，全` 这种半截行（原文没丢，脏的是提示本身）。
    //   这类脚本一定会被跑第二次，不幂等等于每跑一次脏一层。
    const done = /…（正文已截断，全文见/.test(body);
    const cut = (!done && body.length > BODY_MAX + 20)
      ? `${body.slice(0, BODY_MAX)}\n…（正文已截断，全文见 ${hint}）`
      : body;
    if (cut !== body) shrunk = true;
    const parts = cut.split('\n');
    out.push(buf.head + (parts[0] ?? ''));
    out.push(...parts.slice(1));
    buf = null;
  };

  for (const line of lines) {
    // ⚠⚠ 开锚和闭锚永远不属于消息正文。漏掉这一条时，`<!-- /seg -->` 会被当成最后
    //   一条消息的续行收进 body，正文一截断就把它一起截没了——整份 inbox.md 的段
    //   结构会当场崩掉。
    if (/^<!-- \/?seg/.test(line)) { flush(); out.push(line); continue; }
    const m = line.match(/^(- \d{2}:\d{2} <!-- m:[^>]*--> )([\s\S]*)$/);
    if (m) { flush(); buf = { head: m[1], body: [m[2]] }; continue; }
    if (buf) { buf.body.push(line); continue; }
    out.push(line);
  }
  flush();
  return { text: out.join('\n'), shrunk };
}

// ---------- 主逻辑 ----------

export function planFile(file, root, today = new Date()) {
  const text = readFileSync(file, 'utf-8');
  const re = /<!-- seg:([^\s>]+)[^>]*-->[\s\S]*?<!-- \/seg -->/g;
  const project = projectOf(file);
  const win = windowOf(project);
  const acts = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    if (isSuspicious(raw)) { acts.push({ raw, kind: 'suspicious' }); continue; }
    const via = attrOf(raw, 'via');
    const mine = attrOf(raw, 'mine') === '1';
    const date = dateOf(raw);
    const age = daysAgo(date, today);

    // ⚠ mine=1 是「以 机主 名义发出去的消息」，不是噪音，一段都不许删。
    //   实测它们平均 8 行，本来就不胖，连压缩都不需要。
    // ⚠ 任务级 inbox（路径含 /tasks/）一段都不删，只压缩和轮转。
    //   段落能落到某个具体任务下，说明归位时有人判断过「这条跟这件事有关」——
    //   哪怕它形式上是条日程通知，也是这个任务的上下文（T317 整个任务就只有两条
    //   会议通知，删完文件就空了）。项目级兜底桶才是该清的地方。
    const inTask = /\/tasks\//.test(file);
    if (!mine && !inTask) {
      if (NOISE_VIA.test(via)) { acts.push({ raw, kind: 'drop', why: `播报类（${via}）` }); continue; }
      const subj = subjectOf(raw);
      const hit = subj && NOISE_SUBJECT.find((r) => r.test(subj));
      if (hit) { acts.push({ raw, kind: 'drop', why: `噪音主题（${subj.slice(0, 30)}）` }); continue; }
    }

    // 超窗 → 轮转。轮转优先于压缩：搬走的那份保持原样，archive 是给人翻的。
    if (age >= 0 && age > win) {
      acts.push({ raw, kind: 'move', month: date.slice(0, 7), why: `${age} 天前 > ${win} 天窗口` });
      continue;
    }

    if (/邮件/.test(via)) {
      const hint = date ? `assets/mail-log/${date.slice(0, 7)}.md` : 'assets/mail-log/';
      const r = shrinkBody(raw, hint);
      if (r.shrunk) { acts.push({ raw, kind: 'shrink', text: r.text }); continue; }
    }
    acts.push({ raw, kind: 'keep' });
  }
  return { file, project, window: win, text, acts };
}

export function applyPlan(plan, root, { write = false } = {}) {
  let text = plan.text;
  const moves = new Map();   // archive 路径 → 段 raw 列表
  const drops = new Map();   // 留底路径 → 被删段 raw 列表
  const stat = { drop: 0, shrink: 0, move: 0, keep: 0, suspicious: 0 };

  for (const a of plan.acts) {
    stat[a.kind]++;
    if (a.kind === 'keep' || a.kind === 'suspicious') continue;
    // ⚠ 只做精确子串替换，绝不整文件重建 —— 畸形块在别处原样躺着，碰不到它。
    const at = text.indexOf(a.raw);
    if (at === -1) continue;
    let next = '';
    if (a.kind === 'shrink') next = a.text;
    if (a.kind === 'move') {
      const p = archivePathFor(plan.file, root, a.month);
      if (!moves.has(p)) moves.set(p, []);
      moves.get(p).push(a.raw);
    }
    if (a.kind === 'drop') {
      // ⚠⚠ 删之前一律留底。SKILL.md 里那句「drop 掉也没关系，原文照样在
      //   assets/hap-log/」对**通知类**是假的：notice-* 的消息（工作流/应用/
      //   日程/系统/人事播报）压根不进归档 jsonl，删了就真的只剩 git 历史。
      //   2026-09-15 第一次跑 compact 删掉的 76 段里有 71 段属于这一类，
      //   是事后抽查 jsonl 才发现的。留底之后「丢得起」才是真的。
      const p = dropLogPathFor(root, dateOf(a.raw));
      if (!drops.has(p)) drops.set(p, []);
      drops.get(p).push(a.raw);
    }
    text = text.slice(0, at) + next + text.slice(at + a.raw.length);
  }
  text = `${text.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')}\n`;

  if (write) {
    for (const [p, segs] of drops) {
      mkdirSync(dirname(p), { recursive: true });
      const head = existsSync(p) ? readFileSync(p, 'utf-8').replace(/\s+$/, '') : DROP_HEADER;
      writeAtomic(p, `${head}\n\n${segs.join('\n\n')}\n`);
    }
    for (const [p, segs] of moves) {
      mkdirSync(dirname(p), { recursive: true });
      const head = existsSync(p) ? readFileSync(p, 'utf-8').replace(/\s+$/, '') : '# 往来消息（归档）';
      writeAtomic(p, `${head}\n\n${segs.join('\n\n')}\n`);
    }
    writeAtomic(plan.file, text);
  }
  return { stat, text, moves, drops };
}

function writeAtomic(file, content) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, file);
}

// ---------- CLI ----------

export function run(argv, root) {
  const write = argv.includes('--write');
  const files = walkInbox(root);
  let totalBefore = 0;
  let totalAfter = 0;
  const sus = [];
  const rows = [];

  for (const file of files) {
    const plan = planFile(file, root);
    const { stat, text } = applyPlan(plan, root, { write });
    const before = plan.text.split('\n').length;
    const after = text.split('\n').length;
    totalBefore += before;
    totalAfter += after;
    if (stat.suspicious) sus.push(`${relative(root, file)}（${stat.suspicious} 处）`);
    if (stat.drop || stat.shrink || stat.move) {
      rows.push(`  ${relative(root, file)}\n`
        + `    ${before} → ${after} 行　删 ${stat.drop} · 压 ${stat.shrink} · 轮转 ${stat.move}`
        + `　（窗口 ${plan.window} 天）`);
    }
  }

  console.log(write ? '【已写入】' : '【只看不动，加 --write 才真改】');
  console.log('');
  console.log(rows.length ? rows.join('\n') : '  （没有要动的）');
  console.log('');
  console.log(`合计：${totalBefore} → ${totalAfter} 行（省 ${totalBefore - totalAfter}）`);
  if (sus.length) {
    console.log('');
    console.log('⚠ 下面这些文件里有没闭合/畸形的段，已原样保留、一个字没碰：');
    for (const s of sus) console.log(`    ${s}`);
    console.log('  用 grep -c "<!-- seg:" 和 grep -c "<!-- /seg -->" 对一下，手工补上闭合锚点。');
  }
  return 0;
}
