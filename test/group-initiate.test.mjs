// 主动往群里发一条消息（`--group`）这条入口的护栏。
//
// 身世（2026-08-17）：`--seg` 只能**回**一条群里已经收到的消息。「往群里发一条公示，
//   没人先发起过」在段库里根本没有段可回，于是唯一的出路成了直接敲
//   `hap chat send-to-group` —— 而那条命令在 deny 名单里（正是要堵的形状）。
//   补的是**入口**，不是第二条路：合成段照样走完 sendReply 的每一道门。
//   跟 test/task-initiate.test.mjs 同一个规矩：一条真消息都不许发出去。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { synthGroup, confirmToken } from '../dm.mjs';
import * as hapAdapter from '../connect/hap.mjs';
import { lineOf } from '../recheck.mjs';
import { tierOf } from '../bin/send.mjs';
import { tmpDailymd, tmpState } from './helpers.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GID = '11112222-3333-4444-5555-666677778888';

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
];

// ---------- 合成段的形状 ----------

test('没给 groupId 直接拒绝（不猜一个群发出去）', () => {
  assert.throws(() => synthGroup({ groupId: '' }), /哪个群/);
  assert.throws(() => synthGroup({ groupId: '   ' }), /哪个群/);
});

test('⚠⚠ kind=group、target.groupId 对，来源标签带群名', () => {
  const item = synthGroup({ groupId: GID, groupName: '演示群甲' });
  assert.equal(item.kind, 'group');
  assert.equal(item.target.groupId, GID);
  assert.equal(item.target.groupName, '演示群甲');
  assert.match(item.sourceLabel, /演示群甲/);
});

test('档位：群消息恒为 🔴（受众是整个群，不比任务评论窄）', () => {
  assert.equal(tierOf({ isGroup: true }), '🔴');
  assert.equal(tierOf({ isGroup: true, auto: '' }), '🔴');
});

test('合成段喂进 sendVia 真的走 hap chat send-to-group，带的是那个 groupId', () => {
  const calls = [];
  const item = synthGroup({ groupId: GID, groupName: '演示群甲' });
  const r = hapAdapter.sendVia(item, '🤖 我是 小明 的 AI Agent，以下内容已经过 小明 本人审核。\n\n名单公示。', {
    io: { hap: (args) => { calls.push(args); return ''; } },
  });
  assert.equal(r.channel, '群消息');
  assert.deepEqual(calls[0].slice(0, 4), ['chat', 'send-to-group', '-g', GID]);
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
    const r = runCli(['--group', GID, '--text', '本周新签：某某某，中午前没人提异议就发布。'], dm.root);
    assert.equal(r.code, 0, `预览不是失败；实际输出：${r.out}`);
    assert.match(r.out, /还没有发出去/);
    assert.match(r.out, /--confirm [a-z0-9-]+/);
    assert.match(r.out, /AI Agent/);
    assert.doesNotMatch(r.out, /已发送|已发出/);
  } finally {
    dm.cleanup();
  }
});

test('⚠ 确认码认的是 groupId：换个群，同一段正文的码就不一样', () => {
  const body = '🤖 我是 小明 的 AI Agent，以下内容已经过 小明 本人审核。\n\n名单公示。';
  assert.notEqual(confirmToken(GID, body), confirmToken('another-group', body));
});

test('确认码对上之后才会走到真发那一步（被 assertNoRealIO 挡在传输层）', () => {
  const dm = dailymdWithContacts();
  try {
    const text = '本周新签：某某某，中午前没人提异议就发布。';
    const first = runCli(['--group', GID, '--text', text], dm.root);
    const token = (first.out.match(/--confirm ([a-z0-9-]+)/) || [])[1];
    assert.ok(token, `第一步没给出确认码：${first.out}`);
    const second = runCli(
      ['--group', GID, '--text', text, '--confirm', token, '--off-hours'], dm.root,
    );
    assert.doesNotMatch(second.out, /还没有发出去/, '码对上了就不该再停在预览');
    assert.match(second.out, /测试模式|assertNoRealIO|发送失败/i,
      `应该被测试模式挡在真打 hap 之前；实际输出：${second.out}`);
  } finally {
    dm.cleanup();
  }
});

test('--group 和 --seg / --to / --task 同时给 → 拒绝（只能走一条）', () => {
  const dm = dailymdWithContacts();
  try {
    assert.match(runCli(['--group', GID, '--seg', 'x1', '--text', '话'], dm.root).out, /只能给一个/);
    assert.match(runCli(['--group', GID, '--to', '李雷', '--text', '话'], dm.root).out, /只能给一个/);
  } finally {
    dm.cleanup();
  }
});

test('⚠⚠ --auto 在这条路上一律拒绝：群消息没有 🟢 的口子', () => {
  const dm = dailymdWithContacts();
  try {
    const r = runCli(['--group', GID, '--text', '收到。', '--auto', '纯回执'], dm.root);
    assert.equal(r.code, 1);
    assert.match(r.out, /只用于回复/);
  } finally {
    dm.cleanup();
  }
});

test('找不到群名 → 拒绝，不猜（这条走网络解析，测试模式下会被挡在 hap 之前，同样算拒发）', () => {
  const dm = dailymdWithContacts();
  try {
    const r = runCli(['--group', '一个不存在的群名', '--text', '话'], dm.root);
    assert.equal(r.code, 1);
  } finally {
    dm.cleanup();
  }
});

test('用法里要写出 --group（不然这条入口等于不存在）', () => {
  const dm = dailymdWithContacts();
  try {
    const r = runCli([], dm.root);
    assert.equal(r.code, 1);
    assert.match(r.out, /--group/);
  } finally {
    dm.cleanup();
  }
});
