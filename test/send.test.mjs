// 唯一发送出口的测试。
//
// ⚠⚠ 这个文件里**一条真消息都不许发出去**。明道云没有撤回接口，
//   `hap chat send-to-one` 对任何 accountId 都回 `Message sent.`——
//   一次跑错就是真往同事那儿发了一条。所以每一条测试都显式注入假适配器
//   （`opts.adapter`），谁都不许省这一步。
// ⚠ 称呼门那几条一律注入假通讯录，绝不读 小明 真实的 contactmd/contacts.json——
//   那份会变，测试会跟着飘。
// ⚠ 假适配器/假通讯录都从 `opts.__test` 进，而且只在 MAILROOM_TEST==='1' 时才被认
//   （见 send.mjs 的 hooks()）——所以这个文件必须设这个环境变量，
//   否则每一条 sendReply 都会去找真适配器。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync, existsSync, readdirSync, rmSync, writeFileSync, mkdirSync, mkdtempSync, chmodSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sendReply, precheckSend } from '../send.mjs';
import { tierOf, needWhy } from '../bin/send.mjs';
import { tmpDailymd, tmpState } from './helpers.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OK = { source: 'approval-desk-button' };

// ⚠ 整个文件先套一个临时状态目录：sendReply 会写日志（lib.log → stateDir()），
//   不套的话跑一次测试就在真实的 ~/.mailroom 里建目录写日志。
let box = null;
before(() => {
  box = tmpState();
  process.env.MAILROOM_TEST = '1';   // 不设的话 opts.__test 里的假适配器不被认，会去找真的
});
after(() => {
  if (box) box.cleanup();
  delete process.env.MAILROOM_TEST;
});

// 顶掉一个进程级环境变量、跑一段、再还原。
//
// ⚠⚠ 必须认得出 fn 返回的是不是 promise：sendReply 现在是 async，
//   写成 `try { return fn(); } finally { 还原 }` 的话，fn 里第一个 await 一挂起，
//   finally 当场就把变量还原了 —— 同一个块里后面几次调用就跑在**还原之后**的环境里。
//   实跑复现过：一条「没有批准标记」的测试里，第二、第三次调用变成了「不是发送入口」，
//   测的东西悄悄换了。所以异步就等它结束再还原。
function withEnv(name, value, fn) {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  const restore = () => {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  };
  let out;
  try {
    out = fn();
  } catch (e) {
    restore();
    throw e;
  }
  if (out && typeof out.then === 'function') return out.finally(restore);
  restore();
  return out;
}

// 把测试钩子的门关上跑一段（验证「不在自查环境里就伪造不出东西」）。
// ⚠ 判据是 lib.mjs 的 inTest()：MAILROOM_TEST 和 node --test 给的 NODE_TEST_CONTEXT
//   **两个都要摘掉**，只摘一个的话门还开着，这条绊线就绊不到东西。
function withoutTestEnv(fn) {
  return withEnv('MAILROOM_TEST', undefined,
    () => withEnv('NODE_TEST_CONTEXT', undefined, fn));
}

// 假通讯录。只要两个人够用：一个有「X 总」风险（赵四 → 老赵），
// 一个当日常收件人（李雷 → 雷哥）。
const PEOPLE = [
  { name: '赵四', nickname: '老赵', md_account_id: 'acc-zhao' },
  { name: '李雷', nickname: '雷哥', md_account_id: 'acc-lilei' },
];

// 一个已经归位到 T89 的段（sendReply 收到的 item 就是这个形状，见 PLAN 数据模型）。
function segTo(who, accountId, overrides = {}) {
  return {
    id: `seg-${accountId}`,
    sourceKind: 'mingdao',
    sourceType: 'user',            // ⚠ 段上叫 sourceType，候选上叫 kind，别写混
    sourceLabel: '明道云 · 私信',
    who,
    whoAccountId: accountId,
    target: { accountId },
    msgs: [{ id: 'm1', at: '2026-08-08T11:18:00.000Z', text: 'DNS 那条怎么说' }],
    firstAt: '2026-08-08T11:18:00.000Z',
    lastAt: '2026-08-08T11:18:00.000Z',
    filed: {
      project: 'P26-agent-ready-sites',
      task: 'T89-2026-08-07-help-center-repo-access',
      reason: '命中「帮助中心」', by: 'auto', sure: true, createdTask: false,
      at: '2026-08-08T11:20:00.000Z',
    },
    dropped: false,
    waiting: null,
    ...overrides,
  };
}

const FENG = () => segTo('李雷', 'acc-lilei');
const JERRY = () => segTo('赵四', 'acc-zhao');

// 假适配器：记下被要求发什么，绝不真打 hap。
function spyAdapter(over = {}) {
  const calls = [];
  return {
    calls,
    sendVia(item, body) {
      calls.push({ item, body });
      if (over.throws) throw new Error(over.throws);
      return { channel: '私信', to: item.who };
    },
  };
}

// MAILROOM_ROLE 是进程级的，改完必须还原，否则会污染同文件后面的测试。
// ⚠ 走 withEnv：异步的那一支要等 promise 结束才还原，理由见上面。
function withRole(value, fn) {
  return withEnv('MAILROOM_ROLE', value, fn);
}
const asDesk = (fn) => withRole('approval-desk', fn);

function inboxOf(root, task = 'T89-2026-08-07-help-center-repo-access') {
  return join(root, 'projects/P26-agent-ready-sites/tasks', task, 'inbox.md');
}

// ---------- 简报要求的六条 ----------

test('① 不是审批台进程，拒发', async () => {
  const a = spyAdapter();
  await withRole(undefined, async () => {
    await assert.rejects(() => sendReply(FENG(), '你好', OK, { __test: { adapter: a, people: PEOPLE } }),
      /不是发送入口/);
  });
  // 角色不对的时候连传输层都不许碰一下
  assert.equal(a.calls.length, 0, '角色断言没过就不该走到 sendVia');
});

test('① 之二：角色是别的值也一样拒发（只认 approval-desk 这一个字符串）', async () => {
  const a = spyAdapter();
  await withRole('poller', async () => {
    await assert.rejects(() => sendReply(FENG(), '你好', OK, { __test: { adapter: a, people: PEOPLE } }),
      /不是发送入口/);
  });
  assert.equal(a.calls.length, 0);
});

test('② 没有批准标记，拒发', async () => {
  const a = spyAdapter();
  await asDesk(async () => {
    await assert.rejects(() => sendReply(FENG(), '你好', undefined, { __test: { adapter: a, people: PEOPLE } }),
      /批准标记/);
    await assert.rejects(() => sendReply(FENG(), '你好', {}, { __test: { adapter: a, people: PEOPLE } }),
      /批准标记/);
    await assert.rejects(() => sendReply(FENG(), '你好', { source: '' }, { __test: { adapter: a, people: PEOPLE } }),
      /批准标记/);
  });
  assert.equal(a.calls.length, 0, '批准断言没过就不该走到 sendVia');
});

test('③ authorized-rule 这种标记一律不认了（老架构的按类授权已经砍掉）', async () => {
  const a = spyAdapter();
  await asDesk(async () => {
    await assert.rejects(
      () => sendReply(FENG(), '你好', { source: 'authorized-rule', ruleId: 'r1' },
        { __test: { adapter: a, people: PEOPLE } }),
      /批准标记/,
    );
  });
  assert.equal(a.calls.length, 0);
});

test('④ 身份声明在发送这一步补，草稿里删掉也没用', async () => {
  const { root, cleanup } = tmpDailymd();
  const a = spyAdapter();
  try {
    await asDesk(async () => {
      const r = await sendReply(FENG(), 'DNS 那条我看了', OK,
        { __test: { adapter: a, people: PEOPLE }, dailymd: root });
      assert.match(r.body, /^🤖 我是 小明 的 AI Agent/);
      // 真正吐给传输层的那一版也必须带声明，不能只是返回值好看
      assert.match(a.calls[0].body, /^🤖 我是 小明 的 AI Agent/);
    });
  } finally { cleanup(); }
});

test('④ 之二：草稿开头本来有声明也不会补出两句', async () => {
  const { root, cleanup } = tmpDailymd();
  const a = spyAdapter();
  try {
    await asDesk(async () => {
      const r = await sendReply(FENG(), '我是小明的AI Agent,代他回复。\nDNS 那条我看了', OK,
        { __test: { adapter: a, people: PEOPLE }, dailymd: root });
      assert.equal((r.body.match(/AI Agent/g) || []).length, 1, '声明只许有一句');
      assert.match(r.body, /^🤖 我是 小明 的 AI Agent/);
      assert.match(r.body, /DNS 那条我看了/);
    });
  } finally { cleanup(); }
});

test('⑤ 称呼门：写「赵总」会被拦，错误带 code=CALLNAME', async () => {
  const a = spyAdapter();
  await asDesk(async () => {
    let err = null;
    try {
      await sendReply(JERRY(), '赵总您好，DNS 那条我看了', OK, { __test: { adapter: a, people: PEOPLE } });
    } catch (e) { err = e; }
    assert.ok(err, '「赵总」必须被拦下来');
    assert.equal(err.code, 'CALLNAME', '前端认这个码才弹「就按原文发」');
    assert.match(err.message, /老赵/, '错误信息要直接告诉人该叫什么');
  });
  assert.equal(a.calls.length, 0, '被称呼门拦下就不该走到 sendVia');
});

test('⑤ 之二：allowFormalName 是唯一的绕过口，绕过之后才发得出去', async () => {
  const { root, cleanup } = tmpDailymd();
  const a = spyAdapter();
  try {
    await asDesk(async () => {
      const r = await sendReply(JERRY(), '赵总您好，DNS 那条我看了', OK,
        { __test: { adapter: a, people: PEOPLE }, dailymd: root, allowFormalName: true });
      assert.equal(a.calls.length, 1);
      assert.match(r.body, /赵总/, '绕过之后原文一个字不改，不许悄悄替换称呼');
    });
  } finally { cleanup(); }
});

test('⑤ 之三：自称门——正文把 小明 写成第三人称会被拦，错误带 code=SELF3P', async () => {
  const a = spyAdapter();
  await asDesk(async () => {
    let err = null;
    try {
      await sendReply(FENG(), '小明 想跟你聊一下那条 DNS', OK, { __test: { adapter: a, people: PEOPLE } });
    } catch (e) { err = e; }
    assert.ok(err, '第三人称的「小明」必须被拦下来');
    assert.equal(err.code, 'SELF3P');
    assert.match(err.message, /第一人称/, '错误信息要说清该怎么改');
  });
  assert.equal(a.calls.length, 0, '被自称门拦下就不该走到 sendVia');
});

test('⑤ 之四：声明句里的 小明 不算违规，正文用第一人称照常发得出去', async () => {
  const { root, cleanup } = tmpDailymd();
  const a = spyAdapter();
  try {
    await asDesk(async () => {
      const r = await sendReply(FENG(), '🤖 我是 小明 的 AI Agent，以下内容已经过 小明 本人审核。\n\n我想跟你聊一下那条 DNS', OK,
        { __test: { adapter: a, people: PEOPLE }, dailymd: root });
      assert.equal(a.calls.length, 1, '声明句里的 小明 是它本来就该有的，不许拦');
      assert.match(r.body, /我想跟你聊/);
    });
  } finally { cleanup(); }
});

test('⑤ 之五：自称门的预检结论跟真发同源，且 allowFormalName 能绕过', async () => {
  const { root, cleanup } = tmpDailymd();
  const a = spyAdapter();
  try {
    const text = '小明 想跟你聊一下那条 DNS';
    const pre = precheckSend(text, FENG(), { __test: { adapter: a, people: PEOPLE } });
    assert.equal(pre.selfThirdPerson.ok, false, '预检要提前红，不能等到发的时候才拦');
    assert.deepEqual(pre.selfThirdPerson.hits, ['小明']);
    await asDesk(async () => {
      const r = await sendReply(FENG(), text, OK,
        { __test: { adapter: a, people: PEOPLE }, dailymd: root, allowFormalName: true });
      assert.equal(a.calls.length, 1, 'allowFormalName 是唯一绕过口');
      assert.match(r.body, /小明 想跟你聊/, '绕过之后原文一个字不改');
    });
  } finally { cleanup(); }
});

test('⑥ 发送成功后，这条自动落进对应任务的 inbox.md', async () => {
  const { root, cleanup } = tmpDailymd();
  const a = spyAdapter();
  try {
    await asDesk(async () => {
      const r = await sendReply(FENG(), 'DNS 那条我看了，明天给你', OK,
        { __test: { adapter: a, people: PEOPLE }, dailymd: root });
      const file = inboxOf(root);
      assert.ok(existsSync(file), 'inbox.md 应该被写出来');
      const text = readFileSync(file, 'utf-8');
      assert.match(text, /我 → 李雷/, 'who 要写成「我 → 对方」');
      assert.match(text, /^> 已发 · .*审批台$/m, '块头要有一行「已发 · … · 审批台」');
      assert.match(text, /我是 小明 的 AI Agent/, '落盘的要是对方实际收到的那一版');
      assert.match(text, /DNS 那条我看了，明天给你/);
      assert.ok(r.filed && r.filed.dir, '返回值要告诉调用方落到哪了');
      assert.equal(r.filed.dir, join(root, 'projects/P26-agent-ready-sites/tasks/T89-2026-08-07-help-center-repo-access'));
    });
  } finally { cleanup(); }
});

// ---------- 额外两条：防判定漂移 + 防第二条发送路 ----------

test('⑦ precheckSend 和 sendReply 的判定必须一致（同一段文本，两边不许对不上）', async () => {
  const { root, cleanup } = tmpDailymd();
  try {
    const cases = [
      ['赵总您好，DNS 那条我看了', JERRY()],
      ['赵四老师，这事我来跟', JERRY()],
      ['老赵，DNS 那条我看了', JERRY()],
      ['DNS 那条我看了，明天给你', JERRY()],
      ['雷哥，反代那条我看了', FENG()],
      ['李雷，反代那条我看了', FENG()],
    ];
    for (const [text, item] of cases) {
      const pre = precheckSend(text, item, { __test: { people: PEOPLE } });
      const a = spyAdapter();
      let err = null;
      await asDesk(async () => {
        try {
          await sendReply(item, text, OK, { __test: { adapter: a, people: PEOPLE }, dailymd: root });
        } catch (e) { err = e; }
      });
      const blocked = !!(err && err.code === 'CALLNAME');
      assert.equal(blocked, !pre.callName.ok,
        `「${text}」：预检说 ok=${pre.callName.ok}，sendReply 却 ${blocked ? '拦了' : '放了'}`
        + `（两份判定漂移是最伤信任的行为，precheckSend 必须调 sendReply 用的同一对函数）`);
      // 顺带钉死：预检说会补声明，发出去也确实补了
      assert.match(pre.agentPrefix.body, /^🤖 我是 小明 的 AI Agent/);
    }
  } finally { cleanup(); }
});

test('⑦ 之二：precheckSend 只标不拦，一条都不许真发出去', async () => {
  const a = spyAdapter();
  const pre = precheckSend('赵总您好', JERRY(), { __test: { people: PEOPLE } });
  assert.equal(pre.callName.ok, false);
  assert.equal(pre.to.kind, 'user');
  assert.equal(pre.to.name, '赵四');
  assert.equal(a.calls.length, 0);
});

test('⑧ 仓库里除了 bin/send.mjs，没有别的文件 import send.mjs', async () => {
  // ⚠⚠ 「唯一发送出口」的字面意思。2026-08-09 网页砍掉之后白名单从 server.mjs
  //   换成了 bin/send.mjs —— **换锚点的这一刻是这道闸最容易被改松的时候**，
  //   所以这条测试连同下面那条 MAILROOM_ROLE 的一起，是整个仓库最不许放宽的两条。
  //   收消息那条链的反向测试在 test/run.test.mjs 和 test/connect.test.mjs 里。
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name.startsWith('.')) return [];
    if (e.isDirectory()) return ['test', 'node_modules'].includes(e.name) ? [] : walk(join(dir, e.name));
    return e.name.endsWith('.mjs') ? [join(dir, e.name)] : [];
  });
  const bad = [];
  for (const f of walk(ROOT)) {
    const base = f.slice(ROOT.length).replace(/^\//, '');
    if (base === 'send.mjs' || base === 'bin/send.mjs') continue;
    // 注释行先剥掉，免得一句「⚠ 不许 import send.mjs」的注释把自己判成违规
    const code = readFileSync(f, 'utf-8').split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    if (/['"]\.\.?\/send\.mjs['"]/.test(code)) bad.push(base);
  }
  assert.deepEqual(bad, [], `这些文件开了第二条发送路：${bad.join(', ')}`);
});

test('⑧ 之二：全仓库只有 bin/send.mjs 会给 MAILROOM_ROLE 赋值', async () => {
  // ⚠⚠ role 断言的锚点。多一处赋值 = 多一个「不用 小明 点同意也能发」的进程。
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name.startsWith('.')) return [];
    if (e.isDirectory()) return ['test', 'node_modules'].includes(e.name) ? [] : walk(join(dir, e.name));
    return e.name.endsWith('.mjs') ? [join(dir, e.name)] : [];
  });
  const bad = [];
  for (const f of walk(ROOT)) {
    const base = f.slice(ROOT.length).replace(/^\//, '');
    if (base === 'bin/send.mjs') continue;
    const code = readFileSync(f, 'utf-8').split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    if (/process\.env\.MAILROOM_ROLE\s*=/.test(code)) bad.push(base);
  }
  assert.deepEqual(bad, [], `这些文件自己给自己发了发送资格：${bad.join(', ')}`);
});

// ---------- 出错时的边界 ----------

test('内容为空，拒发', async () => {
  const a = spyAdapter();
  await asDesk(async () => {
    await assert.rejects(() => sendReply(FENG(), '   ', OK, { __test: { adapter: a, people: PEOPLE } }), /内容为空/);
  });
  assert.equal(a.calls.length, 0);
});

test('传输层抛错 = 没发出去，绝不许在 inbox.md 里留下「已发」', async () => {
  const { root, cleanup } = tmpDailymd();
  const a = spyAdapter({ throws: 'hap 超时' });
  try {
    await asDesk(async () => {
      await assert.rejects(() => sendReply(FENG(), 'DNS 那条我看了', OK,
        { __test: { adapter: a, people: PEOPLE }, dailymd: root }), /hap 超时/);
    });
    assert.equal(existsSync(inboxOf(root)), false, '没发出去就不许写「已发」记录');
  } finally { cleanup(); }
});

test('段还没归位（filed 为空）：照发不误，兜底落进 P00-misc，绝不无痕', async () => {
  const { root, cleanup } = tmpDailymd();
  const a = spyAdapter();
  try {
    await asDesk(async () => {
      const r = await sendReply(segTo('李雷', 'acc-lilei', { filed: null }), 'DNS 那条我看了', OK,
        { __test: { adapter: a, people: PEOPLE }, dailymd: root });
      assert.equal(a.calls.length, 1, '消息该发还是要发出去');
      assert.ok(r.filed, '发出去的每一条都必须落盘');
      assert.equal(r.filed.dir, join(root, 'projects/P00-misc'));
      assert.equal(r.filed.level, 'misc', '要如实标成兜底，不能装作归得很准');
      assert.match(readFileSync(join(root, 'projects/P00-misc/inbox.md'), 'utf-8'), /我 → 李雷/);
      assert.match(r.body, /^🤖 我是 小明 的 AI Agent/);
    });
  } finally { cleanup(); }
});

test('落点目录不认（模型编的任务号 / 已被搬走）：退到项目目录，不许照着这个路径 mkdir 造假任务目录', async () => {
  const { root, cleanup } = tmpDailymd();
  const a = spyAdapter();
  try {
    await asDesk(async () => {
      const item = segTo('李雷', 'acc-lilei', {
        filed: { project: 'P26-agent-ready-sites', task: 'T99-2026-08-08-不存在的任务' },
      });
      const r = await sendReply(item, 'DNS 那条我看了', OK,
        { __test: { adapter: a, people: PEOPLE }, dailymd: root });
      assert.equal(r.filed.dir, join(root, 'projects/P26-agent-ready-sites'), '任务不认就退到项目一级');
      assert.equal(r.filed.level, 'project');
      assert.equal(existsSync(join(root, 'projects/P26-agent-ready-sites/tasks/T99-2026-08-08-不存在的任务')), false);
    });
  } finally { cleanup(); }
});

test('连 P00-misc 都不在（dailymd 指错了）：只写日志，绝不 mkdir 造骨架', async () => {
  const { root, cleanup } = tmpDailymd();
  const a = spyAdapter();
  try {
    rmSync(join(root, 'projects/P00-misc'), { recursive: true, force: true });
    await asDesk(async () => {
      const r = await sendReply(segTo('李雷', 'acc-lilei', { filed: null }), 'DNS 那条我看了', OK,
        { __test: { adapter: a, people: PEOPLE }, dailymd: root });
      assert.equal(a.calls.length, 1, '消息该发还是要发出去');
      assert.equal(r.filed, null, '真没地方落就如实说没落盘');
      assert.equal(existsSync(join(root, 'projects/P00-misc')), false);
    });
  } finally { cleanup(); }
});

test('群消息：认不出单个收件人时称呼门退回全表判定（拿不准一律关门）', async () => {
  const a = spyAdapter();
  const group = segTo('赵四', 'acc-zhao', {
    sourceType: 'group',
    target: { groupId: 'g1', groupName: '开发组' },
  });
  assert.equal(precheckSend('赵总您好', group, { __test: { people: PEOPLE } }).to.kind, 'group');
  await asDesk(async () => {
    await assert.rejects(() => sendReply(group, '赵总您好', OK, { __test: { adapter: a, people: PEOPLE } }),
      /称呼不对/);
  });
  assert.equal(a.calls.length, 0);
});

test('段上只有 sourceType 没有 kind，也要能发出去（适配器认的是 kind）', async () => {
  const { root, cleanup } = tmpDailymd();
  const a = spyAdapter();
  try {
    await asDesk(async () => {
      await sendReply(FENG(), 'DNS 那条我看了', OK, { __test: { adapter: a, people: PEOPLE }, dailymd: root });
      assert.equal(a.calls[0].item.kind, 'user',
        '喂给适配器的 item 必须带 kind，否则 sendVia 一路 fallthrough 抛「未知的消息类型」');
    });
  } finally { cleanup(); }
});

// ---------- 🔴 正文被身份声明吃掉（2026-08-08 评审的 Critical） ----------
//
// 老实现按**行**剥声明：第一行里只要出现「AI Agent」字样，整行被吞。
// 实测过的后果：对方收到一句光秃秃的身份声明，而 小明 在审批台上看到的是完整的话，
// 落回 inbox.md 的也是残缺版，事后翻记录看不出发生过什么。
// 下面三条钉死「正文必须还在」，断言的是**适配器实际收到的那一版**。

test('🔴 正文开头就有「AI Agent」字样：整段正文必须还在', async () => {
  const { root, cleanup } = tmpDailymd();
  const a = spyAdapter();
  try {
    await asDesk(async () => {
      await sendReply(FENG(), 'AI Agent 那个方案我看了，明天给你答复', OK,
        { __test: { adapter: a, people: PEOPLE }, dailymd: root });
      const got = a.calls[0].body;
      assert.match(got, /^🤖 我是 小明 的 AI Agent/);
      assert.match(got, /那个方案我看了/, '正文被整行吞掉了');
      assert.match(got, /明天给你答复/);
    });
  } finally { cleanup(); }
});

test('🔴 声明和正文写在同一行（草拟器最自然的写法）：正文必须还在，声明只留一句', async () => {
  const { root, cleanup } = tmpDailymd();
  const a = spyAdapter();
  try {
    await asDesk(async () => {
      await sendReply(FENG(), '我是 小明 的 AI Agent，关于帮助中心那件事，我明天给你答复', OK,
        { __test: { adapter: a, people: PEOPLE }, dailymd: root });
      const got = a.calls[0].body;
      assert.match(got, /^🤖 我是 小明 的 AI Agent/);
      assert.match(got, /关于帮助中心那件事/, '正文被整行吞掉了');
      assert.match(got, /我明天给你答复/);
      assert.equal((got.match(/AI Agent/g) || []).length, 1, '声明只许有一句');
    });
  } finally { cleanup(); }
});

test('🔴 标准声明句 + 同行正文：声明换成标准句，正文一个字不少', async () => {
  const { root, cleanup } = tmpDailymd();
  const a = spyAdapter();
  try {
    await asDesk(async () => {
      await sendReply(FENG(), '我是 小明 的 AI Agent，以下内容已经过 小明 本人审核。DNS 那条我看了', OK,
        { __test: { adapter: a, people: PEOPLE }, dailymd: root });
      const got = a.calls[0].body;
      assert.equal(got, '🤖 我是 小明 的 AI Agent，以下内容已经过 小明 本人审核。\n\nDNS 那条我看了');
    });
  } finally { cleanup(); }
});

test('🔴 兜底：补完声明之后正文什么都没剩，拒发（不发一句光秃秃的声明）', async () => {
  const a = spyAdapter();
  await asDesk(async () => {
    for (const raw of [
      '我是 小明 的 AI Agent，以下内容已经过 小明 本人审核。',
      '我是小明的AI Agent,代他回复。',
      '我是 小明 的 AI Agent',
    ]) {
      await assert.rejects(() => sendReply(FENG(), raw, OK, { __test: { adapter: a, people: PEOPLE } }),
        /没剩下任何内容/, `「${raw}」应该被拒发`);
    }
  });
  assert.equal(a.calls.length, 0, '一条都不许发出去');
});

test('🔴 剥声明的判据三处同源：hasAgentDeclaration / precheckSend / sendReply 不许对不上', async () => {
  const { root, cleanup } = tmpDailymd();
  try {
    const cases = [
      '我是 小明 的 AI Agent，关于帮助中心那件事，我明天给你答复',
      'AI Agent 那个方案我看了，明天给你答复',
      'DNS 那条我看了',
      '我是小明的AI Agent,代他回复。\nDNS 那条我看了',
    ];
    for (const raw of cases) {
      const pre = precheckSend(raw, FENG(), { __test: { people: PEOPLE } });
      const a = spyAdapter();
      await asDesk(async () => {
        await sendReply(FENG(), raw, OK, { __test: { adapter: a, people: PEOPLE }, dailymd: root });
      });
      assert.equal(pre.agentPrefix.body, a.calls[0].body,
        `「${raw}」：预检说发出去长这样，实际发的却是另一样`);
      // already=true 的那些，补完之后不许多出第二句声明
      if (pre.agentPrefix.already) {
        assert.equal((a.calls[0].body.match(/AI Agent/g) || []).length, 1);
      }
    }
  } finally { cleanup(); }
});

test('🔴 正文开头长得像声明但夹着实质内容：一个字都不许吃', async () => {
  // ⚠ 复审实跑出来的：判据用「开头 24 字内出现 AI Agent」这种模糊窗口时，
  //   这两条的开头那截被当成声明剥掉，剩下的还非空，兜底不触发 = **静默漏字**。
  //   而「AI Agent」是 小明 业务里的高频词（明道云 CMO），这不是理论输入。
  const { root, cleanup } = tmpDailymd();
  try {
    for (const raw of [
      '这是我们 AI Agent 产品的报价，你看下',
      '我是王小明，明道云 CMO，AI Agent 那块归我管',
      '以下内容已经过法务审核，请查收',
    ]) {
      const a = spyAdapter();
      await asDesk(async () => {
        await sendReply(FENG(), raw, OK, { __test: { adapter: a, people: PEOPLE }, dailymd: root });
      });
      assert.equal(a.calls[0].body, `🤖 我是 小明 的 AI Agent，以下内容已经过 小明 本人审核。\n\n${raw}`,
        `「${raw}」的正文被吃掉了`);
    }
  } finally { cleanup(); }
});

test('🔴 剥完声明的收尾清理不许啃掉正文首行的列表符号', async () => {
  // ⚠ 复审实跑：收尾清理把 `-` / `——` / `…` 也当分句标点，正文第一条 `- 第一点`
  //   丢了 `-`，后面几条还在，列表看着是坏的。
  const { root, cleanup } = tmpDailymd();
  const a = spyAdapter();
  try {
    await asDesk(async () => {
      await sendReply(FENG(), '🤖 我是 小明 的 AI Agent，以下内容已经过 小明 本人审核。\n\n- 第一点\n- 第二点', OK,
        { __test: { adapter: a, people: PEOPLE }, dailymd: root });
      assert.equal(a.calls[0].body,
        '🤖 我是 小明 的 AI Agent，以下内容已经过 小明 本人审核。\n\n- 第一点\n- 第二点');
    });
  } finally { cleanup(); }
});

test('🔴 声明前面挂着 🤖 时认得出来，不叠成两句', async () => {
  // 声明句要求带 emoji 标识 + 与正文空一行。识别声明的正则是句首锚定的，
  // 加上 emoji 之后如果不跳过它，程序就认不出**自己上一轮写的那句**，会叠出两句声明。
  const { root, cleanup } = tmpDailymd();
  const a = spyAdapter();
  try {
    await asDesk(async () => {
      await sendReply(FENG(), '🤖 我是 小明 的 AI Agent，以下内容已经过 小明 本人审核。\n\nDNS 那条我看了', OK,
        { __test: { adapter: a, people: PEOPLE }, dailymd: root });
    });
    assert.equal(a.calls[0].body,
      '🤖 我是 小明 的 AI Agent，以下内容已经过 小明 本人审核。\n\nDNS 那条我看了');
  } finally { cleanup(); }
});

test('🔴 正文自己以 emoji 开头（不是声明）：那个 emoji 一个都不许吃', async () => {
  // ⚠ 跳过 emoji 的实现必须是「只在判定时临时剥掉」，不能先消费再判断——
  //   消费掉才发现这句不是声明的话，正文开头那个 emoji 就没了。
  const { root, cleanup } = tmpDailymd();
  try {
    for (const raw of ['😂 那个方案我看了，明天答复你', '🤖 是我们新出的机器人产品，你看下']) {
      const a = spyAdapter();
      await asDesk(async () => {
        await sendReply(FENG(), raw, OK, { __test: { adapter: a, people: PEOPLE }, dailymd: root });
      });
      assert.equal(a.calls[0].body, `🤖 我是 小明 的 AI Agent，以下内容已经过 小明 本人审核。\n\n${raw}`,
        `「${raw}」开头的 emoji 被吃掉了`);
    }
  } finally { cleanup(); }
});

test('🔴 @提及开头也认得出声明，不补出两句；@ 谁不许弄丢', async () => {
  const { root, cleanup } = tmpDailymd();
  const a = spyAdapter();
  try {
    await asDesk(async () => {
      const raw = '@雷哥 我是 小明 的 AI Agent，DNS 那条我看了';   // ⚠ @ 也得用 nickname，写本名会被称呼门拦（那是对的）
      assert.equal(precheckSend(raw, FENG(), { __test: { people: PEOPLE } }).agentPrefix.already,
        true, '@ 开头会让声明认不出来，于是补出两句');
      await sendReply(FENG(), raw, OK, { __test: { adapter: a, people: PEOPLE }, dailymd: root });
      const got = a.calls[0].body;
      assert.equal((got.match(/AI Agent/g) || []).length, 1, '声明只许有一句');
      assert.match(got, /@雷哥/, '群里 @ 谁不许弄丢');
      assert.match(got, /DNS 那条我看了/);
    });
  } finally { cleanup(); }
});

test('🔴 预检和发送在「剥完为空」上不许漂移', async () => {
  // 复审逮到的：界面显示「没问题」，真按发送却被拒——正是这两个函数存在要避免的那类漂移。
  const a = spyAdapter();
  for (const raw of [
    '我是 小明 的 AI Agent，以下内容已经过 小明 本人审核。',
    '我是小明的AI Agent,代他回复。',
    '@雷哥 我是 小明 的 AI Agent',
    '   ',
  ]) {
    const pre = precheckSend(raw, FENG(), { __test: { people: PEOPLE } });
    let threw = false;
    await asDesk(async () => {
      try { await sendReply(FENG(), raw, OK, { __test: { adapter: a, people: PEOPLE } }); } catch { threw = true; }
    });
    assert.equal(pre.empty, threw, `「${raw}」：预检说 empty=${pre.empty}，sendReply 却 ${threw ? '拒了' : '放了'}`);
  }
  assert.equal(a.calls.length, 0);
});

// ---------- 🟡 2026-08-07 事故原型 ----------

test('🟡 称呼门的漏：用空格断句、或「本人审核」当正文，一样要拦', async () => {
  // ⚠⚠ 复审实跑出来的四条。第一条就是 2026-08-07 那类事故，
  //   只是把逗号换成空格 —— 老的 callZone 用宽松判据整段跳过，门当场失效。
  const a = spyAdapter();
  for (const raw of [
    '赵总您好 我是 小明 的 AI Agent',
    '赵总 AI Agent 那事你怎么看',
    '赵总 本人审核过的方案我看了',
    '赵总您好，我是 小明 的 AI Agent，DNS 那条我看了',
  ]) {
    await asDesk(async () => {
      await assert.rejects(() => sendReply(JERRY(), raw, OK, { __test: { adapter: a, people: PEOPLE } }),
        (e) => e.code === 'CALLNAME', `「${raw}」没被称呼门拦住`);
    });
  }
  assert.equal(a.calls.length, 0);
});

test('🟡 「赵总您好，我是 小明 的 AI Agent，…」写在同一行，必须抛 CALLNAME', async () => {
  // ⚠ 这就是 2026-08-07 真发出去的那条的句式。称呼门查的必须是**原文**：
  //   声明被换掉的过程中不许把「赵总」一起带走。
  const a = spyAdapter();
  await asDesk(async () => {
    let err = null;
    try {
      await sendReply(JERRY(), '赵总您好，我是 小明 的 AI Agent，DNS 那条我看了', OK,
        { __test: { adapter: a, people: PEOPLE } });
    } catch (e) { err = e; }
    assert.ok(err, '事故原型必须被拦下来');
    assert.equal(err.code, 'CALLNAME');
    assert.match(err.message, /老赵/);
  });
  assert.equal(a.calls.length, 0);
});

test('🟡 绊线：称呼门必须查原文——违规就藏在会被剥掉的那句声明里', async () => {
  // ⚠⚠ 上面两条钉的是事故句式，但它们**拦不住「把 raw 改成 body」这个改动**：
  //   声明句被换掉之后，「赵总您好」还在正文里，查哪个都能查出来（实测两边都是 1 条违规）。
  //   真正能区分两者的，只有**违规落在声明句本身**的输入 —— 那一段正是 body 里被剥掉的部分。
  //   这条就是那根绊线：查 raw = 1 条违规，查 body = 0 条（实测）。
  const a = spyAdapter();
  await asDesk(async () => {
    await assert.rejects(
      () => sendReply(JERRY(), '我是 赵四 的 AI Agent，DNS 那条我看了', OK,
        { __test: { adapter: a, people: PEOPLE } }),
      (e) => e.code === 'CALLNAME',
      '把 assertProperCallName 的实参从 raw 改成 body，这条就会漏',
    );
  });
  assert.equal(a.calls.length, 0);
});

test('🟡 称呼写在声明后面同一行，一样要抛 CALLNAME', async () => {
  const a = spyAdapter();
  await asDesk(async () => {
    await assert.rejects(
      () => sendReply(JERRY(), '我是 小明 的 AI Agent，赵总您好，DNS 那条我看了', OK,
        { __test: { adapter: a, people: PEOPLE } }),
      (e) => e.code === 'CALLNAME',
    );
  });
  assert.equal(a.calls.length, 0);
});

// ---------- 🟡 测试钩子网络传不进来 ----------

test('🟡 没设 MAILROOM_TEST：opts.__test 里的假适配器一律不认', async () => {
  // ⚠ 绊线用「一个压根不存在的消息源」：钩子被认 → 走假适配器发成功；
  //   钩子不被认 → adapterFor 当场抛「没有这个消息源适配器」。
  //   **两条路都碰不到真 hap**，这条测试绝不会往明道云发东西。
  const { root, cleanup } = tmpDailymd();
  const prevDaily = process.env.MAILROOM_DAILYMD;
  process.env.MAILROOM_DAILYMD = root;   // 让 checkCallName 的默认通讯录读到空表，不碰真文件
  const a = spyAdapter();
  const item = segTo('李雷', 'acc-lilei', { sourceKind: '压根不存在的消息源' });
  try {
    // ⚠ 环境变量是进程级的，而 sendReply 现在是 async：**先同步地把调用发出去**
    //   （那几道门和 hooks() 都在第一个 await 之前跑完），拿到 promise 再 await，
    //   这样 withoutTestEnv 的还原不会插在门判定的中间。
    const p = withoutTestEnv(() => asDesk(() => sendReply(item, 'DNS 那条我看了', OK,
      { __test: { adapter: a, people: PEOPLE }, dailymd: root })));
    await assert.rejects(p, /没有.*这个消息源适配器/);
    assert.equal(a.calls.length, 0, '假适配器不许被认出来');
    // 同一个调用，把门打开就走得通——证明差别只在那个环境变量上
    await asDesk(async () => {
      await sendReply(item, 'DNS 那条我看了', OK,
        { __test: { adapter: a, people: PEOPLE }, dailymd: root });
    });
    assert.equal(a.calls.length, 1);
  } finally {
    if (prevDaily === undefined) delete process.env.MAILROOM_DAILYMD;
    else process.env.MAILROOM_DAILYMD = prevDaily;
    cleanup();
  }
});

test('🟡 opts 顶层的 adapter 一律不认（Task 10 摊了请求体也伪造不出传输层）', async () => {
  const { root, cleanup } = tmpDailymd();
  const a = spyAdapter();
  const item = segTo('李雷', 'acc-lilei', { sourceKind: '压根不存在的消息源' });
  try {
    await asDesk(async () => {
      await assert.rejects(
        () => sendReply(item, 'DNS 那条我看了', OK,
          { adapter: a, people: PEOPLE, dailymd: root }),   // 老写法，adapter 现在应该失效
        /没有.*这个消息源适配器/,
      );
    });
    assert.equal(a.calls.length, 0);
  } finally { cleanup(); }
});

test('🟡 opts.people 是生产通道（审批台那道门读到的那份），但空名单一律拒发', async () => {
  // ⚠ 2026-08-08 评审之后 `opts.people` 成了**正式**入口：审批台那道 GATE-DOWN 检查
  //   把它刚读到的名单显式传下来，一条路只读一次通讯录（见 send.mjs 的 peopleFor）。
  //   代价是「顶层 people 一律不认」这条老边界不再成立，所以换一条更硬的：
  //   **空名单 = 门大开 = 当场拒发**。哪天有人写成 `sendReply(…, {...req.body})`，
  //   请求体里塞 `people: []` 得到的是拒发，不是静默放行。
  const { root, cleanup } = tmpDailymd();
  const a = spyAdapter();
  try {
    await asDesk(async () => {
      await assert.rejects(
        () => sendReply(JERRY(), '赵总您好', OK,
          { __test: { adapter: a }, people: [], dailymd: root }),
        /通讯录是空的|拒绝发送/,
      );
      // 非空名单：门真的用它判，「赵总您好」照样被拦
      let e = null;
      try {
        await sendReply(JERRY(), '赵总您好', OK,
          { __test: { adapter: a }, people: PEOPLE, dailymd: root });
      } catch (err) { e = err; }
      assert.ok(e, '传下来的名单必须真的被用上，不是摆设');
      assert.equal(e.code, 'CALLNAME');
    });
    assert.equal(a.calls.length, 0, '两次都一个字没发');
  } finally { cleanup(); }
});

// ---------- ⚪ precheckSend 的三种状态要分得开 ----------

test('precheckSend：纯空白草稿如实说「空的」，不许显示成没问题', async () => {
  const pre = precheckSend('   \n  ', FENG(), { __test: { people: PEOPLE } });
  assert.equal(pre.empty, true);
});

test('precheckSend：勾了「就按原文发」，称呼门要跟着反映，别跟实际行为对不上', async () => {
  const bare = precheckSend('赵总您好', JERRY(), { __test: { people: PEOPLE } });
  assert.equal(bare.callName.ok, false);
  const bypass = precheckSend('赵总您好', JERRY(),
    { __test: { people: PEOPLE }, allowFormalName: true });
  assert.equal(bypass.callName.ok, true);
  assert.equal(bypass.callName.bypassed, true);
  assert.equal(bypass.callName.vios.length, 1, '绕过了也要留着违规明细给界面显示');
});

// ---------- lib：花钱的那个二进制也要有开关 ----------

test('BIN.claude 认 MAILROOM_CLAUDE_BIN（不然一条走归位的测试就真跑 claude 花钱）', async () => {
  const libUrl = new URL('../lib.mjs', import.meta.url).href;
  const out = execFileSync(process.execPath,
    ['--input-type=module', '-e', `import { BIN } from ${JSON.stringify(libUrl)}; console.log(BIN.claude);`],
    { env: { ...process.env, MAILROOM_CLAUDE_BIN: '/tmp/假的-claude' }, encoding: 'utf-8' });
  assert.equal(out.trim(), '/tmp/假的-claude');
});

// ---------- ⚠ stage：这个错到底能不能放心重试 ----------
//
// ⚠⚠ 这一节是补 2026-08-10 那个漏的：`stage` 这个字符串原来只出现在 send.mjs 两处、
//   bin/send.mjs 一处，**没有一条测试断言过它的值** —— 于是两边写的不是同一个字符串
//   （'unknown' vs 'transport'），最要紧的那句「消息可能已经发出去了，别急着重发」
//   一次都没打印过，而且谁都不会发现。

test('⚠ 传输层抛错 = 结果不明：stage 标 unknown（不许说成「确定没发出去」）', async () => {
  const a = spyAdapter({ throws: 'hap 超时' });
  await asDesk(async () => {
    const e = await sendReply(FENG(), 'DNS 那条我看了', OK,
      { __test: { adapter: a, people: PEOPLE } }).then(() => null, (err) => err);
    assert.ok(e);
    assert.equal(e.stage, 'unknown');
  });
});

test('⚠ 适配器自己标了 pre-send（比如存草稿失败）就不许被覆盖成 unknown', async () => {
  // 存草稿失败最坏只是草稿箱里少一份草稿，一个字都没到对方那儿 —— 明确可以重试。
  const a = {
    calls: [],
    sendVia() {
      const e = new Error('Graph 500');
      e.stage = 'pre-send';
      throw e;
    },
  };
  await asDesk(async () => {
    const e = await sendReply(FENG(), 'DNS 那条我看了', OK,
      { __test: { adapter: a, people: PEOPLE } }).then(() => null, (err) => err);
    assert.equal(e.stage, 'pre-send', '被覆盖成 unknown 的话，小明 就不敢重试一件确定没发生的事');
  });
});

test('⚠ 门那一层抛的错永远是 pre-send', async () => {
  const a = spyAdapter();
  await asDesk(async () => {
    const e = await sendReply(JERRY(), '赵总您好', OK, { __test: { adapter: a, people: PEOPLE } })
      .then(() => null, (err) => err);
    assert.equal(e.code, 'CALLNAME');
    assert.equal(e.stage, 'pre-send');
  });
});

test('⚠⚠ stage 的字面量三处必须对得上（send.mjs 打的 / bin 认的 / 适配器打的）', () => {
  const code = (f) => readFileSync(join(ROOT, f), 'utf-8');
  const lits = (src, re) => new Set([...src.matchAll(re)].map((m) => m[1]));

  const 打的 = lits(code('send.mjs'), /\.stage\s*=\s*'([^']+)'/g);
  assert.deepEqual([...打的].sort(), ['pre-send', 'unknown'], 'stage 只许有这两级');

  // bin/send.mjs 认的每一个值，send.mjs 都必须真的会打上——
  // 对不上就是「那句提醒永远不出现」，而且没有任何报错。
  const 认的 = lits(code('bin/send.mjs'), /\.stage\s*===\s*'([^']+)'/g);
  assert.ok(认的.size > 0, 'bin/send.mjs 里那句「可能已经发出去了」的判断不见了');
  for (const v of 认的) {
    assert.ok(打的.has(v), `bin/send.mjs 认的 stage '${v}' 在 send.mjs 里根本不会被打上`);
  }

  // 适配器也不许自己发明第三个值
  for (const f of ['connect/mail.mjs', 'connect/hap.mjs']) {
    for (const v of lits(code(f), /\.stage\s*=\s*'([^']+)'/g)) {
      assert.ok(打的.has(v), `${f} 打了一个 send.mjs 不认识的 stage：'${v}'`);
    }
  }
});

// ---------- ⚠ 草稿不补身份声明 ----------
//
// 小明 定的：内部同事带，外部客户不带。道理也自洽——草稿是**他本人**点的发送，
// 不是 Claude 发的，本来就不需要声明。
// ⚠ 判据不在 send.mjs 里猜，靠适配器显式导出的 deliveryMode()。

function draftAdapter(mode = 'draft') {
  const calls = [];
  return {
    calls,
    deliveryMode: () => mode,
    sendVia(item, body) {
      calls.push({ item, body });
      return mode === 'draft'
        ? { channel: '邮件草稿', to: `${item.who}（草稿…去点发送）`, draft: true }
        : { channel: '邮件', to: item.who };
    },
  };
}

test('⚠ deliveryMode 说 draft：正文一个字不加，不补身份声明', async () => {
  const { root, cleanup } = tmpDailymd();
  const a = draftAdapter('draft');
  try {
    await asDesk(async () => {
      const r = await sendReply(FENG(), '您好，报价见附件。', OK,
        { __test: { adapter: a, people: PEOPLE }, dailymd: root });
      assert.equal(a.calls[0].body, '您好，报价见附件。');
      assert.doesNotMatch(a.calls[0].body, /AI Agent/, '草稿是 小明 本人点发送的，不该带声明');
      assert.equal(r.body, '您好，报价见附件。');
    });
  } finally { cleanup(); }
});

test('⚠ deliveryMode 说 send / 或者压根没有这个函数：声明照旧补上', async () => {
  const { root, cleanup } = tmpDailymd();
  try {
    await asDesk(async () => {
      const a = draftAdapter('send');
      await sendReply(FENG(), '收到', OK, { __test: { adapter: a, people: PEOPLE }, dailymd: root });
      assert.match(a.calls[0].body, /^🤖 我是 小明 的 AI Agent/);

      const b = spyAdapter();   // 明道云那种没有 deliveryMode 的适配器，行为一个字不变
      await sendReply(FENG(), '收到', OK, { __test: { adapter: b, people: PEOPLE }, dailymd: root });
      assert.match(b.calls[0].body, /^🤖 我是 小明 的 AI Agent/);
    });
  } finally { cleanup(); }
});

test('⚠ 草稿照样过称呼门', async () => {
  const a = draftAdapter('draft');
  await asDesk(async () => {
    await assert.rejects(
      () => sendReply(JERRY(), '赵总您好，方案见附件', OK, { __test: { adapter: a, people: PEOPLE } }),
      (e) => e.code === 'CALLNAME',
    );
  });
  assert.equal(a.calls.length, 0);
});

test('⚠ 预检跟真发在「补不补声明」上不许漂移（草稿路径也一样）', async () => {
  const { root, cleanup } = tmpDailymd();
  try {
    for (const mode of ['draft', 'send']) {
      const a = draftAdapter(mode);
      const pre = precheckSend('您好，报价见附件。', FENG(), { __test: { adapter: a, people: PEOPLE } });
      await asDesk(async () => {
        await sendReply(FENG(), '您好，报价见附件。', OK,
          { __test: { adapter: a, people: PEOPLE }, dailymd: root });
      });
      assert.equal(pre.agentPrefix.body, a.calls[0].body,
        `${mode}：预检说发出去长这样，实际发的却是另一样`);
      assert.equal(pre.agentPrefix.draft, mode === 'draft');
    }
  } finally { cleanup(); }
});

// ---------- 草稿落进 inbox.md 的措辞 ----------
//
// ⚠⚠ 外部收件人的邮件只能存草稿，还躺在 小明 自己的草稿箱里等他点发送。
//   时间线上第一个词写「已发」= 一周后他翻记录会以为客户早就收到了。

test('存草稿：inbox.md 里那一行是「草稿」，一个「已发」都不许有', async () => {
  const { root, cleanup } = tmpDailymd();
  // 邮件适配器存草稿时的真实回执形状（connect/mail.mjs 的 external 分支）
  const a = {
    calls: [],
    deliveryMode: () => 'draft',
    sendVia(item, body) {
      this.calls.push({ item, body });
      return {
        channel: '邮件草稿',
        to: `${item.who}（草稿已放进你的 Outlook 草稿箱，去点发送）`,
        link: 'https://outlook.office.com/draft/1',
        draft: true,
      };
    },
  };
  try {
    await asDesk(async () => {
      await sendReply(FENG(), '报价我这周给你', OK,
        { __test: { adapter: a, people: PEOPLE }, dailymd: root });
    });
    const text = readFileSync(inboxOf(root), 'utf-8');
    assert.match(text, /^> 草稿 · /m, '草稿那一行必须以「草稿」开头');
    assert.doesNotMatch(text, /已发/, '草稿块里出现「已发」正是「误以为已经回了客户」那一类');
    assert.match(text, /报价我这周给你/, '正文照旧落盘');
  } finally { cleanup(); }
});

test('真发出去的仍然写「已发」（别把两种状态混成一种）', async () => {
  const { root, cleanup } = tmpDailymd();
  const a = spyAdapter();
  try {
    await asDesk(async () => {
      await sendReply(FENG(), 'DNS 那条我看了', OK,
        { __test: { adapter: a, people: PEOPLE }, dailymd: root });
    });
    const text = readFileSync(inboxOf(root), 'utf-8');
    assert.match(text, /^> 已发 · /m);
    assert.doesNotMatch(text, /^> 草稿 · /m);
  } finally { cleanup(); }
});

// ---------- 发信总账（2026-08-12） ----------

test('档位算得对', () => {
  assert.equal(tierOf({ auto: '理由', wantDm: false, isGroup: false, isTask: false }), '🟢');
  assert.equal(tierOf({ auto: '', wantDm: true, isGroup: false, isTask: false }), '🔴');
  assert.equal(tierOf({ auto: '', wantDm: false, isGroup: true, isTask: false }), '🔴');
  assert.equal(tierOf({ auto: '', wantDm: false, isGroup: false, isTask: true }), '🔴',
    '任务评论受众是整个任务的参与人，比私信广，归 🔴');
  assert.equal(tierOf({ auto: '', wantDm: false, isGroup: false, isTask: false }), '🟡');
});

test('只有 🟡 必填 --why', () => {
  assert.equal(needWhy({ tier: '🟡', isDraft: false }), true);
  assert.equal(needWhy({ tier: '🟢', isDraft: false }), false, '🟢 的理由走 --auto');
  assert.equal(needWhy({ tier: '🔴', isDraft: false }), false, '🔴 有两步确认码，小明 本人背书');
  assert.equal(needWhy({ tier: '🟡', isDraft: true }), false,
    '存草稿的那封信一个字都没出去，最终是 小明 自己点的发送');
});

// ---------- 主线：main() 真的会拒发 / 真的会记账（修复轮 1，补的自动化覆盖） ----------
//
// 上面两条只验了 tierOf/needWhy 这两个纯函数本身，没有任何测试证明 bin/send.mjs
// 的 main() 真的会调它们、真的会拒发、真的会记账——这两条补上。

test('主线 · 命令行缺 --why 的 🟡 当场拒发：没到传输层，账本也没多一行', () => {
  // ⚠ 真子进程跑 bin/send.mjs（不是重实现它的门），用一个**真实存在**的段——
  //   跟 小明 之前打回的那条「起子进程测 --seg 不存在的段」不一样：那条两个分支
  //   都能通过，验不出东西；这条段是真的，能唯一定位到「就是 --why 这道门拦的」。
  const dm = tmpDailymd();
  // ⚠ 用 mkdtempSync 直接建一个独立目录，不借 tmpState()——那个会把
  //   process.env.MAILROOM_STATE 也顶掉，这条测试只靠子进程的 env 传参就够了，
  //   没必要动当前进程的环境变量。
  const stateDir = mkdtempSync(join(tmpdir(), 'mailroom-state-'));
  try {
    mkdirSync(join(dm.root, 'contactmd'), { recursive: true });
    writeFileSync(join(dm.root, 'contactmd/contacts.json'), JSON.stringify([
      { name: '李雷', nickname: '雷哥', md_account_id: 'acc-lilei' },
    ]));
    writeFileSync(join(stateDir, 'segments.json'), JSON.stringify([{
      id: 'seg-u', sourceKind: 'mingdao', sourceType: 'user', sourceLabel: '明道云 · 私信',
      who: '李雷', whoAccountId: 'acc-lilei', target: { accountId: 'acc-lilei' },
    }]));
    let out = '';
    let code = 0;
    try {
      out = execFileSync(process.execPath,
        [join(ROOT, 'bin/send.mjs'), '--seg', 'seg-u', '--text', '收到，我看一下。'],
        {
          encoding: 'utf-8',
          env: { ...process.env, MAILROOM_TEST: '1', MAILROOM_DAILYMD: dm.root, MAILROOM_STATE: stateDir },
        });
    } catch (e) {
      code = e.status;
      out = String(e.stdout || '') + String(e.stderr || '');
    }
    assert.equal(code, 1);
    assert.match(out, /必须带 --why/, '拒发理由要点名缺的是 --why');
    // ⚠ 真正钉住「一个字都没发出去」的信号：没有走到 assertNoRealIO 那道物理门
    //   （走到了会报「不许真跑 hap chat」）——传输层压根没被碰，不是碰了被物理挡住。
    assert.doesNotMatch(out, /不许真跑 hap chat/);
    assert.doesNotMatch(out, /已发出|还没有发出去/);
    assert.equal(existsSync(join(stateDir, 'outbox.jsonl')), false, '被拦下就不该有任何一行账');
  } finally { dm.cleanup(); rmSync(stateDir, { recursive: true, force: true }); }
});

test('主线 · 命令行真的把一条 🟡 发出去之后，账本多一行：tier=🟡、why 是命令行给的那句、session 是登记表查出来的名字', () => {
  // ⚠ 这条要验的是 main() 自己真的调用了 logSent，不是「把它的逻辑在测试里再抄一遍」——
  //   抄一遍的话，main() 里那行 logSent 被删掉，测试照样绿，就白测了。所以这条必须
  //   起真子进程、把 bin/send.mjs 走到底。
  // ⚠ 拿掉两处会碰真 IO 的地方，而不是索性放开 MAILROOM_ALLOW_REAL_IO 图省事：
  //   ① recheckBeforeSend 内部会去跑一整轮真实取信（mingdao/imap/ms365）——跟 --seg/--why
  //     无关，只要没显式跳过就会触发，这是唯一真正危险的部分，用命令行本来就有的
  //     --skip-recheck 避开，不是新开的口子。
  //   ② 真发那一下：不放开真 hap，是把 MAILROOM_HAP_BIN（lib.mjs 自己在 assertNoRealIO
  //     注释里点名允许的口子）指到一个只 `exit 0` 的假二进制上，配合 MAILROOM_ALLOW_REAL_IO=1
  //     解除那道物理门——碰的是这个假二进制，不是真 hap，跟 cli.test.mjs 那条 ssh 转发
  //     测试顶掉 ssh 二进制是同一个手法。
  const dm = tmpDailymd();
  const stateDir = mkdtempSync(join(tmpdir(), 'mailroom-state-'));
  const sessDir = mkdtempSync(join(tmpdir(), 'mailroom-sessions-'));
  const binDir = mkdtempSync(join(tmpdir(), 'mailroom-hap-stub-'));
  const sessionName = 'dailymd-测试会话';
  try {
    mkdirSync(join(dm.root, 'contactmd'), { recursive: true });
    writeFileSync(join(dm.root, 'contactmd/contacts.json'), JSON.stringify([
      { name: '李雷', nickname: '雷哥', md_account_id: 'acc-lilei' },
    ]));
    writeFileSync(join(stateDir, 'segments.json'), JSON.stringify([{
      id: 'seg-u', sourceKind: 'mingdao', sourceType: 'user', sourceLabel: '明道云 · 私信',
      who: '李雷', whoAccountId: 'acc-lilei', target: { accountId: 'acc-lilei' },
    }]));
    const hapStub = join(binDir, 'hap');
    writeFileSync(hapStub, '#!/bin/sh\nexit 0\n');
    chmodSync(hapStub, 0o755);
    writeFileSync(join(sessDir, '1.json'), JSON.stringify({
      pid: process.pid, sessionId: 'uuid-outbox-测试', name: sessionName, cwd: '/x', status: 'idle',
    }));

    const why = '对方问进度，纯回执，无承诺';
    const out = execFileSync(process.execPath,
      [join(ROOT, 'bin/send.mjs'), '--seg', 'seg-u', '--text', '收到，我看一下。', '--why', why, '--skip-recheck'],
      {
        encoding: 'utf-8',
        env: {
          ...process.env,
          MAILROOM_DAILYMD: dm.root,
          MAILROOM_STATE: stateDir,
          MAILROOM_HAP_BIN: hapStub,
          MAILROOM_ALLOW_REAL_IO: '1',
          MAILROOM_SESSIONS: sessDir,
          CLAUDE_CODE_SESSION_ID: 'uuid-outbox-测试',
        },
      });
    assert.match(out, /已发出/, `这条应该真的走完发送；实际输出：${out}`);

    const rows = readFileSync(join(stateDir, 'outbox.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(rows.length, 1, '账本应该多且只多这一行');
    assert.equal(rows[0].tier, '🟡');
    assert.equal(rows[0].why, why, 'why 得是命令行给的那句');
    assert.equal(rows[0].result, 'sent');
    assert.equal(rows[0].session, sessionName, 'session 得是从登记表查出来的名字，不是调用方随手填的');
    assert.equal(rows[0].sessionId, 'uuid-outbox-测试');
    assert.equal(rows[0].accountId, 'acc-lilei', '私信这一栏照旧是收件人的 accountId');
  } finally {
    dm.cleanup();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(sessDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

test('主线 · 🔴 群消息发出去之后，账上认得出是哪个群（accountId 对群恒为空，那一栏放 groupId）', () => {
  // ⚠ 2026-08-13 补：群和任务评论的 `pre.to.accountId` 恒为空（收件人不是某一个人），
  //   在这之前账上只剩一个群名，事后根本定位不到是哪个群。复用同一栏放对方那一侧的
  //   机器 id：私信是 accountId、群是 groupId、任务评论是 taskId。
  // ⚠ 手法跟上一条一样：真子进程 + 假 hap 二进制 + --skip-recheck，不碰任何真 IO。
  //   群走 🔴，所以要跑两趟：第一趟拿确认码，第二趟带着码真发。
  const dm = tmpDailymd();
  const stateDir = mkdtempSync(join(tmpdir(), 'mailroom-state-'));
  const binDir = mkdtempSync(join(tmpdir(), 'mailroom-hap-stub-'));
  try {
    mkdirSync(join(dm.root, 'contactmd'), { recursive: true });
    writeFileSync(join(dm.root, 'contactmd/contacts.json'), JSON.stringify([
      { name: '李雷', nickname: '雷哥', md_account_id: 'acc-lilei' },
    ]));
    writeFileSync(join(stateDir, 'segments.json'), JSON.stringify([{
      id: 'seg-g', sourceKind: 'mingdao', sourceType: 'group', sourceLabel: '明道云 · 群「Ops Team」',
      who: '李雷', whoAccountId: 'acc-lilei',
      target: { groupId: 'grp-ops', groupName: 'Ops Team' },
    }]));
    const hapStub = join(binDir, 'hap');
    writeFileSync(hapStub, '#!/bin/sh\nexit 0\n');
    chmodSync(hapStub, 0o755);
    const env = {
      ...process.env,
      MAILROOM_DAILYMD: dm.root,
      MAILROOM_STATE: stateDir,
      MAILROOM_HAP_BIN: hapStub,
      MAILROOM_ALLOW_REAL_IO: '1',
    };
    const argv = ['--seg', 'seg-g', '--text', '收到，我看一下。', '--skip-recheck'];
    const first = execFileSync(process.execPath, [join(ROOT, 'bin/send.mjs'), ...argv],
      { encoding: 'utf-8', env });
    assert.match(first, /还没有发出去/, '群走 🔴，第一趟只该预览');
    assert.equal(existsSync(join(stateDir, 'outbox.jsonl')), false, '只预览不许记账');
    const token = (first.match(/--confirm ([a-z0-9-]+)/) || [])[1];
    assert.ok(token, `第一趟得给出确认码；实际输出：${first}`);

    const second = execFileSync(process.execPath,
      [join(ROOT, 'bin/send.mjs'), ...argv, '--confirm', token], { encoding: 'utf-8', env });
    assert.match(second, /已发出/, `第二趟该真发；实际输出：${second}`);

    const rows = readFileSync(join(stateDir, 'outbox.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tier, '🔴');
    assert.equal(rows[0].channel, '群消息');
    assert.equal(rows[0].accountId, 'grp-ops',
      '群这一栏得是 groupId——只留群名的话，事后定位不到是哪个群');
  } finally {
    dm.cleanup();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

test('主线 · 🔴 任务评论发出去之后，账上那一栏是 taskId，不是评论人的 accountId', () => {
  // ⚠⚠ 2026-08-13 复审逮到的：第一版写成 `pre.to.accountId || (groupId || taskId)`，
  //   taskId 那一支**永远走不到** —— recipientOf 对任务通知段返回的是
  //   `{kind:'user', accountId: whoAccountId}`（评论人的 accountId，正常都有值），
  //   于是账上记的是评论人，而注释里写着「任务评论记 taskId」。当时只 e2e 测了群那一支，
  //   任务评论这一支没测试，才让它漏过去 —— 这条就是补那个缺口的。
  // ⚠ 手法同群那条：真子进程 + 假 hap 二进制 + --skip-recheck，不碰任何真 IO。
  const dm = tmpDailymd();
  const stateDir = mkdtempSync(join(tmpdir(), 'mailroom-state-'));
  const binDir = mkdtempSync(join(tmpdir(), 'mailroom-hap-stub-'));
  try {
    mkdirSync(join(dm.root, 'contactmd'), { recursive: true });
    writeFileSync(join(dm.root, 'contactmd/contacts.json'), JSON.stringify([
      { name: '李雷', nickname: '雷哥', md_account_id: 'acc-lilei' },
    ]));
    writeFileSync(join(stateDir, 'segments.json'), JSON.stringify([{
      id: 'seg-t', sourceKind: 'mingdao', sourceType: 'notice', sourceLabel: '明道云 · 任务通知',
      // ⚠ 评论人的 accountId 是有值的 —— 这正是当年把 taskId 那一支挤掉的那个值
      who: '李雷', whoAccountId: 'acc-lilei',
      target: { replyVia: 'task', taskId: 'task-abc', recordName: 'Real AI 评委邀请' },
    }]));
    const hapStub = join(binDir, 'hap');
    writeFileSync(hapStub, '#!/bin/sh\nexit 0\n');
    chmodSync(hapStub, 0o755);
    const env = {
      ...process.env,
      MAILROOM_DAILYMD: dm.root,
      MAILROOM_STATE: stateDir,
      MAILROOM_HAP_BIN: hapStub,
      MAILROOM_ALLOW_REAL_IO: '1',
    };
    const argv = ['--seg', 'seg-t', '--text', '收到，我看一下。', '--skip-recheck'];
    const first = execFileSync(process.execPath, [join(ROOT, 'bin/send.mjs'), ...argv],
      { encoding: 'utf-8', env });
    assert.match(first, /还没有发出去/, '任务评论走 🔴，第一趟只该预览');
    const token = (first.match(/--confirm ([a-z0-9-]+)/) || [])[1];
    assert.ok(token, `第一趟得给出确认码；实际输出：${first}`);

    const second = execFileSync(process.execPath,
      [join(ROOT, 'bin/send.mjs'), ...argv, '--confirm', token], { encoding: 'utf-8', env });
    assert.match(second, /已发出/, `第二趟该真发；实际输出：${second}`);

    const rows = readFileSync(join(stateDir, 'outbox.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tier, '🔴');
    assert.equal(rows[0].channel, '任务评论');
    assert.equal(rows[0].accountId, 'task-abc',
      '这一栏得是 taskId——记成评论人的 accountId 就定位不到发去了哪个任务');
    assert.notEqual(rows[0].accountId, 'acc-lilei', '别被评论人的 accountId 挤掉');
    assert.equal(rows[0].to, '李雷', '人是谁靠 to 这一栏，不靠 accountId');
  } finally {
    dm.cleanup();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

test('主线 · 发失败那行账带齐 tier/channel/accountId/正文（stage=unknown 那条要计入 🟢 的频次门）', () => {
  // ⚠ 2026-08-13 补：失败那行原来只有 session/to/seg/result/why——
  //   ① `mailroom out` 里看不出这条走哪条通道、发的什么；
  //   ② stage='unknown'（**可能已经投出去了**）因为 tier/accountId 空着，不计入
  //     🟢 的频次门（recentCount 按 accountId 数、只数 🟢），额度白白多一条。
  // ⚠ 怎么造失败：MAILROOM_TEST=1 那道物理门会在真打 hap 之前抛错——不放开
  //   MAILROOM_ALLOW_REAL_IO，一个字节都到不了传输层。--skip-recheck 是为了避开
  //   recheckBeforeSend 里那一整轮真实取信（跟这条要验的东西无关）。
  const dm = tmpDailymd();
  const stateDir = mkdtempSync(join(tmpdir(), 'mailroom-state-'));
  try {
    mkdirSync(join(dm.root, 'contactmd'), { recursive: true });
    writeFileSync(join(dm.root, 'contactmd/contacts.json'), JSON.stringify([
      { name: '李雷', nickname: '雷哥', md_account_id: 'acc-lilei' },
    ]));
    writeFileSync(join(stateDir, 'segments.json'), JSON.stringify([{
      id: 'seg-u', sourceKind: 'mingdao', sourceType: 'user', sourceLabel: '明道云 · 私信',
      who: '李雷', whoAccountId: 'acc-lilei', target: { accountId: 'acc-lilei' },
    }]));
    let out = '';
    try {
      out = execFileSync(process.execPath, [join(ROOT, 'bin/send.mjs'),
        '--seg', 'seg-u', '--text', '收到，我看一下。', '--why', '纯回执', '--skip-recheck'], {
        encoding: 'utf-8',
        env: { ...process.env, MAILROOM_TEST: '1', MAILROOM_DAILYMD: dm.root, MAILROOM_STATE: stateDir },
      });
    } catch (e) {
      out = String(e.stdout || '') + String(e.stderr || '');
    }
    assert.match(out, /发送失败/, `这条该在传输层失败；实际输出：${out}`);

    const rows = readFileSync(join(stateDir, 'outbox.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(rows.length, 1, '失败也必须留一行账');
    assert.equal(rows[0].result, 'failed');
    assert.equal(rows[0].tier, '🟡', 'tier 不许空——空的话 🟢 的频次门就漏数了');
    assert.equal(rows[0].accountId, 'acc-lilei', 'accountId 不许空，同上');
    assert.ok(rows[0].channel, `channel 不许空（发去哪一条线）：${JSON.stringify(rows[0])}`);
    assert.equal(rows[0].to, '李雷');
    assert.equal(rows[0].seg, 'seg-u');
    assert.match(rows[0].text, /收到，我看一下。/, '发的什么也得记下来——可能已经投出去了');
    assert.match(rows[0].why, /\[stage=/, 'why 里要带 stage，分得出「崩在发之前」和「可能已经发出去了」');
  } finally { dm.cleanup(); rmSync(stateDir, { recursive: true, force: true }); }
});

test('⑨ 仓库里除了 outbox.mjs 自己，没有别的 .mjs 能 import appendOutbox / outboxFile（裸写入的原语）', async () => {
  // ⚠⚠ 跟 ⑧「唯一发送出口」同一种病：账本一旦能被绕开写，「发了什么」和
  //   「账上记了什么」就会对不上，而且没人会发现。
  // ⚠ 修复轮 1：原来钉的是字面量 'outbox.jsonl'，两个洞——
  //   ① 弱：outbox.mjs 已经把 appendOutbox 和 outboxFile 都导出了，谁 import
  //     outboxFile() 拿到路径再自己 appendFileSync，一个字面量都不出现，照样能
  //     开出第二本账，这条测试却是绿的。
  //   ② 误伤：任何 .mjs 在非注释行提一句这个文件名就红，包括纯帮助文本——
  //     下一个任务要写 bin/outbox-report.mjs，大概率第一时间撞上，届时的压力
  //     会是「把测试改松」，那正是这个仓库最怕的事。
  //   改成钉 import：logSent / readOutbox / recentOutbox / migrateAutosendOnce
  //   是公开的读写口，随便用；appendOutbox / outboxFile 是裸写入原语，只有
  //   outbox.mjs 自己能碰——钉字符串钉不住，钉原语的 import 才钉得住。
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name.startsWith('.')) return [];
    if (e.isDirectory()) return ['test', 'node_modules'].includes(e.name) ? [] : walk(join(dir, e.name));
    return e.name.endsWith('.mjs') ? [join(dir, e.name)] : [];
  });
  const bad = [];
  for (const f of walk(ROOT)) {
    const base = f.slice(ROOT.length).replace(/^\//, '');
    if (base === 'outbox.mjs') continue;
    // 注释行先剥掉，免得一句「outboxFile 是裸写入原语」的说明把自己判成违规
    const code = readFileSync(f, 'utf-8').split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    // ⚠ 2026-08-13 修的两个洞：
    //   ① 原来是 `code.match(...)`（没有 /g），只查每个文件的**第一条** import ——
    //     第二条 import outbox.mjs 的语句怎么写都查不到。改成 matchAll，条条都查。
    //   ② `import * as outbox from './outbox.mjs'` 一样能拿到 appendOutbox/outboxFile，
    //     而花括号那个正则压根匹配不上它。单独补一条判定。
    for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]\.{1,2}\/outbox\.mjs['"]/g)) {
      if (/\b(appendOutbox|outboxFile)\b/.test(m[1])) bad.push(base);
    }
    if (/import\s+\*\s+as\s+\w+\s+from\s*['"]\.{1,2}\/outbox\.mjs['"]/.test(code)) {
      bad.push(`${base}（import * as：整个模块拿过去，裸写入原语一起带走了）`);
    }
  }
  assert.deepEqual(bad, [], `这些文件 import 了裸写入原语，开了第二条记账路：${bad.join(', ')}`);
});
