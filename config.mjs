// mailroom 配置层：把「谁在用这套东西」从代码里摘出来。
//
// 为什么放仓库外（默认 ~/.mailroom/config.json）：
//   ① 拉上游代码永远不会跟你的身份/邮箱冲突；
//   ② 克隆这个仓库的人**物理上没法**把自己的账号信息提交上去。
//
// ⚠⚠ 跟 lib.mjs 的 dailymdRoot()/stateDir() 同一条铁律：**导出的是函数不是常量**。
//   常量在模块加载那一刻定死，同一个进程里跑第二份测试文件时会复用第一份的值，
//   隔离形同虚设。缓存按「解析出来的配置文件路径」做 key——测试换 MAILROOM_STATE
//   就自动换 key，不需要谁记得调 reset。

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { stateDir } from './paths.mjs';

const REPO = dirname(fileURLToPath(import.meta.url));

// 内置默认值。**只放对谁都成立的东西**——凡是「Andy 的」都不许出现在这里，
// 缺了就降级（见 README 的降级矩阵），不许拿某个人的值当兜底。
export const DEFAULTS = {
  identity: {
    name: '',          // 本名（明道云上那个名字）；HAP 配好时 setup 会自动填
    callName: '',      // 对外自称、别人叫你的那个名字
    selfTerms: null,   // 正文里不许出现的第三人称自称；null = 用 [callName, name]
    // ⚠ 开头那个 emoji 是给收件人的记号：一眼分得清这段是机器代发的。
    agentDeclaration: '以上内容由 {callName} 的 AI Agent 辅助完成，已经过 {callName} 本人审核。',
  },
  hap: { enabled: false, accountId: '', bin: null, webBase: '' },
  mail: { enabled: false, internalDomains: [], accounts: [] },
  knowledgeBase: {
    root: null,                              // null = lib.mjs 的 dailymdRoot() 兜底
    fallbackProject: 'P00-misc',
    contactsFile: 'contactmd/contacts.json',
  },
  policy: {
    autoMaxChars: 60,
    autoWindowHours: 24,
    autoMaxPerWindow: 2,
    workHours: { days: [1, 2, 3, 4, 5], start: 9, end: 19 },
  },
  topology: { primaryHost: null, primaryHostSsh: null, unlockKeychainItem: null },
  credentials: { backend: 'keychain' },
  runner: { command: null },
};

// 配置文件在哪。顺序是死的：显式指定 > 状态目录 > 仓库内逃生口。
export function configPath() {
  if (process.env.MAILROOM_CONFIG) return process.env.MAILROOM_CONFIG;
  const inState = join(stateDir(), 'config.json');
  if (existsSync(inState)) return inState;
  const local = join(REPO, 'config.local.json');
  if (existsSync(local)) return local;
  return inState; // 不存在也返回它——setup 往这儿写，报错信息也指这儿
}

const cache = new Map(); // path -> { cfg, errors }

// 只合并对象，数组一律整体替换。
// ⚠ 数组不能合并：internalDomains 或 accounts 要是跟默认值拼起来，
//   用户「删掉一个内部域名」这个动作就永远生效不了。
function merge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!over || typeof over !== 'object' || Array.isArray(over)) return out;
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v)
        && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = merge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

// 自查里跑、又没显式指定配置位置 = 一个字都不许从磁盘读。
// ⚠ 跟 lib.mjs 的 logToDisk() 同一条理由：靠「每份测试都记得指定」的兜底不叫兜底。
//   没这道门，一份忘了调 tmpState() 的测试就会读到本机真实的身份和邮箱配置，
//   跑出依赖本机环境的结果（更糟：把真实 accountId 带进断言）。
function sandboxed() {
  const inTest = Boolean(process.env.NODE_TEST_CONTEXT) || process.env.MAILROOM_TEST === '1';
  return inTest && !process.env.MAILROOM_CONFIG && !process.env.MAILROOM_STATE;
}

function load() {
  const p = configPath();
  if (sandboxed()) return { cfg: merge(DEFAULTS, {}), errors: [] };
  if (cache.has(p)) return cache.get(p);
  const errors = [];
  let raw = null;
  if (existsSync(p)) {
    try {
      raw = JSON.parse(readFileSync(p, 'utf-8'));
    } catch (e) {
      errors.push(`配置文件读不了：${p}（${e.message}）。它必须是合法 JSON——多半是多了个逗号或少了个引号。`);
    }
  }
  const cfg = merge(DEFAULTS, raw || {});
  errors.push(...validate(cfg, p, raw !== null));
  const entry = { cfg, errors };
  cache.set(p, entry);
  return entry;
}

// 校验只挑「配了但配错」的，**不报「没配」**——没配是合法状态，走降级。
function validate(cfg, p, exists) {
  const errs = [];
  if (!exists) return errs;
  const id = cfg.identity || {};
  if (id.callName && String(id.callName).length > 24) {
    errs.push('identity.callName 太长了（超过 24 字）。这个名字会被拼进身份声明的正则，太长会让判据失准。');
  }
  if (id.selfTerms != null && !Array.isArray(id.selfTerms)) {
    errs.push('identity.selfTerms 必须是数组，比如 ["小明","王小明"]。');
  }
  if (cfg.hap?.enabled && !cfg.hap.accountId) {
    errs.push('hap.enabled 是 true 但没有 hap.accountId。跑 mailroom setup 让它从 hap auth whoami 抓，或手填。');
  }
  const accts = cfg.mail?.accounts;
  if (accts != null && !Array.isArray(accts)) {
    errs.push('mail.accounts 必须是数组。');
  } else if (Array.isArray(accts)) {
    const seen = new Set();
    accts.forEach((a, i) => {
      const at = `mail.accounts[${i}]`;
      if (!a || typeof a !== 'object') { errs.push(`${at} 不是一个对象。`); return; }
      if (!a.id) errs.push(`${at} 缺 id（钥匙串条目名要用它，同一台机器上不能重名）。`);
      else if (seen.has(a.id)) errs.push(`${at}.id「${a.id}」重复了。`);
      else seen.add(a.id);
      if (!a.address) errs.push(`${at} 缺 address（邮箱地址）。`);
      if (!['graph', 'imap'].includes(a.transport)) {
        errs.push(`${at}.transport 只能是 "imap"（任何邮箱都行）或 "graph"（Microsoft 365）。`);
      }
      if (a.transport === 'imap' && !a.imap?.host) errs.push(`${at} 走 imap 就必须有 imap.host。`);
      if (a.transport === 'imap' && !a.smtp?.host) errs.push(`${at} 走 imap 就必须有 smtp.host（发信要用）。`);
      // ⚠ graph.clientId **不是**必填：走 `mailroom mail-bootstrap` 借来的令牌里本来就带着
      //   clientId（存在钥匙串那份 JSON 里），配置里不会有。只有走设备码登录才需要它，
      //   那条路自己会在缺的时候报错并指路。在这里当成必填 = 借令牌那条路永远过不了自检。
    });
  }
  const wh = cfg.policy?.workHours;
  if (wh && (!Array.isArray(wh.days) || !wh.days.length)) {
    errs.push('policy.workHours.days 得是星期几的数组，0=周日。想全天候发就把 policy.workHours 整个删掉。');
  }
  if (cfg.runner?.command != null && !Array.isArray(cfg.runner.command)) {
    errs.push('runner.command 必须是数组，比如 ["claude","-p"] 或 ["codex","exec"]。');
  }
  void p;
  return errs;
}

export function config() { return load().cfg; }

// 人话错误列表。**永远不抛**——每个入口自己决定是打出来退出还是继续。
export function configErrors() { return load().errors; }

export function configExists() { return existsSync(configPath()); }

// 哪些消息来源是活的。两个都 false 是合法状态（新克隆还没配），不是错误。
export function sources() {
  const c = config();
  return {
    hap: Boolean(c.hap?.enabled && c.hap.accountId),
    mail: Boolean(c.mail?.enabled && Array.isArray(c.mail.accounts) && c.mail.accounts.length),
  };
}

// 身份。callName 空 = 身份声明门和自称门都关（见 lib.mjs），且 🟢 自动发整档禁用。
export function identity() {
  const id = config().identity || {};
  const callName = String(id.callName || '').trim();
  const name = String(id.name || '').trim();
  const terms = Array.isArray(id.selfTerms) ? id.selfTerms : [callName, name];
  return {
    name,
    callName,
    selfTerms: [...new Set(terms.map((s) => String(s || '').trim()).filter(Boolean))],
    declarationTemplate: String(id.agentDeclaration || DEFAULTS.identity.agentDeclaration),
  };
}

export function policy() { return config().policy || DEFAULTS.policy; }
export function topology() { return config().topology || DEFAULTS.topology; }

export function knowledgeBase() {
  const kb = config().knowledgeBase || {};
  const root = kb.root ? String(kb.root).replace(/^~(?=\/|$)/, homedir()) : null;
  return {
    root,
    fallbackProject: kb.fallbackProject || DEFAULTS.knowledgeBase.fallbackProject,
    contactsFile: kb.contactsFile || DEFAULTS.knowledgeBase.contactsFile,
  };
}

// 测试用。正常代码路径不需要——换 MAILROOM_STATE / MAILROOM_CONFIG 就自动换 key。
export function resetConfigCache() { cache.clear(); }
