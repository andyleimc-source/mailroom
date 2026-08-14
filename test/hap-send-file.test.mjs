// 私信/群消息带附件：正文一条、文件一条，成败分开报。
//
// ⚠ 传输层一律注入假的（`{ io: { hap } }`），绝不真发 —— 明道云没有撤回接口。
//   本文件**故意不设** MAILROOM_ALLOW_REAL_IO：哪天注入漏了，lib.assertNoRealIO 当场打红。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as hapAdapter from '../connect/hap.mjs';

function fakeHap(failOn) {
  const calls = [];
  return {
    calls,
    hap: (args) => {
      calls.push(args);
      if (failOn && args.includes(failOn)) throw new Error('hap 超时');
      return '';
    },
  };
}

const USER_SEG = () => ({
  kind: 'user', who: '周婷', target: { accountId: 'acc-mai' },
});
const GROUP_SEG = () => ({
  kind: 'group', who: '周婷', target: { groupId: 'g-1', groupName: '前端群' },
});

test('私信带附件：先发正文，再发文件，两条独立的命令', () => {
  const t = fakeHap();
  const r = hapAdapter.sendVia(USER_SEG(), '包发你了。', {
    io: { hap: t.hap }, filePath: '/tmp/pkg.zip',
  });

  assert.equal(t.calls.length, 2, '正文一条 + 附件一条');
  assert.deepEqual(t.calls[0].slice(0, 4), ['chat', 'send-to-one', '-t', 'acc-mai']);
  assert.deepEqual(t.calls[1], ['chat', 'send-file-to-one', '-t', 'acc-mai', '--file', '/tmp/pkg.zip']);
  assert.equal(r.file, '/tmp/pkg.zip');
  assert.ok(!r.fileError);
});

test('群消息带附件：走 send-file-to-group', () => {
  const t = fakeHap();
  const r = hapAdapter.sendVia(GROUP_SEG(), '包发群里了。', {
    io: { hap: t.hap }, filePath: '/tmp/pkg.zip',
  });

  assert.equal(t.calls.length, 2);
  assert.deepEqual(t.calls[1], ['chat', 'send-file-to-group', '-g', 'g-1', '--file', '/tmp/pkg.zip']);
  assert.equal(r.channel, '群消息');
});

test('不给 --file 就一条都不多发（老路径一个字没变）', () => {
  const t = fakeHap();
  const r = hapAdapter.sendVia(USER_SEG(), '就一句话。', { io: { hap: t.hap } });
  assert.equal(t.calls.length, 1);
  assert.ok(!r.file);
});

test('⚠ 附件发失败不许拖垮正文：如实报 fileError，不抛错', () => {
  const t = fakeHap('send-file-to-one');
  const r = hapAdapter.sendVia(USER_SEG(), '包发你了。', {
    io: { hap: t.hap }, filePath: '/tmp/pkg.zip',
  });

  // 正文那一条已经出去了。抛错的话调用方会当成整件事没发成，
  // 小明 再按一次 = 对方收到两条正文，而消息撤不回来。
  assert.equal(t.calls.length, 2, '正文那条确实发了');
  assert.match(r.fileError, /hap 超时/);
  assert.equal(r.channel, '私信', '正文成功的事实不许被附件失败抹掉');
});
