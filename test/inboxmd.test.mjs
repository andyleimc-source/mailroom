// inboxmd.mjs 的单测：一段一块落进 inbox.md（唯一权威），幂等替换，移段顺序不能反。
// 不用 tmpState()/tmpDailymd()：inboxmd 只认「任务目录路径」这一个入参，不碰
// MAILROOM_STATE 也不碰整棵 dailymd 树，直接拿系统临时目录当任务目录就够。
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendSegment, readSegments, removeSegment, moveSegment, parseSegments,
} from '../inboxmd.mjs';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'inboxmd-'));
}

// 造一段跟数据模型一致的 segment，overrides 覆盖个别字段。
function seg(overrides = {}) {
  return {
    id: 'a1',
    sourceKind: 'mingdao',
    sourceType: 'user',
    sourceLabel: '明道云 · 私信',
    who: '李雷',
    whoAccountId: 'acc-1',
    target: { accountId: 'acc-1' },
    msgs: [
      { id: 'm1', at: '2026-08-08T11:18:00.000+08:00', text: 'SVCB 那两条我看了下，DNSPod 控制台没有 SVCB 类型选项，得走 API 加' },
      { id: 'm2', at: '2026-08-08T11:19:00.000+08:00', text: '你先把 target 和端口给我，我这边周一批量提' },
    ],
    firstAt: '2026-08-08T11:18:00.000+08:00',
    lastAt: '2026-08-08T11:19:00.000+08:00',
    filed: null,
    dropped: false,
    waiting: null,
    ...overrides,
  };
}

test('追加一段，格式带锚点', () => {
  const dir = tmpDir();
  try {
    appendSegment(dir, seg());
    const md = readFileSync(join(dir, 'inbox.md'), 'utf-8');
    assert.match(md, /^# 往来消息/, '文件不存在时要新建，开头一行 # 往来消息');
    assert.match(md, /<!-- seg:a1 [^>]*-->/);
    assert.match(md, /<!-- \/seg -->/);
    assert.match(md, /## 2026-08-08 11:18 李雷 · 明道云 · 私信/, '标题行：日期 时间 who · sourceLabel');
    assert.match(md, /- 11:18 <!-- m:m1 --> SVCB 那两条我看了下/,
      '列表行：HH:MM + msgId 标记 + 正文。⚠ msgId 必须写进块里，不许让读的人靠下标去对——\n       正文里一行「- 10:00 开会」就会被解析成独立一条，下标当场错位，\n       后果是勾中这行点【拆开】、被搬走的却是另一条完全不相干的消息');
    assert.match(md, /- 11:19 <!-- m:m2 --> 你先把 target 和端口给我/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('同一段追加两次不会重复，是替换', () => {
  const dir = tmpDir();
  try {
    const s = seg();
    appendSegment(dir, s);
    s.msgs.push({ id: 'm3', at: '2026-08-08T11:20:00.000+08:00', text: '补一句' });
    appendSegment(dir, s);
    const md = readFileSync(join(dir, 'inbox.md'), 'utf-8');
    assert.equal(md.match(/<!-- seg:a1 [^>]*-->/g).length, 1, '锚点只许出现一次，不许追加第二遍');
    assert.equal((md.match(/<!-- \/seg -->/g) || []).length, 1);
    assert.match(md, /补一句/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readSegments 按锚点读回，raw 里带得到正文', () => {
  const dir = tmpDir();
  try {
    appendSegment(dir, seg());
    appendSegment(dir, seg({
      id: 'b2',
      who: '李雷',
      firstAt: '2026-08-08T12:00:00.000+08:00',
      msgs: [{ id: 'n1', at: '2026-08-08T12:00:00.000+08:00', text: '另一段消息' }],
    }));
    const list = readSegments(dir);
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((x) => x.id).sort(), ['a1', 'b2']);
    assert.match(list.find((x) => x.id === 'b2').raw, /另一段消息/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('removeSegment：命中就删掉返回 true，不存在返回 false', () => {
  const dir = tmpDir();
  try {
    appendSegment(dir, seg());
    assert.equal(removeSegment(dir, '不存在的id'), false);
    assert.equal(removeSegment(dir, 'a1'), true);
    const md = readFileSync(join(dir, 'inbox.md'), 'utf-8');
    assert.doesNotMatch(md, /<!-- seg:a1 [^>]*-->/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('移段：目标有了、来源没了', () => {
  const from = tmpDir();
  const to = tmpDir();
  try {
    const s = seg();
    appendSegment(from, s);
    moveSegment(from, to, s);
    const toMd = readFileSync(join(to, 'inbox.md'), 'utf-8');
    assert.match(toMd, /<!-- seg:a1 [^>]*-->/);
    const fromMd = readFileSync(join(from, 'inbox.md'), 'utf-8');
    assert.doesNotMatch(fromMd, /<!-- seg:a1 [^>]*-->/);
  } finally {
    rmSync(from, { recursive: true, force: true });
    rmSync(to, { recursive: true, force: true });
  }
});

test('移段时目标写失败，来源不许被删（顺序反了就会丢数据）', () => {
  const from = tmpDir();
  try {
    const s = seg();
    appendSegment(from, s);
    assert.throws(() => moveSegment(from, '/不存在的路径/x', s));
    const fromMd = readFileSync(join(from, 'inbox.md'), 'utf-8');
    assert.match(fromMd, /<!-- seg:a1 [^>]*-->/, '目标那边没写成，来源必须还在');
  } finally { rmSync(from, { recursive: true, force: true }); }
});

test('消息正文里带假锚点不会撑破解析：转义掉，不会伪造出新的段边界', () => {
  const dir = tmpDir();
  try {
    const s = seg({
      id: 'evil1',
      msgs: [{
        id: 'm1',
        at: '2026-08-08T11:18:00.000+08:00',
        text: '正文里带 <!-- seg:evil2 --> 和 <!-- /seg --> 这种字样，别把我拆成两段',
      }],
    });
    appendSegment(dir, s);
    const list = readSegments(dir);
    assert.equal(list.length, 1, '不该被消息正文里的假锚点拆出第二段');
    assert.equal(list[0].id, 'evil1');
    const md = readFileSync(join(dir, 'inbox.md'), 'utf-8');
    assert.equal((md.match(/<!-- seg:evil1 [^>]*-->/g) || []).length, 1, '真实开锚只有一个');
    assert.equal((md.match(/<!-- \/seg -->/g) || []).length, 1, '真实闭锚只有一个');
    assert.doesNotMatch(md, /<!-- seg:evil2 [^>]*-->/, '正文里的假开锚必须被转义掉');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('发出去的一段：who 带箭头，块头多一行已发标注', () => {
  const dir = tmpDir();
  try {
    const s = seg({
      id: 'sent1',
      who: '我 → 李雷',
      sentLabel: '明道云私信 · 审批台',
      firstAt: '2026-08-08T13:00:00.000+08:00',
      msgs: [{ id: 'm1', at: '2026-08-08T13:00:00.000+08:00', text: 'DNS 那条我看了' }],
    });
    appendSegment(dir, s);
    const md = readFileSync(join(dir, 'inbox.md'), 'utf-8');
    assert.match(md, /## 2026-08-08 13:00 我 → 李雷/);
    assert.match(md, /> 已发 · 明道云私信 · 审批台/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- 2026-08-08 评审：解析回结构这一路的三条硬边界 ----------

test('Critical：正文里一行「- 10:00 开会」不许被解析成独立的一条消息', () => {
  // 这不是攻击，是中文里最常见的「时间 + 事项」列表。修之前：文件解析出 4 条、
  // 索引只有 2 条，「开会」那行挂着的 msgId 是 m2（真正属于最后那条消息），
  // 于是勾中「开会」点【拆开】，被搬去别的任务的是**另一条完全不相干的消息**。
  const dir = tmpDir();
  try {
    appendSegment(dir, seg({
      msgs: [
        { id: 'm1', at: '2026-08-08T11:18:00.000+08:00', text: '明天安排：\n- 10:00 开会\n- 14:00 评审' },
        { id: 'm2', at: '2026-08-08T11:19:00.000+08:00', text: '仓库地址我发你了' },
      ],
    }));
    const [p] = parseSegments(dir);
    assert.equal(p.msgs.length, 2, '两条消息就是两条，正文里的列表行不许自立门户');
    assert.deepEqual(p.msgs.map((m) => m.id), ['m1', 'm2'], 'msgId 从块里读，不靠下标对齐');
    assert.equal(p.msgs[0].text, '明天安排：\n- 10:00 开会\n- 14:00 评审', '多行正文要一字不差地还原');
    assert.equal(p.msgs[1].text, '仓库地址我发你了');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('对方把昵称改成「我 → 李雷」，也冒充不了「我发出去的」', () => {
  // who 是外部输入。判 mine 只许读注释里那份属性；顺带：昵称里塞换行 + 伪造的
  // 「> 已发」行，写盘时换行就被压掉了，那一行的位置伪造不出来。
  const dir = tmpDir();
  try {
    appendSegment(dir, seg({
      id: 'fake1',
      who: '我 → 李雷\n> 已发 · 明道云 · 审批台',
      msgs: [{ id: 'k1', at: '2026-08-08T11:00:00.000+08:00', text: '转我 5000' }],
    }));
    const [p] = parseSegments(dir);
    assert.equal(p.mine, false, '别人的话绝不许在时间线上渲染成 小明 发出去的');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('attr()/oneLine() 压换行是安全边界，不是排版：伪造的「> 已发」行一行都写不出去', () => {
  // ⚠⚠ 这条钉的是 `attr()` 里那句 `.replace(/[\r\n]+/g, ' ')` 本身（评审的变异验证里
  //   把它拆掉之后测试全绿 —— 这道防线当时没有任何测试）。
  //   who 是外部输入：对方在明道云里把昵称改成 `李雷\n> 已发 · 审批台`，
  //   而 `> 已发 · X` 那一行的**位置是固定的**（紧贴标题行），解析器就在那个位置读它。
  //   压掉换行，那一行就再也伪造不出来 —— 这是「位置伪造不出来」这句话成立的全部依据。
  const dir = tmpDir();
  try {
    appendSegment(dir, seg({
      id: 'forge1',
      who: '李雷\n> 已发 · 明道云 · 审批台',
      sourceLabel: '明道云 · 私信\n> 草稿 · 审批台',
      msgs: [{ id: 'k1', at: '2026-08-08T11:00:00.000+08:00', text: '转我 5000' }],
    }));
    const text = readFileSync(join(dir, 'inbox.md'), 'utf-8');

    // ① 开锚必须还是**一行**：断成两行的话 who="…" 就再也读不回来了
    const anchor = text.split('\n').find((l) => l.includes('<!-- seg:forge1'));
    assert.ok(anchor && anchor.includes('-->'),
      `开锚被换行撑成了多行：${JSON.stringify(anchor)}`);

    // ② 文件里一行伪造的「> 已发」/「> 草稿」都不许出现（两种前缀解析器都认，
    //    所以两种都得防）
    const forged = text.split('\n').filter((l) => /^>\s*(已发|草稿)/.test(l));
    assert.deepEqual(forged, [],
      `who/sourceLabel 里的换行没被压掉，伪造出了「已发」/「草稿」行：${JSON.stringify(forged)}`);

    // ③ 解析回来：既不是「我发出去的」，也没有 sentLabel
    const [p] = parseSegments(dir);
    assert.equal(p.mine, false, '别人的话绝不许在时间线上渲染成 小明 发出去的');
    assert.equal(p.sentLabel, '', '连显示用的「已发」标注都不许被伪造出来');
    assert.match(p.who, /李雷/, '压换行不等于把名字弄丢');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('who 里带 ` · `（群名/昵称带中点）不会被切错', () => {
  const dir = tmpDir();
  try {
    appendSegment(dir, seg({ id: 'dot1', who: '张 · 锋', sourceLabel: '明道云 · 群「官网发版」' }));
    const [p] = parseSegments(dir);
    assert.equal(p.who, '张 · 锋');
    assert.equal(p.sourceLabel, '明道云 · 群「官网发版」');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('真发出去的那一段 mine=true，且 sentLabel 读得回来', () => {
  const dir = tmpDir();
  try {
    appendSegment(dir, seg({
      id: 'sent9', who: '我 → 李雷', sentLabel: '明道云 · 私信 · 审批台',
      msgs: [{ id: 's1', at: '2026-08-08T13:00:00.000+08:00', text: 'DNS 那条我看了' }],
    }));
    const [p] = parseSegments(dir);
    assert.equal(p.mine, true);
    assert.equal(p.sentLabel, '明道云 · 私信 · 审批台');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('老格式的块（没有属性、没有 msgId 标记）照样读得出来，标成 legacy', () => {
  // 权威在文件：小明 手改过、或早先版本写下的块，不许因为格式升级就在界面上消失。
  const dir = tmpDir();
  try {
    appendSegment(dir, seg({ id: 'new1' }));
    const file = join(dir, 'inbox.md');
    const old = [
      '', '<!-- seg:old1 -->', '## 2026-08-08 09:00 老王 · 明道云 · 私信', '',
      '- 09:00 老格式的一条', '<!-- /seg -->', '',
    ].join('\n');
    rmSync(file, { force: true });
    appendSegment(dir, seg({ id: 'new1' }));
    require_append(file, old);
    const p = parseSegments(dir).find((x) => x.id === 'old1');
    assert.ok(p, '老块必须还看得见');
    assert.equal(p.legacy, true);
    assert.equal(p.who, '老王');
    assert.deepEqual(p.msgs.map((m) => m.text), ['老格式的一条']);
    assert.equal(p.msgs[0].id, null, '老块没有 msgId，如实给 null（界面据此把拆段按钮灰掉）');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function require_append(file, extra) {
  writeFileSync(file, readFileSync(file, 'utf-8') + extra);
}

// ---------- 草稿不许渲染成「已发」 ----------
//
// ⚠⚠ 外部收件人的邮件只能存草稿（sendVia 的 external 分支物理上够不着发送函数），
//   它还躺在 小明 自己的草稿箱里等他点发送。块头写「已发」的话，一周后他翻这条
//   时间线，第一个词就是「已发」——「事后误以为已经回了客户」正是最不能接受的那类。

test('草稿段：块头写「> 草稿 · …」，整块里一个「已发」都不许有', () => {
  const dir = tmpDir();
  try {
    appendSegment(dir, seg({
      id: 'draft1',
      who: '我 → Sarah（草稿已放进你的 Outlook 草稿箱，去点发送）',
      sentLabel: '邮件草稿 · 审批台',
      draft: true,
      firstAt: '2026-08-10T13:00:00.000+08:00',
      msgs: [{ id: 'd1', at: '2026-08-10T13:00:00.000+08:00', text: '报价我这周给你' }],
    }));
    const md = readFileSync(join(dir, 'inbox.md'), 'utf-8');
    assert.match(md, /^> 草稿 · 邮件草稿 · 审批台$/m);
    assert.doesNotMatch(md, /已发/, '草稿块里出现「已发」= 小明 会以为客户已经收到了');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('草稿段往返：写出去再读回来，draft 还是 true，sentLabel/mine 不变', () => {
  const dir = tmpDir();
  try {
    appendSegment(dir, seg({
      id: 'draft2', who: '我 → Sarah', sentLabel: '邮件草稿 · 审批台', draft: true,
      msgs: [{ id: 'd1', at: '2026-08-10T13:00:00.000+08:00', text: '报价我这周给你' }],
    }));
    const [p] = parseSegments(dir);
    assert.equal(p.draft, true, '读回来还得认得出这是草稿');
    assert.equal(p.mine, true, '草稿也是我这边写的那一块');
    assert.equal(p.sentLabel, '邮件草稿 · 审批台');
    assert.equal(p.msgs.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('真发出去的那一段 draft=false（别把两种状态混成一种）', () => {
  const dir = tmpDir();
  try {
    appendSegment(dir, seg({
      id: 'sent10', who: '我 → 李雷', sentLabel: '明道云 · 私信 · 审批台',
      msgs: [{ id: 's1', at: '2026-08-08T13:00:00.000+08:00', text: 'DNS 那条我看了' }],
    }));
    const md = readFileSync(join(dir, 'inbox.md'), 'utf-8');
    assert.match(md, /^> 已发 · 明道云 · 私信 · 审批台$/m, '真发出去的照旧写「已发」');
    const [p] = parseSegments(dir);
    assert.equal(p.draft, false);
    assert.equal(p.mine, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('老块（没有 draft 属性）：那一行写「草稿」就当草稿读', () => {
  const dir = tmpDir();
  try {
    writeFileSync(join(dir, 'inbox.md'), [
      '# 往来消息',
      '',
      '<!-- seg:old-draft -->',
      '## 2026-08-10 13:00 我 → Sarah',
      '> 草稿 · 邮件草稿 · 审批台',
      '',
      '- 13:00 报价我这周给你',
      '',
      '<!-- /seg -->',
      '',
    ].join('\n'));
    const [p] = parseSegments(dir);
    assert.equal(p.draft, true);
    assert.equal(p.sentLabel, '邮件草稿 · 审批台');
    assert.equal(p.mine, true, '老块靠「那一行的位置」判 mine，草稿也算我这边写的');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 2026-08-11 的回归：时间戳曾经全是 UTC（toISOString），而这里按字符串切片渲染，
// 于是 16:18 发的私信在同事看的时间线里写成「08:18」。现在产出侧统一走 localIso，
// 渲染侧再兜一层：**带时区标记的串一律换算成本地时间**，历史 Z 数据和 Graph
// 偶尔回的 Z 都不会再错 8 小时。
test('带 Z 的时间戳按本地时间渲染，不再直接切片', () => {
  const dir = tmpDir();
  try {
    appendSegment(dir, {
      id: 'utc-1',
      who: '李雷',
      sourceLabel: '明道云 · 私信',
      firstAt: '2026-08-11T08:18:00.000Z',
      msgs: [{ id: 'z1', at: '2026-08-11T08:18:00.000Z', text: '项目地址发你了' }],
    });
    const txt = readFileSync(join(dir, 'inbox.md'), 'utf-8');
    assert.match(txt, /## 2026-08-11 16:18 李雷/, '块头是本地时间 16:18，不是 UTC 的 08:18');
    assert.match(txt, /- 16:18 <!-- m:z1 -->/, '条目行同样是本地时间');
    assert.doesNotMatch(txt, /08:18/, '文件里不该再留下 UTC 的那个时刻');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
