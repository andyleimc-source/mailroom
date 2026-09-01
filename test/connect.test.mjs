// 明道云取数与适配器：四条安全边界（简报里点名的）+ 一些真跑编排逻辑的功能测试。
//
// ⚠ 保险丝：任何没被 io 注入顶掉的 hap() 调用（比如 fetch.mjs 里 fetchFreshMessages /
//   fetchPostInbox 内部直接调用真实 hap()，这两个不像 `chat list` 走的是 pull() 里
//   可注入的 `call`）都不许打到真的明道云——顶成一个只回空 JSON 的假二进制。
//   这是最后一道保险，独立于下面每条测试各自的 io.hap/io.runWatch 注入。
//   （hap-desk 的 README 记过这个坑：`hap chat send-to-one` 对任何 accountId 都回
//   `Message sent.`，跑一次 `node --test` 就可能真的往明道云发一条消息。）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpState } from './helpers.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HERE = dirname(fileURLToPath(import.meta.url));

// ⚠ pull() 里的 log() 会写 ~/.mailroom/mailroom.log——必须先把状态目录顶成临时目录，
//   否则这份测试日志会真的写进 小明 的 ~/.mailroom（不是数据错误，但仍然是「碰了真实状态目录」，
//   规矩不许）。整份文件共用一个临时状态目录即可，不用每条测试各自 tmpState/cleanup。
tmpState();

const FAKE_BIN_DIR = mkdtempSync(join(tmpdir(), 'mailroom-fakehap-'));
const FAKE_HAP = join(FAKE_BIN_DIR, 'hap');
writeFileSync(FAKE_HAP, [
  '#!/bin/sh',
  'for a in "$@"; do if [ "$a" = "--json" ]; then echo "{}"; exit 0; fi; done',
  'echo ok',
].join('\n'), { mode: 0o755 });
process.env.MAILROOM_HAP_BIN = FAKE_HAP;
// ⚠ lib.mjs 的 assertNoRealIO 默认在 `node --test` 里禁掉一切真 hap / 真 claude 调用
//   （堵「测试忘了注入假适配器」那一类）。**这一份文件是例外**：上面那个假二进制就是
//   它的保险丝，`fetchFreshMessages` 那条路要真的走一遍 execFileSync 才测得到
//   「那句调用本身写没写对」。不放开的话 hap() 当场抛错，规范化那段一步都跑不到。
//   ⚠ 放开只在这个子进程里生效，别把它抄到别的测试文件去。
process.env.MAILROOM_ALLOW_REAL_IO = '1';

// grep 型断言要先把注释剥掉——否则一句「⚠ 别在这儿调 sendVia」的注释
// 就会把它自己判成违规。
const codeOf = (file) => readFileSync(file, 'utf-8')
  .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

function walkMjs(dir, skipDirs) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) {
      if (skipDirs.includes(e.name)) continue;
      out.push(...walkMjs(join(dir, e.name), skipDirs));
      continue;
    }
    if (e.name.endsWith('.mjs')) out.push(join(dir, e.name));
  }
  return out;
}

// ---------- 简报要求的四条安全边界 ----------

test('① 除了 send.mjs 和 connect/* 没有别的文件调 sendVia', () => {
  // ⚠ send.mjs 是 Task 8 才建的文件，眼下还不存在——白名单先把它放进去，
  //   等 Task 8 建了这条测试自然对得上，不用回头再改。
  const bad = [];
  for (const f of walkMjs(ROOT, ['test', 'web', 'launchd'])) {
    // ⚠ 白名单只放**根目录那一个** send.mjs。原来写的是 `endsWith('/send.mjs')`，
    //   顺带把 `bin/send.mjs`（命令行入口、全库唯一设 MAILROOM_ROLE 的地方）也豁免了——
    //   于是这条「谁可以调传输层」的红线对那个文件等于不存在，它恰恰是最该盯的一个。
    if (f === join(ROOT, 'send.mjs')) continue;
    if (f.includes(`${ROOT.replace(/\/$/, '')}/connect/`) || f.includes('/connect/')) continue;
    if (/\bsendVia\b/.test(codeOf(f))) bad.push(f.slice(ROOT.length));
  }
  assert.deepEqual(bad, [], `这些文件绕过 send.mjs 直接调了传输层：${bad.join(', ')}`);
});

test('② 适配器里没有 enforceAgentPrefix —— 闸只有一处', () => {
  for (const f of ['connect/hap.mjs', 'connect/index.mjs', 'connect/mail.mjs']) {
    assert.doesNotMatch(codeOf(join(ROOT, f)), /enforceAgentPrefix/,
      `⚠ ${f} 里出现了 enforceAgentPrefix：两处都补身份声明的话会出现两句，且各自以为另一处管了`);
  }
});

test('③ run.mjs 不许 import send.mjs（run.mjs 是 Task 7 才建，容忍它还不存在）', () => {
  const pollFile = join(ROOT, 'run.mjs');
  if (!existsSync(pollFile)) return; // Task 7 之前这条测试视为通过，不许红在这上面
  const src = readFileSync(pollFile, 'utf-8');
  assert.ok(!/from '\.\/send\.mjs'/.test(src), 'run.mjs 不许 import send.mjs');
});

test('④ pull 遇到 401 把 authError 报上去，不换通道', async () => {
  const { pull } = await import('../connect/hap.mjs');
  let hapCalls = 0;
  const r = pull({
    prevSeen: { s1: '旧时间' },
    io: {
      runWatch: () => ({ code: 1, out: '', err: 'token is missing, invalid, or expired' }),
      hap: () => { hapCalls++; return []; },
    },
  });
  assert.ok(r.authError, '要把 401 报上去，让上层去 Bark 喊人');
  assert.match(String(r.authError), /token/i);
  assert.equal(r.candidates.length, 0);
  assert.equal(hapCalls, 0, '401 之后不许再打任何一趟 hap，更不许换通道兜底');
});

// ---------- 全仓库的两条卫生条款 ----------

// ⚠ 2026-08-13 终审逮到的：`bin/send.mjs` 里真的有一个裸 NUL 字节（两步确认码那句
//   `\n\x00file:…` 的分隔符，当年被原样敲进去了）。后果不是运行时——运行时那个字符串
//   一模一样——而是 **grep 会把整个文件当二进制，静默一行都不返回**。而这个文件正是
//   全库唯一的发送出口，「人工去 grep 一下确认没有第二条路」是这里的常规排查手段，
//   排查工具当场被骗，还不报错。所以这条盯的是全仓库，不是单个文件。
test('⑤ 源码里不许有裸 NUL 字节（会让 grep 把文件当二进制、静默返回空）', () => {
  const bad = [];
  for (const f of walkMjs(ROOT, ['node_modules'])) {
    if (readFileSync(f).includes(0)) bad.push(f.slice(ROOT.length));
  }
  assert.deepEqual(bad, [], `这些文件里有裸 NUL 字节，grep 它们会静默返回空：${bad.join(', ')}\n`
    + '要表达 NUL 请写转义 `\\x00`，运行时字符串完全一样。');
});

// ⚠ run-tests.sh 头上第 3 条保证「所有测试用临时的假 ~/.mailroom，不碰真库」。
//   这条保证一度是假的：只对记得调 tmpState() 的测试成立，inboxmd / timestamps 那两份
//   按设计不碰状态目录，healTimestamps 的自愈告警就从落盘门口漏进了 小明 真实的
//   mailroom.log（2026-08-13 发现已积 656 行）。日志是事后排查唯一的现场。
//   现在 lib.mjs 的 log() 自己认：在自查里且没显式指定 MAILROOM_STATE = 一个字都不落盘。
test('⑥ 测试里没指定 MAILROOM_STATE 时，log() 不许碰真实 ~/.mailroom', () => {
  const home = mkdtempSync(join(tmpdir(), 'mailroom-fakehome-'));
  const env = { ...process.env, HOME: home, MAILROOM_TEST: '1' };
  delete env.MAILROOM_STATE;
  const r = spawnSync(process.execPath, [
    '-e', `import('${join(ROOT, 'lib.mjs')}').then((m) => m.log('这行不许落盘'))`,
  ], { env, encoding: 'utf-8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /这行不许落盘/, 'stderr 那一路照旧要有，测试还得看得见输出');
  assert.equal(existsSync(join(home, '.mailroom', 'mailroom.log')), false,
    '⚠ 测试往真实 ~/.mailroom/mailroom.log 写了日志——排查现场会被测试噪音污染');
});

// ---------- 编排逻辑真跑：不把整个 pull 注入掉 ----------
// README 那条坑：「测试注入了假的外部调用，就测不到那句调用本身写错了」。

test('真的没新动静：照自己的水位线核过一遍，再报 noNews', async () => {
  const { pull } = await import('../connect/hap.mjs');
  const r = pull({
    prevSeen: { s1: '旧时间' },
    io: {
      runWatch: () => ({ code: 3, out: '', err: '' }),
      hap: () => [{ value: 's1', time: '旧时间', category: 'user', name: '李雷' }],
    },
  });
  assert.equal(r.noNews, true);
  assert.equal(r.candidates.length, 0);
});

test('⚠ watch 说没新动静、但我们自己的水位线说有：照收不误', async () => {
  // ⚠⚠ 2026-08-13 事故：`~/.hap-watch/mailroom.json` 是全局共享的，别的进程跑一次
  //   watch.mjs 就把「有新消息」这个标记消费掉了，watch 于是给我们退 3。老代码直接信它，
  //   某同事 17:36 回的那条私信连着两轮报「无新动静」，人问起来才发现——而那是一条在等的回复。
  //   现在退出码只当提示，判据是**我们自己记的**水位线。
  const { pull } = await import('../connect/hap.mjs');
  const r = pull({
    prevSeen: { s1: '旧时间' },
    io: {
      runWatch: () => ({ code: 3, out: '', err: '' }),
      hap: (args) => {
        if (args[1] === 'list') {
          return [{
            value: 's1', time: '新时间', category: 'user', name: '李雷',
            from: { id: 's1', name: '李雷' }, msg: { con: '你看下那条 DNS' },
          }];
        }
        return { list: [{ id: 'm1', time: '新时间', text: '你看下那条 DNS', from: { id: 's1', name: '李雷' } }] };
      },
    },
  });
  assert.equal(r.noNews, false, 'watch 的退出码不是判据，自己的水位线才是');
  assert.equal(r.seen.s1, '新时间', '这一轮看到的水位线要交回给调用方，好在干净收尾时存住');
  // ⚠ 这里不断言 candidates：fetchFreshMessages 走的是顶层 hap()（假二进制回空表），
  //   跟上面「有新动静」那条测试同一个限制。这条盯的是「退出码 3 也照样往下走」。
});

test('watch 出别的错：不当成 401，也不当成有新消息', async () => {
  const { pull } = await import('../connect/hap.mjs');
  const r = pull({
    prevSeen: { s1: '旧时间' },
    io: { runWatch: () => ({ code: 1, out: '', err: 'ENOENT 什么鬼' }) },
  });
  assert.equal(r.authError, null);
  assert.equal(r.candidates.length, 0);
});

test('首轮只建基线，不把历史当新消息；store 靠参数注入，不碰真的 ~/.mailroom', async () => {
  const { pull } = await import('../connect/hap.mjs');
  const saved = {};
  const fakeStore = {
    stateGet: (k, d) => (k in saved ? saved[k] : d),
    stateSet: (k, v) => { saved[k] = v; },
  };
  const r = pull({
    prevSeen: {},                                    // 空 = 首轮
    store: fakeStore,
    io: {
      runWatch: () => ({ code: 0, out: 'x', err: '' }),
      hap: () => ({ list: [{ inboxId: 'i1' }, { inboxId: 'i2' }] }),
    },
  });
  assert.equal(r.firstRun, true);
  assert.equal(r.candidates.length, 0);
  assert.deepEqual(saved['seen-post'].ids, ['i1', 'i2'],
    '首轮要把动态收件箱也标记已读，否则第一次会把历史评论全倒出来');
});

test('有新动静：私信会话过一遍规范化，出来的是渠道无关的 candidate', async () => {
  const { pull } = await import('../connect/hap.mjs');
  const r = pull({
    prevSeen: { 'acc-ln': '旧时间' },
    io: {
      runWatch: () => ({ code: 0, out: '李雷 有新消息', err: '' }),
      hap: (args) => (args[0] === 'chat' && args[1] === 'list'
        ? [{
          value: 'acc-ln', name: '李雷', category: 'user', time: '2026-08-08 09:00:00.000',
          msg: { con: '嗨' },
        }]
        : { list: [] }),
    },
  });
  assert.equal(r.authError, null);
  assert.equal(r.noNews, false);
  assert.ok(Array.isArray(r.candidates));
  assert.ok(Array.isArray(r.records));
  // ⚠ fetchFreshMessages 内部直接调 hap()（不走 io.hap 注入，走顶层保险丝 FAKE_HAP），
  //   在这个假二进制下拿到的是空列表，所以这一轮不会有 msgs，candidate 也就不会出现——
  //   这条测试真正要盯的是「chat list 之后走到规范化那步不炸」，不是拼消息内容。
});

test('⚠ pull 这条路上不许有任何发送分支', () => {
  const src = readFileSync(join(ROOT, 'connect/hap.mjs'), 'utf-8');
  const pullPart = src.slice(src.indexOf('export function pull'));
  for (const bad of ['send-to-one', 'send-to-group', 'add-discussion']) {
    assert.ok(!pullPart.includes(bad), `pull 里出现了 ${bad}`);
  }
});

// ---------- connect/index.mjs ----------

test('注册表认得 mingdao 和 mail，不认得的当场报人话；没有 ensureDefaultConnector', async () => {
  const mod = await import('../connect/index.mjs');
  assert.ok(mod.adapterFor('mingdao'));
  assert.ok(mod.adapterFor('mail'), 'Task 6 接进来的邮件适配器');
  assert.deepEqual(mod.listAdapters(), ['mingdao', 'mail']);
  assert.throws(() => mod.adapterFor('telegram'), /没有.*适配器/);
  assert.ok(mod.adapterFor(undefined), '不给 kind 时退回 mingdao');
  assert.equal(mod.ensureDefaultConnector, undefined,
    'ensureDefaultConnector 是老架构的多租户预留，mailroom 不需要，必须删掉');
});

// ---------- describe() ----------

test('describe 给人看的来源标签，都带着是哪个系统', async () => {
  const { describe } = await import('../connect/hap.mjs');
  assert.match(describe({ kind: 'user', who: '李雷' }), /私信/);
  assert.match(describe({ kind: 'group', target: { groupName: '开发组' } }), /开发组/);
  assert.match(describe({ kind: 'notice', channel: '任务通知' }), /任务/);
  assert.match(describe({ kind: 'post' }), /动态/);
  for (const k of ['user', 'group', 'notice', 'post']) {
    assert.match(describe({ kind: k, target: {}, channel: '' }), /明道云/);
  }
});

// ---------- fetch.mjs：normalizeSession 规范化成 candidate 形状 ----------

test('normalizeSession：私信规范化成 candidate 形状，msgs 的 at 是 ISO 字符串', async () => {
  const { normalizeSession } = await import('../fetch.mjs');
  const sess = { value: 'acc-ln', name: '李雷', category: 'user', time: '2026-08-08 09:00:00.000' };
  const freshMsgs = [
    { id: 'm1', from: 'acc-ln', time: '2026-08-08 09:00:00.000', msg: { con: '在吗' } },
    { id: 'm2', from: 'acc-ln', time: '2026-08-08 09:01:00.000', msg: { con: '在的话回一下' } },
  ];
  const c = normalizeSession(sess, freshMsgs);
  assert.equal(c.sourceKind, 'mingdao');
  assert.equal(c.kind, 'user');
  assert.equal(c.who, '李雷');
  assert.equal(c.whoAccountId, 'acc-ln');
  assert.deepEqual(c.target, { accountId: 'acc-ln' });
  assert.equal(c.msgs.length, 2);
  assert.match(c.msgs[0].at, /^\d{4}-\d{2}-\d{2}T/, 'at 必须是 ISO 字符串，供 segment.mjs 按时间聚段');
  assert.equal(c.msgs[1].text, '在的话回一下');
});

test('normalizeSession：我自己发的不入队', async () => {
  const { normalizeSession, ME } = await import('../fetch.mjs');
  const sess = { value: 'acc-ln', name: '李雷', category: 'user', time: '2026-08-08 09:00:00.000' };
  const freshMsgs = [{ id: 'm1', from: ME.accountId, time: '2026-08-08 09:00:00.000', msg: { con: '好的' } }];
  assert.equal(normalizeSession(sess, freshMsgs), null);
});

test('normalizeSession：群里不再只挑 @ 我的，freshMsgs 里所有人说的都进 candidate', async () => {
  const { normalizeSession } = await import('../fetch.mjs');
  const sess = { value: 'g1', name: '开发组', category: 'group', time: '2026-08-08 09:00:00.000' };
  const freshMsgs = [
    {
      id: 'm1', from: 'acc-a', fromAccount: { name: '张三' },
      time: '2026-08-08 09:00:00.000', msg: { con: '随便聊聊，没提任何人' },
    },
    {
      id: 'm2', from: 'acc-b', fromAccount: { name: '李四' },
      time: '2026-08-08 09:01:00.000', msg: { con: '@王小明 这个你看一下' },
    },
  ];
  const c = normalizeSession(sess, freshMsgs);
  assert.equal(c.kind, 'group');
  assert.equal(c.msgs.length, 2, '没有 lane 打分了，两条都该进候选，判断值不值得回交给下游 AI');
});

test('normalizeSession：通知类没有回复对象时 replyVia 是 null，不瞎猜', async () => {
  const { normalizeSession } = await import('../fetch.mjs');
  const sess = {
    value: 'workflow', category: 'workflow', time: '2026-08-08 09:00:00.000',
    msg: { con: '你的审批已通过' },
  };
  const c = normalizeSession(sess, [], null);
  assert.equal(c.kind, 'notice');
  assert.equal(c.replyVia, null);
  assert.ok(Array.isArray(c.msgs) && c.msgs.length === 1);
});

// ---------- noticeReplyTarget 三种结局 ----------

test('noticeReplyTarget：record / dm / null 三种结局', async () => {
  const { noticeReplyTarget } = await import('../fetch.mjs');
  const record = noticeReplyTarget({
    worksheetId: 'ws1', rowId: 'row1', inboxId: 'i1',
    sender: { accountId: 'acc-a', name: '张三' },
  });
  assert.equal(record.via, 'record');
  assert.equal(record.target.worksheetId, 'ws1');

  const dm = noticeReplyTarget({ sender: { accountId: 'acc-b', name: '李四' } });
  assert.equal(dm.via, 'dm');
  assert.equal(dm.target.accountId, 'acc-b');

  assert.equal(noticeReplyTarget({}), null);
  assert.equal(noticeReplyTarget(null), null);
});

// ---------- archive.mjs：只测归档不碰真实 dailymd ----------

test('archive：写进临时 dailymd 的 assets/hap-log/，不碰真实仓库', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const tmpRoot = mkdtempSync(join(tmpdir(), 'mailroom-archive-dailymd-'));
  const prev = process.env.MAILROOM_DAILYMD;
  process.env.MAILROOM_DAILYMD = tmpRoot;
  try {
    const { archive, readMonth, logDir } = await import('../archive.mjs');
    const n = archive([
      {
        id: 'm1', ts: '2026-08-08 09:00:00.000', dir: 'in', kind: 'user',
        peer: '李雷', peerId: 'acc-ln', text: '在吗',
      },
    ]);
    assert.equal(n, 1);
    assert.equal(readMonth('2026-08').length, 1);
    assert.ok(logDir().startsWith(tmpRoot), '必须写进临时目录，不许落进真实 dailymd');
    // 同一条 id 再归档一次不许重复写
    const n2 = archive([
      {
        id: 'm1', ts: '2026-08-08 09:00:00.000', dir: 'in', kind: 'user',
        peer: '李雷', peerId: 'acc-ln', text: '在吗',
      },
    ]);
    assert.equal(n2, 0);
    assert.equal(readMonth('2026-08').length, 1);
  } finally {
    if (prev === undefined) delete process.env.MAILROOM_DAILYMD;
    else process.env.MAILROOM_DAILYMD = prev;
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('archive：显式传 { dailymd } 说了算，环境变量顶不动它', async () => {
  // ⚠ 归档原来只认环境变量，跟本仓别处（file.mjs / tree.mjs / fileAll）显式传 dailymd
  //   的风格不一致。run.mjs 是串链的地方，它手上有 dailymd，就该直接传下来——
  //   否则「这一轮写进哪个库」取决于一个看不见的全局变量，测试之间也容易互相串。
  const { mkdtempSync, rmSync, existsSync } = await import('node:fs');
  const wanted = mkdtempSync(join(tmpdir(), 'mailroom-archive-explicit-'));
  const decoy = mkdtempSync(join(tmpdir(), 'mailroom-archive-decoy-'));
  const prev = process.env.MAILROOM_DAILYMD;
  process.env.MAILROOM_DAILYMD = decoy;      // 环境变量指着另一个库
  try {
    const { archive, readMonth, logDir } = await import('../archive.mjs');
    const rec = {
      id: 'x1', ts: '2026-08-08 09:00:00.000', dir: 'in', kind: 'user',
      peer: '李雷', peerId: 'acc-ln', text: '显式传参说了算',
    };
    assert.equal(archive([rec], { dailymd: wanted }), 1);
    assert.ok(logDir({ dailymd: wanted }).startsWith(wanted));
    assert.equal(readMonth('2026-08', { dailymd: wanted }).length, 1);
    assert.equal(existsSync(join(decoy, 'assets/hap-log')), false,
      '显式传了 dailymd，就一个字都不许写到环境变量指的那个库里');
    // .md 也得渲染进同一个库（renderMonth 是 archive 内部调的，别漏掉传参）
    assert.ok(existsSync(join(wanted, 'assets/hap-log/2026-08.md')));
    // 去重也认这个库：同一条再来一次不重复写
    assert.equal(archive([rec], { dailymd: wanted }), 0);
    assert.equal(readMonth('2026-08', { dailymd: wanted }).length, 1);
  } finally {
    if (prev === undefined) delete process.env.MAILROOM_DAILYMD;
    else process.env.MAILROOM_DAILYMD = prev;
    rmSync(wanted, { recursive: true, force: true });
    rmSync(decoy, { recursive: true, force: true });
  }
});

test('recordFromChatMessage / recordFromPostComment：按发送人判方向', async () => {
  const { recordFromChatMessage, recordFromPostComment } = await import('../archive.mjs');
  const { ME } = await import('../fetch.mjs');

  const inMsg = recordFromChatMessage(
    { id: 1, from: 'acc-ln', fromAccount: { name: '李雷' }, time: '2026-08-08 09:00:00.000', msg: { con: '在吗' } },
    { category: 'user', value: 'acc-ln', name: '李雷' },
  );
  assert.equal(inMsg.dir, 'in');

  const outMsg = recordFromChatMessage(
    { id: 2, from: ME.accountId, time: '2026-08-08 09:00:00.000', msg: { con: '在的' } },
    { category: 'user', value: 'acc-ln', name: '李雷' },
  );
  assert.equal(outMsg.dir, 'out');

  const comment = recordFromPostComment(
    { inboxId: 'i1', post: { postId: 'p1' } },
    { commentId: 'i1', author: { accountId: 'acc-a', name: '张三' }, message: '不错', createTime: '2026-08-08 09:00:00.000' },
  );
  assert.equal(comment.dir, 'in');
  assert.equal(comment.peer, '张三');
});
