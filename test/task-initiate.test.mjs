// 主动在某个任务下留言（`--task`）这条入口的护栏。
//
// 身世（2026-08-13）：`--seg` 只能**回**任务里已经有人 @ 我的那条评论。
//   「我派了个活、想去任务下问一句进度」在段库里根本没有段可回，于是唯一的出路
//   成了直接敲 `hap task comment` —— 而那条命令 2026-08-13 已经进了 deny 名单
//   （正是要堵的形状：绕过审批台以 小明 名义发东西，明道云没有撤回接口）。
//   所以补的是**入口**，不是第二条路：合成段照样走完 sendReply 的每一道门。
//
// ⚠⚠ 跟 test/dm.test.mjs 同一个规矩：一条真评论都不许发出去。
//   端到端那几条设 MAILROOM_TEST=1，lib.assertNoRealIO 会在真打 hap 之前抛错。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { synthTask, confirmToken } from '../dm.mjs';
import { replyViaOf } from '../connect/hap.mjs';
import * as hapAdapter from '../connect/hap.mjs';
import { lineOf, sameLine } from '../recheck.mjs';
import { tierOf } from '../bin/send.mjs';
import { tmpDailymd, tmpState } from './helpers.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TID = '00000000-0000-4000-8000-000000000003';

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
  { name: '孙强', nickname: '强哥', md_account_id: 'acc-rocky' },
  { name: '李雷', nickname: '雷哥', md_account_id: 'acc-zhangfeng' },
];

// ---------- 合成段的形状 ----------

test('没给 taskId 直接拒绝（不猜一个 id 发出去）', () => {
  assert.throws(() => synthTask({ taskId: '' }), /哪个任务/);
  assert.throws(() => synthTask({ taskId: '   ' }), /哪个任务/);
});

test('⚠⚠ replyVia=task —— 决定了走 hap task comment，也决定了这条恒为 🔴', () => {
  const item = synthTask({ taskId: TID, name: '孙强', accountId: 'acc-rocky' });
  assert.equal(replyViaOf(item), 'task');
  assert.equal(item.kind, 'notice');
  assert.equal(item.target.taskId, TID);
});

test('⚠⚠ sourceType 必须是 notice：不然「发送前重收」那道门认不出同线', () => {
  const item = synthTask({ taskId: TID });
  // lineOf 只认 sourceType。写漏了就退成 {kind:'seg'}，同一个任务下别人在
  // 「拟稿 → 点头」之间新发的评论判不出同线、直接放行（2026-08-12 那次说岔的形状）。
  assert.deepEqual(lineOf(item), { kind: 'task', key: TID });
  assert.equal(
    sameLine({ sourceType: 'notice', target: { taskId: TID } }, lineOf(item)),
    true,
  );
  assert.equal(
    sameLine({ sourceType: 'notice', target: { taskId: 'other' } }, lineOf(item)),
    false,
  );
});

test('档位：任务评论恒为 🔴（受众是任务全体参与人，比私信广）', () => {
  assert.equal(tierOf({ isTask: true }), '🔴');
  assert.equal(tierOf({ isTask: true, auto: '' }), '🔴');
});

test('合成段喂进 sendVia 真的走 hap task comment，带的是那个 taskId', () => {
  const calls = [];
  const item = synthTask({ taskId: TID, name: '孙强', accountId: 'acc-rocky' });
  const r = hapAdapter.sendVia(item, '我是 小明 的 AI Agent，进度怎么样？', {
    io: { hap: (args) => { calls.push(args); return ''; } },
  });
  assert.equal(r.channel, '任务评论');
  assert.deepEqual(calls[0].slice(0, 3), ['task', 'comment', TID]);
});

// ---------- 端到端：真跑 bin/send.mjs ----------

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

function dailymdWithContacts() {
  const dm = tmpDailymd();
  mkdirSync(join(dm.root, 'contactmd'), { recursive: true });
  writeFileSync(join(dm.root, 'contactmd/contacts.json'), JSON.stringify(PEOPLE));
  return dm;
}

test('⚠⚠ 第一步只预览、绝不发送：打出确认码，退出码 0，正文已补身份声明', () => {
  const dm = dailymdWithContacts();
  try {
    const r = runCli(['--task', TID, '--text', '强哥，那个单大概什么时候能排上？'], dm.root);
    assert.equal(r.code, 0, `预览不是失败；实际输出：${r.out}`);
    assert.match(r.out, /还没有发出去/);
    assert.match(r.out, /--confirm [a-z0-9-]+/);
    assert.match(r.out, /AI Agent/);
    assert.doesNotMatch(r.out, /已发送|已发出/);
  } finally {
    dm.cleanup();
  }
});

test('⚠ 确认码认的是 taskId：换个任务号，同一段正文的码就不一样', () => {
  const body = '🤖 我是 小明 的 AI Agent，以下内容已经过 小明 本人审核。\n\n进度怎么样？';
  assert.notEqual(confirmToken(TID, body), confirmToken('another-task', body));
});

test('确认码对上之后才会走到真发那一步（被 assertNoRealIO 挡在传输层）', () => {
  const dm = dailymdWithContacts();
  try {
    const text = '强哥，那个单大概什么时候能排上？';
    const first = runCli(['--task', TID, '--text', text], dm.root);
    const token = (first.out.match(/--confirm ([a-z0-9-]+)/) || [])[1];
    assert.ok(token, `第一步没给出确认码：${first.out}`);
    const second = runCli(
      ['--task', TID, '--text', text, '--confirm', token, '--off-hours'], dm.root,
    );
    assert.doesNotMatch(second.out, /还没有发出去/, '码对上了就不该再停在预览');
    assert.match(second.out, /测试模式|assertNoRealIO|发送失败/i,
      `应该被测试模式挡在真打 hap 之前；实际输出：${second.out}`);
  } finally {
    dm.cleanup();
  }
});

test('⚠ 称呼门在这条路上照样拦（给了 --account-id 就按那个人判）', () => {
  const dm = dailymdWithContacts();
  try {
    const r = runCli(
      ['--task', TID, '--account-id', 'acc-rocky', '--text', '孙总您好，进度怎么样？'], dm.root,
    );
    assert.match(r.out, /称呼门/);
  } finally {
    dm.cleanup();
  }
});

test('--task 和 --seg / --to 同时给 → 拒绝（三条路只能走一条）', () => {
  const dm = dailymdWithContacts();
  try {
    assert.match(runCli(['--task', TID, '--seg', 'x1', '--text', '话'], dm.root).out, /只能给一个/);
    assert.match(runCli(['--task', TID, '--to', '李雷', '--text', '话'], dm.root).out, /只能给一个/);
  } finally {
    dm.cleanup();
  }
});

test('⚠⚠ --auto 在这条路上一律拒绝：任务评论没有 🟢 的口子', () => {
  const dm = dailymdWithContacts();
  try {
    const r = runCli(['--task', TID, '--text', '收到。', '--auto', '纯回执'], dm.root);
    assert.equal(r.code, 1);
    assert.match(r.out, /只用于回复/);
  } finally {
    dm.cleanup();
  }
});

test('用法里要写出 --task（不然这条入口等于不存在）', () => {
  const dm = dailymdWithContacts();
  try {
    const r = runCli([], dm.root);
    assert.equal(r.code, 1);
    assert.match(r.out, /--task/);
  } finally {
    dm.cleanup();
  }
});
