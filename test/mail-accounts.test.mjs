// 账号配置与内外部判定。这道判定决定「这封能不能直发」，是全系统最不能出错的一处，
// 所以畸形输入、子域、大小写、空收件人全部钉死。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpState } from './helpers.mjs';
import {
  accounts, accountById, parseAddress, parseAddressList,
  isInternalAddress, isExternalRecipients,
} from '../mail/accounts.mjs';

tmpState();

test('两个账号都在，地址和传输方式对得上', () => {
  assert.equal(accounts().length, 2);
  assert.equal(accountById('work').address, 'me@acme.com');
  assert.equal(accountById('work').transport, 'graph');
  assert.equal(accountById('corp').address, 'me@corp-mail.com');
  assert.equal(accountById('corp').transport, 'imap');
  assert.equal(accountById('不存在'), undefined);
});

test('parseAddress 认得三种写法', () => {
  assert.deepEqual(parseAddress('"小明 Lei" <me@acme.com>'),
    { name: '小明 Lei', address: 'me@acme.com' });
  assert.deepEqual(parseAddress('李雷 <lei.li@corp-mail.com>'),
    { name: '李雷', address: 'lei.li@corp-mail.com' });
  assert.deepEqual(parseAddress('a@b.com'), { name: '', address: 'a@b.com' });
  assert.deepEqual(parseAddress('<a@b.com>'), { name: '', address: 'a@b.com' });
  assert.deepEqual(parseAddress(''), { name: '', address: '' });
  assert.deepEqual(parseAddress(null), { name: '', address: '' });
});

test('parseAddressList 认逗号分隔，也认已经是数组的', () => {
  assert.deepEqual(parseAddressList('a@b.com, "X Y" <x@y.com>').map((p) => p.address),
    ['a@b.com', 'x@y.com']);
  assert.deepEqual(parseAddressList(['a@b.com']).map((p) => p.address), ['a@b.com']);
  assert.deepEqual(parseAddressList(''), []);
  assert.deepEqual(parseAddressList(null), []);
});

test('内部域名判定：大小写、子域、畸形', () => {
  assert.equal(isInternalAddress('feng.zhang@corp-mail.com'), true);
  assert.equal(isInternalAddress('Me.Wang@ACME.COM'), true);
  assert.equal(isInternalAddress('x@mail.corp-mail.com'), true);      // 子域算内部
  assert.equal(isInternalAddress('x@notcorp-mail.com'), false);       // 后缀相同但不是子域
  assert.equal(isInternalAddress('x@corp-mail.com.evil.cn'), false);  // 域名在中间不算
  assert.equal(isInternalAddress('corp-mail.com@gmail.com'), false);  // 域名出现在本地部不算
  assert.equal(isInternalAddress(''), false);
  assert.equal(isInternalAddress('没有at符号'), false);
});

test('只要出现一个外部地址，整封算外部', () => {
  const inn = [{ address: 'feng.zhang@corp-mail.com' }];
  const ext = [{ address: 'client@example.com' }];
  assert.equal(isExternalRecipients({ to: inn }), false);
  assert.equal(isExternalRecipients({ to: inn, cc: inn }), false);
  assert.equal(isExternalRecipients({ to: ext }), true);
  assert.equal(isExternalRecipients({ to: inn, cc: ext }), true);   // 抄送里有外部
  assert.equal(isExternalRecipients({ to: inn, bcc: ext }), true);  // 密送里有外部
});

test('一个收件人都认不出来，按外部处理（拿不准一律关门）', () => {
  assert.equal(isExternalRecipients({}), true);
  assert.equal(isExternalRecipients({ to: [], cc: [], bcc: [] }), true);
  assert.equal(isExternalRecipients({ to: [{ address: '' }] }), true);
});

test('显示名含逗号不切分（Outlook 常见的「姓, 名」格式）', () => {
  // 单个地址，显示名是「Wang, Xiaoming」
  const single = parseAddressList('"Wang, Xiaoming" <me@corp-mail.com>');
  assert.equal(single.length, 1);
  assert.equal(single[0].name, 'Wang, Xiaoming');
  assert.equal(single[0].address, 'me@corp-mail.com');

  // 两个地址，第一个显示名含逗号，第二个简单
  const two = parseAddressList('"Wang, Xiaoming" <a@corp-mail.com>, b@acme.com');
  assert.equal(two.length, 2);
  assert.equal(two[0].name, 'Wang, Xiaoming');
  assert.equal(two[0].address, 'a@corp-mail.com');
  assert.equal(two[1].name, '');
  assert.equal(two[1].address, 'b@acme.com');

  // 含逗号显示名的内部地址不应该被误判成外部
  assert.equal(isExternalRecipients({ to: parseAddressList('"Wang, Xiaoming" <a@corp-mail.com>') }), false);
});
