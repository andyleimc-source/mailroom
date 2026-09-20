// 主动在某个日程下留言（`--calendar`）这条入口的护栏。
//
// 身世（2026-09-07）：日程评论此前完全没有 mailroom 通道——`hap calendar comment`
//   从没进过 deny 名单，是唯一发得出去的路，也因此从没有身份声明自动补全 /
//   称呼检查 / 发信总账 / 两步确认码这四道门。当天就在这条野路子上出过事：
//   手写 `[aid]<rowId>[/aid]` 把内部工作表的 rowId 当成了 accountId 发出去，
//   没人被 @ 到，事后连补了两条才发现——补的是入口，把这条路收回闸门里，
//   不是给它开第二条。
//
// ⚠⚠ 跟 test/task-initiate.test.mjs 同一个规矩：一条真评论都不许发出去。
//   端到端那几条设 MAILROOM_TEST=1，lib.assertNoRealIO 会在真打 hap 之前抛错。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { synthCalendar, confirmToken } from '../dm.mjs';
import { replyViaOf } from '../connect/hap.mjs';
import * as hapAdapter from '../connect/hap.mjs';
import { lineOf } from '../recheck.mjs';
import { tierOf } from '../bin/send.mjs';
import { tmpDailymd, tmpState } from './helpers.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CID = '00000000-0000-4000-8000-000000000004';

let box = null;
before(() => {
  box = tmpState();
  process.env.MAILROOM_TEST = '1';
});
after(() => {
  if (box) box.cleanup();
  delete process.env.MAILROOM_TEST;
});

// 何岚的 accountId（…0011）跟 2026-09-07 那次事故里误传的
// Assign 花名册 rowId（…3333）长得都是 uuid，肉眼分不出来——
// 这份 PEOPLE 名单只登记 accountId，--at 解析走这份表。
const PEOPLE = [
  { name: '何岚', nickname: '何岚', md_account_id: '00000000-0000-4000-8000-000000000011' },
  { name: '陈望', nickname: 'Aaron', md_account_id: '00000000-0000-4000-8000-000000000012' },
];

// ---------- 合成段的形状 ----------

test('没给 calendarId 直接拒绝（不猜一个 id 发出去）', () => {
  assert.throws(() => synthCalendar({ calendarId: '' }), /哪个日程/);
  assert.throws(() => synthCalendar({ calendarId: '   ' }), /哪个日程/);
});

test('⚠⚠ replyVia=calendar —— 决定了走 hap calendar comment，也决定了这条恒为 🔴', () => {
  const item = synthCalendar({ calendarId: CID, name: '何岚', accountId: '00000000-0000-4000-8000-000000000011' });
  assert.equal(replyViaOf(item), 'calendar');
  assert.equal(item.kind, 'notice');
  assert.equal(item.target.calendarId, CID);
});

test('⚠ lineOf 认不出日程的稳定线，退回按段 id 比对——跟动态评论一个待遇，不是回归', () => {
  // 这是既有、故意的取舍（跟 synthPost 一样），不是遗漏：日程评论没有像
  // task/record 那样的专属 lineOf 分支，见 recheck.mjs lineOf 顶部注释。
  const item = synthCalendar({ calendarId: CID });
  assert.equal(lineOf(item).kind, 'seg');
});

test('档位：日程评论恒为 🔴（受众是日程全体参与人，比私信广）', () => {
  assert.equal(tierOf({ isCalendar: true }), '🔴');
  assert.equal(tierOf({ isCalendar: true, auto: '' }), '🔴');
});

test('合成段喂进 sendVia 真的走 hap calendar comment，带的是那个 calendarId', () => {
  const calls = [];
  const item = synthCalendar({ calendarId: CID, name: '何岚', accountId: '00000000-0000-4000-8000-000000000011' });
  const r = hapAdapter.sendVia(item, '会议纪要回填：核心待办是目标客户画像。', {
    io: { hap: (args) => { calls.push(args); return ''; } },
  });
  assert.equal(r.channel, '日程评论');
  assert.deepEqual(calls[0].slice(0, 3), ['calendar', 'comment', CID]);
});

test('⚠⚠ sendVia 把 mentionAccountIds 拼成 [aid]...[/aid] 前缀——这正是 2026-09-07 手写漏标的那道语法', () => {
  const calls = [];
  const item = synthCalendar({
    calendarId: CID,
    mentionAccountIds: ['00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000012'],
  });
  hapAdapter.sendVia(item, '会议纪要回填', {
    io: { hap: (args) => { calls.push(args); return ''; } },
  });
  const msgArg = calls[0][calls[0].indexOf('-m') + 1];
  assert.match(msgArg, /\[aid\]00000000-0000-4000-8000-000000000011\[\/aid\]/);
  assert.match(msgArg, /\[aid\]00000000-0000-4000-8000-000000000012\[\/aid\]/);
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
    const r = runCli(['--calendar', CID, '--at', '何岚', '--text', '会议纪要回填：核心待办是目标客户画像。'], dm.root);
    assert.equal(r.code, 0, `预览不是失败；实际输出：${r.out}`);
    assert.match(r.out, /还没有发出去/);
    assert.match(r.out, /--confirm [a-z0-9-]+/);
    assert.match(r.out, /AI Agent/);
    assert.doesNotMatch(r.out, /已发送|已发出/);
  } finally {
    dm.cleanup();
  }
});

test('⚠ --at 按通讯录反查 accountId——2026-09-07 那次事故就是这步手抄错了才出的问题', () => {
  const dm = dailymdWithContacts();
  try {
    const r = runCli(['--calendar', CID, '--at', '何岚', '--text', '正文'], dm.root);
    // 预览里能看到发给谁；真正 [aid] 注入发生在 sendVia，上面的单测已经锁死那段逻辑。
    assert.match(r.out, /还没有发出去/);
  } finally {
    dm.cleanup();
  }
});

test('⚠ 确认码认的是 calendarId：换个日程号，同一段正文的码就不一样', () => {
  const body = '🤖 我是 Andy 的 AI Agent，以下内容已经过 Andy 本人审核。\n\n会议纪要回填。';
  assert.notEqual(confirmToken(CID, body), confirmToken('another-calendar', body));
});

test('确认码对上之后才会走到真发那一步（被 assertNoRealIO 挡在传输层）', () => {
  const dm = dailymdWithContacts();
  try {
    const text = '会议纪要回填：核心待办是目标客户画像。';
    const first = runCli(['--calendar', CID, '--at', '何岚', '--text', text], dm.root);
    const token = (first.out.match(/--confirm ([a-z0-9-]+)/) || [])[1];
    assert.ok(token, `第一步没给出确认码：${first.out}`);
    const second = runCli(
      ['--calendar', CID, '--at', '何岚', '--text', text, '--confirm', token, '--off-hours'], dm.root,
    );
    assert.doesNotMatch(second.out, /还没有发出去/, '码对上了就不该再停在预览');
    assert.match(second.out, /测试模式|assertNoRealIO|发送失败/i,
      `应该被测试模式挡在真打 hap 之前；实际输出：${second.out}`);
  } finally {
    dm.cleanup();
  }
});

test('--calendar 和 --seg / --to / --task 同时给 → 拒绝（只能走一条）', () => {
  const dm = dailymdWithContacts();
  try {
    assert.match(runCli(['--calendar', CID, '--seg', 'x1', '--text', '话'], dm.root).out, /只能给一个/);
    assert.match(runCli(['--calendar', CID, '--to', '陈望', '--text', '话'], dm.root).out, /只能给一个/);
    assert.match(runCli(['--calendar', CID, '--task', 't1', '--text', '话'], dm.root).out, /只能给一个/);
  } finally {
    dm.cleanup();
  }
});

test('⚠⚠ --auto 在这条路上一律拒绝：日程评论没有 🟢 的口子', () => {
  const dm = dailymdWithContacts();
  try {
    const r = runCli(['--calendar', CID, '--text', '收到。', '--auto', '纯回执'], dm.root);
    assert.equal(r.code, 1);
    assert.match(r.out, /只用于回复/);
  } finally {
    dm.cleanup();
  }
});

test('⚠⚠ 日程评论不支持 --file——静默丢文件的坑跟当年 mail 那次一模一样，必须当场拒发', () => {
  const dm = dailymdWithContacts();
  try {
    // 用一个必然存在的路径（脚本自己）避免又新开一道「文件不存在」的分支干扰断言。
    const r = runCli(['--calendar', CID, '--text', '正文', '--file', join(ROOT, 'bin/send.mjs')], dm.root);
    assert.equal(r.code, 1);
    assert.match(r.out, /不支持带附件/);
  } finally {
    dm.cleanup();
  }
});

test('用法里要写出 --calendar（不然这条入口等于不存在）', () => {
  const dm = dailymdWithContacts();
  try {
    const r = runCli([], dm.root);
    assert.equal(r.code, 1);
    assert.match(r.out, /--calendar/);
  } finally {
    dm.cleanup();
  }
});
