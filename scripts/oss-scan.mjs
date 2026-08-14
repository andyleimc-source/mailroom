#!/usr/bin/env node
// 发布前的敏感信息闸。**推到 GitHub 公开就撤不回**——会被爬、被 fork、进训练集，
// 删掉仓库不等于删干净。所以这道闸宁可误报，也不许漏报。
//
// 四层，一层抓一类，缺一层就不叫万无一失：
//
//   L0 白名单发布   —— 在 PUBLISH.allow 里，不在这个文件里（release-oss.sh 负责）。
//                      新文件默认不发布，必须有人手动加一行。
//   L1 结构化正则   —— 机器 100% 抓得住的：邮箱、手机号、UUID、私有网段 IP、
//                      内部主机名、私人钥匙串条目名。命中即挡。
//   L2 人名清单     —— 从你的通讯录**本地生成**一份名字清单来比对。
//                      ⚠ 这份清单绝不进仓库（它本身就是通讯录），用 --names 传路径。
//   L3 中文兜底     —— 抓 L2 漏网的：通讯录里没有的人名、公司/产品专名。
//                      **命中不自动挡**，但必须逐条人工看过并记进 PUBLISH.reviewed。
//
// 用法：
//   node scripts/oss-scan.mjs [--root <目录>] [--names <人名清单文件>] [--all]
//   退出码 0 = 可以发；1 = 有 L1/L2 命中（挡住）；2 = 只有 L3 待人工确认。

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));

// ---------- 允许出现的东西 ----------

// 示例/占位用的域名。**只放明确是假的**——真实公司域名一个都不许进这个名单，
// 那样等于给自己开后门。
const FAKE_DOMAINS = [
  'example.com', 'example.org', 'example.net', 'example.invalid', 'example',
  'acme.com', 'corp-mail.com', 'yourcompany.com', 'yourtenant.com',
  'client-corp.com', 'primary.invalid', 'mail.example',
];

// 公开的、属于**产品或平台本身**的地址。这类不是个人信息，但每加一条都要写清理由。
const PUBLIC_HOSTS = [
  'graph.microsoft.com', 'login.microsoftonline.com', 'outlook.office.com',
  'outlook.office365.com', 'github.com', 'registry.npmjs.org',
];

// ---------- L1：结构化 ----------

const L1 = [
  {
    name: '邮箱地址',
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    ok: (hit) => {
      const domain = hit.split('@')[1].toLowerCase();
      return FAKE_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))
        || /^(no-?reply|donotreply|do-not-reply|mailer-daemon|notifications?|alerts?|updates?)@/i.test(hit);
    },
  },
  { name: '手机号', re: /(?:\+?86[- ]?)?1[3-9]\d{9}/g },
  {
    name: 'UUID（可能是 accountId）',
    re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  },
  {
    name: '内网 IP',
    // 10.x / 172.16-31.x / 192.168.x / 100.64-127.x（Tailscale 那一段）
    re: /\b(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}\.\d{1,3}\b/g,
  },
  {
    name: '内部主机名',
    re: /\b[A-Za-z0-9.-]*(?:\.mingdao\.net|sourcecode\.[A-Za-z0-9.-]+|hub\.[A-Za-z0-9.-]*mingdao[A-Za-z0-9.-]*)\b/g,
  },
  {
    name: '私人钥匙串条目',
    re: /mailroom-(?:netease|work-unlock|ms365)\b/g,
  },
];

// ---------- L3：中文兜底 ----------

// L3 的「疑似人名」判据。
//
// ⚠⚠ 这里试过两版都不行，记下来免得有人再走一遍：
//   ① 「百家姓 + 1~2 个汉字」满篇扫 —— 「路径早」「项目及」「和状态」全被当人名报，
//      一跑几百条。
//   ② 加「点名语境」（前面是 给/找/对/由，后面是 说/回）也没救回来 ——
//      那些字本身就是中文里最常见的功能词，「对水位线」「给方案」「任务评论」照样中招。
//   **没人会读的清单等于没有清单**：噪音一大，这一层就退化成摆设，还会让人以为扫过了。
//
// 所以现在只留高准确率的两种：
//   · `@某某` 提及 —— 名字真出现在这里的时候，格式是确定的
//   · 一张手写的公司/产品专名表
//   通讯录里有的人由 L2 兜（那才是「这个仓库里哪些名字要紧」的权威来源）。
//   L3 只是补一层，不承担主要拦截责任。
// ⚠ 前面不能是字母/数字/点/横线：那是**邮箱地址**的 @，不是提及（否则 `a@b.com` 会被当成提及了「b.com」）
const MENTION_NAME_RE = /(^|[^A-Za-z0-9._-])[@＠]([一-鿿]{2,4}|[A-Za-z][A-Za-z.]{1,15})/g;

function nameCandidates(line) {
  const out = [];
  let m;
  MENTION_NAME_RE.lastIndex = 0;
  // eslint-disable-next-line no-cond-assign
  while ((m = MENTION_NAME_RE.exec(line))) out.push(m[2]);
  return out;
}

// 一看就该人工确认的专名。⚠ 这是「提醒去看」，不是「一定不能有」——
// 比如产品名出现在文档里多半是对的，出现在测试夹具里就多半是忘了换。
const PROPER_NOUNS = ['明道云', '明道', 'nocoly', 'Nocoly', 'MPC', 'HAP大使', 'G2', '网易企业邮'];

// ---------- 扫描 ----------

function walk(root, rel = '') {
  const out = [];
  for (const name of readdirSync(join(root, rel))) {
    if (name === '.git' || name === 'node_modules' || name === '__pycache__') continue;
    const r = rel ? join(rel, name) : name;
    const st = statSync(join(root, r));
    if (st.isDirectory()) out.push(...walk(root, r));
    else out.push(r);
  }
  return out;
}

function isText(file) {
  return !/\.(png|jpg|jpeg|gif|pdf|zip|mp4|mov|ico|woff2?)$/i.test(file);
}

function loadReviewed(root) {
  const f = join(root, 'PUBLISH.reviewed');
  if (!existsSync(f)) return new Set();
  const out = new Set();
  for (const line of readFileSync(f, 'utf-8').split('\n')) {
    const s = line.split('#')[0].trim();
    if (s) out.add(s);
  }
  return out;
}

function loadNames(file) {
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, 'utf-8').split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'));
}

function scan({ root = REPO, namesFile = '', all = false } = {}) {
  const reviewed = loadReviewed(root);
  const names = loadNames(namesFile);
  const cjkNames = names.filter((n) => /^[一-鿿]{2,4}$/.test(n));
  // 拉丁名字要 ≥4 个字符才比对：3 个字母的「名字」在代码里撞车太狠
  // （实扫过一次：`AM` 命中 34 处，全是 CALLNAME / STREAM 里的子串）
  const latinNames = names.filter((n) => /^[A-Za-z][A-Za-z. ]{3,}$/.test(n));

  const hits = { L1: [], L2: [], L3: [] };
  const files = walk(root).filter(isText);

  for (const file of files) {
    let text;
    try { text = readFileSync(join(root, file), 'utf-8'); } catch { continue; }
    const lines = text.split('\n');

    lines.forEach((line, i) => {
      const at = { file, line: i + 1 };

      // L1
      for (const rule of L1) {
        rule.re.lastIndex = 0;
        let m;
        // eslint-disable-next-line no-cond-assign
        while ((m = rule.re.exec(line))) {
          const hit = m[0];
          if (reviewed.has(hit)) continue;
          if (rule.ok && rule.ok(hit)) continue;
          if (PUBLIC_HOSTS.some((h) => hit.includes(h))) continue;
          hits.L1.push({ ...at, kind: rule.name, hit });
        }
      }

      // L2
      for (const n of cjkNames) {
        if (line.includes(n) && !reviewed.has(n)) hits.L2.push({ ...at, kind: '通讯录里的人名', hit: n });
      }
      for (const n of latinNames) {
        const re = new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
        if (re.test(line) && !reviewed.has(n)) hits.L2.push({ ...at, kind: '通讯录里的人名', hit: n });
      }

      // L3
      // ⚠ 定义这些清单的文件本身当然会命中自己的清单，跳过它，否则每次都要人看一遍噪音。
      if (file === 'scripts/oss-scan.mjs') return;
      for (const cand of new Set(nameCandidates(line))) {
        if (reviewed.has(cand)) continue;
        hits.L3.push({ ...at, kind: '疑似人名（人工确认）', hit: cand });
      }
      for (const w of PROPER_NOUNS) {
        if (line.includes(w) && !reviewed.has(w)) hits.L3.push({ ...at, kind: '专名（人工确认）', hit: w });
      }
    });
  }

  if (!all) {
    // 同一个命中在很多地方出现时，只留前几处——报告要能读完，不然没人看
    for (const k of ['L1', 'L2', 'L3']) hits[k] = dedupe(hits[k]);
  }
  return hits;
}

function dedupe(list, per = 3) {
  const seen = new Map();
  const out = [];
  for (const h of list) {
    const n = (seen.get(h.hit) || 0) + 1;
    seen.set(h.hit, n);
    if (n <= per) out.push(h);
    else if (n === per + 1) out.push({ ...h, more: true });
  }
  return out;
}

function report(hits) {
  const say = (title, list) => {
    if (!list.length) { console.log(`${title}：干净`); return; }
    console.log(`${title}：${list.length} 处`);
    for (const h of list) {
      if (h.more) { console.log(`    …「${h.hit}」还有更多，用 --all 看全部`); continue; }
      console.log(`  ${h.file}:${h.line}  [${h.kind}] ${h.hit}`);
    }
  };
  say('L1 结构化（命中即挡）', hits.L1);
  say('L2 通讯录人名（命中即挡）', hits.L2);
  say('L3 中文兜底（人工确认）', hits.L3);
}

// ---------- 入口 ----------

export { scan };

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const argv = process.argv.slice(2);
  const arg = (k, d = '') => {
    const i = argv.indexOf(k);
    return i === -1 ? d : (argv[i + 1] || '');
  };
  const hits = scan({
    root: arg('--root', REPO),
    namesFile: arg('--names', ''),
    all: argv.includes('--all'),
  });
  report(hits);
  const blocked = hits.L1.length + hits.L2.length;
  if (blocked) {
    console.log('');
    console.log('✗ 挡住了：上面 L1/L2 的每一条都要么改掉，要么确认无害后写进 PUBLISH.reviewed（带理由）。');
    process.exit(1);
  }
  if (hits.L3.length) {
    console.log('');
    console.log('⚠ L1/L2 干净。L3 那些要你自己看一眼：确认无害就写进 PUBLISH.reviewed，下次不再问。');
    process.exit(2);
  }
  console.log('');
  console.log('✓ 三层都干净。');
}
