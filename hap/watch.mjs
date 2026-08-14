#!/usr/bin/env node
// hap-watch — 拉一次 hap 消息，只报「上次之后新出现的」。
//
// 数据源是 `hap chat list`：一次就覆盖 1对1、群聊、和通知收件箱
// （post / workflow / task / calendar / kc / hr / app / system 各类各占一条），
// 每条给出该会话的最新一句。比逐个 category 拉 messages 便宜得多，
// 而「对方回没回」只需要知道最新一句变了没有。
//
// 用法：
//   node watch.mjs --state <名字> [--who 张三,李四] [--keyword 发版,上线] [--wide] [--limit 40]
//
// 退出码：0 = 有新内容（已打印）；3 = 无新内容；1 = 出错（含 hap 未登录）。
// 用退出码而不是解析文本，是为了让调用方一眼判断要不要往下走。

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, def = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(`--${name}`);

const stateName = arg('state');
if (!stateName) {
  console.error('用法: node watch.mjs --state <名字> [--who A,B] [--keyword X,Y] [--wide] [--limit 40]');
  process.exit(1);
}
const who = arg('who').split(',').map((s) => s.trim()).filter(Boolean);
const keywords = arg('keyword').split(',').map((s) => s.trim()).filter(Boolean);
const wide = flag('wide');
const limit = Number(arg('limit', '40')) || 40;

const stateDir = join(homedir(), '.hap-watch');
const stateFile = join(stateDir, `${stateName}.json`);

function hapJson(args) {
  const out = execFileSync('hap', ['--json', ...args], {
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(out);
}

let sessions;
try {
  sessions = hapJson(['chat', 'list', '-n', String(limit)]);
} catch (e) {
  const msg = String(e.stderr || e.stdout || e.message);
  if (/not logged in|token is missing|invalid, or expired/i.test(msg)) {
    console.error('hap 未登录。跑一次：hap auth login');
  } else {
    console.error('hap chat list 失败：', msg.slice(0, 500));
  }
  process.exit(1);
}
if (!Array.isArray(sessions)) sessions = [];

// 会话身份用 value（会话/群/收件箱的 id），变化检测用「最新一句的时间戳」。
//
// ⚠⚠ who 和 sender 是两回事，别只报 who。群会话的 `s.name` 是**群名**，压过了
//   `s.from.name`（真正说话的那个人），所以老代码打出来是「群名｜正文」——
//   谁说的整个丢了。真出过事：群里某人说的一句话，AI 只看到群名，顺着上文猜成了
//   另一个人，还据此戴给了别的会话。
//   单聊 s.name 本来就是人名，两者相同时不重复打。
const items = sessions.map((s) => ({
  key: String(s.value ?? ''),
  who: s.name || (s.from && s.from.name) || s.category || s.value || '',
  sender: (s.from && s.from.name) || '',
  category: s.category || '',
  time: s.time || '',
  unread: Number(s.unread || 0),
  text: (s.msg && s.msg.con) || '',
}));

// 「群名 · 发言人」这种标签；单聊/没有发言人信息时退回 who。
const label = (it) => (it.sender && it.sender !== it.who ? `${it.who} · ${it.sender}` : it.who);

let prev = {};
if (existsSync(stateFile)) {
  try {
    prev = JSON.parse(readFileSync(stateFile, 'utf-8')).seen || {};
  } catch {
    prev = {};
  }
}
const first = Object.keys(prev).length === 0;

const fresh = items.filter((it) => it.key && it.time && prev[it.key] !== it.time);

const seen = {};
for (const it of items) if (it.key) seen[it.key] = it.time;
mkdirSync(stateDir, { recursive: true });
writeFileSync(stateFile, JSON.stringify({ updated: new Date().toISOString(), seen }, null, 2)); // utc-ok: state file timestamp

// 首次运行只建基线，不把整个收件箱当成「新消息」倒出来。
if (first) {
  console.log(`已建立基线：${items.length} 个会话，本次不报新消息。`);
  process.exit(3);
}

const matched = fresh.filter((it) => {
  if (!who.length && !keywords.length) return true;
  // hay 里带上 sender，`--who <某人>` 才能命中他在群里说的话（群会话的 who 是群名）。
  const hay = `${it.who} ${it.sender} ${it.text}`;
  const okWho = who.length ? who.some((w) => hay.includes(w)) : true;
  const okKw = keywords.length ? keywords.some((k) => hay.includes(k)) : true;
  // 两个筛子都给了就取交集：盯某人说了某话。
  return okWho && okKw;
});

if (wide) {
  const byCat = {};
  for (const it of fresh) byCat[it.category || '其他'] = (byCat[it.category || '其他'] || 0) + 1;
  const parts = Object.entries(byCat).map(([c, n]) => `${c} ${n}`);
  console.log(fresh.length ? `新动静：${parts.join('、')}` : '无新动静');
  if (matched.length) {
    console.log('其中命中筛选：');
    for (const it of matched) console.log(`  [${it.time}] ${label(it)}｜${it.text.slice(0, 160)}`);
  }
  process.exit(fresh.length ? 0 : 3);
}

if (!matched.length) process.exit(3);
for (const it of matched) {
  console.log(`[${it.time}] ${label(it)}（${it.category || '会话'}）`);
  console.log(`  ${it.text.slice(0, 400)}`);
}
process.exit(0);
