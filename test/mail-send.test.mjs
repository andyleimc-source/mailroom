// 邮件发送。⚠⚠ 这一份里最要紧的一条：external 的邮件永远走不到发送函数。
//   小明 全局开着 bypassPermissions，权限确认框不弹，所以这道门必须是物理的。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpState } from './helpers.mjs';
import * as mail from '../connect/mail.mjs';
import { checkCallName } from '../lib.mjs';
import { toCandidate } from '../mail/normalize.mjs';
import { accountById } from '../mail/accounts.mjs';
import { toSegments } from '../segment.mjs';

tmpState();

// ---------- 称呼门按邮箱认人 ----------
//
// 邮件段的收件人身上没有 md_account_id，只有一个邮箱地址；而 `who` 是**邮件显示名**，
// 跟通讯录里的本名常常对不上（Outlook 里可能是 "Feng Zhang"、也可能干脆就是地址本身）。
// 名字对不上 → matchPerson 认不出人 → 「X 总」那条规则**整条被跳过**（它只按收件人判），
// 这是 fail-open，不是误拦。通讯录里 183 个人有 emails 字段，按它对得上。

const PEOPLE = [
  { name: '赵四', nickname: '老赵', emails: ['zhao.si@corp-mail.com'] },
  { name: '李明', nickname: '明哥', emails: ['ming.li@corp-mail.com'] },
];

test('⚠ 显示名对不上通讯录（邮件里最常见）：靠邮箱照样认得出人，「赵总」要被拦', () => {
  // 这就是生产里的形状：recipientOf 拿 item.who 当 name，而邮件的 who 常常是地址本身
  const vios = checkCallName('赵总您好，收到了。', PEOPLE, {
    to: {
      kind: 'user', name: 'zhao.si@corp-mail.com', accountId: '',
      email: 'zhao.si@corp-mail.com',
    },
  });
  assert.ok(vios.length > 0, '按名字认不出人时「X 总」这条规则会被整条跳过 —— 那是 fail-open');
  assert.equal(vios[0].nickname, '老赵');
});

test('称呼门按邮箱认得出人：给赵四写「赵总」要被拦', () => {
  const vios = checkCallName('赵总您好，收到了。', PEOPLE,
    { to: { kind: 'user', name: '', accountId: '', email: 'zhao.si@corp-mail.com' } });
  assert.ok(vios.length > 0, '按邮箱应该认得出收件人是赵四');
});

test('认出来的是哪一位要准：收件人是李明，「赵总」不是在叫他', () => {
  // ⚠ 这条是上面那条的绊线：邮箱没被真正用来认人的话，会退回「拿全表判 X 总」，
  //   全表里有赵四，于是照样报违规——测试绿着，但认人这件事根本没发生。
  const vios = checkCallName('赵总您好，收到了。', PEOPLE,
    { to: { kind: 'user', name: '', accountId: '', email: 'ming.li@corp-mail.com' } });
  assert.equal(vios.length, 0, '收件人是李明，这条「赵总」不该按李明判成违规');
});

test('邮箱大小写和空格不影响认人', () => {
  const vios = checkCallName('赵总您好', PEOPLE,
    { to: { kind: 'user', name: '', accountId: '', email: '  Zhao.Si@Corp-Mail.COM ' } });
  assert.ok(vios.length > 0);
});

test('邮箱认不出来的人（外部客户）：退回原来的行为，不许因此崩', () => {
  const vios = checkCallName('王总您好，方案见附件。', PEOPLE,
    { to: { kind: 'user', name: 'Client', accountId: '', email: 'client@example.com' } });
  assert.equal(vios.length, 0, '通讯录里没这个人，「王总」是对的叫法');
});

test('recipientOf 给邮件段带上 email —— 门那边才认得出人', async () => {
  const { precheckSend } = await import('../send.mjs');
  const seg = {
    id: 'seg-mail-1',
    sourceKind: 'mail',
    sourceType: 'mail',
    who: 'zhao.si@corp-mail.com',
    whoAddress: 'zhao.si@corp-mail.com',
    target: { account: 'work', from: 'zhao.si@corp-mail.com', whoAddress: 'zhao.si@corp-mail.com' },
    msgs: [{ id: 'm1', at: '2026-08-10T06:00:00Z', text: '主题：x' }],
  };
  const pre = precheckSend('赵总您好', seg, { __test: { people: PEOPLE } });
  assert.equal(pre.to.email, 'zhao.si@corp-mail.com');
  assert.equal(pre.callName.ok, false, '预检就该红着：收件人是赵四，该叫老赵');
});

// ---------- 发：内部直发 / 外部只存草稿 ----------

// 一个已经聚过段的邮件段（sendVia 收到的就是这个形状：顶层没有 external/account/
// whoAddress，全在 target 里 —— 见 mail/normalize.mjs 里那段说明）。
function item(over = {}) {
  const target = {
    account: 'work', messageId: 'g1', threadId: 'c1', subject: '关于 G2',
    from: 'zhao.si@corp-mail.com', whoAddress: 'zhao.si@corp-mail.com',
    messageIdHeader: '<orig@corp-mail.com>',
    to: ['me@acme.com'], cc: [], replyTo: [], external: false,
    ...(over.target || {}),
  };
  return {
    id: 'seg-1', sourceKind: 'mail', sourceType: 'mail', kind: 'mail',
    sourceLabel: '邮件 · work',
    who: '赵四',
    msgs: [{ id: 'm1', at: '2026-08-10T06:00:00Z', text: '主题：关于 G2\n\n原文正文' }],
    firstAt: '2026-08-10T06:00:00Z', lastAt: '2026-08-10T06:00:00Z',
    ...over,
    target,
  };
}

function io() {
  const calls = [];
  return {
    calls,
    graphSend: async (a) => { calls.push(['graphSend', a]); return { ok: true }; },
    graphSaveDraft: async (a) => { calls.push(['graphSaveDraft', a]); return { ok: true, id: 'd1', webLink: 'https://outlook/x' }; },
    smtpSend: (a) => { calls.push(['smtpSend', a]); return { ok: true }; },
    imapSaveDraft: (a) => { calls.push(['imapSaveDraft', a]); return { ok: true, folder: '草稿箱' }; },
  };
}

function 网易(over = {}) {
  return item({
    ...over,
    target: { account: 'corp', ...(over.target || {}) },
  });
}

test('内部收件人：ms365 直发', async () => {
  const t = io();
  const r = await mail.sendVia(item(), '好的，我看一下。', { io: t });
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0][0], 'graphSend');
  assert.equal(r.channel, '邮件');
  assert.ok(!r.draft);
  assert.deepEqual(t.calls[0][1].to, ['zhao.si@corp-mail.com'], '回给原信的发件人');
  assert.equal(t.calls[0][1].replyToId, 'g1', '回在原线程上，不另起一封');
});

test('内部收件人：网易走 SMTP 直发，带上 In-Reply-To 保线程', async () => {
  const t = io();
  await mail.sendVia(网易(), '收到。', { io: t });
  assert.equal(t.calls[0][0], 'smtpSend');
  assert.equal(t.calls[0][1].inReplyTo, '<orig@corp-mail.com>');
  assert.equal(t.calls[0][1].references, '<orig@corp-mail.com>');
});

test('⚠⚠ 外部收件人：只存草稿，绝不调发送', async () => {
  const t = io();
  const r = await mail.sendVia(item({ target: { external: true } }), '您好，方案见附件。', { io: t });
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0][0], 'graphSaveDraft');
  assert.equal(r.draft, true);
  assert.equal(r.channel, '邮件草稿');
  assert.match(r.to, /草稿|点发送/);
  assert.ok(!t.calls.some((c) => c[0] === 'graphSend' || c[0] === 'smtpSend'));
});

test('⚠⚠ 外部收件人（网易）：只存草稿', async () => {
  const t = io();
  const r = await mail.sendVia(网易({ target: { external: true } }), '您好。', { io: t });
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0][0], 'imapSaveDraft');
  assert.equal(r.draft, true);
  assert.ok(!t.calls.some((c) => c[0] === 'smtpSend'));
});

test('⚠⚠ 外部客户单独发给 小明 一个人：原信收件人「全内部」，回信照样只存草稿', async () => {
  // ⚠⚠ Task 2 的 external 算的是**原信的收件人**（to+cc+bcc），发件人自己不在里面。
  //   客户 client@example.com 只发给 me@acme.com 时，收件人全内部 → external=false，
  //   而我们要回的那个人正是这位客户 —— 光信这个字段就会以 小明 本人名义直发给客户，
  //   正是这个任务存在的全部理由。所以门这里再按**这封回复的实际收件人**算一遍。
  const t = io();
  const r = await mail.sendVia(item({
    who: 'client',
    target: { external: false, from: 'client@example.com', whoAddress: 'client@example.com' },
  }), '您好，报价如下。', { io: t });
  assert.equal(r.draft, true, '收件人是外部客户，只能存草稿');
  assert.equal(t.calls[0][0], 'graphSaveDraft');
  assert.ok(!t.calls.some((c) => c[0] === 'graphSend' || c[0] === 'smtpSend'));
});

test('external 缺字段（老段/畸形数据）按外部处理', async () => {
  const t = io();
  const r = await mail.sendVia(
    item({ target: { external: undefined, from: '', whoAddress: '', to: [] } }), '喂', { io: t },
  );
  assert.equal(r.draft, true);
  assert.ok(!t.calls.some((c) => c[0] === 'graphSend' || c[0] === 'smtpSend'));
});

test('external 是个奇怪的值（字符串 "false" / null）也按外部处理', async () => {
  for (const bad of ['false', null, 0, '']) {
    const t = io();
    const r = await mail.sendVia(item({ target: { external: bad } }), '喂', { io: t });
    assert.equal(r.draft, true, `external=${JSON.stringify(bad)} 应该按外部处理`);
  }
});

test('认不出账号：当场抛错，一个字都不发', async () => {
  const t = io();
  await assert.rejects(
    () => mail.sendVia(item({ target: { account: '不存在的账号' } }), '喂', { io: t }),
    /认不出这封邮件属于哪个账号/,
  );
  assert.equal(t.calls.length, 0);
});

test('⚠⚠ 真段走一遍：收信 → 规范化 → 聚段 → 存盘读盘 → 发，内部那条路真的走得到', async () => {
  // ⚠ 这条钉的是「字段在聚段那一步掉了，于是所有邮件都静默走草稿」那个坑：
  //   构造的段是假的话，测试会绿着而生产永远走不到直发。这里从真 candidate 聚出来，
  //   再过一遍 JSON（segments.json 就是这条路），最后喂给 sendVia。
  const parsed = {
    id: 'g9', threadId: 'c9', at: '2026-08-10T06:00:00Z', subject: '内部同事的邮件',
    from: { name: '赵四', address: 'zhao.si@corp-mail.com' },
    to: [{ name: '小明', address: 'me@acme.com' }], cc: [], bcc: [],
    text: '这封全是内部人', html: '', attachmentNames: [], messageIdHeader: '<x@y>',
  };
  const seg = JSON.parse(JSON.stringify(
    toSegments([toCandidate(parsed, accountById('work'))]),
  ))[0];
  assert.equal(seg.external, undefined, '前提：段顶层没有 external，只有 target 里有');

  const t = io();
  const r = await mail.sendVia(seg, '收到，明天给你。', { io: t });
  assert.equal(t.calls[0][0], 'graphSend', '全内部收件人必须走得到直发');
  assert.equal(r.draft, undefined);

  // 同一条链，抄送一个外部地址 → 只存草稿
  const seg2 = JSON.parse(JSON.stringify(toSegments([toCandidate(
    { ...parsed, id: 'g10', cc: [{ name: '', address: 'client@example.com' }] },
    accountById('work'),
  )])))[0];
  const t2 = io();
  assert.equal((await mail.sendVia(seg2, '收到。', { io: t2 })).draft, true);
  assert.equal(t2.calls[0][0], 'graphSaveDraft');
});

test('正文转成 HTML，并把原文用 blockquote 引进来', async () => {
  const t = io();
  await mail.sendVia(item(), '第一行\n第二行', { io: t });
  const { html } = t.calls[0][1];
  assert.match(html, /第一行<br>第二行|第一行<br \/>第二行/);
  assert.match(html, /<blockquote/);
  assert.match(html, /原文正文/);
});

test('正文里的尖括号被转义，不许当成标签发出去', async () => {
  const t = io();
  await mail.sendVia(item(), '报价 <5万 & 交付 >30 天', { io: t });
  const { html } = t.calls[0][1];
  assert.match(html, /&lt;5万 &amp; 交付 &gt;30 天/);
});

test('引原文取的是段里最后一封（要回的就是它），不是第一封', async () => {
  const t = io();
  await mail.sendVia(item({
    msgs: [
      { id: 'm1', at: '2026-08-10T06:00:00Z', text: '第一封说的事' },
      { id: 'm2', at: '2026-08-10T06:20:00Z', text: '第二封才是要回的那封' },
    ],
  }), 'x', { io: t });
  assert.match(t.calls[0][1].html, /第二封才是要回的那封/);
});

test('配了签名的账号：外部邮件带签名，内部邮件不带；没配签名的账号一概不带', async () => {
  // 签名来自配置（mail.accounts[].signature）。这条测试自己造一份带签名的账号配置，
  // 不依赖任何一家公司的落款——仓库里本来就不该内置。
  const st = tmpState({
    mail: {
      enabled: true,
      internalDomains: ['acme.com', 'corp-mail.com'],
      accounts: [
        { id: 'work', address: 'me@acme.com', transport: 'graph',
          graph: { clientId: 'test-client-id', tenant: 'common' },
          signature: ['<p>Best,<br>', '<strong>Test Owner</strong><br>', 'Example Ltd</p>'] },
        { id: 'corp', address: 'me@corp-mail.com', transport: 'imap',
          imap: { host: 'imap.example.com', port: 993 },
          smtp: { host: 'smtp.example.com', port: 465, ssl: true } },
      ],
    },
  });
  try {
    const t = io();
    await mail.sendVia(item({ target: { external: true } }), '您好', { io: t });
    assert.match(t.calls[0][1].html, /Example Ltd/);

    const t2 = io();
    await mail.sendVia(item(), '在的', { io: t2 });
    assert.doesNotMatch(t2.calls[0][1].html, /Example Ltd/, '内部收件人不加签名');

    // corp 账号没配 signature：哪怕是外部邮件也不挂别人的签名
    const t3 = io();
    await mail.sendVia(网易({ target: { external: true } }), '您好', { io: t3 });
    assert.doesNotMatch(t3.calls[0][1].html, /Example Ltd/);
  } finally { st.cleanup(); }
});

test('主题带 RE: 前缀，已经有的不重复加', async () => {
  const t = io();
  await mail.sendVia(item(), 'x', { io: t });
  assert.match(t.calls[0][1].subject, /^RE: 关于 G2$/);
  for (const s of ['RE: 关于 G2', 're: 关于 G2', 'Re: 关于 G2']) {
    const t2 = io();
    await mail.sendVia(item({ target: { subject: s } }), 'x', { io: t2 });
    assert.equal(t2.calls[0][1].subject, s);
  }
});

test('草稿的回执如实说「去点发送」，链接单独给，不塞进落 inbox.md 的那半截', async () => {
  const t = io();
  const r = await mail.sendVia(item({ target: { external: true } }), '您好', { io: t });
  assert.match(r.to, /赵四/);
  assert.doesNotMatch(r.to, /https?:/, '链接不进 inbox.md 的标题行');
  assert.equal(r.link, 'https://outlook/x');

  const t2 = io();
  const r2 = await mail.sendVia(网易({ target: { external: true } }), '您好', { io: t2 });
  assert.match(r2.to, /草稿箱/);
});

// ---------- ⚠⚠ 源码层面的物理门 ----------

// 取 `if (external)` 那对花括号之间的源码。数括号而不是靠正则——正则数不了嵌套，
// 而这条断言的全部价值就在于它数得准。
function externalBlock(src) {
  const at = src.indexOf('if (external)');
  assert.notEqual(at, -1, '找不到 external 那条分支：这条断言等于没测，先来看这里');
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (!depth) return src.slice(open, i + 1);
    }
  }
  throw new Error('external 分支的花括号没配对');
}

test('⚠⚠ 源码里不许出现「external 也能发」的路径', () => {
  // 注释先剥掉：一句「⚠ 这里绝不调 graphSend」的注释不该把自己判成违规。
  const src = readFileSync(new URL('../connect/mail.mjs', import.meta.url), 'utf-8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  // ① 整个文件里，两个发送函数各自只有一处调用点。
  //    ⚠ 数的是**实际的调用形态** `|| graphSend)(`，不是 `graphSend(`——
  //      调用写成 `(io.graphSend || graphSend)({...})`，后者一处都匹配不到，
  //      断言会永远绿着（简报里给的正则就是这个毛病）。
  assert.equal((src.match(/\|\|\s*graphSend\s*\)\s*\(/g) || []).length, 1);
  assert.equal((src.match(/\|\|\s*smtpSend\s*\)\s*\(/g) || []).length, 1);

  // ② external 那条分支里，连这两个名字都不许出现。
  const block = externalBlock(src);
  assert.match(block, /SaveDraft/, '前提：抠出来的确实是存草稿那一段');
  assert.doesNotMatch(block, /graphSend/, '⚠⚠ external 分支里出现了 graphSend');
  assert.doesNotMatch(block, /smtpSend/, '⚠⚠ external 分支里出现了 smtpSend');

  // ③ 分支里必须以 return 收尾——掉出去就会走到下面的直发。
  assert.match(block.trimEnd().slice(-400), /return[\s\S]*\}$/);
});

test('⚠ 适配器是纯传输：没有身份声明、没有称呼门、没有授权断言', () => {
  const src = readFileSync(new URL('../connect/mail.mjs', import.meta.url), 'utf-8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  for (const banned of ['enforceAgentPrefix', 'checkCallName', 'MAILROOM_ROLE', 'approval-desk']) {
    assert.doesNotMatch(src, new RegExp(banned), `⚠ connect/mail.mjs 里出现了 ${banned}：闸只有一处，在 send.mjs`);
  }
});

// ---------- ⚠⚠ Reply-To：回信真正会送到的地址 ----------

test('⚠⚠ From 内部 + Reply-To 外部：只存草稿，一个发送函数都不许碰（ms365）', async () => {
  // 工单系统／转发网关／邮件列表的典型形状：
  //   From: crm-notify@corp-mail.com（内部）  Reply-To: bob@client-corp.com（客户）
  // 只看 From 会判成内部同事 → 直发 → Outlook 按 Reply-To 把这封以 小明 本人名义、
  // 还带着 AI 身份声明的信投给了客户。这正是这道门存在的全部理由。
  const t = io();
  const r = await mail.sendVia(item({
    who: 'CRM 通知',
    target: {
      external: false,
      from: 'crm-notify@corp-mail.com', whoAddress: 'crm-notify@corp-mail.com',
      replyTo: ['bob@client-corp.com'],
    },
  }), '您好，报价如下。', { io: t });
  assert.equal(r.draft, true);
  assert.equal(t.calls[0][0], 'graphSaveDraft');
  assert.ok(!t.calls.some((c) => c[0] === 'graphSend' || c[0] === 'smtpSend'));
});

test('⚠⚠ From 内部 + Reply-To 外部：只存草稿（网易）', async () => {
  const t = io();
  const r = await mail.sendVia(网易({
    target: {
      external: false,
      from: 'crm-notify@corp-mail.com', whoAddress: 'corp-notify@corp-mail.com',
      replyTo: ['bob@client-corp.com'],
    },
  }), '您好。', { io: t });
  assert.equal(r.draft, true);
  assert.equal(t.calls[0][0], 'imapSaveDraft');
  assert.ok(!t.calls.some((c) => c[0] === 'smtpSend'));
});

test('Reply-To 也是内部的：照常直发，收件人用 Reply-To（邮件客户端就是这个语义）', async () => {
  const t = io();
  await mail.sendVia(网易({
    target: {
      external: false, from: 'crm-notify@corp-mail.com', whoAddress: 'crm-notify@corp-mail.com',
      replyTo: ['zhao.si@corp-mail.com'],
    },
  }), '收到。', { io: t });
  assert.equal(t.calls[0][0], 'smtpSend');
  assert.deepEqual(t.calls[0][1].to, ['zhao.si@corp-mail.com'], 'SMTP 那侧的收件人是我们自己写的，必须是门验过的那一份');
});

test('⚠⚠ From 外部 + Reply-To 内部：一样只存草稿', async () => {
  // ⚠ 反过来的那一半：Reply-To 指着内部同事，但 From 是客户。
  //   我们自己算的收件人是 Reply-To，可 Outlook 的 `/reply` 到底选哪个是**服务端**说了算的
  //   （见 connect/mail.mjs 里那段说明）——两个都得验过才敢直发，任一外部就关门。
  const t = io();
  const r = await mail.sendVia(item({
    who: 'client',
    target: {
      external: false, from: 'client@example.com', whoAddress: 'client@example.com',
      replyTo: ['zhao.si@corp-mail.com'],
    },
  }), '您好', { io: t });
  assert.equal(r.draft, true);
  assert.ok(!t.calls.some((c) => c[0] === 'graphSend' || c[0] === 'smtpSend'));
});

test('Reply-To 有多个、其中一个是外部：只存草稿', async () => {
  const t = io();
  const r = await mail.sendVia(item({
    target: {
      external: false, from: 'zhao.si@corp-mail.com',
      replyTo: ['zhao.si@corp-mail.com', 'bob@client-corp.com'],
    },
  }), '您好', { io: t });
  assert.equal(r.draft, true);
});

// ---------- stage：这个错到底能不能放心重试 ----------

test('⚠ 存草稿失败标 pre-send：一个字都没到对方那儿，可以放心重试', async () => {
  const t = io();
  t.graphSaveDraft = async () => { throw new Error('Graph 500'); };
  const e = await mail.sendVia(item({ target: { external: true } }), '您好', { io: t })
    .then(() => null, (err) => err);
  assert.ok(e, '要抛出来');
  assert.equal(e.stage, 'pre-send', '草稿没存成 ≠ 消息可能已经发出去了');
});

test('⚠ 存草稿失败不许掉到直发那条路上去', async () => {
  const t = io();
  t.imapSaveDraft = () => { throw new Error('imap.py 挂了'); };
  await assert.rejects(
    () => mail.sendVia(网易({ target: { external: true } }), '您好', { io: t }),
    /imap\.py 挂了/,
  );
  assert.ok(!t.calls.some((c) => c[0] === 'smtpSend' || c[0] === 'graphSend'));
});

test('⚠ 认不出账号也是 pre-send（压根还没碰传输层）', async () => {
  const e = await mail.sendVia(item({ target: { account: 'x' } }), '喂', { io: io() })
    .then(() => null, (err) => err);
  assert.equal(e.stage, 'pre-send');
});

test('直发失败不标 stage：交给 send.mjs 判成 unknown（可能已经投出去了）', async () => {
  const t = io();
  t.graphSend = async () => { throw new Error('Graph 超时'); };
  const e = await mail.sendVia(item(), '收到', { io: t }).then(() => null, (err) => err);
  assert.equal(e.stage, undefined, '直发的失败结果不明，不许冒充「确定没发出去」');
});

// ---------- deliveryMode 与 sendVia 必须是同一个判据 ----------

test('⚠⚠ deliveryMode 说 draft 的，sendVia 一定碰不到发送函数（真代码跑一遍）', async () => {
  const cases = [
    ['全内部', item()],
    ['外部收件人', item({ target: { external: true } })],
    ['external 缺字段', item({ target: { external: undefined } })],
    ['外部客户单独来信', item({ target: { external: false, from: 'client@example.com' } })],
    ['Reply-To 是客户', item({ target: { external: false, replyTo: ['bob@client-corp.com'] } })],
    ['网易全内部', 网易()],
    ['网易外部', 网易({ target: { external: true } })],
  ];
  for (const [name, seg] of cases) {
    const mode = mail.deliveryMode(seg);
    assert.ok(mode === 'draft' || mode === 'send', `${name}: deliveryMode 只能是这两个值`);
    const t = io();
    const r = await mail.sendVia(seg, '正文', { io: t });
    const 碰了发送 = t.calls.some((c) => c[0] === 'graphSend' || c[0] === 'smtpSend');
    if (mode === 'draft') {
      assert.equal(碰了发送, false, `${name}: deliveryMode 说草稿，sendVia 却发了出去`);
      assert.equal(r.draft, true, `${name}: 两处判据对不上`);
    } else {
      assert.equal(碰了发送, true, `${name}: deliveryMode 说直发，sendVia 却只存了草稿`);
      assert.ok(!r.draft, `${name}: 两处判据对不上`);
    }
  }
});

test('deliveryMode 认不出账号也不抛错（它只回答「发还是存」，报错是 sendVia 的事）', () => {
  // ⚠ 账号认不认得出**不属于**这个判断：它只回答「外不外部」。
  //   账号不对照样会被 sendVia 当场抛错（上面有一条钉着），一封都发不出去。
  assert.equal(mail.deliveryMode(item({ target: { account: 'x' } })), 'send');
  // 什么都没有的畸形输入一律关门
  assert.equal(mail.deliveryMode(undefined), 'draft');
  assert.equal(mail.deliveryMode({}), 'draft');
  assert.equal(mail.deliveryMode({ target: {} }), 'draft');
});

test('引用块里「主题：」只出现一次', async () => {
  const t = io();
  await mail.sendVia(item({
    msgs: [{ id: 'm1', at: '2026-08-10T06:00:00Z', text: '主题：关于 G2\n\n原文正文' }],
  }), 'x', { io: t });
  assert.equal((t.calls[0][1].html.match(/主题：/g) || []).length, 1);
  assert.match(t.calls[0][1].html, /原文正文/, '把「主题：」那行剥掉时不许连正文一起吃了');
});
