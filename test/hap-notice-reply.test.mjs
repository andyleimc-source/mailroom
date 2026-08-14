// 通知类消息（任务 @我 / 记录讨论 / 知识库 @）能不能回得出去。
//
// ⚠⚠ 这条测试盯的是**聚段这一步会把顶层字段吃掉**：candidate 上的 `replyVia` 到了段上
//   就没了（`toSegments` 只搬白名单里的几个字段 + `target`），于是 `sendVia` 里两个
//   `if` 都不成立，通知类回复一律抛「这条通知没有可回复的对象」。
//   所以这里必须走**真的** toSegments，不许手搓一个段来测——手搓的段想带什么字段就带什么，
//   正好把要测的那个洞绕过去了。
//
// ⚠ 传输层注入假的（`{ io: { hap } }`），绝不真发：`hap chat send-to-one` 对任何
//   accountId 都回 `Message sent.`，而明道云没有撤回接口。本文件**故意不设**
//   MAILROOM_ALLOW_REAL_IO —— 哪天注入漏了，lib.assertNoRealIO 会当场把测试打红。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSession } from '../fetch.mjs';
import { toSegments } from '../segment.mjs';
import * as hapAdapter from '../connect/hap.mjs';

// 一条「有人在记录/任务里 @我」的通知：chat list 给的会话 + 通知收件箱给的明细。
const sess = (category) => ({
  value: category, category, time: '2026-08-10 09:00:00.000',
  msg: { con: '张三在「客户跟进」的一条记录里 @了你：这个报价要不要调？' },
});

const ENTRY_RECORD = {
  inboxId: 'inbox-1',
  worksheetId: 'ws-1',
  rowId: 'row-1',
  viewId: 'view-1',
  appId: 'app-1',
  sender: { accountId: 'acc-zhang', name: '张三' },
  comment: { recordName: '客户 A' },
};

// 同样的通知，但既没有 worksheetId/rowId 也没有 taskId ——真认不出落点，只能退而私信本人。
// ⚠ 2026-08-12 起「任务讨论」不再一律退 dm：带 taskId 的走新的 via=task
//   （见 test/hap-task-comment.test.mjs），这条 fixture 是「task 分类但没给 taskId」的场景。
const ENTRY_DM = {
  inboxId: 'inbox-2',
  sender: { accountId: 'acc-zhang', name: '张三' },
};

// candidate → **真的** toSegments → 段，再补上 send.mjs 那一下 kind 换名
// （send.mjs:368 `{ ...item, kind: typeOf(item) }`，段上字段叫 sourceType）。
function segFor(entry, category = 'app') {
  const c = normalizeSession(sess(category), [], entry);
  assert.ok(c, '这条通知该进候选');
  const segs = toSegments([c]);
  assert.equal(segs.length, 1, '一条候选该聚成一段');
  return { ...segs[0], kind: segs[0].sourceType };
}

// 假传输层：只记命令，不执行。
function fakeHap() {
  const calls = [];
  return { calls, hap: (args) => { calls.push(args); return ''; } };
}

test('通知类·记录讨论：聚段后照样回得出去，走 worksheet record add-discussion', () => {
  const t = fakeHap();
  const r = hapAdapter.sendVia(segFor(ENTRY_RECORD), '收到，我看一下。', { io: { hap: t.hap } });

  assert.equal(t.calls.length, 1, '该发且只发一条');
  const args = t.calls[0];
  assert.deepEqual(args.slice(0, 5), ['worksheet', 'record', 'add-discussion', 'ws-1', 'row-1']);
  assert.ok(args.includes('收到，我看一下。'));
  assert.equal(r.channel, '记录讨论');
});

test('通知类·退而私信：聚段后照样回得出去，走 chat send-to-one', () => {
  const t = fakeHap();
  const r = hapAdapter.sendVia(segFor(ENTRY_DM, 'task'), '好的。', { io: { hap: t.hap } });

  assert.equal(t.calls.length, 1);
  assert.deepEqual(t.calls[0], ['chat', 'send-to-one', '-t', 'acc-zhang', '-m', '好的。']);
  assert.equal(r.channel, '私信');
});

test('通知类：真认不出落点才抛「没有可回复的对象」，且一个字都没发出去', () => {
  const t = fakeHap();
  const c = normalizeSession(
    { value: 'workflow', category: 'workflow', time: '2026-08-10 09:00:00.000', msg: { con: '你的审批已通过' } },
    [], null,
  );
  const seg = toSegments([c])[0];
  assert.throws(
    () => hapAdapter.sendVia({ ...seg, kind: seg.sourceType }, '收到', { io: { hap: t.hap } }),
    /没有可回复的对象/,
  );
  assert.equal(t.calls.length, 0, '认不出落点绝不许瞎发');
});

// ⚠ 存量段（改动之前落盘的 segments.json）身上只有顶层 replyVia，target 里没有。
//   读法必须 target 优先、顶层兜底，否则这批段一升级就再也回不了。
test('存量段：target 里没有 replyVia 时，退回读顶层的那个', () => {
  const t = fakeHap();
  const seg = segFor(ENTRY_DM, 'task');
  delete seg.target.replyVia;
  seg.replyVia = 'dm';       // 老段就是这个形状
  hapAdapter.sendVia(seg, '好的。', { io: { hap: t.hap } });
  assert.deepEqual(t.calls[0].slice(0, 4), ['chat', 'send-to-one', '-t', 'acc-zhang']);
});
