// inbox.md 的读 / 追加 / 移段 / 删段。
//
// ⚠⚠ 这是全产品的权威所在：任务目录里的 `inbox.md` 才是消息的唯一真相，
//   `~/.mailroom/` 下那份 segments.json 只是运行态索引，删了要能从这个文件重建。
//   所以这里的格式必须一字不差地照 PLAN.md「数据模型」那节实现，解析器也必须够稳：
//   同一个 segId 每五分钟都会被归位器重复写一次，绝不能追加出第二份。

import {
  readFileSync, writeFileSync, renameSync, mkdirSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';

import { healTimestamps } from './lib.mjs';

const HEADER = '# 往来消息';

function inboxPath(taskDir) {
  return join(taskDir, 'inbox.md');
}

// 先写 .tmp 再 rename：跟 store.mjs 同一个套路，防止进程中途死掉留半个文件。
function writeAtomic(file, content) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

// ---------- 锚点转义：防止消息正文撑破解析器 ----------
//
// ⚠ 消息正文是外部输入（对方在明道云里想打什么就打什么），解析器认的段边界
//   只有两个字面串：`<!-- seg:ID -->` 和 `<!-- /seg -->`。如果正文里原样出现
//   这两个字面串（哪怕只是随口贴了一段别的 inbox.md），blockRegexForId 的
//   非贪婪匹配会在正文里的假 `<!-- /seg -->` 处提前收尾——真正的段边界被吃掉，
//   后面本该属于这一段的内容会被解析成「游离在任何段之外」，appendSegment 的
//   幂等替换也会因为找不到完整的旧块而退化成重复追加。
//   所以：把消息正文（连同 who / sourceLabel 这些同样来自外部或转述的字段）
//   里的这两个字面串在写盘前就拆开，而不是指望解析器足够聪明地识别「谁是真的」。
function escapeAnchors(s) {
  return String(s == null ? '' : s)
    .replace(/<!--/g, '<\\!--')
    .replace(/-->/g, '--\\>');
}

// 写进锚点属性里的值（who / sourceLabel / msgId）。比 escapeAnchors 更严三样：
//   · 换行压成空格 —— ⚠⚠ 这条是安全边界，不是排版。who 是外部输入（对方在明道云里
//     把昵称改成什么都行），标题行是 `## 日期 时间 who · label`；who 里塞一个换行 +
//     `> 已发 · x`，解析器在固定位置就读到了「已发」那行，对方的话在时间线上被渲染成
//     **Andy 自己发出去的**。压掉换行，`> 已发` 那行的位置就再也伪造不出来。
//   · `"` 和 `>` 转义 —— 属性用双引号包，锚点用 `-->` 收尾，这两个字符能提前把锚点关掉。
function attr(s) {
  return escapeAnchors(s)
    .replace(/[\r\n]+/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/>/g, '&gt;');
}

function unattr(s) {
  return String(s == null ? '' : s)
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

// 标题行上给人看的那份 who / label：只压换行（理由同上），别的原样。
function oneLine(s) {
  return escapeAnchors(s).replace(/[\r\n]+/g, ' ');
}

// ISO 时间串切片取 `YYYY-MM-DD` / `HH:MM`。
//
// 现在所有时间戳都由 `localIso()` 产出（本地时间 + `+08:00` 偏移），切片即所见。
// ⚠ 但**带 UTC 标记的串必须先换算**：历史数据里有一批 `…Z`（2026-08-11 之前
// 全都是），Graph 的 `receivedDateTime` 也可能再给出 `Z`。直接切片就是那个
// 早 8 小时的 bug（见 lib.mjs `localIso` 的注释）。判据只看**有没有显式时区**：
// 有 Z 或 ±HH:MM 偏移 → 交给 Date 换算成本地；裸串（没时区信息）→ 原样切片，
// 因为它本来就是本地时间，硬解析反而会被当成 UTC 再挪一次。
function shortTime(iso) {
  const s = String(iso || '');
  const zoned = /(?:Z|[+-]\d{2}:\d{2})$/.test(s);
  if (zoned) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      const pad = (n) => String(n).padStart(2, '0');
      return {
        date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
        time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
      };
    }
  }
  const m = s.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (m) return { date: m[1], time: m[2] };
  return { date: s.slice(0, 10), time: s.slice(11, 16) };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 定位某个 segId 对应的整块（从开锚到闭锚），非全局、非贪婪——
// 只找「这个 id 的开锚」之后第一个闭锚。因为消息正文里的假闭锚已经在
// escapeAnchors 里被拆掉了，文件里属于这一段的范围内不会再出现第二个
// 真的 `<!-- /seg -->`，非贪婪匹配到的就是真正的那一个。
// ⚠ 开锚现在带属性（`<!-- seg:ID who="…" via="…" mine=0 -->`），所以不能再按
//   `<!-- seg:ID -->` 这个字面串找。`[^>]*` 停在第一个 `>` 上（属性值里的 `>` 已经
//   被 attr() 转义掉了），回溯之后正好落在 `-->` 上；老格式 `<!-- seg:ID -->` 同样命中。
//   id 后面那个空格不能省：没有它 `seg:a1` 会匹配上 `seg:a1x`。
function blockRegexForId(id) {
  const esc = escapeRegExp(id);
  return new RegExp(`<!-- seg:${esc} [^>]*-->[\\s\\S]*?<!-- /seg -->`);
}

// 把一个 segment 渲染成 inbox.md 里的一块：
//
//   <!-- seg:ID mine=0 who="李雷" via="明道云 · 私信" -->
//   ## YYYY-MM-DD HH:MM 李雷 · 明道云 · 私信
//
//   - 11:18 <!-- m:m1 --> 正文
//   - 11:19 <!-- m:m2 --> 正文
//
//   <!-- /seg -->
//
// 我发出去的那一段（seg.sentLabel 有值）多插一行 `> 已发 · sentLabel`，
// 紧跟在标题行后面、消息列表前面（seg.who 这时约定写成「我 → 对方」）。
//
// ⚠⚠ `seg.draft` 为真时那一行写成 `> 草稿 · …`，**不许写「已发」**：外部收件人的邮件
//   只能存草稿（物理上发不出去），它还躺在用户自己的草稿箱里等他点发送。
//   一周后他翻这条时间线，第一个词是「已发」的话就会以为客户早就收到了 ——
//   「事后误以为已经回了客户」正是这套东西最不能接受的失败模式之一。
//   开锚上同步写一个 `draft="1"`，判定一律读注释里那份（跟 mine 同一个道理）。
//
// ⚠⚠ 两处 HTML 注释是**机器读的那一份**，跟给人看的标题行/正文各管各的，
//   评审挖出的 Critical 就是「机器只能靠给人看的那份反推」造成的：
//
//   ① 每条消息带 `<!-- m:ID -->`。原来 msgId 是靠**下标**把文件里的第 N 行对到
//      索引里的第 N 条 —— 而正文里一行「- 10:00 开会」会被解析成独立的一条消息，
//      下标当场错位。后果不是显示错行，是用户勾中「开会」点【拆开】，
//      被搬去别的任务的是**另一条完全不相干的消息**，且没有任何提示。
//      触发条件不是攻击，是中文里最常见的「时间 + 事项」列表。
//   ② 段头带 `who` / `via` / `mine`。标题行上 who 和 sourceLabel 之间用 ` · ` 分隔，
//      而 sourceLabel 自己就含中点（「明道云 · 私信」），who 里再出现一个 ` · `
//      （群名带中点、昵称带中点）就再也切不准；`mine` 更是绝不能从显示名反推 ——
//      对方把昵称改成 `我 → 李雷` 就能让自己的话冒充本人发出去的消息。
//
//   所以：显示归显示，判定一律读注释里这一份。改这段格式必须同步改 parseBlock。
function renderBlock(seg) {
  const who = oneLine(seg.who);
  const label = oneLine(seg.sourceLabel || '');
  const { date, time } = shortTime(seg.firstAt);
  const mine = seg.sentLabel ? 1 : 0;
  const draft = seg.draft ? 1 : 0;
  const lines = [
    `<!-- seg:${seg.id} mine=${mine} draft=${draft} who="${attr(seg.who)}" via="${attr(seg.sourceLabel || '')}" -->`,
    `## ${date} ${time} ${who}${label ? ` · ${label}` : ''}`,
  ];
  if (seg.sentLabel) lines.push(`> ${seg.draft ? '草稿' : '已发'} · ${oneLine(seg.sentLabel)}`);
  lines.push('');
  for (const m of (seg.msgs || [])) {
    const { time: mt } = shortTime(m.at);
    lines.push(`- ${mt} <!-- m:${attr(m.id ?? '')} --> ${escapeAnchors(m.text)}`);
  }
  lines.push('');
  lines.push('<!-- /seg -->');
  return lines.join('\n');
}

// 追加一段。⚠ 幂等：同一个 seg.id 已经在文件里，就整块替换，不追加第二遍——
// 归位器每五分钟跑一轮，同一段会带着新消息被反复写进来。
// 文件不存在就新建，开头一行 `# 往来消息`。
export function appendSegment(taskDir, seg) {
  // ⚠ 落盘门口的自愈：不管这个 seg 是谁拼的、时间戳从哪来，写进 inbox.md 的
  //   一律是本地时间。见 lib.mjs 的 healTimestamps。
  seg = healTimestamps(seg, `appendSegment ${seg && seg.id}`);
  mkdirSync(taskDir, { recursive: true });
  const file = inboxPath(taskDir);
  const text = existsSync(file) ? readFileSync(file, 'utf-8') : `${HEADER}\n`;
  const block = renderBlock(seg);
  // ⚠ 幂等判据必须跟替换用的是**同一个**正则：原来这里用 `text.includes('<!-- seg:ID -->')`
  //   判、用 blockRegexForId 替，开锚一带上属性，判的那句就永远是 false，
  //   同一段每轮追加一遍 —— 五分钟一份重影。判和替只许有一个判据。
  const re = blockRegexForId(seg.id);
  const next = re.test(text)
    ? text.replace(re, block)
    : `${text.replace(/\s+$/, '')}\n\n${block}\n`;
  writeAtomic(file, next);
}

// 按锚点读回所有段。raw 是这一块的原始 markdown（含首尾两行锚点），
// 谁要转手把这一块整块搬去别的任务目录，直接把 raw 喂给别处即可。
export function readSegments(taskDir) {
  const file = inboxPath(taskDir);
  if (!existsSync(file)) return [];
  const text = readFileSync(file, 'utf-8');
  const re = /<!-- seg:([^\s>]+)[^>]*-->[\s\S]*?<!-- \/seg -->/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({ id: m[1], raw: m[0] });
  }
  return out;
}

// 把 renderBlock 写出去的那一块**读回结构**。
//
// ⚠⚠ 为什么必须有这个函数：`inbox.md` 是权威，`~/.mailroom/segments.json` 只是索引，
//   「删了要能从 inbox.md 重建」。网页的任务时间线要是只认索引，那索引一丢
//   （换机器、清缓存、JSON 写坏）整个页面就白屏了——而消息其实一条没少，都在文件里。
//   所以时间线一律以本函数的结果为准，索引只用来往上贴 filed / waiting / msgId。
//
// 解析规则（跟 renderBlock 一一对应，改那边就得改这边）：
//   who / sourceLabel / mine / msgId —— **一律读注释里那份**（开锚属性 + `<!-- m:ID -->`），
//     给人看的标题行只在「这一块是老格式/被人手改过、注释那份不存在」时才退回去解析。
//   `- HH:MM <!-- m:ID --> 正文` —— 一条消息。⚠ 只要这一块里出现过带 `m:` 标记的行，
//     就**只有带标记的行**能起一条新消息，其余非空行一律算上一条的续行 ——
//     正文里那句「- 10:00 开会」于是老老实实待在它所属的消息里，不再冒充成一条。
//   `> 已发 · X` —— 显示用的「已发」标注；判不判「我发出去的」看 mine 属性。
export function parseSegments(taskDir) {
  return readSegments(taskDir).map((b) => ({ id: b.id, raw: b.raw, ...parseBlock(b.raw) }));
}

// escapeAnchors 的逆操作：读回来给人看的时候要还原成原文，
// 别让界面上出现 `<\!--` 这种只有写盘时才需要的转义。
function unescapeAnchors(s) {
  return String(s == null ? '' : s).replace(/<\\!--/g, '<!--').replace(/--\\>/g, '-->');
}

// 开锚上的一个属性。取不到返回 null（老格式/手改过的块），调用方据此决定退不退回标题行。
function anchorAttr(anchorLine, key) {
  const quoted = anchorLine.match(new RegExp(`\\s${key}="([^"]*)"`));
  if (quoted) return unattr(unescapeAnchors(quoted[1]));
  const bare = anchorLine.match(new RegExp(`\\s${key}=([^\\s>"]+)`));
  return bare ? bare[1] : null;
}

function parseBlock(raw) {
  const lines = String(raw || '').split('\n');
  const out = {
    who: '', sourceLabel: '', sentLabel: '', date: '', time: '', msgs: [], mine: false,
    draft: false, legacy: false,
  };
  const anchor = lines[0] || '';
  const aWho = anchorAttr(anchor, 'who');
  const aVia = anchorAttr(anchor, 'via');
  const aMine = anchorAttr(anchor, 'mine');
  const aDraft = anchorAttr(anchor, 'draft');

  let i = 1; // 第 0 行是开锚
  const head = (lines[i] || '').match(/^##\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s*(.*)$/);
  if (head) {
    out.date = head[1];
    out.time = head[2];
    // ⚠ 退回标题行解析是**明确的降级路径**：` · ` 既分隔 who 和 label、又出现在 label
    //   自己里头，切不准是必然的。新块一律走上面的属性，这里只兜老块/手改块。
    const rest = head[3].trim();
    const at = rest.indexOf(' · ');
    out.who = unescapeAnchors(at === -1 ? rest : rest.slice(0, at)).trim();
    out.sourceLabel = unescapeAnchors(at === -1 ? '' : rest.slice(at + 3)).trim();
    i++;
  }
  // `> 已发 · X` / `> 草稿 · X`。老块只有前一种，两种都要认得。
  const sent = (lines[i] || '').match(/^>\s*(已发|草稿)\s*·\s*(.*)$/);
  if (sent) {
    out.draft = sent[1] === '草稿';
    out.sentLabel = unescapeAnchors(sent[2]).trim();
    i++;
  }
  if (aWho !== null) out.who = aWho;
  if (aVia !== null) out.sourceLabel = aVia;

  const body = lines.slice(i);
  // 这一块里有没有带标记的消息行？有就进严格模式：只有带标记的行能起新消息。
  const marked = /^-\s\d{2}:\d{2}\s<!-- m:/m;
  const strict = body.some((l) => marked.test(l));
  out.legacy = !strict && aMine === null;
  for (const line of body) {
    if (line.startsWith('<!-- /seg -->')) break;
    const withId = line.match(/^-\s(\d{2}:\d{2})\s<!-- m:([^\s>]*) -->\s?([\s\S]*)$/);
    const loose = strict ? null : line.match(/^-\s(\d{2}:\d{2})\s(.*)$/);
    if (withId) {
      out.msgs.push({ id: unattr(withId[2]) || null, time: withId[1], text: unescapeAnchors(withId[3]) });
    } else if (loose) {
      out.msgs.push({ id: null, time: loose[1], text: unescapeAnchors(loose[2]) });
    } else if (out.msgs.length && line.trim()) {
      out.msgs[out.msgs.length - 1].text += `\n${unescapeAnchors(line)}`;
    }
  }

  // ⚠⚠ 「我发出去的」只认注释里那一份。**绝不许**从显示名的 `我 → ` 前缀反推：
  //   who 是外部输入，对方把明道云昵称改成「我 → 李雷」，他的话就在时间线上
  //   冒充成本人发出去的消息（评审实跑为真）。
  //   老块没有 mine 属性，退回看「已发」那行——它的位置（紧贴标题行）伪造不出来，
  //   因为 who 里的换行在写盘时已经被 attr()/oneLine() 压掉了。
  out.mine = aMine !== null ? aMine === '1' : !!out.sentLabel;
  // draft 同样以注释里那份为准；老块没有这个属性，退回看那一行写的是「草稿」还是「已发」。
  if (aDraft !== null) out.draft = aDraft === '1';
  return out;
}

// 删掉某一段。命中返回 true，文件不存在或没有这个 id 返回 false（不抛错——
// 「删一个本来就不在的段」不是异常情况，调用方（比如重复的移段请求）不用特地兜底）。
export function removeSegment(taskDir, segId) {
  const file = inboxPath(taskDir);
  if (!existsSync(file)) return false;
  const text = readFileSync(file, 'utf-8');
  const re = blockRegexForId(segId);
  if (!re.test(text)) return false;
  const stripped = text.replace(re, '')
    .replace(/\n{3,}/g, '\n\n'); // 挖掉一块后收拢多出来的空行，别让文件越删越花
  writeAtomic(file, `${stripped.replace(/\s+$/, '')}\n`);
  return true;
}

// 移段：先把整段写进目标任务目录，**确认成功**之后再从来源删除。
// ⚠ 顺序不能反——appendSegment(toDir, ...) 如果因为目标路径不存在/没权限而抛错，
//   这个函数会跟着往外抛，removeSegment(fromDir, ...) 根本不会被执行到，
//   来源那份原样留着。反过来写的话，目标那边一失败，消息就凭空丢了。
export function moveSegment(fromDir, toDir, seg) {
  appendSegment(toDir, seg);
  removeSegment(fromDir, seg.id);
}
