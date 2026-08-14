// 发送前重收那道闸门。
//
// ⚠ 跟别的发送测试一个规矩：**一条真消息都不许发出去**，也不许真收一轮——
//   runOnce 一律用假的 runner 顶掉，段库用临时状态目录。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  lineOf, sameLine, msgIdsOnLine, authBlocks, recheckBeforeSend,
} from '../recheck.mjs';

const GROUP = {
  id: 'seg-g1',
  sourceKind: 'mingdao',
  sourceType: 'group',
  sourceLabel: '明道云 · 群「Ops Team」',
  who: '韩梅',
  target: { groupId: 'grp-ops', groupName: 'Ops Team' },
  msgs: [{ id: 'm1', at: '2026-08-12T15:35:00+08:00', text: '素材可以部分用于官网首页' }],
};

const DM = {
  id: 'seg-u1',
  sourceKind: 'mingdao',
  sourceType: 'user',
  who: '周婷',
  whoAccountId: 'acc-mai',
  target: {},
  msgs: [{ id: 'd1', at: '2026-08-12T14:31:00+08:00', text: '好的，谢谢雷哥' }],
};

const MAIL = {
  id: 'seg-m1',
  sourceKind: 'mail',
  sourceType: 'mail',
  who: 'Charlotte',
  target: { threadId: 'th-1', messageId: 'msg-1', account: 'work' },
  msgs: [{ id: 'e1', at: '2026-08-12T14:19:00+08:00', text: '付款憑證已收到' }],
};

function fakeStore(segs) {
  return { segments: () => segs };
}
// 顺手把锁那层也顶掉：真 acquireLock 会写 ~/.mailroom。
const noLock = (fn) => fn();

test('lineOf：群认 groupId、私信认 accountId、邮件认 threadId', () => {
  assert.deepEqual(lineOf(GROUP), { kind: 'group', key: 'grp-ops' });
  assert.deepEqual(lineOf(DM), { kind: 'user', key: 'acc-mai' });
  assert.deepEqual(lineOf(MAIL), { kind: 'mail', key: 'th-1' });
});

test('lineOf：认不出稳定的线就退回段本身，别把不相干的段算成同线', () => {
  const notice = { id: 'seg-n1', sourceType: 'notice', target: {} };
  assert.deepEqual(lineOf(notice), { kind: 'seg', key: 'seg-n1' });
  assert.equal(sameLine({ id: 'seg-n1', sourceType: 'notice' }, lineOf(notice)), true);
  assert.equal(sameLine({ id: 'seg-n2', sourceType: 'notice' }, lineOf(notice)), false);
});

test('sameLine：同一个群分成几段也算同线，别的群不算', () => {
  const line = lineOf(GROUP);
  assert.equal(sameLine({ sourceType: 'group', target: { groupId: 'grp-ops' } }, line), true);
  assert.equal(sameLine({ sourceType: 'group', target: { groupId: 'grp-other' } }, line), false);
  // ⚠ 私信段哪怕 who 一样也不算同一条线（回私信不该被群消息挡下，反之亦然）
  assert.equal(sameLine({ sourceType: 'user', whoAccountId: 'grp-ops' }, line), false);
});

test('msgIdsOnLine：把同线各段的消息 id 并成一份', () => {
  const segs = [
    GROUP,
    { sourceType: 'group', target: { groupId: 'grp-ops' }, msgs: [{ id: 'm0' }] },
    { sourceType: 'group', target: { groupId: 'grp-other' }, msgs: [{ id: 'x1' }] },
  ];
  assert.deepEqual([...msgIdsOnLine(segs, lineOf(GROUP))].sort(), ['m0', 'm1']);
});

test('这条线上没有新消息 → 放行', async () => {
  const r = await recheckBeforeSend(GROUP, {
    dailymd: '/tmp/x',
    store: fakeStore([GROUP]),
    runner: async () => ({ got: 0, authErrors: [], pending: [] }),
    lock: noLock,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.fresh, []);
});

test('⚠⚠ 这条线上有新消息 → 拦下，并把新消息带出来（2026-08-12 那次事故的回归）', async () => {
  const segs = [structuredClone(GROUP)];
  const r = await recheckBeforeSend(GROUP, {
    dailymd: '/tmp/x',
    store: fakeStore(segs),
    runner: async () => {
      // 模拟收一轮：新消息落进同一个群的段
      segs[0].msgs.push({ id: 'm2', at: '2026-08-12T15:44:00+08:00', text: '未来就是线上的地址 corp-mail.com/intro' });
      return { got: 1, authErrors: [], pending: [] };
    },
    lock: noLock,
  });
  assert.equal(r.ok, false);
  assert.equal(r.fresh.length, 1);
  assert.equal(r.fresh[0].id, 'm2');
  assert.match(r.fresh[0].text, /corp-mail\.com\/intro/);
});

test('新消息在别的线上 → 照发（别拿无关消息挡人，那会逼人学会绕过这道门）', async () => {
  const segs = [structuredClone(GROUP)];
  const r = await recheckBeforeSend(GROUP, {
    dailymd: '/tmp/x',
    store: fakeStore(segs),
    runner: async () => {
      segs.push({ sourceType: 'user', whoAccountId: 'acc-other', msgs: [{ id: 'z1', text: '无关私信' }] });
      return { got: 1, authErrors: [], pending: [] };
    },
    lock: noLock,
  });
  assert.equal(r.ok, true);
  assert.equal(r.got, 1);
});

test('新消息落在同一个群的**另一段**里也要认出来', async () => {
  const segs = [structuredClone(GROUP)];
  const r = await recheckBeforeSend(GROUP, {
    dailymd: '/tmp/x',
    store: fakeStore(segs),
    runner: async () => {
      segs.push({
        id: 'seg-g2', sourceType: 'group', sourceLabel: '明道云 · 群「Ops Team」', who: '周婷',
        target: { groupId: 'grp-ops' }, msgs: [{ id: 'm9', at: '2026-08-12T15:50:00+08:00', text: '我再调一版' }],
      });
      return { got: 1, authErrors: [], pending: [] };
    },
    lock: noLock,
  });
  assert.equal(r.ok, false);
  assert.equal(r.fresh[0].id, 'm9');
});

test('⚠ 收不成一律 fail-closed：明道云掉线时不许发明道云消息', async () => {
  const r = await recheckBeforeSend(GROUP, {
    dailymd: '/tmp/x',
    store: fakeStore([GROUP]),
    runner: async () => ({ got: 0, authErrors: [{ kind: 'mingdao', message: '401' }], pending: [] }),
    lock: noLock,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /认证失败/);
});

test('明道云掉线不该锁死邮件那条路', async () => {
  const r = await recheckBeforeSend(MAIL, {
    dailymd: '/tmp/x',
    store: fakeStore([MAIL]),
    runner: async () => ({ got: 0, authErrors: [{ kind: 'hap', message: '401' }], pending: [] }),
    lock: noLock,
  });
  assert.equal(r.ok, true);
});

test('邮箱掉线时不许发邮件', async () => {
  const r = await recheckBeforeSend(MAIL, {
    dailymd: '/tmp/x',
    store: fakeStore([MAIL]),
    runner: async () => ({ got: 0, authErrors: [{ kind: 'work', message: 'token 过期' }], pending: [] }),
    lock: noLock,
  });
  assert.equal(r.ok, false);
});

test('authBlocks：只挡自己那条来源', () => {
  assert.ok(authBlocks(GROUP, [{ kind: 'hap', message: 'x' }]));
  assert.equal(authBlocks(GROUP, [{ kind: 'work', message: 'x' }]), null);
  assert.ok(authBlocks(MAIL, [{ kind: 'work', message: 'x' }]));
  assert.equal(authBlocks(MAIL, [{ kind: 'hap', message: 'x' }]), null);
});

test('runOnce 抛错 → 拒发，不许当成「没有新消息」', async () => {
  const r = await recheckBeforeSend(GROUP, {
    dailymd: '/tmp/x',
    store: fakeStore([GROUP]),
    runner: async () => { throw new Error('网络炸了'); },
    lock: noLock,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /网络炸了/);
});

test('别人正在收一轮（拿不到锁）→ 拒发', async () => {
  const r = await recheckBeforeSend(GROUP, {
    dailymd: '/tmp/x',
    store: fakeStore([GROUP]),
    runner: async () => ({ got: 0, authErrors: [], pending: [] }),
    lock: async () => ({ lockBusy: true }),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /正在收消息/);
});

test('⚠ 拦下之后重跑同一条命令要能过（那些消息已经不新了）', async () => {
  const segs = [structuredClone(GROUP)];
  const runner = async () => {
    if (segs[0].msgs.length === 1) {
      segs[0].msgs.push({ id: 'm2', at: '2026-08-12T15:44:00+08:00', text: '新情况' });
      return { got: 1, authErrors: [], pending: [] };
    }
    return { got: 0, authErrors: [], pending: [] };
  };
  const opts = { dailymd: '/tmp/x', store: fakeStore(segs), runner, lock: noLock };
  assert.equal((await recheckBeforeSend(GROUP, opts)).ok, false);
  assert.equal((await recheckBeforeSend(GROUP, opts)).ok, true);
});

// ---------- 任务评论 / 记录讨论也要认得出同线（2026-08-13 补） ----------
//
// ⚠⚠ 任务评论归 🔴，而 🔴 恰恰是「拟稿 → 他点头」中间隔着几分钟的那个事故形状
//   （2026-08-12 Ops Team 那次就是这么说岔的）。lineOf 原来没有 task 分支，通知一律
//   退成 `{kind:'seg'}`、只比段 id —— 同一个任务下别人在这几分钟里新发的评论会落进
//   **另一个段**，这道门判不出同线、直接放行，等于对任务线基本不设防。

const TASK = {
  id: 'seg-t1',
  sourceKind: 'mingdao',
  sourceType: 'notice',
  sourceLabel: '明道云 · 任务通知',
  who: '韩梅',
  whoAccountId: 'acc-ren',
  target: { replyVia: 'task', taskId: 'task-abc', recordName: 'Real AI 评委邀请' },
  msgs: [{ id: 't1', at: '2026-08-13T15:35:00+08:00', text: '名单先不用增减' }],
};

const RECORD = {
  id: 'seg-r1',
  sourceKind: 'mingdao',
  sourceType: 'notice',
  sourceLabel: '明道云 · 应用通知',
  who: '韩梅',
  whoAccountId: 'acc-ren',
  target: { replyVia: 'record', worksheetId: 'ws-1', rowId: 'row-1' },
  msgs: [{ id: 'r1', at: '2026-08-13T15:35:00+08:00', text: '这条记录的金额对不上' }],
};

test('lineOf：任务认 taskId、记录讨论认 worksheetId+rowId', () => {
  assert.deepEqual(lineOf(TASK), { kind: 'task', key: 'task-abc' });
  assert.deepEqual(lineOf(RECORD), { kind: 'record', key: 'ws-1:row-1' });
});

test('sameLine：同一个任务分成几段也算同线，别的任务不算', () => {
  const line = lineOf(TASK);
  assert.equal(sameLine({ sourceType: 'notice', target: { taskId: 'task-abc' } }, line), true);
  assert.equal(sameLine({ sourceType: 'notice', target: { taskId: 'task-other' } }, line), false);
  assert.equal(sameLine({ sourceType: 'notice', target: {} }, line), false,
    '没有 taskId 的通知不许被算进任何任务线');
  assert.equal(sameLine({ sourceType: 'group', target: { groupId: 'task-abc' } }, line), false,
    'id 撞车也不算同线——来源类型得对上');
});

test('sameLine：记录讨论按 worksheetId+rowId 认，只对上一半不算', () => {
  const line = lineOf(RECORD);
  assert.equal(sameLine({ sourceType: 'notice', target: { worksheetId: 'ws-1', rowId: 'row-1' } }, line), true);
  assert.equal(sameLine({ sourceType: 'notice', target: { worksheetId: 'ws-1', rowId: 'row-9' } }, line), false);
  assert.equal(sameLine({ sourceType: 'notice', target: { worksheetId: 'ws-1' } }, line), false);
});

test('⚠⚠ 同一个任务下别人的新评论落在**另一段**里，也要拦下（不然 🔴 那几分钟是敞着的）', async () => {
  const segs = [structuredClone(TASK)];
  const r = await recheckBeforeSend(TASK, {
    dailymd: '/tmp/x',
    store: fakeStore(segs),
    runner: async () => {
      // 拟稿到点头之间，同一个任务下有人补了一条——它会自成一段（不同的 who / 超窗）
      segs.push({
        id: 'seg-t2', sourceType: 'notice', sourceLabel: '明道云 · 任务通知', who: '李雷',
        target: { replyVia: 'task', taskId: 'task-abc' },
        msgs: [{ id: 't9', at: '2026-08-13T15:44:00+08:00', text: '这几位已经答应了，别重复邀请' }],
      });
      return { got: 1, authErrors: [], pending: [] };
    },
    lock: noLock,
  });
  assert.equal(r.ok, false, '同一个任务下的新评论必须拦下来');
  assert.equal(r.fresh[0].id, 't9');
});

test('别的任务下的新评论 → 照发（别拿无关任务挡人）', async () => {
  const segs = [structuredClone(TASK)];
  const r = await recheckBeforeSend(TASK, {
    dailymd: '/tmp/x',
    store: fakeStore(segs),
    runner: async () => {
      segs.push({
        id: 'seg-t3', sourceType: 'notice', who: '李雷',
        target: { replyVia: 'task', taskId: 'task-other' },
        msgs: [{ id: 't8', at: '2026-08-13T15:44:00+08:00', text: '另一个任务的事' }],
      });
      return { got: 1, authErrors: [], pending: [] };
    },
    lock: noLock,
  });
  assert.equal(r.ok, true);
});

test('认不出落点的通知（日程提醒这种）照旧只比段 id，行为一个字不变', () => {
  const notice = { id: 'seg-n1', sourceType: 'notice', target: { replyVia: 'dm', accountId: 'acc-x' } };
  assert.deepEqual(lineOf(notice), { kind: 'seg', key: 'seg-n1' });
});
