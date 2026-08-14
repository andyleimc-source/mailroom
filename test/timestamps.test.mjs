// 时间戳的三道门。⚠⚠ 这个文件是「UTC 早 8 小时」那个 bug 的根治措施，别删。
//
// 2026-08-11：给同事看的时间线上，16:18 发出去的私信写着「08:18」，对方 16:25 的
// 回复写着「08:25」，而同一个文件里的邮件写着 16:59 —— 邮件排到了后发的私信前面，
// 看上去像"先收到授权邮件才发的申请"。根因是时间戳存 UTC（toISOString）而渲染
// 直接切字符串。修完之后要保证**将来也不会再犯**，所以设了三道：
//
//   ① 产出：所有给人看的时间戳走 localIso()
//   ② 写入：落盘门口 healTimestamps() 自愈（新渠道/外部 SDK 塞进来的 Z 也救得回）
//   ③ 渲染：shortTime() 见到带时区的串先换算再切
//
// 下面每道都有用例。最后一条是源码守卫：**新代码不许再出现裸的 toISOString()**，
// 真要用（水位线那种给机器比大小的）必须在同一行标 `// utc-ok: 理由`。

import test from 'node:test';
import assert from 'node:assert';
import { readdirSync, readFileSync, statSync, rmSync, mkdtempSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { localIso, healTimestamps } from '../lib.mjs';
import { appendSegment, parseSegments } from '../inboxmd.mjs';

function tmpDir() { return mkdtempSync(join(tmpdir(), 'timestamps-')); }

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// ---------- ① 产出 ----------

test('localIso：UTC 串转成本地时间，带偏移量', () => {
  assert.equal(localIso('2026-08-11T08:18:00.000Z'), '2026-08-11T16:18:00.000+08:00');
});

test('localIso：HAP 给的裸本地串不挪时刻，只补上偏移量', () => {
  // ⚠ 这条最容易写错：裸串本来就是本地时间，当成 UTC 再挪一次就又错 8 小时。
  assert.equal(localIso('2026-08-11 16:55:12'), '2026-08-11T16:55:12.000+08:00');
});

test('localIso：带毫秒，否则跟 Date.now() 比大小会显得"发生在请求之前"', () => {
  const before = Date.now();
  const t = new Date(localIso()).getTime();
  assert.ok(t >= before && t <= Date.now(), 'localIso() 的时刻必须落在调用前后之间');
  assert.match(localIso(), /\.\d{3}\+\d{2}:\d{2}$/);
});

// ---------- ② 写入 ----------

test('healTimestamps：嵌套结构里的 Z 时间戳全部就地修好', () => {
  const healed = healTimestamps({
    id: 's1',
    firstAt: '2026-08-11T08:18:00.000Z',
    msgs: [{ id: 'm1', at: '2026-08-11T08:25:00Z', text: '正文里写 2026-01-01T00:00:00Z 不该被动' }],
  }, 'test');
  assert.equal(healed.firstAt, '2026-08-11T16:18:00.000+08:00');
  assert.equal(healed.msgs[0].at, '2026-08-11T16:25:00.000+08:00');
});

test('healTimestamps：裸串和已经带偏移的串一个字都不动', () => {
  const src = { a: '2026-08-11 16:55:12', b: '2026-08-11T16:18:00.000+08:00', c: '不是时间' };
  assert.deepEqual(healTimestamps(src, 'test'), src);
});

test('写盘门口自愈：塞一个 UTC 段进 appendSegment，落到 inbox.md 的是本地时间', () => {
  const dir = tmpDir();
  try {
    appendSegment(dir, {
      id: 'heal-1',
      who: '李雷',
      sourceLabel: '明道云 · 私信',
      firstAt: '2026-08-11T08:18:00.000Z',
      msgs: [{ id: 'z1', at: '2026-08-11T08:18:00.000Z', text: '项目地址发你了' }],
    });
    const txt = readFileSync(join(dir, 'inbox.md'), 'utf-8');
    assert.match(txt, /## 2026-08-11 16:18 /);
    assert.doesNotMatch(txt, /08:18/);
    assert.equal(parseSegments(dir).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- ③ 源码守卫 ----------

function sourceFiles(dir = ROOT, out = []) {
  for (const name of readdirSync(dir)) {
    // test/ 里的夹具可以随便造 UTC 串；node_modules 和 .git 不看。
    if (['node_modules', '.git', 'test', 'docs', '_tmp'].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

test('源码守卫：不许再出现裸的 toISOString()，要用得标 utc-ok 说明理由', () => {
  const offenders = [];
  for (const file of sourceFiles()) {
    const lines = readFileSync(file, 'utf-8').split('\n');
    lines.forEach((line, i) => {
      if (!line.includes('.toISOString(')) return;
      if (line.trimStart().startsWith('//')) return;      // 注释里提到它是在讲这段历史
      if (line.includes('utc-ok:')) return;               // 显式豁免：水位线那类给机器比大小的
      offenders.push(`${relative(ROOT, file)}:${i + 1}  ${line.trim()}`);
    });
  }
  assert.deepEqual(
    offenders, [],
    '给人看的时间戳一律走 lib.mjs 的 localIso()；\n'
    + '确实需要 UTC（增量查询的水位线那种，给机器比大小的）就在同一行加 `// utc-ok: 理由`。\n'
    + `违规行：\n${offenders.join('\n')}`,
  );
});
