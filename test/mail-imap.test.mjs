// 网易传输层的薄壳。⚠ 不连真邮箱：run 执行器整个注入掉，
//   这里测的是「参数拼对没有」和「错误分级对不对」，不是 IMAP 协议本身。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpState } from './helpers.mjs';
import { imapFetch, imapMarkRead, imapSaveDraft, smtpSend } from '../mail/imap.mjs';
import { MailAuthError } from '../lib.mjs';

tmpState();

test('fetch 把 sinceUid / uidValidity 原样传给 python，回来的消息直接给出去', () => {
  let seen = null;
  const run = (payload) => {
    seen = payload;
    return {
      ok: true,
      uidValidity: '123',
      lastUid: '42',
      messages: [{
        id: '42', threadId: 't1', at: '2026-08-10T06:00:00.000Z', subject: '主题',
        from: { name: '李雷', address: 'lei.li@corp-mail.com' },
        to: [{ name: '', address: 'me@corp-mail.com' }], cc: [], bcc: [],
        text: '正文', html: '', attachmentNames: [],
      }],
    };
  };
  const r = imapFetch({ sinceUid: '40', uidValidity: '123', limit: 50, run });
  assert.equal(seen.op, 'fetch');
  assert.equal(seen.since_uid, '40');
  assert.equal(seen.uid_validity, '123');
  assert.equal(seen.limit, 50);
  assert.equal(r.messages.length, 1);
  assert.equal(r.lastUid, '42');
});

test('授权码失效 → MailAuthError（要让整轮停下来喊 小明，不能当成没新邮件）', () => {
  const run = () => ({ ok: false, auth: true, error: 'LOGIN failed' });
  assert.throws(() => imapFetch({ run }), MailAuthError);
});

test('普通错误抛普通 Error，不是 MailAuthError（分级不能混）', () => {
  const run = () => ({ ok: false, auth: false, error: '连接超时' });
  assert.throws(() => imapFetch({ run }), (e) => e instanceof Error && !(e instanceof MailAuthError));
});

test('python 吐回来的不是对象一律抛错，绝不当成零封新邮件', () => {
  assert.throws(() => imapFetch({ run: () => null }), /没给回/);
  assert.throws(() => imapFetch({ run: () => 'boom' }), /没给回/);
});

test('mark_read 传 uid 数组', () => {
  let seen = null;
  imapMarkRead(['1', '2'], { run: (p) => { seen = p; return { ok: true }; } });
  assert.equal(seen.op, 'mark_read');
  assert.deepEqual(seen.uids, ['1', '2']);
});

test('save_draft 传的是 html，并带上线程头', () => {
  let seen = null;
  imapSaveDraft({
    subject: 'RE: 关于 G2', html: '<p>好的</p>',
    to: ['client@example.com'], cc: [], inReplyTo: '<abc@x>', references: '<abc@x>',
  }, { run: (p) => { seen = p; return { ok: true, folder: '&g0l6P3ux-' }; } });
  assert.equal(seen.op, 'save_draft');
  assert.equal(seen.html, '<p>好的</p>');
  assert.equal(seen.in_reply_to, '<abc@x>');
  assert.equal(seen.references, '<abc@x>');
  assert.deepEqual(seen.to, ['client@example.com']);
});

test('smtp_send 也是 html', () => {
  let seen = null;
  smtpSend({ subject: 'RE: 在吗', html: '<p>在</p>', to: ['feng.zhang@corp-mail.com'] },
    { run: (p) => { seen = p; return { ok: true }; } });
  assert.equal(seen.op, 'smtp_send');
  assert.equal(seen.html, '<p>在</p>');
});

test('授权码不许经过 node：薄壳源码里不许出现读钥匙串的命令', () => {
  const src = readFileSync(new URL('../mail/imap.mjs', import.meta.url), 'utf-8');
  assert.doesNotMatch(src, /find-generic-password/);
});

test('python 助手不许有「登录失败就当没新邮件」这种吞错写法', () => {
  const src = readFileSync(new URL('../mail/imap.py', import.meta.url), 'utf-8');
  // 裸 except 后面直接 pass / 直接 return 空，是老系统「消息永久消失」的模子
  assert.doesNotMatch(src, /except[^\n]*:\s*\n\s*pass\s*\n/);
});

test('fetch 把这一轮的 uidValidity 挂到每封信上（记录 id 要用它防重号撞车）', () => {
  const run = () => ({
    ok: true,
    uidValidity: '222',
    lastUid: '1202',
    messages: [{ id: '1201', subject: 'a' }, { id: '1202', subject: 'b' }],
  });
  const r = imapFetch({ sinceUid: '1200', uidValidity: '111', limit: 50, run });
  assert.deepEqual(r.messages.map((m) => m.uidValidity), ['222', '222'],
    '不挂上去 normalize 就拼不出带 uidValidity 的 id，邮箱重建后新邮件会被当成重复丢掉');
  assert.deepEqual(r.messages.map((m) => m.id), ['1201', '1202'],
    'm.id 本身不许改：标已读要拿它传回给 python');
});
