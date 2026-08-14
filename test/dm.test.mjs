// 主动发起私信（`--to`）这条新路的护栏。
//
// ⚠⚠ 跟 test/send.test.mjs 一个规矩：**一条真消息都不许发出去**。
//   `hap chat send-to-one` 对任何 accountId 都回 `Message sent.`，跑错一次就是真往
//   同事那儿发了一条，而明道云没有撤回接口。所以：
//     · 单元测试注入假 hap（`io.hap`）和假适配器（`opts.__test.adapter`）；
//     · 端到端那几条走真 bin/send.mjs 子进程，但设 MAILROOM_TEST=1 ——
//       lib.assertNoRealIO 会在真打 hap 之前抛错，等于物理上发不出去。
//
// 这条路存在的理由见 dm.mjs 顶部：原来只能回复已收到的段，主动私信一位从没
// 私信过 小明 的同事没有入口，而绕过 send.mjs 直接敲 hap 正是 2026-08-08 事故的形状。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveRecipient, synthDm, confirmToken, offHours } from '../dm.mjs';
import { sendReply, precheckSend } from '../send.mjs';
import { tmpDailymd, tmpState } from './helpers.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OK = { source: 'approval-desk-button' };

let box = null;
before(() => {
  box = tmpState();
  process.env.MAILROOM_TEST = '1';
});
after(() => {
  if (box) box.cleanup();
  delete process.env.MAILROOM_TEST;
});

const PEOPLE = [
  { name: '赵四', nickname: '老赵', md_account_id: 'acc-jerry' },
  { name: '李雷', nickname: '雷哥', md_account_id: 'acc-zhangfeng' },
  { name: '周婷', md_account_id: 'acc-sevi' },
];

// MAILROOM_ROLE 是进程级的，改完必须还原（照搬 send.test.mjs 那份：异步的那一支
// 要等 promise 结束才还原，否则第一个 await 一挂起就把变量还回去了）。
function asDesk(fn) {
  const prev = process.env.MAILROOM_ROLE;
  process.env.MAILROOM_ROLE = 'approval-desk';
  const restore = () => {
    if (prev === undefined) delete process.env.MAILROOM_ROLE;
    else process.env.MAILROOM_ROLE = prev;
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

// 假适配器：记下被要求发什么，绝不真打 hap。
function spyAdapter() {
  const calls = [];
  return {
    calls,
    sendVia(item, body) {
      calls.push({ item, body });
      return { channel: '私信', to: item.who };
    },
  };
}

// ---------- 收件人解析 ----------

test('本地通讯录精确命中，不打网络', () => {
  let called = false;
  const r = resolveRecipient('周婷', {
    people: PEOPLE,
    io: { hap: () => { called = true; return { candidates: [] }; } },
  });
  assert.equal(r.accountId, 'acc-sevi');
  assert.equal(r.name, '周婷');
  assert.equal(called, false, '本地对得上就不该再去问 hap');
});

test('按 nickname 也能命中（小明 平时就叫雷哥，不叫李雷）', () => {
  const r = resolveRecipient('雷哥', { people: PEOPLE, io: { hap: () => { throw new Error('不该被调用'); } } });
  assert.equal(r.accountId, 'acc-zhangfeng');
});

test('⚠ 不做模糊匹配：「周」不许悄悄命中「周婷」', () => {
  // 本地不命中就会退回 hap，这里让 hap 也返回空 —— 要的是「拒绝」，不是「猜一个」。
  assert.throws(
    () => resolveRecipient('周', { people: PEOPLE, io: { hap: () => ({ candidates: [] }) } }),
    /找不到/,
  );
});

test('⚠⚠ 歧义一律拒发，绝不取第一个（发错人跟发错内容一样收不回来）', () => {
  const io = {
    hap: () => ({
      candidates: [
        { id: 'a1', name: '王刚', company: '甲公司' },
        { id: 'a2', name: '王刚', company: '乙公司' },
      ],
    }),
  };
  assert.throws(() => resolveRecipient('王刚', { people: PEOPLE, io }), /对上了 2 个人/);
  // 报错里要带上 --account-id 的用法，否则人卡在这儿不知道下一步怎么办
  assert.throws(() => resolveRecipient('王刚', { people: PEOPLE, io }), /--account-id a1/);
});

test('本地重名（两个人同名且都有 account id）也拒发', () => {
  const dupes = [
    { name: '王刚', md_account_id: 'x1' },
    { name: '王刚', md_account_id: 'x2' },
  ];
  assert.throws(() => resolveRecipient('王刚', { people: dupes }), /本地通讯录里对上了 2 个人/);
});

test('⚠ 不看返回里的 total（实测 total=0 而 candidates 有 1 条）', () => {
  const r = resolveRecipient('周婷', {
    people: [],
    io: { hap: () => ({ total: 0, candidates: [{ id: 'acc-remote', name: '周婷' }] }) },
  });
  assert.equal(r.accountId, 'acc-remote');
});

test('通讯录里没这个人 → 拒发', () => {
  assert.throws(
    () => resolveRecipient('查无此人', { people: PEOPLE, io: { hap: () => ({ candidates: [] }) } }),
    /找不到/,
  );
});

test('空关键词 → 拒发', () => {
  assert.throws(() => resolveRecipient('  ', { people: PEOPLE }), /没说发给谁/);
});

// ---------- 合成段能被 send.mjs 的每一道门认出来 ----------

test('⚠⚠ 合成段走完 sendReply：kind=user、accountId 对、身份声明照补', async () => {
  const a = spyAdapter();
  const item = synthDm({ accountId: 'acc-sevi', name: '周婷' });
  const r = await asDesk(() => sendReply(item, '金山 WPS 那条我在跟，同步你一下。', OK,
    { __test: { adapter: a, people: PEOPLE } }));

  assert.equal(a.calls.length, 1);
  // sendVia 拿到的 kind 必须是 'user'，否则 connect/hap.mjs 会一路 fallthrough 抛
  // 「未知的消息类型」——这正是段上叫 sourceType、候选上叫 kind 那个坑。
  assert.equal(a.calls[0].item.kind, 'user');
  assert.equal(a.calls[0].item.target.accountId, 'acc-sevi');
  // 主动发起的私信是 Claude 发的，身份声明一个字都不能少
  assert.match(a.calls[0].body, /AI Agent/);
  assert.match(a.calls[0].body, /金山 WPS 那条我在跟/);
  assert.equal(r.channel, '私信');
});

test('⚠⚠ 称呼门对主动私信同样生效（「赵总您好」照样拦）', async () => {
  const a = spyAdapter();
  const item = synthDm({ accountId: 'acc-jerry', name: '赵四' });
  await assert.rejects(
    () => asDesk(() => sendReply(item, '赵总您好，帮助中心那事…', OK,
      { __test: { adapter: a, people: PEOPLE } })),
    (e) => e.code === 'CALLNAME',
  );
  assert.equal(a.calls.length, 0, '被称呼门拦下就一个字都不许发出去');
});

test('没给 filed 的主动私信：兜底落进 P00-misc，且绝不 mkdir 造一个假任务目录出来', async () => {
  const dm = tmpDailymd();
  try {
    const a = spyAdapter();
    const before = readdirSync(join(dm.root, 'projects')).sort();
    const item = synthDm({ accountId: 'acc-sevi', name: '周婷' });
    const r = await asDesk(() => sendReply(item, '同步一下进度。', OK,
      { dailymd: dm.root, __test: { adapter: a, people: PEOPLE } }));
    assert.equal(r.filed.dir, join(dm.root, 'projects', 'P00-misc'), '没给落点也必须落盘');
    assert.equal(r.filed.level, 'misc');
    assert.match(readFileSync(join(dm.root, 'projects/P00-misc/inbox.md'), 'utf-8'), /我 → 周婷/);
    assert.deepEqual(readdirSync(join(dm.root, 'projects')).sort(), before,
      'projects/ 下不许因为发了条消息就多出目录');
  } finally {
    dm.cleanup();
  }
});

test('给了 filed 就把发出去的这条记进那个任务的 inbox.md', async () => {
  const dm = tmpDailymd();
  try {
    const a = spyAdapter();
    // 用假 dailymd 里真实存在的那个任务目录
    const project = 'P26-agent-ready-sites';
    const task = readdirSync(join(dm.root, 'projects', project, 'tasks'))[0];
    const item = synthDm({ accountId: 'acc-sevi', name: '周婷', filed: { project, task } });
    const r = await asDesk(() => sendReply(item, '金山 WPS 归属对一下。', OK,
      { dailymd: dm.root, __test: { adapter: a, people: PEOPLE } }));
    assert.ok(r.filed, '给了落点就该落盘');
    const md = readFileSync(join(dm.root, 'projects', project, 'tasks', task, 'inbox.md'), 'utf-8');
    assert.match(md, /我 → 周婷/);
    assert.match(md, /金山 WPS 归属对一下/);
    // 真发出去的绝不能渲染成「草稿」（那会让人以为还没发）
    assert.doesNotMatch(md, /> 草稿/);
  } finally {
    dm.cleanup();
  }
});

test('没有 account id 的合成段直接拒绝', () => {
  assert.throws(() => synthDm({ accountId: '', name: '张三' }), /没有 account id/);
});

// ---------- 确认码：小明 看到的那一版 == 发出去的那一版 ----------

test('⚠⚠ 正文改一个字，确认码就失效', () => {
  const t1 = confirmToken('acc-sevi', '金山 WPS 那条我在跟。');
  const t2 = confirmToken('acc-sevi', '金山 WPS 那条我在跟!');
  assert.notEqual(t1, t2);
});

test('⚠⚠ 换个收件人，确认码也失效（防「预览给 A 看、发给 B」）', () => {
  assert.notEqual(confirmToken('acc-sevi', '同一段话'), confirmToken('acc-jerry', '同一段话'));
});

test('同样的人 + 同样的正文 → 同一个码（不然第二步永远对不上）', () => {
  assert.equal(confirmToken('acc-sevi', '一样的话'), confirmToken('acc-sevi', '一样的话'));
});

// ---------- 别在休息时间发 ----------

test('工作日 09:00–19:00 之间放行', () => {
  assert.equal(offHours(new Date('2026-08-11T10:00:00')), '');   // 周二上午
  assert.equal(offHours(new Date('2026-08-11T18:59:00')), '');
});

test('太早 / 太晚 / 周末都拦下来', () => {
  assert.match(offHours(new Date('2026-08-11T08:30:00')), /才 8 点/);
  assert.match(offHours(new Date('2026-08-11T19:00:00')), /已经 19 点/);
  assert.match(offHours(new Date('2026-08-15T14:00:00')), /周六/);
  assert.match(offHours(new Date('2026-08-16T14:00:00')), /周日/);
});

// ---------- 端到端：真跑 bin/send.mjs ----------
//
// ⚠ 这几条设 MAILROOM_TEST=1，lib.assertNoRealIO 会在真打 hap 之前抛错。
//   也就是说就算下面某条不小心走到了发送那一步，物理上也发不出去。

function runCli(args, dailymd) {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [join(ROOT, 'bin/send.mjs'), ...args], {
        encoding: 'utf-8',
        cwd: ROOT,
        env: {
          ...process.env,
          MAILROOM_TEST: '1',
          MAILROOM_DAILYMD: dailymd,
          MAILROOM_STATE: box.dir,
        },
      }),
    };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

// 假 dailymd + 一份带 md_account_id 的假通讯录（称呼门和收件人解析都读它）
function dailymdWithContacts() {
  const dm = tmpDailymd();
  mkdirSync(join(dm.root, 'contactmd'), { recursive: true });
  writeFileSync(join(dm.root, 'contactmd/contacts.json'), JSON.stringify(PEOPLE));
  return dm;
}

test('⚠⚠ 第一步只预览、绝不发送：打出确认码，退出码 0', () => {
  const dm = dailymdWithContacts();
  try {
    const r = runCli(['--to', '周婷', '--text', '金山 WPS 那条我在跟，同步你一下。'], dm.root);
    assert.equal(r.code, 0, `预览不是失败，退出码该是 0；实际输出：${r.out}`);
    assert.match(r.out, /还没有发出去/);
    assert.match(r.out, /--confirm [a-z0-9-]+/);
    assert.match(r.out, /AI Agent/, '预览里要能看到补完声明后的完整正文');
    assert.doesNotMatch(r.out, /已发送|已发出/);
  } finally {
    dm.cleanup();
  }
});

test('⚠⚠ 确认码不对就不发（防预览之后正文被悄悄改掉）', () => {
  const dm = dailymdWithContacts();
  try {
    const r = runCli(['--to', '周婷', '--text', '换了一段话', '--confirm', 'deadbeef'], dm.root);
    assert.match(r.out, /确认码对不上/);
    assert.doesNotMatch(r.out, /已发送|已发出/);
  } finally {
    dm.cleanup();
  }
});

test('确认码对上之后才会走到真发那一步（被 assertNoRealIO 挡在传输层）', () => {
  const dm = dailymdWithContacts();
  try {
    const text = '金山 WPS 那条我在跟，同步你一下。';
    const first = runCli(['--to', '周婷', '--text', text], dm.root);
    const token = (first.out.match(/--confirm ([a-z0-9-]+)/) || [])[1];
    assert.ok(token, `第一步没给出确认码：${first.out}`);
    const second = runCli(['--to', '周婷', '--text', text, '--confirm', token, '--off-hours'], dm.root);
    // 走到了传输层 = 前面每一道门都过了。真 hap 被 MAILROOM_TEST 挡住，一条都没发出去。
    assert.doesNotMatch(second.out, /还没有发出去/, '码对上了就不该再停在预览');
    assert.match(second.out, /测试模式|assertNoRealIO|发送失败/i,
      `应该被测试模式挡在真打 hap 之前；实际输出：${second.out}`);
  } finally {
    dm.cleanup();
  }
});

test('--seg 和 --to 同时给 → 拒绝（两条路只能走一条）', () => {
  const dm = dailymdWithContacts();
  try {
    const r = runCli(['--seg', 'x1', '--to', '周婷', '--text', '话'], dm.root);
    assert.equal(r.code, 1);
    assert.match(r.out, /只能给一个/);
  } finally {
    dm.cleanup();
  }
});

test('什么都不给 → 打用法，两条路都要写出来', () => {
  const dm = dailymdWithContacts();
  try {
    const r = runCli([], dm.root);
    assert.equal(r.code, 1);
    assert.match(r.out, /--seg/);
    assert.match(r.out, /--to/);
  } finally {
    dm.cleanup();
  }
});

test('⚠ 称呼门在命令行这一路也拦得住（「赵总您好」发不出去）', () => {
  const dm = dailymdWithContacts();
  try {
    const text = '赵总您好，那事怎么说';
    const first = runCli(['--to', '赵四', '--text', text], dm.root);
    // 预检只标不拦，但要红出来
    assert.match(first.out, /称呼门/);
    const token = (first.out.match(/--confirm ([a-z0-9-]+)/) || [])[1];
    const second = runCli(['--to', '赵四', '--text', text, '--confirm', token, '--off-hours'], dm.root);
    assert.match(second.out, /发送失败/);
    assert.doesNotMatch(second.out, /已发送/);
  } finally {
    dm.cleanup();
  }
});

// ---------- 结构性护栏 ----------

test('⚠⚠ dm.mjs 里不许出现任何一道门（断言只该有一处，两处等于没有）', () => {
  const src = readFileSync(join(ROOT, 'dm.mjs'), 'utf-8');
  const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.doesNotMatch(code, /enforceAgentPrefix/, '身份声明只能在 send.mjs 补，两处会补出两句');
  assert.doesNotMatch(code, /checkCallName/, '称呼门只能有一处');
  assert.doesNotMatch(code, /MAILROOM_ROLE/, '只有 bin/send.mjs 能碰这个变量');
  assert.doesNotMatch(code, /sendVia|chat['"\s,\]]*.*send-to-one/, 'dm.mjs 不许自己发消息');
});

test('⚠⚠ 主动发起这条路仍然只有 sendReply 一个出口', () => {
  const src = readFileSync(join(ROOT, 'bin/send.mjs'), 'utf-8');
  const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.doesNotMatch(code, /hap\s*\(\s*\[\s*['"]chat['"]/, 'bin/send.mjs 里不许直接敲 hap chat');
  // 全文件只能有一次 sendReply 调用（回复和主动发起共用同一个出口）
  assert.equal((code.match(/await sendReply\(/g) || []).length, 1,
    '两条路必须共用同一次 sendReply 调用，分叉出第二次就是第二条发送路');
});
