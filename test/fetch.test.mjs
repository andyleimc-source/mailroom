// 取数失败不许被吞成「这个会话零条新消息」。
//
// ⚠⚠ 这份文件盯的是老系统那个「收消息链死了两天一直在丢消息」的模子本身：
//   `fetch.mjs` 里三处裸 `catch { return []; }` 把 401、25 秒超时、代理抖动
//   一律吞成「这个会话没有新消息」。而 watch.mjs 早在 `chat list` 一成功就把
//   水位线推过去了，run.mjs 的 lostWhy / finished 都不置位 —— 不回滚、不推 Bark、
//   界面上照常显示「刚刚收过一轮」。整套 restoreWatch 机器在这条路上一次都不触发。
//
// ⚠ 本文件要真的走一遍 execFileSync（否则测不到「那句调用本身写没写对」），
//   所以顶掉 hap 二进制 + 显式放开 MAILROOM_ALLOW_REAL_IO。**别把这两行抄到别的测试文件去。**

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tmpState } from './helpers.mjs';

// log() 会写状态目录，先顶成临时的，别碰 小明 真的 ~/.mailroom。
tmpState();

// 假 hap：环境变量 FAKE_HAP_FAIL 决定这一趟怎么失败（execFileSync 默认把
// process.env 原样传给子进程，所以每条测试改一下环境变量就能换失败方式）。
const BIN_DIR = mkdtempSync(join(tmpdir(), 'mailroom-fetchhap-'));
const FAKE_HAP = join(BIN_DIR, 'hap');
writeFileSync(FAKE_HAP, [
  '#!/bin/sh',
  'if [ "$FAKE_HAP_FAIL" = "auth" ]; then echo "Error: not logged in" >&2; exit 1; fi',
  'if [ -n "$FAKE_HAP_FAIL" ]; then echo "$FAKE_HAP_FAIL" >&2; exit 1; fi',
  'for a in "$@"; do if [ "$a" = "--json" ]; then echo "{}"; exit 0; fi; done',
  'echo ok',
].join('\n'), { mode: 0o755 });
// ⚠ 必须在 import lib.mjs **之前**设：BIN.hap 是模块加载那一刻求值的。
process.env.MAILROOM_HAP_BIN = FAKE_HAP;
process.env.MAILROOM_ALLOW_REAL_IO = '1';

const { fetchFreshMessages, fetchPostInbox, fetchNoticeInbox } = await import('../fetch.mjs');
const { HapAuthError } = await import('../lib.mjs');

const SESS = { category: 'user', value: 'acc-x', name: '李雷' };

function withFail(how, fn) {
  process.env.FAKE_HAP_FAIL = how;
  try { return fn(); } finally { delete process.env.FAKE_HAP_FAIL; }
}

// ---------- 三处 catch ----------

test('会话取数 401：抛 HapAuthError，绝不吞成「零条新消息」', () => {
  withFail('auth', () => {
    assert.throws(
      () => fetchFreshMessages(SESS, '2026-08-08 09:00:00.000'),
      HapAuthError,
      '401 是全局故障，本来就该停下来喊 小明 跑 hap auth login',
    );
  });
});

test('会话取数普通失败（超时 / 代理抖动 / CLI 非零退出）：也要抛，不许静默返回 []', () => {
  withFail('ETIMEDOUT 代理抖了一下', () => {
    assert.throws(
      () => fetchFreshMessages(SESS, '2026-08-08 09:00:00.000'),
      /代理抖了一下|hap chat messages/,
      '吞掉的话这个会话就被当成「没有新消息」，而水位线已经过去了 —— 消息永久消失',
    );
  });
});

test('动态收件箱取数失败：401 抛 HapAuthError，其余也要抛', () => {
  withFail('auth', () => assert.throws(() => fetchPostInbox(), HapAuthError));
  withFail('boom', () => assert.throws(() => fetchPostInbox(), /boom|hap chat messages/));
});

test('通知收件箱取数失败：401 抛 HapAuthError，其余也要抛', () => {
  withFail('auth', () => assert.throws(() => fetchNoticeInbox('task'), HapAuthError));
  withFail('boom', () => assert.throws(() => fetchNoticeInbox('task'), /boom|hap chat messages/));
});

test('没出错时行为一个字没变：照常返回', () => {
  assert.deepEqual(fetchFreshMessages(SESS, '2026-08-08 09:00:00.000'), []);
  assert.deepEqual(fetchPostInbox(), []);
  assert.deepEqual(fetchNoticeInbox('task'), []);
});

// ---------- pull 要把这件事报上去 ----------

test('pull：某个会话取数失败 → 记进 lost 报上去，不冒充「这一轮没新消息」', async () => {
  const { pull } = await import('../connect/hap.mjs');
  const r = withFail('ETIMEDOUT', () => pull({
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
  }));
  assert.ok(Array.isArray(r.lost), 'pull 要有 lost 这一栏，否则上层没法知道「这轮有没取到的」');
  assert.equal(r.lost.length, 1, `取数失败要报上去，实际 lost=${JSON.stringify(r.lost)}`);
  assert.match(String(r.lost[0]), /李雷|acc-ln/, 'lost 里要说清是哪个会话，不然查不出来');
});

test('pull：401 从会话取数里冒出来要一路抛出去，不许降级成 lost', async () => {
  const { pull } = await import('../connect/hap.mjs');
  withFail('auth', () => {
    assert.throws(() => pull({
      prevSeen: { 'acc-ln': '旧时间' },
      io: {
        runWatch: () => ({ code: 0, out: 'x', err: '' }),
        hap: (args) => (args[0] === 'chat' && args[1] === 'list'
          ? [{
            value: 'acc-ln', name: '李雷', category: 'user', time: '2026-08-08 09:00:00.000',
            msg: { con: '嗨' },
          }]
          : { list: [] }),
      },
    }), HapAuthError);
  });
});

test('pull：动态收件箱取数失败也要记 lost，且不许把 seen-post 往前推', async () => {
  const { pull } = await import('../connect/hap.mjs');
  const saved = { 'seen-post': { ids: ['old'] } };
  const store = {
    stateGet: (k, d) => (k in saved ? saved[k] : d),
    stateSet: (k, v) => { saved[k] = v; },
  };
  const r = withFail('ETIMEDOUT', () => pull({
    prevSeen: { post: '旧时间' },
    store,
    io: {
      runWatch: () => ({ code: 0, out: 'x', err: '' }),
      hap: (args) => (args[0] === 'chat' && args[1] === 'list'
        ? [{ value: 'post', category: 'post', time: '2026-08-08 09:00:00.000', msg: { con: '有人评论了' } }]
        : { list: [] }),
    },
  }));
  assert.ok(r.lost && r.lost.length, '动态收件箱取数失败要报上去');
  assert.deepEqual(saved['seen-post'].ids, ['old'],
    '这一趟没取到东西，绝不许把已读水位推过去 —— 推了这些评论就永远看不见了');
});

// ── 心跳节奏：把下一轮间隔喊给外面那个循环 ─────────────────────────────
// 排下一次拉取的是 /loop / launchd / cron，它们读不到 heartbeat.json，
// 全靠 fetch 打的这一行传话。这一行没了 = 心跳白算，退回固定 15 分钟。

test('buildPaceLine：热区喊 1 分钟，带上加速原因', async () => {
  const { buildPaceLine } = await import('../bin/fetch.mjs');
  const line = buildPaceLine({
    currentIntervalSec: 60, zone: '热区 (1m)', boostReason: '收到互动消息（来自 小李）',
  });
  assert.match(line, /1 分钟/);
  assert.match(line, /热区/);
  assert.match(line, /小李/, '得说清凭什么提速，不然没法查');
});

test('buildPaceLine：稳态喊 15 分钟', async () => {
  const { buildPaceLine } = await import('../bin/fetch.mjs');
  assert.match(buildPaceLine({ currentIntervalSec: 900, zone: '稳态 (15m)' }), /15 分钟/);
});

test('buildPaceLine：不整分钟的间隔按秒说', async () => {
  const { buildPaceLine } = await import('../bin/fetch.mjs');
  assert.match(buildPaceLine({ currentIntervalSec: 90, zone: '温区' }), /90 秒/);
});

test('buildPaceLine：心跳状态坏了就闭嘴，不许喊出 NaN 分钟', async () => {
  const { buildPaceLine } = await import('../bin/fetch.mjs');
  assert.equal(buildPaceLine(null), '');
  assert.equal(buildPaceLine({}), '');
  assert.equal(buildPaceLine({ currentIntervalSec: 'x' }), '');
  assert.equal(buildPaceLine({ currentIntervalSec: 0 }), '');
});

test('buildFollowupReport：看着没说完就把「问一句」的命令一起打出来', async () => {
  const { buildFollowupReport } = await import('../bin/fetch.mjs');
  const lines = buildFollowupReport([{
    segId: 'seg-9', project: 'P24-x', task: 'T137-y', who: '小李',
    sourceLabel: '明道云 · 私信',
    msgs: [{ at: '2026-08-14 18:11:00', text: '调整内容：' }],
    probe: '他最后那句以冒号/逗号收尾，话没说完',
  }]).join('\n');
  assert.match(lines, /看着像没说完/);
  assert.match(lines, /--seg seg-9/);
  assert.match(lines, /还有要补充的吗/);
  assert.match(lines, /--auto/, '这是纯回执，走 🟢 那一档');
});

test('buildFollowupReport：话说完了就不打那几行', async () => {
  const { buildFollowupReport } = await import('../bin/fetch.mjs');
  const lines = buildFollowupReport([{
    segId: 'seg-9', project: 'P24-x', who: '小李', sourceLabel: '明道云 · 私信',
    msgs: [{ at: '2026-08-14 18:11:00', text: '可以的' }], probe: null,
  }]).join('\n');
  assert.doesNotMatch(lines, /还有要补充的吗/);
});
