#!/usr/bin/env node
// `mailroom setup` —— 把「只配两样」这句承诺兑现的地方：一遍问下来，配好明道云和邮箱。
//
// 设计约束（都不是随口定的）：
//   · **只写一个文件**：<状态目录>/config.json。绝不动知识库，绝不动仓库里的代码。
//   · **凭据不经过这里**：授权码/密码一律打印一条 `security add-generic-password` 让用户
//     自己去跑。让它进这个进程 = 进 argv、进日志、进终端回滚，全是撤不回的地方。
//   · **HAP 和邮箱互相独立**：只配一样也要能跑完（组织没开 CLI 开关的人只能走邮箱，
//     没有 365/企业邮箱的人只能走明道云）。这条由 config.mjs 的降级矩阵兜着。
//   · **🟢 自动发默认关**。替你说话的工具，默认就该是问过你才发。
//
// 非交互模式给测试用：--non-interactive --config <json 文件>，一句都不问，直接写盘。

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stateDir } from '../paths.mjs';
import { DEFAULTS, configPath } from '../config.mjs';
import { BIN } from '../lib.mjs';

// ---------- 小工具 ----------

const out = (...a) => console.log(...a);
const hr = () => out('');

function parseArgs(argv) {
  const a = { interactive: true, config: '', skipHap: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--non-interactive') a.interactive = false;
    else if (v === '--config') a.config = argv[++i] || '';
    else if (v === '--skip-hap') a.skipHap = true;
  }
  return a;
}

// 深合并，数组整体替换（跟 config.mjs 的 merge 同一套规矩，理由见那边注释）
function merge(base, over) {
  const o = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)
        && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) o[k] = merge(base[k], v);
    else if (v !== undefined) o[k] = v;
  }
  return o;
}

// 常见邮箱域名的 IMAP/SMTP 猜测。**只是省几次打字，猜错了用户能改**，
// 所以宁可少收几条，也别塞一堆不确定的进来。
const MX_HINTS = [
  [/(^|\.)qq\.com$/, 'imap.exmail.qq.com', 'smtp.exmail.qq.com'],
  [/(^|\.)163\.com$/, 'imap.qiye.163.com', 'smtp.qiye.163.com'],
  [/(^|\.)126\.com$/, 'imap.126.com', 'smtp.126.com'],
  [/(^|\.)gmail\.com$/, 'imap.gmail.com', 'smtp.gmail.com'],
  [/(^|\.)(outlook|hotmail|live)\.com$/, 'outlook.office365.com', 'smtp.office365.com'],
  [/(^|\.)zoho\.com$/, 'imap.zoho.com', 'smtp.zoho.com'],
  [/(^|\.)feishu\.cn$/, 'imap.feishu.cn', 'smtp.feishu.cn'],
];

function guessHosts(address) {
  const domain = String(address || '').split('@')[1] || '';
  for (const [re, imap, smtp] of MX_HINTS) if (re.test(domain)) return { imap, smtp };
  return { imap: `imap.${domain}`, smtp: `smtp.${domain}` };
}

// ---------- 第 0 步：不提问的自检 ----------

function preflight() {
  const problems = [];
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) problems.push(`node 版本太老（${process.versions.node}），要 18 以上（内置 fetch 从那一版才有）。`);
  let backend = 'keychain';
  try {
    execFileSync('security', ['-h'], { stdio: 'ignore' });
  } catch {
    backend = 'file';
    problems.push('这台机器没有 macOS 的 security 命令，凭据存不进钥匙串。'
      + '暂时只能把它们放进文件里，注意自己保管好权限。');
  }
  return { problems, backend };
}

// 知识库像不像那么回事。⚠ 只看结构，不改它一个字。
function looksLikeKb(root) {
  return existsSync(join(root, 'projects')) && existsSync(join(root, 'assets', 'codes.md'));
}

// ---------- HAP ----------

function hapWhoami() {
  try {
    const raw = execFileSync(BIN.hap, ['--json', 'auth', 'whoami'], { encoding: 'utf-8', timeout: 25000 });
    const d = JSON.parse(raw);
    const u = d.data || d.user || d;
    return { ok: true, accountId: u.accountId || u.account_id || '', name: u.fullname || u.name || '' };
  } catch (e) {
    const msg = `${e.stdout || ''}${e.stderr || ''}${e.message || ''}`;
    if (/ENOENT|not found/i.test(msg)) {
      return { ok: false, why: 'missing',
        say: 'hap 不在 PATH 里。装：pip install hap-cli\n'
          + '  装完还找不到的话，pip 装出来的路径带 Python 版本号（~/Library/Python/3.x/bin），\n'
          + '  把它加进 PATH，或者在 config.json 的 hap.bin 里写绝对路径。' };
    }
    if (/401|not logged in|未登录/i.test(msg)) {
      return { ok: false, why: 'auth',
        say: 'hap 还没登录。跑一次：hap auth login <你的组织>\n  登完再跑 mailroom setup。' };
    }
    if (/403|CLI access|禁用|未开启/i.test(msg)) {
      return { ok: false, why: 'cli-off',
        say: '你的组织没开 CLI 访问。这不是你能自己修的：\n'
          + '  找 HAP 管理员在「组织管理 → 安全 → 数据与访问 → CLI 访问策略」里放开，\n'
          + '  或者跳过明道云只用邮箱（mailroom setup --skip-hap）。' };
    }
    return { ok: false, why: 'unknown', say: `hap 跑不通：${msg.slice(0, 200)}` };
  }
}

// ---------- 写盘 ----------

function writeConfig(cfg, file) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
  return file;
}

// ---------- 主流程 ----------

export async function runSetup(argv = [], io = {}) {
  const args = parseArgs(argv);
  const target = process.env.MAILROOM_CONFIG || join(stateDir(), 'config.json');

  // 非交互：拿给定的 JSON 直接合进默认值写盘。测试和无人值守用。
  if (!args.interactive) {
    const given = args.config ? JSON.parse(readFileSync(args.config, 'utf-8')) : {};
    const cfg = merge(DEFAULTS, given);
    writeConfig(cfg, target);
    out(`已写入 ${target}`);
    return { ok: true, file: target, cfg };
  }

  const rl = io.rl || createInterface({ input: stdin, output: stdout });
  const ask = async (q, dflt = '') => {
    const a = (await rl.question(dflt ? `${q}（回车用 ${dflt}）` : q)).trim();
    return a || dflt;
  };
  const yes = async (q, dflt = true) => {
    const a = (await rl.question(`${q} ${dflt ? '[Y/n] ' : '[y/N] '}`)).trim().toLowerCase();
    if (!a) return dflt;
    return a === 'y' || a === 'yes' || a === '是';
  };

  try {
    const pre = preflight();
    out('mailroom 配置向导');
    out('会问你几个问题，最后只写一个文件：' + target);
    out('凭据一律让你自己敲命令存进钥匙串，不经过我这儿。');
    for (const p of pre.problems) out(`⚠ ${p}`);
    hr();

    // 已经配过就先问一句，别默默盖掉
    const existing = existsSync(target) ? JSON.parse(readFileSync(target, 'utf-8')) : null;
    if (existing && !(await yes('已经有一份配置了，要重新配一遍吗？（不会动你的钥匙串）', false))) {
      out('那就不动它。想改哪一项直接编辑：' + target);
      return { ok: true, file: target, cfg: existing, skipped: true };
    }

    const cfg = merge(DEFAULTS, existing || {});
    cfg.credentials = { backend: pre.backend };

    // ---- 1. 身份 ----
    // ⚠ 这一问不是走过场：callName 空着会连锁关掉三样东西（身份声明门、自称门、
    //   🟢 自动发），而 AI 读 skill 时也没法称呼你，只能干巴巴地说「用户」。
    out('① 你怎么称呼自己');
    out('   两个地方会用到：');
    out('   · 替你回消息时开头那句声明 ——「我是 X 的 AI Agent，以下内容已经过 X 本人审核」');
    out('   · AI 跟你说话时怎么叫你');
    out('   ⚠ 留空 = 没有身份声明，🟢 自动回复会被直接关死（不能既替你说话又不表明身份）。');
    const callName = await ask('   叫你什么？', cfg.identity.callName || '');
    cfg.identity.callName = callName;
    if (!callName) out('   留空了 —— 🟢 自动回复这一档会关着，每条都要你点头。');
    hr();

    // ---- 2. 明道云 ----
    let hapName = '';
    if (!args.skipHap && await yes('② 要接明道云 / HAP 吗？', false)) {
      const r = hapWhoami();
      if (r.ok) {
        cfg.hap.enabled = true;
        cfg.hap.accountId = r.accountId;
        hapName = r.name || '';
        out(`   ✓ 已登录：${hapName || '(没读到名字)'}`);
        const web = await ask('   动态网页地址前缀（私有部署填自己的）：', 'https://www.mingdao.com');
        cfg.hap.webBase = web;
      } else {
        out(`   ✗ ${r.say}`);
        out('   先跳过，明道云这一路不启用。修好之后重跑 mailroom setup 就行。');
        cfg.hap.enabled = false;
      }
    } else {
      cfg.hap.enabled = false;
    }
    cfg.identity.name = cfg.identity.name || hapName || callName;
    cfg.identity.selfTerms = [...new Set([cfg.identity.callName, cfg.identity.name].filter(Boolean))];
    hr();

    // ---- 3. 邮箱 ----
    const accounts = [];
    if (await yes('③ 要接邮箱吗？', true)) {
      const domains = (await ask('   哪些域名算「自己人」（逗号分隔，只要收件人里有一个不在清单里，回信就只存草稿不直发）：', ''))
        .split(/[,，\s]+/).filter(Boolean);
      cfg.mail.internalDomains = domains;

      for (let n = 1; ; n++) {
        out(`   第 ${n} 个邮箱：`);
        out('     1) IMAP/SMTP —— 任何邮箱都行，最省事，推荐');
        out('     2) Microsoft 365 —— 走 Graph，要自己在 Azure 注册一个应用');
        const kind = await ask('     选哪条？', '1');
        const address = await ask('     邮箱地址：', '');
        if (!address) { out('     没填地址，跳过。'); break; }
        const id = await ask('     给它起个短代号（钥匙串条目名要用，只能是字母数字）：', address.split('@')[0]);
        const keychainService = `mailroom-${id}`;
        const acc = { id, address, label: id, keychainService };

        if (kind === '2') {
          acc.transport = 'graph';
          out('     去 Azure 拿应用 ID（一次性）：');
          out('       Entra ID → 应用注册 → 新注册 → 选「公共客户端/本机应用」');
          out('       → 认证页把「允许公共客户端流」设为「是」');
          out('       → API 权限加 Mail.ReadWrite、Mail.Send、offline_access');
          acc.graph = {
            clientId: await ask('     应用（客户端）ID：', ''),
            tenant: await ask('     租户 ID：', 'common'),
          };
          out('     配好之后跑一次：mailroom mail-login ' + id);
        } else {
          acc.transport = 'imap';
          const g = guessHosts(address);
          acc.imap = { host: await ask('     IMAP 服务器：', g.imap), port: 993 };
          acc.smtp = { host: await ask('     SMTP 服务器：', g.smtp), port: 465, ssl: true };
          out('     授权码存进钥匙串（⚠ 企业邮箱要的多半是「客户端授权码」，不是登录密码，');
          out('      去邮箱后台生成一个，同时确认 IMAP/SMTP 服务已开启）。这条命令你自己跑：');
          out(`       security add-generic-password -U -s ${keychainService} -a ${address} -w '<客户端授权码>'`);
        }
        accounts.push(acc);
        if (!(await yes('     还有别的邮箱吗？', false))) break;
      }
      cfg.mail.enabled = accounts.length > 0;
      cfg.mail.accounts = accounts;
    } else {
      cfg.mail.enabled = false;
      cfg.mail.accounts = [];
    }
    hr();

    // ---- 4. 知识库 ----
    out('④ 消息判完落在哪个知识库');
    let root = await ask('   知识库目录：', cfg.knowledgeBase.root || join(process.env.HOME || '', 'coding/workmd'));
    root = root.replace(/^~(?=\/|$)/, process.env.HOME || '');
    if (!looksLikeKb(root)) {
      out('   ⚠ 这个目录看着不像知识库（没有 projects/ 和 assets/codes.md）。');
      out('     还没有的话先建一个：git clone https://github.com/andyleimc-source/workmd.git');
      out('     路径先这么记着，等你建好了它自然就对了。');
    }
    cfg.knowledgeBase.root = root;
    hr();

    // ---- 5. 策略 ----
    out('⑤ 什么时候可以替你发消息');
    if (!(await yes('   只在工作日 09:00–19:00 发？', true))) delete cfg.policy.workHours;
    if (await yes('   开启 🟢 自动回复（纯回执这类，不问你直接发）？', false)) {
      out(`   笼子：单条不超过 ${cfg.policy.autoMaxChars} 字，同一个人 ${cfg.policy.autoWindowHours} 小时内最多 ${cfg.policy.autoMaxPerWindow} 条。`);
      out('   想改就去 config.json 的 policy 里改 —— 改大 = 放宽「什么情况下可以不问你就发」。');
    } else {
      cfg.policy.autoMaxPerWindow = 0;   // 0 = 一条都不许自动发
      out('   已关掉。以后想开，把 policy.autoMaxPerWindow 改回 2。');
    }
    hr();

    writeConfig(cfg, target);
    out(`✓ 写好了：${target}`);
    out('接下来跑一次自检：mailroom doctor');
    return { ok: true, file: target, cfg };
  } finally {
    if (!io.rl) rl.close();
  }
}

// ⚠ 入口守卫：没有它，别的模块 import 这个文件就会当场跑起来问问题。
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  runSetup(process.argv.slice(2)).catch((e) => {
    console.error(`配置向导没走完：${e.message}`);
    console.error(`你也可以直接编辑 ${configPath()}，格式看仓库里的 config.example.json。`);
    process.exit(1);
  });
}
