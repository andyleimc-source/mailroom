// dailymd 不新鲜就拒跑这道闸的纯逻辑测试。
//
// 2026-08-27 事故：dailymd 落后远端 26 个提交，判定时看到过期的项目/任务清单，
// 把已经办完的事重新建了一遍卡。这道闸就是堵这个——见 lib.mjs 的 checkDailymdFreshness。
//
// 全程用假的 exec 函数（不真跑 git、不碰真仓库），只测状态机本身。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpState } from './helpers.mjs';

tmpState();

const { checkDailymdFreshness } = await import('../lib.mjs');

// 造一个假 exec：按 (dir, args) 的关键字匹配返回预设结果。
function fakeExec(script) {
  return (dir, args) => {
    const key = args.join(' ');
    for (const [pattern, result] of script) {
      if (key.startsWith(pattern)) return result;
    }
    throw new Error(`fakeExec 没配置这条: ${key}`);
  };
}

test('不是 git 仓库 —— 放行，不挡', () => {
  const exec = fakeExec([
    ['rev-parse --is-inside-work-tree', { status: 1, stdout: '' }],
  ]);
  const r = checkDailymdFreshness({ dir: '/nope', exec });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.lines, []);
});

test('fetch 失败（离线）—— 放行，不挡', () => {
  const exec = fakeExec([
    ['rev-parse --is-inside-work-tree', { status: 0, stdout: 'true' }],
    ['fetch -q', { status: 1, stdout: '' }],
  ]);
  const r = checkDailymdFreshness({ dir: '/x', exec });
  assert.equal(r.status, 'ok');
});

test('没连远端分支 —— 放行，不挡', () => {
  const exec = fakeExec([
    ['rev-parse --is-inside-work-tree', { status: 0, stdout: 'true' }],
    ['fetch -q', { status: 0, stdout: '' }],
    ['rev-parse --abbrev-ref --symbolic-full-name @{u}', { status: 1, stdout: '' }],
  ]);
  const r = checkDailymdFreshness({ dir: '/x', exec });
  assert.equal(r.status, 'ok');
});

test('干净（不领先不落后）—— 放行', () => {
  const exec = fakeExec([
    ['rev-parse --is-inside-work-tree', { status: 0, stdout: 'true' }],
    ['fetch -q', { status: 0, stdout: '' }],
    ['rev-parse --abbrev-ref --symbolic-full-name @{u}', { status: 0, stdout: 'origin/main' }],
    ['rev-list --count @..@{u}', { status: 0, stdout: '0' }],
    ['rev-list --count @{u}..@', { status: 0, stdout: '0' }],
  ]);
  const r = checkDailymdFreshness({ dir: '/x', exec });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.lines, []);
});

test('分叉（既领先又落后）—— 拒跑', () => {
  const exec = fakeExec([
    ['rev-parse --is-inside-work-tree', { status: 0, stdout: 'true' }],
    ['fetch -q', { status: 0, stdout: '' }],
    ['rev-parse --abbrev-ref --symbolic-full-name @{u}', { status: 0, stdout: 'origin/main' }],
    ['rev-list --count @..@{u}', { status: 0, stdout: '26' }],
    ['rev-list --count @{u}..@', { status: 0, stdout: '1' }],
  ]);
  const r = checkDailymdFreshness({ dir: '/x', exec });
  assert.equal(r.status, 'blocked');
  assert.ok(r.lines.some((l) => l.includes('分叉')));
});

test('只落后、pull --ff-only 成功 —— 放行并留一行说明', () => {
  const exec = fakeExec([
    ['rev-parse --is-inside-work-tree', { status: 0, stdout: 'true' }],
    ['fetch -q', { status: 0, stdout: '' }],
    ['rev-parse --abbrev-ref --symbolic-full-name @{u}', { status: 0, stdout: 'origin/main' }],
    ['rev-list --count @..@{u}', { status: 0, stdout: '3' }],
    ['rev-list --count @{u}..@', { status: 0, stdout: '0' }],
    ['pull --ff-only', { status: 0, stdout: '' }],
  ]);
  const r = checkDailymdFreshness({ dir: '/x', exec });
  assert.equal(r.status, 'ok');
  assert.ok(r.lines.some((l) => l.includes('已自动 pull')));
});

test('只落后、pull --ff-only 失败（本地有改动挡着）—— 拒跑', () => {
  const exec = fakeExec([
    ['rev-parse --is-inside-work-tree', { status: 0, stdout: 'true' }],
    ['fetch -q', { status: 0, stdout: '' }],
    ['rev-parse --abbrev-ref --symbolic-full-name @{u}', { status: 0, stdout: 'origin/main' }],
    ['rev-list --count @..@{u}', { status: 0, stdout: '3' }],
    ['rev-list --count @{u}..@', { status: 0, stdout: '0' }],
    ['pull --ff-only', { status: 1, stdout: '' }],
  ]);
  const r = checkDailymdFreshness({ dir: '/x', exec });
  assert.equal(r.status, 'blocked');
  assert.ok(r.lines.some((l) => l.includes('自动 pull 失败')));
});
