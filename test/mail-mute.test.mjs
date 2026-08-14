// 邮件屏蔽。field 限定了规则的匹配范围，防止正文里的词汇撞进地址规则。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpState } from './helpers.mjs';
import { __muteTest } from '../run.mjs';

tmpState();
const { muteHit } = __muteTest;

function mailCand(over = {}) {
  return {
    sourceKind: 'mail', kind: 'mail', account: 'work',
    who: 'G2', whoAddress: 'noreply@account.g2.com', external: true,
    target: { subject: 'Click to Log-in to your G2 account' },
    msgs: [{ id: 'x', at: '', text: '主题：Click to Log-in\n\n正文' }],
    ...over,
  };
}

test('field:from 限定了规则只匹配发件人地址', () => {
  const rules = [{ pattern: 'noreply@', kind: 'mail', field: 'from', why: '自动发信' }];
  assert.equal(muteHit(mailCand(), rules), '自动发信');
});

test('field:from 的规则不会因为正文里出现 noreply@ 而误伤', () => {
  const rules = [{ pattern: 'noreply@', kind: 'mail', field: 'from', why: '自动发信' }];
  const real = mailCand({
    whoAddress: 'feng.zhang@corp-mail.com',
    msgs: [{ id: 'x', at: '', text: '那个 noreply@ 的规则应该加到屏蔽名单' }],
  });
  assert.equal(muteHit(real, rules), null);
});

test('marketing@ 地址来的真人邮件不被屏蔽', () => {
  const rules = [
    { pattern: '(^|<)(notifications?|alerts?|updates?)@', kind: 'mail', field: 'from', why: '系统播报' },
  ];
  const real = mailCand({
    whoAddress: 'marketing@acme.com',
    msgs: [{ id: 'x', at: '', text: '三月的 newsletter 我们怎么安排' }],
  });
  assert.equal(muteHit(real, rules), null, 'marketing@acme.com 应该不被屏蔽');
});

test('正文里有「退订」的真人邮件不被屏蔽', () => {
  const rules = [
    { pattern: '本邮件由系统自动发送|此邮件为系统自动发送，请勿回复', kind: 'mail', why: '系统自动发信' },
  ];
  const real = mailCand({
    whoAddress: 'feng.zhang@corp-mail.com',
    target: { subject: '邮件营销规划' },
    msgs: [{ id: 'x', at: '', text: '用户反馈，应该加个更明显的退订按钮' }],
  });
  assert.equal(muteHit(real, rules), null, '正文中「退订」不应触发屏蔽');
});

test('主题含 Newsletter 的真人邮件不被屏蔽', () => {
  const rules = [
    { pattern: '本邮件由系统自动发送|此邮件为系统自动发送，请勿回复', kind: 'mail', why: '系统自动发信' },
  ];
  const real = mailCand({
    whoAddress: 'jerry.kim@corp-mail.com',
    target: { subject: 'Newsletter draft for review' },
    msgs: [{ id: 'x', at: '', text: '请帮我过一下这期的文案' }],
  });
  assert.equal(muteHit(real, rules), null, '主题中 Newsletter 不应触发屏蔽');
});

test('noreply@ 地址的邮件仍然被屏蔽', () => {
  const rules = [
    { pattern: '(^|<)(no-?reply|donotreply|do-not-reply|mailer-daemon)@', kind: 'mail', field: 'from', why: '自动发信' },
  ];
  assert.equal(muteHit(mailCand(), rules), '自动发信');
});

test('kind=mail 的规则不许误伤明道云私信', () => {
  const rules = [{ pattern: 'noreply', kind: 'mail', field: 'from', why: '自动发信' }];
  const hap = { sourceKind: 'mingdao', kind: 'user', who: '李雷', msgs: [{ id: '1', at: '', text: 'noreply 这个词' }] };
  assert.equal(muteHit(hap, rules), null);
});

test('不写 field 的规则对整个 hay 生效（向后兼容）', () => {
  const rules = [{ pattern: 'test-word', kind: 'notice', why: '测试' }];
  const notice = { sourceKind: 'mingdao', kind: 'notice', who: '李雷', msgs: [{ id: '1', at: '', text: 'test-word 在正文里' }] };
  assert.equal(muteHit(notice, rules), '测试');
});

test('mute.example.json 里每一条规则都必须显式写 kind（保护明道云私信）', () => {
  const rules = JSON.parse(readFileSync(new URL('../mute.example.json', import.meta.url), 'utf-8'));
  for (const r of rules) {
    assert.equal(typeof r.kind, 'string', `${r.pattern} 缺少 kind 字段，这会吞掉明道云私信`);
  }
  assert.ok(rules.length > 0, 'mute.example.json 应该有规则');
});

// ⚠⚠ 这条比上面那条硬：kind:'mail' 却不写 field 的规则会拿正则去撞**整封邮件**
//   （who/地址/主题/正文全在里面），而同事的来信正文里什么词都可能出现。
//   2026-08-10 评审实跑：第 4 条规则漏了 field，同事转发一封系统告警加一句
//   「这个要不要报运维」，就因为转发正文里带着「本邮件由系统自动发送」被静默吞掉。
test("mute.json 里每条 kind:'mail' 的规则都必须显式写 field", () => {
  const rules = JSON.parse(readFileSync(new URL('../mute.example.json', import.meta.url), 'utf-8'));
  const mail = rules.filter((r) => r.kind === 'mail');
  assert.ok(mail.length > 0, '邮件规则不该一条都没有');
  for (const r of mail) {
    assert.ok(['from', 'subject'].includes(r.field),
      `${r.pattern} 没写 field：不限定范围就会拿正则去撞正文，真人来信会被静默吞掉`);
  }
});

test('真实规则下：同事转发一封系统通知 + 一句话问怎么办，不许被屏蔽', () => {
  // 这封信在评审里是真的被吞掉的。muteHit 不传 rules = 读**真的 mute.json**，
  // 所以哪天有人往里加一条不限 field 的规则，这条会当场变红。
  const real = mailCand({
    account: 'corp',
    who: '李雷',
    whoAddress: 'lei.li@corp-mail.com',
    external: false,
    target: { subject: 'Fwd: 服务器告警，这个要不要处理' },
    msgs: [{
      id: 'x',
      at: '',
      text: '主题：Fwd: 服务器告警，这个要不要处理\n\n雷哥你看下这条，要不要报运维？\n'
        + '---------- 转发的邮件 ----------\n本邮件由系统自动发送，请勿回复',
    }],
  });
  assert.equal(muteHit(real), null, '同事转发系统通知再问一句，是最常见的同事邮件形态之一');
});
