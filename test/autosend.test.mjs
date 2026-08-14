// 🟢 自动发那一档的笼子。
//
// ⚠⚠ 跟 test/send.test.mjs、test/dm.test.mjs 一个规矩：**一条真消息都不许发出去**。
//   端到端那几条走真 bin/send.mjs 子进程，但设 MAILROOM_TEST=1 —— 真打 hap 之前会被
//   lib 里那道物理门拦住。这个文件里所有「应该发得出去」的用例都只验到笼子这一层为止。
//
// 这一档是 2026-08-12 小明 拍的：「不是所有东西都需要我确认的」。笼子的意义在于
// **他松的是内容判断，不是边界**：7 条客观条件由代码验，内容性质才轮到模型判。
// 改这个文件里的数字或条件 = 改他拍板的边界。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  cageCheck, recentCount, autoMaxChars, autoMaxPerWindow,
} from '../autosend.mjs';
import { logSent, readOutbox, outboxFile } from '../outbox.mjs';
import { tmpDailymd, tmpState } from './helpers.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const PEOPLE = [
  { name: '赵四', nickname: '老赵', md_account_id: 'acc-jerry' },
  { name: '王伟', nickname: '小伟', md_account_id: 'acc-mai' },
  // ⚠ 故意留一个没有 md_account_id 的：通讯录里 322 人只有 41 个有，认不出是常态。
  { name: '某外部联系人', emails: ['x@example.com'] },
];

// 工作日白天 / 深夜 / 周六，用来把时间那道门钉死（不然测试半夜跑就红）
const WEEKDAY_NOON = new Date('2026-08-12T12:00:00');   // 周三中午
const WEEKDAY_NIGHT = new Date('2026-08-12T23:00:00');
const SATURDAY_NOON = new Date('2026-08-15T12:00:00');

const TO_JERRY = { kind: 'user', name: '赵四', accountId: 'acc-jerry', email: '' };

// 笼子的默认入参：一条**该过**的。每条测试只改自己要验的那一项。
function ok(over = {}) {
  return cageCheck({
    initiated: false,
    to: TO_JERRY,
    rawText: '收到，我看一下。',
    isDraft: false,
    formalName: false,
    people: PEOPLE,
    now: WEEKDAY_NOON,
    rows: [],
    ...over,
  });
}

let box = null;
before(() => { box = tmpState(); });
after(() => { if (box) box.cleanup(); });

// ---------- 六条死条件，一条一条钉 ----------

test('基线：工作日中午、回复通讯录里的同事、短、一对一 → 过', () => {
  const r = ok();
  assert.equal(r.ok, true, r.violations.join(' / '));
  assert.deepEqual(r.violations, []);
});

test('⚠ 主动发起一律不自动（只回不主动）', () => {
  const r = ok({ initiated: true });
  assert.equal(r.ok, false);
  assert.match(r.violations.join(' '), /主动/);
});

test('⚠ 群消息不自动（受众广、传得远）', () => {
  const r = ok({ to: { kind: 'group' } });
  assert.equal(r.ok, false);
  assert.match(r.violations.join(' '), /群消息/);
});

test('⚠ 通讯录里认不出的收件人不自动', () => {
  const r = ok({ to: { kind: 'user', name: '某外部联系人', accountId: 'acc-unknown' } });
  assert.equal(r.ok, false);
  assert.match(r.violations.join(' '), /认不出来/);
});

test('⚠ 收件人连 accountId 都没有（邮件段）→ 不自动', () => {
  const r = ok({ to: { kind: 'user', name: '某外部联系人', accountId: '', email: 'x@example.com' } });
  assert.equal(r.ok, false);
  assert.match(r.violations.join(' '), /认不出来/);
});

test('⚠ 会存成草稿的（外部邮件）不归这一档', () => {
  const r = ok({ isDraft: true });
  assert.equal(r.ok, false);
  assert.match(r.violations.join(' '), /草稿/);
});

test('⚠⚠ --formal-name 是称呼门/自称门的绕过口，绕门的事永远要 小明 点头', () => {
  const r = ok({ formalName: true });
  assert.equal(r.ok, false);
  assert.match(r.violations.join(' '), /绕过口/);
});

test(`⚠ 超过 ${autoMaxChars()} 字不自动（长回复=有实质内容）`, () => {
  assert.equal(ok({ rawText: '好'.repeat(autoMaxChars()) }).ok, true, '正好卡线要过');
  const r = ok({ rawText: '好'.repeat(autoMaxChars() + 1) });
  assert.equal(r.ok, false);
  assert.match(r.violations.join(' '), new RegExp(`超过 ${autoMaxChars()} 字`));
});

test('⚠ 字数按**字**算不按字节算（中文一个字就是一个字）', () => {
  // 30 个汉字在 UTF-8 里是 90 字节，按字节算会被误判成超长
  assert.equal(ok({ rawText: '好'.repeat(30) }).ok, true);
});

test('⚠ 休息时间一条都不自动（深夜）', () => {
  const r = ok({ now: WEEKDAY_NIGHT });
  assert.equal(r.ok, false);
  assert.match(r.violations.join(' '), /09:00–19:00/);
});

test('⚠ 休息时间一条都不自动（周末）', () => {
  const r = ok({ now: SATURDAY_NOON });
  assert.equal(r.ok, false);
  assert.match(r.violations.join(' '), /09:00–19:00/);
});

test(`⚠ 同一个人 24 小时内最多 ${autoMaxPerWindow()} 条（再多就是在替 小明 聊天）`, () => {
  const rows = [
    { at: '2026-08-12T09:00:00', accountId: 'acc-jerry', tier: '🟢' },
    { at: '2026-08-12T10:00:00', accountId: 'acc-jerry', tier: '🟢' },
  ];
  const r = ok({ rows });
  assert.equal(r.ok, false);
  assert.match(r.violations.join(' '), /上限/);
});

test('频次按 accountId 数，别人的条数不算在这个人头上', () => {
  const rows = [
    { at: '2026-08-12T09:00:00', accountId: 'acc-mai', tier: '🟢' },
    { at: '2026-08-12T10:00:00', accountId: 'acc-mai', tier: '🟢' },
  ];
  assert.equal(ok({ rows }).ok, true);
});

test('超过 24 小时的旧记录不再计数', () => {
  const rows = [
    { at: '2026-08-10T09:00:00', accountId: 'acc-jerry', tier: '🟢' },
    { at: '2026-08-10T10:00:00', accountId: 'acc-jerry', tier: '🟢' },
  ];
  assert.equal(ok({ rows }).ok, true);
});

test('⚠ 违规**全列出来**，不是碰到第一条就返回（不然改一条跑一次，来回四五轮）', () => {
  const r = ok({ initiated: true, to: { kind: 'group' }, now: SATURDAY_NOON });
  assert.ok(r.violations.length >= 3, `应该一次列全，实际 ${r.violations.length} 条`);
});

test('频次门只数 🟢，🟡 发再多也不占自动发的额度', () => {
  const now = new Date('2026-08-12T12:00:00');
  const rows = [
    { at: '2026-08-12 11:00:00', accountId: 'acc-jerry', tier: '🟢' },
    { at: '2026-08-12 11:10:00', accountId: 'acc-jerry', tier: '🟡' },
    { at: '2026-08-12 11:20:00', accountId: 'acc-jerry', tier: '🔴' },
  ];
  assert.equal(recentCount('acc-jerry', { now, rows }), 1,
    '🟡🟢 混在一本账里，频次门只管自动发那一档');
});

// ---------- 留痕 ----------

test('发出去要留痕：理由、字数、收件人、段号都进日志', () => {
  const st = tmpState();
  try {
    logSent({
      to: TO_JERRY.name, accountId: TO_JERRY.accountId, text: '收到，我看一下。',
      why: '纯回执，无承诺', seg: 'seg-1', tier: '🟢',
    });
    const rows = readOutbox();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].accountId, 'acc-jerry');
    assert.equal(rows[0].why, '纯回执，无承诺');
    assert.equal(rows[0].chars, 8);
    assert.equal(rows[0].seg, 'seg-1');
    assert.equal(rows[0].tier, '🟢');
    assert.ok(existsSync(outboxFile()));
  } finally {
    st.cleanup();
  }
});

test('留痕之后频次门立刻认得出来（日志就是计数的来源）', () => {
  const st = tmpState();
  try {
    const now = new Date();
    for (let i = 0; i < autoMaxPerWindow(); i++) {
      logSent({
        to: TO_JERRY.name, accountId: TO_JERRY.accountId, text: '收到',
        why: `第 ${i} 条`, tier: '🟢',
      });
    }
    assert.equal(recentCount('acc-jerry', { now }), autoMaxPerWindow());
    assert.equal(readOutbox().length, autoMaxPerWindow());
    // 真跑一次笼子（不注入 rows）：应该被频次门挡下
    const r = cageCheck({
      to: TO_JERRY, rawText: '收到', people: PEOPLE, now: WEEKDAY_NOON,
    });
    assert.equal(r.ok, false);
    assert.match(r.violations.join(' '), /上限/);
  } finally {
    st.cleanup();
  }
});

test('⚠ 日志坏了当空表，不许把整条发送链卡死', () => {
  const st = tmpState();
  try {
    writeFileSync(outboxFile(), '这不是 JSON\n{"at":"2026-08-12T09:00:00","accountId":"acc-jerry"}\n');
    const rows = readOutbox();
    assert.equal(rows.length, 1, '坏行跳过，好行照读');
  } finally {
    st.cleanup();
  }
});

// ---------- 端到端：真跑 bin/send.mjs ----------

function run(args, dailymd) {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [join(ROOT, 'bin/send.mjs'), ...args], {
        encoding: 'utf-8',
        cwd: ROOT,
        env: {
          ...process.env,
          MAILROOM_TEST: '1',
          MAILROOM_DAILYMD: dailymd,
          MAILROOM_STATE: box.dir,
        },
      }),
    };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

function dailymdWithContacts() {
  const dm = tmpDailymd();
  mkdirSync(join(dm.root, 'contactmd'), { recursive: true });
  writeFileSync(join(dm.root, 'contactmd/contacts.json'), JSON.stringify(PEOPLE));
  return dm;
}

// 往运行态里塞一个段，好让 `--seg` 找得到。⚠ 字段形状照 send.mjs 的 typeOf/recipientOf：
//   段上叫 sourceType（候选上才叫 kind），适配器由 sourceKind 选。
function seedSegments(list) {
  writeFileSync(join(box.dir, 'segments.json'), JSON.stringify(list));
}

test('e2e：--auto 后面没跟理由 → 拒发（写不出理由的就不该自动发）', () => {
  const dm = dailymdWithContacts();
  try {
    const r = run(['--seg', 'seg-x', '--text', '收到', '--auto'], dm.root);
    assert.equal(r.code, 1);
    assert.match(r.out, /要跟一句判成 🟢 的理由/);
  } finally { dm.cleanup(); }
});

test('e2e：--auto 配 --to（主动发起）→ 拒发', () => {
  const dm = dailymdWithContacts();
  try {
    const r = run(['--to', '赵四', '--text', '收到', '--auto', '纯回执'], dm.root);
    assert.equal(r.code, 1);
    assert.match(r.out, /只用于回复/);
  } finally { dm.cleanup(); }
});

test('e2e：群段 + --auto → 笼子拦下，且把违规打出来', () => {
  const dm = dailymdWithContacts();
  try {
    seedSegments([{
      id: 'seg-g', sourceKind: 'mingdao', sourceType: 'group', sourceLabel: '明道云 · 群消息',
      who: '前端群', target: { groupId: 'g-1', groupName: '前端群' },
    }]);
    const r = run(['--seg', 'seg-g', '--text', '收到', '--auto', '纯回执'], dm.root);
    assert.equal(r.code, 1);
    assert.match(r.out, /拒绝自动发送/);
    assert.match(r.out, /群消息/);
  } finally { dm.cleanup(); }
});

test('⚠⚠ e2e：回群消息（不带 --auto）现在也要两步确认码，不再直接发', () => {
  const dm = dailymdWithContacts();
  try {
    seedSegments([{
      id: 'seg-g', sourceKind: 'mingdao', sourceType: 'group', sourceLabel: '明道云 · 群消息',
      who: '前端群', target: { groupId: 'g-1', groupName: '前端群' },
    }]);
    const r = run(['--seg', 'seg-g', '--text', '收到，我看一下。'], dm.root);
    // 退出码 0 且一个字没发 —— 这不是失败，是设计（同主动私信那条路）
    assert.equal(r.code, 0);
    assert.match(r.out, /还没有发出去/);
    assert.match(r.out, /--confirm/);
    assert.doesNotMatch(r.out, /已发出/);
  } finally { dm.cleanup(); }
});

test('e2e：私信段回复（不带 --auto）行为一个字没变，直奔发送', () => {
  const dm = dailymdWithContacts();
  try {
    seedSegments([{
      id: 'seg-u', sourceKind: 'mingdao', sourceType: 'user', sourceLabel: '明道云 · 私信',
      who: '赵四', whoAccountId: 'acc-jerry', target: { accountId: 'acc-jerry' },
    }]);
    const r = run(['--seg', 'seg-u', '--text', '收到，我看一下。', '--why', '测试用'], dm.root);
    // MAILROOM_TEST=1 那道物理门会在真打 hap 之前抛错 —— 走到那儿就说明没被任何门拦住
    assert.doesNotMatch(r.out, /还没有发出去/);
    assert.doesNotMatch(r.out, /拒绝/);
  } finally { dm.cleanup(); }
});

test('e2e：私信段 + --auto，笼子里认得出这个人（不该报「认不出来」）', () => {
  const dm = dailymdWithContacts();
  try {
    seedSegments([{
      id: 'seg-u', sourceKind: 'mingdao', sourceType: 'user', sourceLabel: '明道云 · 私信',
      who: '赵四', whoAccountId: 'acc-jerry', target: { accountId: 'acc-jerry' },
    }]);
    const r = run(['--seg', 'seg-u', '--text', '收到，我看一下。', '--auto', '纯回执，无承诺'], dm.root);
    assert.doesNotMatch(r.out, /认不出来/);
    // ⚠ 这条测试半夜/周末也得绿：那时唯一该出现的违规就是休息时间那一条。
    if (/拒绝自动发送/.test(r.out)) {
      assert.match(r.out, /09:00–19:00/);
      assert.equal((r.out.match(/^ {2}· /gm) || []).length, 1, '除了休息时间不该有别的违规');
    }
  } finally { dm.cleanup(); }
});

// ---------- 第 7 条：任务评论不许自动发（2026-08-13 补） ----------
//
// ⚠⚠ 终审逮到的洞：`bin/send.mjs` 的 🔴 名单是 `wantDm || isGroup || isTaskComment`，
//   而笼子当时只排「主动发起」和「群」。于是任务评论段带 `--auto` 能过笼子 →
//   账上记成 🟢、实际却走 🔴 的确认码，还白占掉那个人 24 小时里的 🟢 额度。
//   受众是这个任务的全体参与人，比私信广——理由跟群一模一样。

test('⚠ 任务评论不自动（受众是任务的全体参与人）', () => {
  const r = ok({ isTaskComment: true });
  assert.equal(r.ok, false);
  assert.match(r.violations.join(' '), /任务里的评论/);
  assert.equal(r.violations.length, 1, '只该多这一条，别的死条件不许被牵连');
});

test('e2e：任务评论段 + --auto → 笼子拦下（笼子和 🔴 名单不许分家）', () => {
  const dm = dailymdWithContacts();
  try {
    seedSegments([{
      id: 'seg-t', sourceKind: 'mingdao', sourceType: 'notice', sourceLabel: '明道云 · 任务通知',
      who: '赵四', whoAccountId: 'acc-jerry',
      target: { replyVia: 'task', taskId: 'task-abc', recordName: 'Real AI 评委邀请' },
    }]);
    const r = run(['--seg', 'seg-t', '--text', '收到，我看一下。', '--auto', '纯回执，无承诺'], dm.root);
    assert.equal(r.code, 1, '笼子该拦下它');
    assert.match(r.out, /拒绝自动发送/);
    assert.match(r.out, /任务里的评论/);
    assert.doesNotMatch(r.out, /已发出/);
  } finally { dm.cleanup(); }
});

test('⚠⚠ e2e：任务评论段（不带 --auto）走两步确认码，确认码认的是 taskId', () => {
  const dm = dailymdWithContacts();
  try {
    seedSegments([{
      id: 'seg-t', sourceKind: 'mingdao', sourceType: 'notice', sourceLabel: '明道云 · 任务通知',
      who: '赵四', whoAccountId: 'acc-jerry',
      target: { replyVia: 'task', taskId: 'task-abc', recordName: 'Real AI 评委邀请' },
    }]);
    const r = run(['--seg', 'seg-t', '--text', '收到，我看一下。'], dm.root);
    assert.equal(r.code, 0, '只预览不发，退出码 0 是设计不是失败');
    assert.match(r.out, /还没有发出去/);
    assert.match(r.out, /--confirm/);
    assert.doesNotMatch(r.out, /已发出/);
  } finally { dm.cleanup(); }
});
