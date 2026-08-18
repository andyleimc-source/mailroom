// 任务评论：第六条发送通道（2026-08-12）。
//
// ⚠⚠ 一条真评论都不许发出去：这个文件只验 sendVia 拼出来的 argv，
//   连接到 hap 的那一层由假传输层（`{ io: { hap } }`）顶掉——跟仓库里其他
//   sendVia 测试（test/hap-notice-reply.test.mjs、test/hap-send-file.test.mjs）
//   同一个注入方式，别再造一个 __call 口子。
// 身世：当年 hap CLI 没有任务评论的写接口，connect/hap.mjs 里写死了「回不到原处，
// 退而私信本人」。2026-08-12 实测 `hap task comment` 已经有了，通知条目也带 taskId。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { noticeReplyTarget } from '../fetch.mjs';
import * as hapAdapter from '../connect/hap.mjs';

test('任务通知带 taskId → via=task，回到那个任务下面', () => {
  const rt = noticeReplyTarget({
    inboxId: 'inbox-1',
    taskId: '00000000-0000-4000-8000-000000000001',
    sender: { accountId: 'acc-ren', name: '韩梅' },
    comment: { recordName: 'Real AI 大赛评委邀请' },
    message: '名单先不用增减，尽力去邀请。',
  });
  assert.equal(rt.via, 'task');
  assert.equal(rt.target.taskId, '00000000-0000-4000-8000-000000000001');
  assert.equal(rt.who.name, '韩梅');
});

test('记录讨论优先于任务：两个 id 都在时回到记录那条讨论下面', () => {
  const rt = noticeReplyTarget({
    worksheetId: 'ws-1', rowId: 'row-1', taskId: 'task-1',
    sender: { accountId: 'acc-a', name: '甲' },
  });
  assert.equal(rt.via, 'record', 'record 能原地回到对方那条讨论下面，比任务级评论准');
});

test('没有 taskId 的任务通知照旧退成私信本人，不猜', () => {
  const rt = noticeReplyTarget({
    inboxId: 'inbox-2', sourceId: 'src-1',
    sender: { accountId: 'acc-qiu', name: '赵四' },
  });
  assert.equal(rt.via, 'dm');
});

// 假传输层：只记命令，不执行。跟 hap-notice-reply.test.mjs 的 fakeHap 同一个套路。
function fakeHap() {
  const calls = [];
  return { calls, hap: (args) => { calls.push(args); return ''; } };
}

test('via=task 真的走 hap task comment，不是退回私信', () => {
  const t = fakeHap();
  const item = {
    kind: 'notice',
    who: '韩梅',
    replyVia: 'task',
    target: { replyVia: 'task', taskId: 'task-abc', recordName: 'Real AI 大赛评委邀请' },
  };
  const r = hapAdapter.sendVia(item, '我是 小明 的 AI Agent，收到。', { io: { hap: t.hap } });

  assert.equal(t.calls.length, 1, '该发且只发一条');
  assert.deepEqual(t.calls[0].slice(0, 3), ['task', 'comment', 'task-abc']);
  assert.ok(!t.calls[0].includes('--reply-id'), 'inboxId 是不是讨论 id 没验过，绝不瞎传');
  assert.equal(r.channel, '任务评论');
  assert.equal(r.to, '韩梅');
});

// 2026-08-17：Andy 实测发现附件和 @ 都丢了——这两条测试钉死那次修复，别再退化。
test('via=task 带 opts.filePath → 同一条 task comment 命令带 --attach，不是第二条消息', () => {
  const t = fakeHap();
  const item = {
    kind: 'notice',
    who: '张三丰',
    replyVia: 'task',
    target: { replyVia: 'task', taskId: 'task-abc', recordName: '三周 AEO 任务' },
  };
  const r = hapAdapter.sendVia(item, '进度同步。', { io: { hap: t.hap }, filePath: '/tmp/report.html' });

  assert.equal(t.calls.length, 1, 'task 没有独立的发文件子命令，附件必须跟正文同一条调用');
  assert.deepEqual(t.calls[0].slice(0, 3), ['task', 'comment', 'task-abc']);
  const attachIdx = t.calls[0].indexOf('--attach');
  assert.ok(attachIdx !== -1, '--attach 必须真的传给 hap CLI');
  assert.equal(t.calls[0][attachIdx + 1], '/tmp/report.html');
  assert.equal(r.file, '/tmp/report.html');
});

test('via=task 带 whoAccountId → 正文里插入 [aid]…[/aid] 真 @ 对方，不只是称呼门判断用', () => {
  const t = fakeHap();
  const item = {
    kind: 'notice',
    who: '张三丰',
    whoAccountId: 'aaaabbbb-cccc-dddd-eeee-ffff00001111',
    replyVia: 'task',
    target: { replyVia: 'task', taskId: 'task-abc', recordName: '三周 AEO 任务' },
  };
  const r = hapAdapter.sendVia(item, '进度同步。', { io: { hap: t.hap } });

  const msgArg = t.calls[0][t.calls[0].indexOf('-m') + 1];
  assert.match(msgArg, /\[aid\]aaaabbbb-cccc-dddd-eeee-ffff00001111\[\/aid\]/,
    '不写 [aid]…[/aid] 服务端不会真推送通知，只是显示文字，等于没 @');
});

// ---------- replyViaOf：「这条通知回到哪儿」只许有一处判定 ----------
//
// ⚠⚠ 2026-08-13 终审逮到的形状：connect/hap.mjs 用 `t.replyVia ?? item.replyVia`
//   决定发到哪，bin/send.mjs 又自己写了一份 `(target.replyVia || item.replyVia) === 'task'`
//   决定归不归 🔴。今天两份结论一致，但改一处另一处不会跟着改 —— 这个仓库反复写着
//   「两份判定迟早对不上」。判定收进 replyViaOf，两边都调它。

test('replyViaOf：target 优先，退回顶层，空串当没写', () => {
  const { replyViaOf } = hapAdapter;
  assert.equal(replyViaOf({ target: { replyVia: 'task' }, replyVia: 'dm' }), 'task',
    'target 优先：item 是段，聚段只把 target 整块带过来');
  assert.equal(replyViaOf({ target: {}, replyVia: 'task' }), 'task',
    '存量段身上只有顶层那一份，必须退得回去');
  assert.equal(replyViaOf({ target: { replyVia: '' }, replyVia: 'task' }), 'task',
    '空串不是落点，当「没写」处理（`??` 会把它当成有效值，于是一路掉到「没有可回复的对象」）');
  assert.equal(replyViaOf({ target: {} }), null, '都没有就是 null，绝不瞎猜');
  assert.equal(replyViaOf(null), null);
});

test('bin/send.mjs 里不许再自己读 .replyVia —— 判定只有 replyViaOf 一处', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(fileURLToPath(new URL('../bin/send.mjs', import.meta.url)), 'utf-8');
  // 注释先剥掉，免得一句解释把自己判成违规
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.doesNotMatch(code, /\.replyVia\b/,
    'bin/send.mjs 又开了第二份路由判定：该调 connect/hap.mjs 的 replyViaOf(item)');
  assert.match(code, /\breplyViaOf\(/, '得真的在用那一处判定');
});
