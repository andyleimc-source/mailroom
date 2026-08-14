// segment.mjs 测试：归位的单位是「一段对话」不是「一条消息」——同一个人连发几条要
// 聚在一起判断，省掉重复判断的次数,也让 inbox.md 读起来有来龙去脉。
//
// 五条：同人同窗合并 / 超窗断开 / 不同人不合并 / 乱序输入先排序再聚段 /
// mergeInto 沿用已有 filed 且不重新判断（外加一条超窗新段的对照）。
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toSegments, mergeInto } from '../segment.mjs';
import { tmpState } from './helpers.mjs';

const T0 = '2026-08-08T03:00:00.000Z';
const T1 = '2026-08-08T03:05:00.000Z'; // T0 +5min
const T2 = '2026-08-08T03:13:00.000Z'; // T1 +8min，跟 T0 也在 30min 窗口内
const T2_FAR = '2026-08-08T03:45:00.000Z'; // T1 +40min，超 30min 窗口

test('同人同窗：相邻消息间隔 ≤ windowMin 聚成一段', () => {
  const candidates = [{
    sourceKind: 'mingdao', kind: 'user', who: '李雷', whoAccountId: 'a1',
    target: { accountId: 'a1' }, sourceLabel: '明道云 · 私信',
    msgs: [
      { id: 'm1', at: T0, text: '你好' },
      { id: 'm2', at: T1, text: '仓库地址我发你' },
      { id: 'm3', at: T2, text: 'https://example.com/repo' },
    ],
  }];
  const segs = toSegments(candidates, { windowMin: 30 });
  assert.equal(segs.length, 1, '三条消息间隔都在 30 分钟内，应该聚成一段');
  assert.equal(segs[0].msgs.length, 3);
  assert.equal(segs[0].firstAt, T0);
  assert.equal(segs[0].lastAt, T2);
  assert.equal(segs[0].who, '李雷');
  assert.equal(segs[0].whoAccountId, 'a1');
  assert.equal(segs[0].sourceType, 'user');
  assert.equal(segs[0].sourceKind, 'mingdao');
  assert.equal(segs[0].sourceLabel, '明道云 · 私信', 'sourceLabel 要原样带过来');
  assert.deepEqual(segs[0].target, { accountId: 'a1' });
  assert.equal(segs[0].filed, null);
  assert.equal(segs[0].dropped, false);
  assert.equal(segs[0].waiting, null);
  assert.ok(segs[0].id, '要有 id');
});

test('超窗断开：间隔 > windowMin 就切成新段', () => {
  const candidates = [{
    sourceKind: 'mingdao', kind: 'user', who: '李雷', whoAccountId: 'a1',
    target: { accountId: 'a1' },
    msgs: [
      { id: 'm1', at: T0, text: '你好' },
      { id: 'm2', at: T1, text: '在吗' },
      { id: 'm3', at: T2_FAR, text: '权限我明天开' }, // 距上一条 40 分钟，超窗
    ],
  }];
  const segs = toSegments(candidates, { windowMin: 30 });
  assert.equal(segs.length, 2, '第三条消息超窗，应该断成新段');
  assert.equal(segs[0].msgs.length, 2);
  assert.equal(segs[0].lastAt, T1);
  assert.equal(segs[1].msgs.length, 1);
  assert.equal(segs[1].firstAt, T2_FAR);
});

test('边界：间隔正好等于 windowMin 仍然合并（≤ 不是 <）', () => {
  const candidates = [{
    sourceKind: 'mingdao', kind: 'user', who: '李雷', whoAccountId: 'a1',
    target: { accountId: 'a1' },
    msgs: [
      { id: 'm1', at: T0, text: '第一条' },
      // 正好 30 分钟后，等于 windowMin，规则是「≤ windowMin 聚合」，这条不该断开
      { id: 'm2', at: '2026-08-08T03:30:00.000Z', text: '正好 30 分钟后' },
    ],
  }];
  const segs = toSegments(candidates, { windowMin: 30 });
  assert.equal(segs.length, 1, '间隔正好等于窗口值时应该仍算窗口内');
  assert.equal(segs[0].msgs.length, 2);
});

test('不同人不合并：即使时间重叠也各自成段', () => {
  const candidates = [
    {
      sourceKind: 'mingdao', kind: 'user', who: '李雷', whoAccountId: 'a1',
      target: { accountId: 'a1' }, msgs: [{ id: 'm1', at: T0, text: '你好' }],
    },
    {
      sourceKind: 'mingdao', kind: 'user', who: '老赵', whoAccountId: 'a2',
      target: { accountId: 'a2' }, msgs: [{ id: 'm2', at: T0, text: '在吗' }],
    },
  ];
  const segs = toSegments(candidates, { windowMin: 30 });
  assert.equal(segs.length, 2, '不同人不能合并到同一段');
  const who = segs.map((s) => s.who).sort();
  assert.deepEqual(who, ['李雷', '老赵'].sort());
  for (const s of segs) assert.equal(s.msgs.length, 1);
});

test('乱序输入：聚段前必须按时间排序，否则相邻间隔算错', () => {
  const candidates = [{
    sourceKind: 'mingdao', kind: 'user', who: '李雷', whoAccountId: 'a1',
    target: { accountId: 'a1' },
    // 顺序打乱：T2 排最前，T0 排中间，T1 排最后——如果不先排序，
    // 用原始顺序算相邻间隔（T2→T0→T1）会算出巨大的负间隔/错误的切段。
    msgs: [
      { id: 'm3', at: T2, text: '第三条' },
      { id: 'm1', at: T0, text: '第一条' },
      { id: 'm2', at: T1, text: '第二条' },
    ],
  }];
  const segs = toSegments(candidates, { windowMin: 30 });
  assert.equal(segs.length, 1, '排序后三条都在窗口内，应该是一段');
  assert.deepEqual(segs[0].msgs.map((m) => m.id), ['m1', 'm2', 'm3'], 'msgs 应该按时间正序排列');
  assert.equal(segs[0].firstAt, T0);
  assert.equal(segs[0].lastAt, T2);
});

test('坏时间戳不会被静默合并：解析失败当超窗处理，并留下日志痕迹', () => {
  const { dir, cleanup } = tmpState();
  try {
    const candidates = [{
      sourceKind: 'mingdao', kind: 'user', who: '李雷', whoAccountId: 'a1',
      target: { accountId: 'a1' },
      msgs: [
        { id: 'm1', at: T0, text: '第一条' },
        { id: 'm2', at: '不是一个日期', text: '坏时间戳' }, // 解析不出来
        { id: 'm3', at: T1, text: '第三条' }, // 跟 m1 在窗口内，不该被 m2 牵连
      ],
    }];
    const segs = toSegments(candidates, { windowMin: 30 });

    const segOfBad = segs.find((s) => s.msgs.some((m) => m.id === 'm2'));
    assert.ok(segOfBad, '坏消息也该出现在某一段里，不是被丢掉');
    assert.equal(segOfBad.msgs.length, 1, '坏消息不该拖着别的消息一起合并（当作超窗处理）');

    const segOfGood = segs.find((s) => s.msgs.some((m) => m.id === 'm1'));
    assert.ok(segOfGood.msgs.some((m) => m.id === 'm3'), 'm1/m3 本该在窗口内正常合并');
    assert.ok(!segOfGood.msgs.some((m) => m.id === 'm2'), 'm1/m3 的段不该被坏消息混进来');

    const logText = readFileSync(join(dir, 'mailroom.log'), 'utf-8');
    assert.match(logText, /at 解析失败/, '解析失败要留日志痕迹，不能无声无息');
    assert.match(logText, /id=m2/, '日志要带上出问题的消息 id，方便回查');
  } finally { cleanup(); }
});

test('toSegments / mergeInto 对 undefined 输入兜底，不抛异常', () => {
  assert.deepEqual(toSegments(undefined), [], 'candidates 是 undefined 时兜底成空数组');
  assert.deepEqual(mergeInto(undefined, undefined), [], 'existing/fresh 是 undefined 时兜底成空数组');
});

function existingFiledSegment() {
  return {
    id: 'existing-id-1',
    sourceKind: 'mingdao', sourceType: 'user', sourceLabel: '明道云 · 私信',
    who: '李雷', whoAccountId: 'a1', target: { accountId: 'a1' },
    msgs: [{ id: 'm1', at: T0, text: '第一条' }],
    firstAt: T0, lastAt: T0,
    filed: {
      project: 'P26-agent-ready-sites', task: 'T70-2026-08-05-three-sites-recon',
      reason: '命中「SVCB / DNSPod」', by: 'auto', sure: true, createdTask: false, at: T0,
    },
    dropped: false, waiting: null,
  };
}

test('mergeInto：同一条线上窗口内的新消息，追加进老段并沿用 filed，不重新判断', () => {
  const existing = [existingFiledSegment()];
  const fresh = toSegments([{
    sourceKind: 'mingdao', kind: 'user', who: '李雷', whoAccountId: 'a1',
    target: { accountId: 'a1' },
    msgs: [{ id: 'm2', at: T1, text: '仓库地址我发你' }], // 距 existing.lastAt(T0) 5 分钟，窗口内
  }], { windowMin: 30 });

  const merged = mergeInto(existing, fresh);
  assert.equal(merged.length, 1, '窗口内应该追加进老段，不新增一段');
  assert.equal(merged[0].id, 'existing-id-1', 'id 不许变');
  assert.deepEqual(merged[0].filed, existing[0].filed, 'filed 要原样沿用，不重新判断');
  assert.equal(merged[0].msgs.length, 2, '消息要追加进去');
  assert.deepEqual(merged[0].msgs.map((m) => m.id), ['m1', 'm2']);
  assert.equal(merged[0].lastAt, T1, 'lastAt 要更新成最新消息的时间');
});

test('mergeInto：边界，距 lastAt 正好 windowMin 仍然算窗口内', () => {
  const existing = [existingFiledSegment()];
  const fresh = toSegments([{
    sourceKind: 'mingdao', kind: 'user', who: '李雷', whoAccountId: 'a1',
    target: { accountId: 'a1' },
    // 距 existing.lastAt(T0) 正好 30 分钟
    msgs: [{ id: 'm2', at: '2026-08-08T03:30:00.000Z', text: '正好 30 分钟后' }],
  }], { windowMin: 30 });

  const merged = mergeInto(existing, fresh);
  assert.equal(merged.length, 1, '正好等于窗口值应该合并，不是新段');
  assert.equal(merged[0].msgs.length, 2);
});

test('mergeInto：超窗就是新段，等着被归位，不影响老段', () => {
  const existing = [existingFiledSegment()];
  const fresh = toSegments([{
    sourceKind: 'mingdao', kind: 'user', who: '李雷', whoAccountId: 'a1',
    target: { accountId: 'a1' },
    // 距 existing.lastAt(T0) 45 分钟，超过 30 分钟窗口
    msgs: [{ id: 'm2', at: '2026-08-08T03:45:00.000Z', text: '新的一轮事' }],
  }], { windowMin: 30 });

  const merged = mergeInto(existing, fresh);
  assert.equal(merged.length, 2, '超窗应该是老段 + 新段');
  const old = merged.find((s) => s.id === 'existing-id-1');
  assert.ok(old, '老段应该还在');
  assert.equal(old.msgs.length, 1, '老段不该被新消息污染');
  assert.deepEqual(old.filed, existing[0].filed);
  const fresh2 = merged.find((s) => s.id !== 'existing-id-1');
  assert.ok(fresh2, '应该多出一段新段');
  assert.equal(fresh2.filed, null, '新段还没归位');
});

// ---------- 已丢弃的段是「死段」，不许再当延续对象 ----------

test('mergeInto：新消息绝不许并进已丢弃的段（并进去 = 这条消息谁都看不见）', () => {
  // ⚠⚠ 2026-08-08 评审实跑复现的活 bug：老赵 发「[OK]」被判丢弃 → 8 分钟后他发
  //   「客户合同今天必须签，麻烦你看一下」→ 并进那个已丢弃的段。而 file.mjs 对
  //   `seg.dropped` 的段是直接 `collect(seg); continue;`（连判定都不进），
  //   于是交给 claude 的段数 = 0，任何 inbox.md 里都没有这句话，界面上它只挂在
  //   原来那张丢弃卡片里 —— 一条要签合同的消息就这么消失了。
  const dropped = existingFiledSegment();
  dropped.id = 'seg-dropped';
  dropped.dropped = true;
  dropped.msgs = [{ id: 'm1', at: T0, text: '[OK]' }];

  const fresh = toSegments([{
    sourceKind: 'mingdao', kind: 'user', who: '李雷', whoAccountId: 'a1',
    target: { accountId: 'a1' },
    // 距那段的 lastAt(T0) 只有 5 分钟，窗口内 —— 老代码会一头并进去
    msgs: [{ id: 'm2', at: T1, text: '客户合同今天必须签，麻烦你看一下' }],
  }], { windowMin: 30 });

  const merged = mergeInto([dropped], fresh);
  assert.equal(merged.length, 2, '已丢弃的段不许当延续对象，新消息必须自成一段');
  const dead = merged.find((s) => s.id === 'seg-dropped');
  assert.equal(dead.msgs.length, 1, '丢弃的那段一条消息都不许被追加进去');
  const live = merged.find((s) => s.id !== 'seg-dropped');
  assert.ok(live, '新消息要有属于自己的新段，才进得了待判定队列');
  assert.equal(live.dropped, false, '新段不许继承「已丢弃」');
  assert.equal(live.filed, null, '新段还没归位，等着被判');
  assert.equal(live.msgs[0].text, '客户合同今天必须签，麻烦你看一下');
});

test('mergeInto：同一条线上既有丢弃段又有正常段时，续到正常那段上', () => {
  // 反向：跳过 dropped 不许把「正常段照常合并」也一起跳掉。
  const dropped = existingFiledSegment();
  dropped.id = 'seg-dropped';
  dropped.dropped = true;
  dropped.lastAt = T1;                 // 丢弃那段反而更「新」，故意让它成为最优候选
  dropped.msgs = [{ id: 'm0', at: T1, text: '[OK]' }];
  const live = existingFiledSegment(); // id=existing-id-1，lastAt=T0，正常段

  const fresh = toSegments([{
    sourceKind: 'mingdao', kind: 'user', who: '李雷', whoAccountId: 'a1',
    target: { accountId: 'a1' },
    msgs: [{ id: 'm2', at: T2, text: '接着上面说' }],   // 距 T0 13 分钟，窗口内
  }], { windowMin: 30 });

  const merged = mergeInto([dropped, live], fresh);
  assert.equal(merged.length, 2, '应该并进正常那段，不新增段');
  assert.equal(merged.find((s) => s.id === 'seg-dropped').msgs.length, 1);
  const kept = merged.find((s) => s.id === 'existing-id-1');
  assert.equal(kept.msgs.length, 2, '正常段照常合并，别把这条路一起堵了');
  assert.equal(kept.lastAt, T2);
});

test('mergeInto：不同线互不干扰', () => {
  const existing = [existingFiledSegment()];
  const fresh = toSegments([{
    sourceKind: 'mingdao', kind: 'user', who: '李雷', whoAccountId: 'a2',
    target: { accountId: 'a2' },
    msgs: [{ id: 'm9', at: T1, text: '另一个人发的' }],
  }], { windowMin: 30 });

  const merged = mergeInto(existing, fresh);
  assert.equal(merged.length, 2, '不同人的线不该合并');
  const old = merged.find((s) => s.id === 'existing-id-1');
  assert.equal(old.msgs.length, 1, '李雷这条线不该被老赵的消息污染');
});

// ---------- msgKey：轮询器去重用的键 ----------

test('msgKey：同一条线上同一条消息，键必须稳定——群里换个最后发言人也不能变', async () => {
  // ⚠ 这条钉的是「同一条消息收两次不会入两次段」的地基。群 candidate 的 who 是
  //   「这批消息里最后一位发言人」，下一轮同一条消息可能挂在另一个人名下；
  //   键里含 who 的话就漏判成新消息，同一句话入两次段、inbox.md 里出现两块。
  const { msgKey } = await import('../segment.mjs');
  const msg = { id: 'm7', at: T1, text: '同一条消息' };
  const a = { sourceKind: 'mingdao', kind: 'group', who: '李雷', whoAccountId: 'a1', target: { groupId: 'g1' } };
  const b = { sourceKind: 'mingdao', kind: 'group', who: '老赵', whoAccountId: 'a2', target: { groupId: 'g1' } };
  assert.equal(msgKey(a, msg), msgKey(b, msg));

  // 段上叫 sourceType、candidate 上叫 kind，两种形状要给出同一个键
  const seg = { sourceKind: 'mingdao', sourceType: 'group', who: '别人', target: { groupId: 'g1' } };
  assert.equal(msgKey(seg, msg), msgKey(a, msg));
});

test('msgKey：不同会话的同一个 id 不许撞成一个键（撞了就是真丢消息）', async () => {
  const { msgKey } = await import('../segment.mjs');
  const msg = { id: 'm7', at: T1, text: 'x' };
  const g1 = { sourceKind: 'mingdao', kind: 'group', who: '李雷', target: { groupId: 'g1' } };
  const g2 = { sourceKind: 'mingdao', kind: 'group', who: '李雷', target: { groupId: 'g2' } };
  const dm = { sourceKind: 'mingdao', kind: 'user', who: '李雷', whoAccountId: 'a1', target: { accountId: 'a1' } };
  assert.notEqual(msgKey(g1, msg), msgKey(g2, msg));
  assert.notEqual(msgKey(g1, msg), msgKey(dm, msg));
});

// ---------- 邮件聚段：按 threadId + 账号认线，绝不按发件人显示名 ----------
//
// ⚠⚠ 2026-08-10 评审实跑出来的活 bug：邮件的 convId 落到 default 分支退回 who
//   （发件人**显示名**），于是显示名撞车的两封信被聚成一段，段的 target 取到其中一封，
//   回信就回到了另一个人手上。下面几条钉的就是这件事。

tmpState();
const { toCandidate } = await import('../mail/normalize.mjs');
const { accountById } = await import('../mail/accounts.mjs');

const ACC_WORK = accountById('work');
const ACC_CORP = accountById('corp');

// 造一封「已解析的邮件」，字段名对齐 mail/normalize.mjs 期待的 ParsedMail。
function mail(over = {}) {
  return {
    id: 'msg-1',
    threadId: 'thread-1',
    at: T0,
    subject: '对账',
    from: { name: '通知', address: 'crm-notify@corp-mail.com' },
    to: [{ address: 'me@acme.com' }],
    cc: [],
    text: '这个月的数对一下',
    ...over,
  };
}

test('邮件：显示名相同但线程/地址不同的两封，必须是两段（并了就会回错人）', () => {
  const internal = toCandidate(mail(), ACC_WORK);
  const client = toCandidate(mail({
    id: 'msg-2',
    threadId: 'thread-2',
    at: T1, // 距 T0 只有 5 分钟，按显示名聚的话必然并进同一段
    from: { name: '通知', address: 'sales@client-corp.com' },
    to: [{ address: 'me@acme.com' }, { address: 'buyer@client-corp.com' }],
    text: '报价我们内部还在过',
  }), ACC_WORK);
  assert.equal(internal.who, client.who, '前提：两封的显示名一模一样');

  const segs = toSegments([internal, client], { windowMin: 30 });
  assert.equal(segs.length, 2, '显示名撞车不等于同一条线，必须分成两段');

  // 每一段的 target 必须是它**自己那封**的，尤其是决定「能不能直发」的 external
  const byFrom = new Map(segs.map((s) => [s.target.from, s]));
  assert.equal(byFrom.get('crm-notify@corp-mail.com').target.external, false);
  assert.equal(byFrom.get('sales@client-corp.com').target.external, true,
    '客户那封必须留着 external=true，并错段就会被判成内部直发');
  assert.equal(byFrom.get('sales@client-corp.com').target.messageId, 'msg-2');
});

test('邮件：同一 threadId 的两封聚成一段', () => {
  const first = toCandidate(mail(), ACC_WORK);
  const second = toCandidate(mail({ id: 'msg-1b', at: T1, text: '补一句' }), ACC_WORK);
  const segs = toSegments([first, second], { windowMin: 30 });
  assert.equal(segs.length, 1, '同一线程同一账号，30 分钟内应该是一段');
  assert.equal(segs[0].msgs.length, 2);
});

test('邮件：同一个人分别发到两个邮箱，绝不并成一段（并了回信必然 404）', () => {
  const toWork = toCandidate(mail({
    from: { name: '李雷', address: 'lei.li@corp-mail.com' },
    to: [{ address: 'me@acme.com' }],
  }), ACC_WORK);
  // 两封连 threadId 都一样（同一个人转发同一封信到两个邮箱），只有账号不同
  const toCorp = toCandidate(mail({
    id: '10241',
    at: T1,
    from: { name: '李雷', address: 'lei.li@corp-mail.com' },
    to: [{ address: 'me@corp-mail.com' }],
  }), ACC_CORP);

  const segs = toSegments([toWork, toCorp], { windowMin: 30 });
  assert.equal(segs.length, 2, '账号不同就是两条线：一段只能属于一个邮箱');
  assert.deepEqual(segs.map((s) => s.target.account).sort(), ['corp', 'work']);
  for (const s of segs) {
    for (const m of s.msgs) {
      assert.ok(m.id.startsWith(`mail-${s.target.account}-`),
        `段里混进了别的账号的消息：${m.id} 在 ${s.target.account} 段里`);
    }
  }
});

test('邮件 mergeInto：老段追加新邮件后，target 要跟上新那封', () => {
  // 第一轮：同事单独发给 小明，全内部收件人
  const round1 = toSegments([toCandidate(mail({
    from: { name: '李雷', address: 'lei.li@corp-mail.com' },
    to: [{ address: 'me@acme.com' }],
  }), ACC_WORK)], { windowMin: 30 });
  assert.equal(round1[0].target.external, false);
  assert.equal(round1[0].target.messageId, 'msg-1');

  // 第二轮：同一线程，他把客户抄送了进来，回的还是这封信
  const round2 = toSegments([toCandidate(mail({
    id: 'msg-9',
    at: T1,
    from: { name: '李雷', address: 'lei.li@corp-mail.com' },
    to: [{ address: 'me@acme.com' }],
    cc: [{ address: 'buyer@client-corp.com' }],
    replyTo: ['buyer@client-corp.com'],
    text: '客户也拉进来了，你直接回他',
  }), ACC_WORK)], { windowMin: 30 });

  const merged = mergeInto(round1, round2, { windowMin: 30 });
  assert.equal(merged.length, 1, '同一线程窗口内应该追加进老段');
  assert.equal(merged[0].id, round1[0].id, 'id 不许变');
  assert.equal(merged[0].msgs.length, 2);
  assert.equal(merged[0].target.messageId, 'msg-9',
    'target 停在老那封 = 回信用旧 messageId，回错信、甚至回错人');
  assert.equal(merged[0].target.external, true,
    'target.external 不跟上 = 这段会被判成「内部直发」，客户的话就被直发出去了');
  assert.deepEqual(merged[0].target.replyTo, ['buyer@client-corp.com']);
  assert.equal(merged[0].target.account, 'work');
  assert.equal(merged[0].target.threadId, 'thread-1');
});

test('明道云 mergeInto：target 跟上新候选，且新候选没带的字段不许被抹掉', () => {
  const existing = [{
    id: 'seg-g1',
    sourceKind: 'mingdao', sourceType: 'group', sourceLabel: '明道云 · 群',
    who: '李雷', whoAccountId: 'a1',
    target: { groupId: 'g1', groupName: '研发群', lastMsgId: 'old' },
    msgs: [{ id: 'm1', at: T0, text: '第一条' }],
    firstAt: T0, lastAt: T0,
    filed: { project: 'P26-agent-ready-sites', task: 'T70-2026-08-05-three-sites-recon' },
    dropped: false, waiting: null,
  }];
  const fresh = toSegments([{
    sourceKind: 'mingdao', kind: 'group', who: '李雷', whoAccountId: 'a1',
    target: { groupId: 'g1', lastMsgId: 'new' },   // 这一轮没带 groupName
    msgs: [{ id: 'm2', at: T1, text: '第二条' }],
  }], { windowMin: 30 });

  const merged = mergeInto(existing, fresh, { windowMin: 30 });
  assert.equal(merged.length, 1, '明道云的聚段行为一个字不许变');
  assert.equal(merged[0].id, 'seg-g1');
  assert.equal(merged[0].msgs.length, 2);
  assert.deepEqual(merged[0].filed, existing[0].filed, 'filed 原样沿用');
  assert.equal(merged[0].target.groupId, 'g1');
  assert.equal(merged[0].target.lastMsgId, 'new', '新候选带了的字段要跟上');
  assert.equal(merged[0].target.groupName, '研发群',
    '新候选没带的字段不许被抹掉（所以是展开合并，不是整体替换）');
});

// ---------- 通知聚段：任务 A / 任务 B / 记录 X 必须是三条线 ----------
//
// ⚠⚠ 2026-08-13 终审实跑出来的活 bug，跟上面邮件那一组是同一种病：notice 的 convId
//   写的是 `noticeId ?? id ?? eventId ?? who`，而通知的 target 里这三个字段**一个都
//   没有** —— 于是所有通知一律按「谁发的」聚成一条线，段的 target 又取最新那个。
//   同一个人在任务 A、任务 B 各评论一次 → 并成一段、target.taskId 是 B；隔 2 小时
//   切成两段 → **两段的 taskId 都是 B**。回「任务 A 那一段」，评论就发进了任务 B，
//   收件人是那个任务的全体参与人。两步确认码也挡不住：预览只打「发给：某某　经由：
//   明道云 · 任务通知」，确认码算的正是那个已经串了的 taskId，看不出异常。
//   下面几条钉的就是这件事。走 normalizeSession 真管线造候选，不手搓 target —— 手搓
//   的话哪天 fetch 那边字段改了，这组测试会绿着骗人。

const { normalizeSession } = await import('../fetch.mjs');

// 一条任务通知（有 taskId → via=task）
function taskNotice({ taskId, at, text, who = '韩梅', acc = 'acc-ren', name = '' }) {
  return normalizeSession(
    { value: 'task', category: 'task', time: at, msg: { con: text } },
    [],
    { inboxId: `inbox-${taskId}`, taskId, sender: { accountId: acc, name: who }, comment: { recordName: name } },
  );
}

// 一条记录讨论通知（有 worksheetId+rowId → via=record）
function recordNotice({ worksheetId, rowId, at, text, who = '韩梅', acc = 'acc-ren' }) {
  return normalizeSession(
    { value: 'app', category: 'app', time: at, msg: { con: text } },
    [],
    { inboxId: 'inbox-r', worksheetId, rowId, sender: { accountId: acc, name: who } },
  );
}

const N0 = '2026-08-13 09:00:00.000';
const N1 = '2026-08-13 09:05:00.000'; // +5min，30 分钟窗口内

test('通知：同一个人在两个任务下各评论一次，绝不许并成一段（并了就回错任务）', () => {
  const a = taskNotice({ taskId: 'task-A', at: N0, text: '这个素材可以用', name: 'Real AI 评委邀请' });
  const b = taskNotice({ taskId: 'task-B', at: N1, text: '预算那版再改改', name: 'Q3 预算' });
  assert.equal(a.who, b.who, '前提：两条是同一个人发的（并错就是靠这一点并的）');

  const segs = toSegments([a, b], { windowMin: 30 });
  assert.equal(segs.length, 2, '同一个人 + 两个任务 = 两条线，5 分钟内也不许并');

  // 各段的 target 必须是**自己那条**的，不是最新那条的
  const byTask = new Map(segs.map((s) => [s.target.taskId, s]));
  assert.deepEqual([...byTask.keys()].sort(), ['task-A', 'task-B']);
  assert.equal(byTask.get('task-A').msgs[0].text, '这个素材可以用');
  assert.equal(byTask.get('task-B').msgs[0].text, '预算那版再改改');
  for (const s of segs) assert.equal(s.target.replyVia, 'task');
});

test('通知：同一个人的「记录讨论 + 任务评论」，绝不许并成一段（并了整段按 task 发出去）', () => {
  const rec = recordNotice({ worksheetId: 'ws-1', rowId: 'row-1', at: N0, text: '这条记录的金额对不上' });
  const task = taskNotice({ taskId: 'task-A', at: N1, text: '任务里再确认一下' });
  assert.equal(rec.who, task.who, '前提：同一个人');
  assert.equal(rec.target.replyVia, 'record');
  assert.equal(task.target.replyVia, 'task');

  const segs = toSegments([rec, task], { windowMin: 30 });
  assert.equal(segs.length, 2, '落点都不一样，不可能是同一条线');
  const viaOf = (v) => segs.find((s) => s.target.replyVia === v);
  assert.equal(viaOf('record').target.rowId, 'row-1');
  assert.equal(viaOf('record').target.taskId, undefined, 'record 那段身上不许沾到任务 id');
  assert.equal(viaOf('task').target.taskId, 'task-A');
});

test('通知：同一个任务下的两条评论，照旧聚成一段（别矫枉过正）', () => {
  const segs = toSegments([
    taskNotice({ taskId: 'task-A', at: N0, text: '名单先不用增减' }),
    taskNotice({ taskId: 'task-A', at: N1, text: '尽力去邀请' }),
  ], { windowMin: 30 });
  assert.equal(segs.length, 1, '同一个任务同一个人 30 分钟内 = 一段');
  assert.equal(segs[0].msgs.length, 2);
  assert.equal(segs[0].target.taskId, 'task-A');
});

test('通知：认不出落点的（日程提醒这种）照旧按人聚，行为一个字不变', () => {
  const one = normalizeSession(
    { value: 'calendar', category: 'calendar', time: N0, msg: { con: '10 点的会要开始了' } }, [], null,
  );
  const two = normalizeSession(
    { value: 'calendar', category: 'calendar', time: N1, msg: { con: '会议室换到 3 楼' } }, [], null,
  );
  const segs = toSegments([one, two], { windowMin: 30 });
  assert.equal(segs.length, 1, '没有任何可定位的 id，退回按 who 聚 —— 宁可退化也别不聚');
});

test('通知 mergeInto：任务 B 的新评论绝不许并进任务 A 的老段', () => {
  const existing = toSegments([taskNotice({ taskId: 'task-A', at: N0, text: '这个素材可以用' })], { windowMin: 30 });
  existing[0].filed = { project: 'P12-mpc2026', task: 'T61-2026-08-04-xxx' };
  const fresh = toSegments([taskNotice({ taskId: 'task-B', at: N1, text: '预算那版再改改' })], { windowMin: 30 });

  const merged = mergeInto(existing, fresh, { windowMin: 30 });
  assert.equal(merged.length, 2, '不同任务 = 不同线，5 分钟内也不许并');
  const old = merged.find((s) => s.id === existing[0].id);
  assert.equal(old.msgs.length, 1, '老段一条不许被塞进来');
  assert.equal(old.target.taskId, 'task-A', '老段的 taskId 绝不许被新那条盖成 task-B');
});
