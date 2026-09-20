// compact-inbox 的安全线。这支脚本会成批改写知识库里的 inbox.md，
// 每一条断言都对应一次真的差点删错东西。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { planFile, applyPlan } from '../scripts/compact-inbox.mjs';

const TODAY = new Date('2026-09-15T12:00:00');

function seg({ id = 's1', mine = 0, who = '李雷', via = '邮件 · mingdao', date = '2026-09-14', body = '正文' }) {
  return [
    `<!-- seg:${id} mine=${mine} draft=0 who="${who}" via="${via}" -->`,
    `## ${date} 10:00 ${who}${via ? ` · ${via}` : ''}`,
    '',
    `- 10:00 <!-- m:m-${id} --> ${body}`,
    '',
    '<!-- /seg -->',
  ].join('\n');
}

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'compact-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, 'utf-8');
  }
  return root;
}

function runOne(root, rel, opts = {}) {
  const file = join(root, rel);
  const plan = planFile(file, root, TODAY);
  return { plan, ...applyPlan(plan, root, opts) };
}

test('播报类段在项目级兜底桶里被删掉', () => {
  const root = repo({
    'projects/P00-misc/inbox.md': `# 往来消息\n\n${seg({ via: '明道云 · 日程通知', who: '日程' })}\n`,
  });
  const { stat } = runOne(root, 'projects/P00-misc/inbox.md');
  assert.equal(stat.drop, 1);
});

// ⚠⚠ 第一版拿 /(退订|取消订阅|unsubscribe)/ 扫全文，dry-run 把 T332「GEO内容实习生招聘」
//    整个清空了——BOSS直聘投来的三份简历，每封底部都有「点击此处取消订阅」。
//    正规商业邮件几乎都带退订链接，它不能当删除判据。
test('⚠ 正文里有「取消订阅」的真实业务邮件不许删', () => {
  const body = '主题：顾曦文 | 应聘 内容 & AI 流量运营实习生\n\n候选人给你发了一封简历。'
    + '如不想再收到此类邮件，请点击此处取消订阅。';
  const root = repo({
    'projects/P00-misc/inbox.md': `# 往来消息\n\n${seg({ who: 'BOSS直聘', body })}\n`,
  });
  const { stat } = runOne(root, 'projects/P00-misc/inbox.md');
  assert.equal(stat.drop, 0);
});

test('主题行自报是验证码/电子发票的才删', () => {
  const root = repo({
    'projects/P00-misc/inbox.md': '# 往来消息\n\n'
      + `${seg({ id: 'a', body: '主题：【电子发票】某某餐饮（309.00元）\n\n发票已开具。' })}\n\n`
      + `${seg({ id: 'b', body: '主题：关于赞助方案的确认\n\n我们讨论一下电子发票怎么开。' })}\n`,
  });
  const { stat } = runOne(root, 'projects/P00-misc/inbox.md');
  assert.equal(stat.drop, 1, '只删主题行命中的那条，正文提到发票的业务邮件要留');
});

// ⚠⚠ SKILL.md 里那句「drop 掉也没关系，原文照样在 assets/hap-log/」对**通知类**是
//    假的：notice-* 的消息压根不进归档 jsonl（2026-09-15 第一次跑 compact 删了 76 段，
//    事后抽查发现其中 71 段在 jsonl 里根本找不到）。所以删之前必须留底。
test('⚠ 删掉的段一律留底到 assets/hap-log/dropped-YYYY-MM.md', () => {
  const rel = 'projects/P00-misc/inbox.md';
  const root = repo({
    [rel]: `# 往来消息\n\n${seg({ via: '明道云 · 工作流通知', who: '工作流', body: '某某记录前往审批' })}\n`,
  });
  const { stat, text } = runOne(root, rel, { write: true });
  assert.equal(stat.drop, 1);
  assert.ok(!text.includes('前往审批'), 'inbox 里该没了');
  const log = join(root, 'assets/hap-log/dropped-2026-09.md');
  assert.ok(existsSync(log), '该生成 dropped-2026-09.md');
  const kept = readFileSync(log, 'utf-8');
  assert.ok(kept.includes('前往审批'), '留底里必须有正文');
  assert.ok(kept.includes('<!-- seg:s1 '), '连锚点一起留，将来还能读回结构');
});

// ⚠ mine=1 是以 Andy 名义发出去的消息记录，不是噪音。
test('mine=1 的自发段一段都不许删', () => {
  const root = repo({
    'projects/P00-misc/inbox.md': `# 往来消息\n\n${seg({ mine: 1, via: '明道云 · 日程通知' })}\n`,
  });
  const { stat } = runOne(root, 'projects/P00-misc/inbox.md');
  assert.equal(stat.drop, 0);
});

// ⚠ 段能落到具体任务下，说明归位时有人判断过它跟这件事有关（T317 整个任务就只有
//   两条会议通知，按项目级规则删完文件就空了）。
test('任务级 inbox 只压缩不删除', () => {
  const rel = 'projects/P00-misc/tasks/T317-2026-09-06-x/inbox.md';
  const root = repo({ [rel]: `# 往来消息\n\n${seg({ via: '明道云 · 日程通知', who: '日程' })}\n` });
  const { stat } = runOne(root, rel);
  assert.equal(stat.drop, 0);
  assert.equal(stat.keep, 1);
});

test('超长邮件正文压到 300 字并留下指向 mail-log 的锚点', () => {
  const rel = 'projects/P00-misc/inbox.md';
  const root = repo({ [rel]: `# 往来消息\n\n${seg({ body: '啊'.repeat(3000) })}\n` });
  const { stat, text } = runOne(root, rel);
  assert.equal(stat.shrink, 1);
  assert.match(text, /assets\/mail-log\/2026-09\.md/);
  assert.ok(text.length < 900, `压完还有 ${text.length} 字`);
  // 结构不许压坏：开锚、闭锚、消息 id 都得在
  assert.match(text, /<!-- seg:s1 /);
  assert.match(text, /<!-- \/seg -->/);
  assert.match(text, /<!-- m:m-s1 -->/);
});

// ⚠⚠ 这类脚本一定会被跑第二次。第一版不幂等：第二遍把上一轮的截断提示当成正文
//    又截了一刀，段尾留下「…（」这种半截行，每跑一次脏一层。
test('⚠ 跑第二遍必须完全不动（幂等）', () => {
  const rel = 'projects/P00-misc/inbox.md';
  const root = repo({ [rel]: `# 往来消息\n\n${seg({ body: '啊'.repeat(3000) })}\n` });
  const first = runOne(root, rel, { write: true });
  assert.equal(first.stat.shrink, 1);
  const second = runOne(root, rel, { write: true });
  assert.equal(second.stat.shrink, 0, '第二遍不该再压');
  assert.equal(second.text, first.text, '第二遍的结果必须跟第一遍一字不差');
  assert.equal((second.text.match(/正文已截断/g) || []).length, 1, '截断提示只许有一条');
});

test('短邮件原样不动', () => {
  const rel = 'projects/P00-misc/inbox.md';
  const before = `# 往来消息\n\n${seg({ body: '收到，我看一下。' })}\n`;
  const root = repo({ [rel]: before });
  const { stat, text } = runOne(root, rel);
  assert.equal(stat.shrink, 0);
  assert.equal(text.trim(), before.trim());
});

// ⚠⚠ readSegments 的正则是非贪婪的：碰到没闭合的畸形块，它会把这一块和后面一整段
//    一起吞进同一个匹配。整文件重建会让这类块连带吃掉内容——实测 P00-misc 就有一个
//    （开锚 977、闭锚 976）。所以：宁可不动，也不能动错。
test('⚠ 没闭合的畸形段一个字节都不碰，并且报出来', () => {
  const rel = 'projects/P00-misc/inbox.md';
  const broken = '<!-- seg:bad mine=0 who="吴迪" via="" -->';   // 只有开锚
  const before = `# 往来消息\n\n${broken}\n\n${seg({ via: '明道云 · 日程通知', who: '日程' })}\n`;
  const root = repo({ [rel]: before });
  const { stat, text } = runOne(root, rel);
  assert.equal(stat.suspicious, 1);
  assert.equal(stat.drop, 0, '被吞进畸形块的那条播报也不许删——碰它就会连累畸形块');
  assert.ok(text.includes(broken), '畸形块必须原样还在');
  assert.ok(text.includes('吴迪'));
});

test('超窗的段搬去 archive 的镜像位置，原文一字不改', () => {
  const rel = 'projects/P00-misc/inbox.md';
  const old = seg({ id: 'old', date: '2026-07-01', body: '很久以前的事' });
  const root = repo({ [rel]: `# 往来消息\n\n${old}\n\n${seg({ id: 'new' })}\n` });
  const { stat, text } = runOne(root, rel, { write: true });
  assert.equal(stat.move, 1);
  assert.ok(!text.includes('很久以前的事'), 'inbox 里不该再有它');
  const archived = join(root, 'archive/P00-misc/inbox-2026-07.md');
  assert.ok(existsSync(archived), '该生成 archive/P00-misc/inbox-2026-07.md');
  assert.ok(readFileSync(archived, 'utf-8').includes('很久以前的事'));
});

test('P00-misc 窗口 30 天，别的项目 90 天', () => {
  const body = { date: '2026-08-01', body: '一个半月前' };   // 45 天前
  const misc = repo({ 'projects/P00-misc/inbox.md': `# x\n\n${seg(body)}\n` });
  const other = repo({ 'projects/P12-mpc2026/inbox.md': `# x\n\n${seg(body)}\n` });
  assert.equal(runOne(misc, 'projects/P00-misc/inbox.md').stat.move, 1);
  assert.equal(runOne(other, 'projects/P12-mpc2026/inbox.md').stat.move, 0);
});

test('dry-run 不碰磁盘', () => {
  const rel = 'projects/P00-misc/inbox.md';
  const before = `# 往来消息\n\n${seg({ via: '明道云 · 日程通知', who: '日程' })}\n`;
  const root = repo({ [rel]: before });
  runOne(root, rel);                       // 不给 write
  assert.equal(readFileSync(join(root, rel), 'utf-8'), before);
});
