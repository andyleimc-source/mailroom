// ⚠⚠ 2026-09-11 事故回归测试：`--at 苏澜`（通讯录本名是「苏澜 Lena」）没匹配上，
//   旧代码把查不到的名字原样当 accountId 发出去，日程评论里变成 [aid]苏澜[/aid] 裸标记，
//   人没被 @ 到也没有报错。现在必须整条拒发。
import test from 'node:test';
import assert from 'node:assert';
import { resolveAtIds } from '../bin/send.mjs';

const people = [
  { name: '苏澜 Lena', nickname: 'Lena', md_account_id: 'aaaa1111' },
  { name: '陈望', nickname: 'Aaron', md_account_id: 'bbbb2222' },
];

test('本名/昵称/accountId 都能查到，返回真 accountId', () => {
  assert.deepStrictEqual(resolveAtIds(['苏澜 Lena', 'Aaron'], people).ids,
    ['aaaa1111', 'bbbb2222']);
});

test('查不到的名字一律拒发，不再原样当 accountId 传下去', () => {
  const r = resolveAtIds(['苏澜'], people);
  assert.ok(!r.ids, '有 miss 就不该返回 ids');
  assert.match(r.error, /拒绝发送/);
  assert.match(r.error, /苏澜 Lena/, '要把相近的候选打出来，否则人只能瞎猜');
});

test('一个人查不到，整条都不发（不是只丢那个人）', () => {
  const r = resolveAtIds(['陈望', '查无此人'], people);
  assert.ok(r.error);
});
