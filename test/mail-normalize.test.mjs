// 一封已解析的邮件 → candidate / 归档 record。
// ⚠ 这一层不碰网络，纯函数，所以边界情况在这儿一次钉死：
//   没有纯文本分支的 HTML 邮件、超长正文、附件名、外部判定、缺字段。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpState } from './helpers.mjs';
import { BODY_MAX, htmlToText, bodyText, toCandidate, toRecord } from '../mail/normalize.mjs';
import { accountById } from '../mail/accounts.mjs';

tmpState();

const WORK_ACC = accountById('work');

function mail(over = {}) {
  return {
    id: 'AAMkAD123',
    threadId: 'conv-1',
    at: '2026-08-10T06:34:14.000Z',
    subject: '关于 G2 评论的事',
    from: { name: '李雷', address: 'lei.li@corp-mail.com' },
    to: [{ name: '小明 Lei', address: 'me@acme.com' }],
    cc: [],
    bcc: [],
    replyTo: [],
    text: '你好，附件里是清单。',
    html: '',
    attachmentNames: [],
    ...over,
  };
}

test('htmlToText 去标签、还原实体、压空行', () => {
  const out = htmlToText('<p>第一段</p><br><div>第二段&nbsp;&amp;结尾</div><script>x=1</script>');
  assert.match(out, /第一段/);
  assert.match(out, /第二段 &结尾/);
  assert.doesNotMatch(out, /<p>|<div>|script/);
});

test('bodyText 优先纯文本；没有纯文本才用 HTML', () => {
  assert.equal(bodyText(mail({ text: '纯文本', html: '<p>HTML</p>' })), '纯文本');
  assert.match(bodyText(mail({ text: '', html: '<p>只有 HTML</p>' })), /只有 HTML/);
  assert.equal(bodyText(mail({ text: '', html: '' })), '');
});

test('candidate 的形状和字段', () => {
  const c = toCandidate(mail(), WORK_ACC);
  assert.equal(c.sourceKind, 'mail');
  assert.equal(c.kind, 'mail');
  assert.equal(c.account, 'work');
  assert.equal(c.who, '李雷');
  assert.equal(c.whoAddress, 'lei.li@corp-mail.com');
  assert.equal(c.external, false);
  assert.equal(c.target.messageId, 'AAMkAD123');
  assert.equal(c.target.threadId, 'conv-1');
  assert.equal(c.target.subject, '关于 G2 评论的事');
  assert.equal(c.msgs.length, 1);
  // ⚠ 段里的 at 是**本地时间**（带 +08:00），不是 Graph 给的 UTC 原值：
  //   原值只留给增量查询的水位线；段里这个只用来显示和聚段。照抄 UTC 会让邮件段和
  //   明道云段在同一个 segments.json 里混两种时区，每轮触发一次落盘门口的自愈。
  assert.equal(c.msgs[0].at, '2026-08-10T14:34:14.000+08:00');
  // 正文第一行是主题，方便在 inbox.md 里一眼看出这封讲什么
  assert.match(c.msgs[0].text, /^主题：关于 G2 评论的事/);
  assert.match(c.msgs[0].text, /你好，附件里是清单。/);
});

test('发件人没有显示名就退回地址，不出现空白的「谁」', () => {
  const c = toCandidate(mail({ from: { name: '', address: 'x@example.com' } }), WORK_ACC);
  assert.equal(c.who, 'x@example.com');
});

test('收件人里有外部地址 → external=true', () => {
  const c = toCandidate(mail({ cc: [{ name: '', address: 'client@example.com' }] }), WORK_ACC);
  assert.equal(c.external, true);
});

test('超长正文截断，并注明全文在哪', () => {
  const c = toCandidate(mail({ text: '啊'.repeat(BODY_MAX + 500) }), WORK_ACC);
  assert.ok(c.msgs[0].text.length < BODY_MAX + 200);
  assert.match(c.msgs[0].text, /assets\/mail-log/);
});

test('附件名列进正文，别让人以为没附件', () => {
  const c = toCandidate(mail({ attachmentNames: ['报价单.pdf', 'logo.png'] }), WORK_ACC);
  assert.match(c.msgs[0].text, /报价单\.pdf/);
  assert.match(c.msgs[0].text, /logo\.png/);
  assert.equal(c.target.hasAttachments, true);
});

test('归档 record 带全字段，正文不截断', () => {
  const long = '啊'.repeat(BODY_MAX + 500);
  const r = toRecord(mail({ text: long }), WORK_ACC);
  assert.equal(r.kind, 'mail');
  assert.equal(r.dir, 'in');
  assert.equal(r.id, 'mail-work-AAMkAD123');
  // ⚠ 给人看的 ts 统一是本地时间（Graph 给的 06:34Z = 东八区 14:34）。
  //   邮件原值 Z 只保留在 ParsedMail 的 at 上，那份要拿去当增量查询的水位线。
  assert.equal(r.ts, '2026-08-10T14:34:14.000+08:00');
  assert.equal(r.peer, '李雷');
  assert.equal(r.peerId, 'lei.li@corp-mail.com');
  assert.equal(r.subject, '关于 G2 评论的事');
  assert.equal(r.account, 'work');
  assert.equal(r.threadId, 'conv-1');
  assert.ok(r.text.includes(long));           // 归档是事实源，不许截断
});

// ---------- ⚠⚠ 聚段活得下来的那几个字段 ----------
//
// 段（segment.mjs 的 toSegments）只把 sourceKind/sourceType/sourceLabel/who/whoAccountId/
// target/msgs/firstAt/lastAt/filed/dropped/waiting 带进去 —— candidate 顶层的
// `external` / `whoAddress` / `account` **在聚段那一步就掉了**。
// 而 `connect/mail.mjs` 的 sendVia 收到的正是段：读顶层的话 `item.external` 永远是
// undefined，「内部直发」那条路一次都走不到（还不报错）。
// `target` 是原样带过去的，所以这三样必须在 target 里也有一份。
test('⚠⚠ target 里带着 external / whoAddress / messageIdHeader —— 聚段之后发送那一步只剩 target', () => {
  const c = toCandidate(mail({ messageIdHeader: '<abc@mail.example>' }), WORK_ACC);
  assert.equal(c.target.external, false);
  assert.equal(c.target.whoAddress, 'lei.li@corp-mail.com');
  assert.equal(c.target.messageIdHeader, '<abc@mail.example>');
  assert.equal(c.target.account, 'work');
  // 顶层那三个不许删：run.mjs 的 muteHit 读的是 cand.whoAddress（candidate 阶段）
  assert.equal(c.external, false);
  assert.equal(c.whoAddress, 'lei.li@corp-mail.com');
  assert.equal(c.account, 'work');
});

test('⚠⚠ target 带上 replyTo：回信真正会送到的是它，不是 From', () => {
  const c = toCandidate(mail({
    from: { name: '', address: 'crm-notify@corp-mail.com' },
    replyTo: [{ name: 'Bob', address: 'bob@client-corp.com' }],
  }), WORK_ACC);
  assert.deepEqual(c.target.replyTo, ['bob@client-corp.com']);
  // ⚠ 这里**故意**不改顶层 external 的算法（那是 Task 2 的语义，别处也在读）：
  //   Reply-To 参与的是发送那一步的门（connect/mail.mjs 的 isExternalReply）。
  assert.equal(c.target.external, false);
});

test('没有 Reply-To 的普通邮件：target.replyTo 是空数组，不是 undefined', () => {
  assert.deepEqual(toCandidate(mail(), WORK_ACC).target.replyTo, []);
});

test('⚠⚠ target.external 跟顶层 external 永远同一个值（两处不许漂移）', () => {
  for (const over of [
    { cc: [{ name: '', address: 'client@example.com' }] },   // 外部
    { to: [] },                                              // 认不出收件人 = 外部
    {},                                                      // 全内部
  ]) {
    const c = toCandidate(mail(over), WORK_ACC);
    assert.equal(c.target.external, c.external, JSON.stringify(over));
  }
});

test('缺字段不崩：没有主题 / 没有时间 / 没有收件人', () => {
  const c = toCandidate(mail({ subject: '', at: '', to: [] }), WORK_ACC);
  assert.equal(typeof c.msgs[0].text, 'string');
  assert.equal(c.external, true);             // 收件人认不出 = 外部
  assert.equal(c.target.subject, '(无主题)');
});

// ---------- 正文为空的邮件不许进不了归档 ----------
//
// ⚠⚠ archive() 会把 text 为空的记录整条过滤掉（`String(r.text||'').trim()`），
//   而 toRecord.text 原来只有正文——主题和附件名都在它之外。实跑：
//   主题「明天会议改到下午3点」+ 附件 议程.pdf + 正文空 → archive() 返回 0，
//   连 jsonl 都没建。而 skill/SKILL.md 写着「drop 掉也没关系，原文照样在归档里」，
//   对这类邮件那句话是假的：drop 之后哪儿都没有了。

test('正文为空：归档 record 退回主题 + 附件名，text 不许是空的', () => {
  const r = toRecord(mail({
    subject: '明天会议改到下午3点',
    text: '',
    html: '',
    attachmentNames: ['议程.pdf'],
  }), WORK_ACC);
  assert.notEqual(r.text.trim(), '', '空 text 会被 archive() 整条丢掉，这封信就哪儿都没有了');
  assert.match(r.text, /明天会议改到下午3点/);
  assert.match(r.text, /议程\.pdf/);
});

test('正文为空、连主题都没有：还是要有内容，不许落成空串', () => {
  const r = toRecord(mail({ subject: '', text: '', html: '', attachmentNames: [] }), WORK_ACC);
  assert.notEqual(r.text.trim(), '');
  assert.match(r.text, /无主题/);
});

test('正文不为空时，归档 text 一个字都不变（不许被主题污染）', () => {
  const r = toRecord(mail({ text: '你好，附件里是清单。', attachmentNames: ['清单.xlsx'] }), WORK_ACC);
  assert.equal(r.text, '你好，附件里是清单。');
});

test('正文为空的邮件真的能落进 jsonl（拿真 archive 跑）', async () => {
  const { tmpDailymd } = await import('./helpers.mjs');
  const { archive } = await import('../archive.mjs');
  const { root, cleanup } = tmpDailymd();
  try {
    const r = toRecord(mail({
      subject: '明天会议改到下午3点', text: '', html: '', attachmentNames: ['议程.pdf'],
    }), WORK_ACC);
    const n = archive([r], { dailymd: root, subdir: 'assets/mail-log' });
    assert.equal(n, 1, 'archive() 返回 0 = 这封信连归档都没有，inbox.md 里 drop 掉就没了');
  } finally { cleanup(); }
});

// ---------- 网易的 id 要带上 uidValidity ----------
//
// ⚠⚠ IMAP 的 UID **只在同一个 uidValidity 里唯一**。服务端重建邮箱之后编号从头再来，
//   同一个自然月内新邮件就可能跟旧邮件撞 `mail-mingdao-<uid>`，而 archive() 按 id 去重
//   —— 撞上就把**新邮件**当成重复静默丢弃，归档里一条不留（inbox.md 里那份是截断过的，
//   长信的后半截就此没了，而且不报错）。窄，但属于「消息静默消失」那一类。

test('网易：同一个 UID 在两个 uidValidity 下必须是两个 id', async () => {
  const CORP_ACC = accountById('corp');
  const before = toRecord(mail({ id: '1201', uidValidity: '111', subject: '老的那封' }), CORP_ACC);
  const after = toRecord(mail({ id: '1201', uidValidity: '222', subject: '重建之后的新信' }), CORP_ACC);
  assert.notEqual(before.id, after.id, 'id 撞车 = 新邮件被 archive() 当成重复静默丢掉');
  assert.equal(after.id, 'mail-corp-222-1201');
  // candidate 那份（msgKey 去重用的）也得跟着分开
  assert.notEqual(
    toCandidate(mail({ id: '1201', uidValidity: '111' }), CORP_ACC).msgs[0].id,
    toCandidate(mail({ id: '1201', uidValidity: '222' }), CORP_ACC).msgs[0].id,
  );
});

test('网易：uidValidity 变了之后，新邮件真的能落进 jsonl（拿真 archive 跑）', async () => {
  const CORP_ACC = accountById('corp');
  const { tmpDailymd } = await import('./helpers.mjs');
  const { archive } = await import('../archive.mjs');
  const { root, cleanup } = tmpDailymd();
  try {
    const opts = { dailymd: root, subdir: 'assets/mail-log' };
    archive([toRecord(mail({ id: '1201', uidValidity: '111', text: '上个月那封' }), CORP_ACC)], opts);
    const n = archive([toRecord(mail({ id: '1201', uidValidity: '222', text: '邮箱重建之后的新信' }), CORP_ACC)], opts);
    assert.equal(n, 1, '邮箱重建后 UID 重号，新邮件不许被当成重复丢掉');
  } finally { cleanup(); }
});

test('ms365 那侧没有 uidValidity，id 形状一个字不变', () => {
  assert.equal(toRecord(mail(), WORK_ACC).id, 'mail-work-AAMkAD123');
});
