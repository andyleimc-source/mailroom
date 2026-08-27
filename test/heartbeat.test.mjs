import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  calculateTier,
  readHeartbeat,
  boostHeartbeat,
  isDue,
  recordRun,
  formatStatus,
  isClosingAck,
  DEFAULT_INTERVAL_SEC,
} from '../heartbeat.mjs';

function withTmpState(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mailroom-heartbeat-test-'));
  try {
    fn(dir);
  } finally {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}

test('calculateTier 阶梯衰退映射准确', () => {
  const now = 1000000000000;

  // 0 分钟：热区 (60s)
  const t0 = calculateTier(now, now);
  assert.equal(t0.intervalSec, 60);
  assert.equal(t0.zoneKey, 'hot');

  // 2.5 分钟：热区 (60s)
  const t2_5 = calculateTier(now - 2.5 * 60 * 1000, now);
  assert.equal(t2_5.intervalSec, 60);
  assert.equal(t2_5.zoneKey, 'hot');

  // 5 分钟：温区 (120s)
  const t5 = calculateTier(now - 5 * 60 * 1000, now);
  assert.equal(t5.intervalSec, 120);
  assert.equal(t5.zoneKey, 'warm');

  // 15 分钟：凉区 (300s)
  const t15 = calculateTier(now - 15 * 60 * 1000, now);
  assert.equal(t15.intervalSec, 300);
  assert.equal(t15.zoneKey, 'cool');

  // 25 分钟：余温 (600s)
  const t25 = calculateTier(now - 25 * 60 * 1000, now);
  assert.equal(t25.intervalSec, 600);
  assert.equal(t25.zoneKey, 'tepid');

  // 35 分钟：稳态 (900s)
  const t35 = calculateTier(now - 35 * 60 * 1000, now);
  assert.equal(t35.intervalSec, 900);
  assert.equal(t35.zoneKey, 'steady');

  // 空值或无效值兜底稳态
  assert.equal(calculateTier(null).intervalSec, DEFAULT_INTERVAL_SEC);
  assert.equal(calculateTier(undefined).intervalSec, DEFAULT_INTERVAL_SEC);
  assert.equal(calculateTier('invalid-date').intervalSec, DEFAULT_INTERVAL_SEC);
});

test('boostHeartbeat 立即激活热区并将 nextRunAt 设为当前时间', () => {
  withTmpState((dir) => {
    const now = 1000000000000;
    const state = boostHeartbeat({ reason: '外发私信给小明', now, stateDir: dir });
    assert.equal(state.currentIntervalSec, 60);
    assert.equal(state.zoneKey, 'hot');
    assert.equal(state.nextRunAt, now);
    assert.equal(state.boostReason, '外发私信给小明');

    // 此时 isDue 应该为 true
    assert.equal(isDue({ now, stateDir: dir }), true);

    // 持久化读取验证
    const read = readHeartbeat(dir);
    assert.equal(read.zoneKey, 'hot');
    assert.equal(read.currentIntervalSec, 60);
  });
});

test('recordRun 在热区中推进 60 秒并在之后逐步衰退', () => {
  withTmpState((dir) => {
    const start = 1000000000000;
    boostHeartbeat({ reason: '测试互动', now: start, stateDir: dir });

    // 第一次运行记录：推进 60 秒
    const r1 = recordRun({ now: start, stateDir: dir });
    assert.equal(r1.nextRunAt, start + 60 * 1000);
    assert.equal(r1.currentIntervalSec, 60);

    // 30 秒后再次检查，尚未到期
    assert.equal(isDue({ now: start + 30 * 1000, stateDir: dir }), false);
    // 60 秒后到期
    assert.equal(isDue({ now: start + 60 * 1000, stateDir: dir }), true);

    // 4 分钟后（进入温区 2m）再次记录运行
    const after4m = start + 4 * 60 * 1000;
    const r2 = recordRun({ now: after4m, stateDir: dir });
    assert.equal(r2.zoneKey, 'warm');
    assert.equal(r2.currentIntervalSec, 120);
    assert.equal(r2.nextRunAt, after4m + 120 * 1000);

    // 35 分钟后（回归稳态 15m）再次记录运行
    const after35m = start + 35 * 60 * 1000;
    const r3 = recordRun({ now: after35m, stateDir: dir });
    assert.equal(r3.zoneKey, 'steady');
    assert.equal(r3.currentIntervalSec, 900);
    assert.equal(r3.nextRunAt, after35m + 900 * 1000);
  });
});

test('formatStatus 格式化输出正常', () => {
  withTmpState((dir) => {
    const now = Date.now();
    const state = boostHeartbeat({ reason: '测试', now, stateDir: dir });
    const str = formatStatus(state);
    assert.ok(str.includes('热区 (1m)'));
    assert.ok(str.includes('秒后') || str.includes('随时就绪') || str.includes('分钟前'));
  });
});

test('isClosingAck：纯回执/寒暄收尾话判成收尾', () => {
  for (const text of ['好的', '好', '收到', '收到了', 'OK', 'ok', 'okay', '嗯嗯', '哦哦', '明白', '知道了', '了解', '辛苦了', '谢谢', '谢啦', 'thanks', 'Thank you', '👌', '[Good]', '[good]']) {
    assert.equal(isClosingAck(text), true, `"${text}" 该判成收尾`);
  }
});

test('isClosingAck：带实质内容的句子不算收尾，就算里面也有「好的」', () => {
  for (const text of [
    '好的，那这个方案我们下周二上线',
    '收到，我这就去处理，大概下午三点前能弄完',
    '这个是我们的网址，目前pc端是可以正常报名使用的',
    '',
    '   ',
    undefined,
    null,
  ]) {
    assert.equal(isClosingAck(text), false, `"${text}" 不该判成收尾`);
  }
});
