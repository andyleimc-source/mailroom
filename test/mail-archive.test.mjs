// 邮件归档去 assets/mail-log/，明道云还在 assets/hap-log/，两边不许串。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpState, tmpDailymd } from './helpers.mjs';
import { archive, logDir, readMonth } from '../archive.mjs';

tmpState();

test('不给 subdir 还是写 hap-log（老行为一个字不变）', () => {
  const { root, cleanup } = tmpDailymd();
  try {
    assert.equal(logDir({ dailymd: root }), join(root, 'assets/hap-log'));
    const n = archive([{
      id: 'm1', ts: '2026-08-10T06:00:00.000Z', dir: 'in', kind: 'user',
      peer: '李雷', peerId: 'acc-1', text: '在吗', via: '明道云 · 私信',
    }], { dailymd: root });
    assert.equal(n, 1);
    const jsonl = join(root, 'assets/hap-log/2026-08.jsonl');
    assert.ok(existsSync(jsonl));
    assert.ok(!existsSync(join(root, 'assets/mail-log')));
    // 锁死明道云记录落盘后的键集合：normalize() 以后谁给
    // recordFromChatMessage/recordFromSend 加个新字段（比如 account），
    // 这条要能因为「多了个没见过的键」而挂掉，不能悄悄改了 hap-log 的形状没人发现。
    const rec = JSON.parse(readFileSync(jsonl, 'utf-8').trim());
    assert.deepEqual(Object.keys(rec).sort(), [
      'id', 'ts', 'dir', 'kind', 'peer', 'peerId', 'groupId', 'groupName', 'postId', 'text', 'via',
    ].sort());
  } finally { cleanup(); }
});

test('给了 subdir 就写到那个目录，并且 .md 也一起渲染', () => {
  const { root, cleanup } = tmpDailymd();
  try {
    const n = archive([{
      id: 'mail-work-1', ts: '2026-08-10T06:34:14.000Z', dir: 'in', kind: 'mail',
      peer: '李雷', peerId: 'lei.li@corp-mail.com', text: '你好',
      via: '邮件 · work', subject: '关于 G2', from: 'lei.li@corp-mail.com',
      to: ['me@acme.com'], cc: [], threadId: 'thread-1', account: 'work',
      attachmentNames: ['报价单.pdf'],
    }], { dailymd: root, subdir: 'assets/mail-log' });
    assert.equal(n, 1);
    const jsonl = join(root, 'assets/mail-log/2026-08.jsonl');
    assert.ok(existsSync(jsonl));
    assert.ok(existsSync(join(root, 'assets/mail-log/2026-08.md')));
    const rec = JSON.parse(readFileSync(jsonl, 'utf-8').trim());
    assert.equal(rec.subject, '关于 G2');       // 邮件专属字段要原样存下来
    // 对称锁一下邮件记录的键集合：7 个邮件专属字段都得原样落盘，一个不许丢。
    assert.deepEqual(Object.keys(rec).sort(), [
      'id', 'ts', 'dir', 'kind', 'peer', 'peerId', 'groupId', 'groupName', 'postId', 'text', 'via',
      'subject', 'from', 'to', 'cc', 'threadId', 'account', 'attachmentNames',
    ].sort());
    assert.ok(!existsSync(join(root, 'assets/hap-log/2026-08.jsonl')));
  } finally { cleanup(); }
});

test('readMonth 也认 subdir，两个目录互不可见', () => {
  const { root, cleanup } = tmpDailymd();
  try {
    archive([{ id: 'a', ts: '2026-08-10T06:00:00.000Z', dir: 'in', kind: 'mail', peer: 'x', peerId: 'x@y.com', text: 'hi' }],
      { dailymd: root, subdir: 'assets/mail-log' });
    assert.equal(readMonth('2026-08', { dailymd: root, subdir: 'assets/mail-log' }).length, 1);
    assert.equal(readMonth('2026-08', { dailymd: root }).length, 0);
  } finally { cleanup(); }
});

test('同一封邮件归档两次只写一条（补收可以反复跑）', () => {
  const { root, cleanup } = tmpDailymd();
  try {
    const rec = { id: 'mail-work-1', ts: '2026-08-10T06:00:00.000Z', dir: 'in', kind: 'mail', peer: 'x', peerId: 'x@y.com', text: 'hi' };
    assert.equal(archive([rec], { dailymd: root, subdir: 'assets/mail-log' }), 1);
    assert.equal(archive([rec], { dailymd: root, subdir: 'assets/mail-log' }), 0);
  } finally { cleanup(); }
});
