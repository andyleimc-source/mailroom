// tree.mjs 是「项目/任务清单」的唯一入口——网页不许自己存一份，唯一真相源是磁盘上的
// projects/ 目录。这里测三件事：扫清单不带 archive、resolve 能在 projects/ 和 archive/
// 里都找到目录、createTask 真调 scripts/new-task.sh 不自己分配编号。
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpDailymd } from './helpers.mjs';
import { listTree, resolve, createTask } from '../tree.mjs';
import { dailymdRoot } from '../lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// test/ -> 仓库根，要拿真实的 scripts/new-task.sh 和模板给 createTask 测试用
// ⚠ 2026-08-09 起这个仓库住在 dailymd 外面了，而 `new-task.sh` 是 **dailymd 的**脚本
//   （createTask 调的就是 `<dailymd>/scripts/new-task.sh`）。所以从真实库根去拷，
//   拷进临时目录里跑——不碰 小明 真实 dailymd 的 assets/codes.md。
//   库不在（换台机器、CI）就跳过这条，别红一条查不出所以然的。
const REPO_ROOT = dailymdRoot();

test('扫出项目和任务，归档目录不算', () => {
  const { root, cleanup } = tmpDailymd();
  try {
    const tree = listTree({ dailymd: root });
    const p26 = tree.find((p) => p.code === 'P26');
    assert.ok(p26, '应该扫到 P26');
    assert.equal(p26.slug, 'agent-ready-sites');
    assert.equal(p26.dir, 'P26-agent-ready-sites');
    assert.deepEqual(p26.tasks.map((t) => t.code).sort(), ['T70', 'T89']);
    assert.ok(!tree.some((p) => p.dir.startsWith('archive')));

    const t70 = p26.tasks.find((t) => t.code === 'T70');
    assert.equal(t70.title, 'T70 — three sites recon', 'title 取自 progress.md 第一个 # 标题');
    assert.equal(t70.status, 'in-progress', 'status 取自 frontmatter');
    assert.equal(t70.dir, 'T70-2026-08-05-three-sites-recon');
  } finally { cleanup(); }
});

test('归档目录里的项目/任务不出现在清单里', () => {
  const { root, cleanup } = tmpDailymd();
  try {
    mkdirSync(join(root, 'archive/P99-old/tasks/T01-2020-01-01-old-task'), { recursive: true });
    writeFileSync(join(root, 'archive/P99-old/progress.md'),
      '---\ntype: project\ncode: P99\nslug: old\nstatus: done\n---\n\n# old\n');
    const tree = listTree({ dailymd: root });
    assert.ok(!tree.some((p) => p.code === 'P99'), 'archive/ 下的项目不该出现在清单里');
  } finally { cleanup(); }
});

test('没有 frontmatter/标题时用 slug 兜底', () => {
  const { root, cleanup } = tmpDailymd();
  try {
    mkdirSync(join(root, 'projects/P26-agent-ready-sites/tasks/T77-2026-08-08-no-title'),
      { recursive: true });
    writeFileSync(
      join(root, 'projects/P26-agent-ready-sites/tasks/T77-2026-08-08-no-title/progress.md'),
      '没有 frontmatter 也没有标题的一份文件\n');
    const tree = listTree({ dailymd: root });
    const p26 = tree.find((p) => p.code === 'P26');
    const t77 = p26.tasks.find((t) => t.dir === 'T77-2026-08-08-no-title');
    assert.ok(t77, '就算 progress.md 没有 frontmatter 也该扫到');
    assert.equal(t77.code, 'T77', 'code 从目录名兜底');
    assert.equal(t77.status, 'active', 'status 没有 frontmatter 时兜底 active');
  } finally { cleanup(); }
});

test('树里带上 desc/start/due/owner，缺的给空串（含需要解引号的值）', () => {
  const { root, cleanup } = tmpDailymd();
  try {
    mkdirSync(join(root, 'projects/P26-agent-ready-sites/tasks/T90-2026-08-09-with-fields'),
      { recursive: true });
    writeFileSync(
      join(root, 'projects/P26-agent-ready-sites/tasks/T90-2026-08-09-with-fields/progress.md'),
      [
        '---',
        'type: task',
        'code: T90',
        'status: in-progress',
        'owner: 李雷',
        'due: 2026-08-20',
        'desc: "带: 冒号的描述"',
        '---',
        '',
        '# T90 — with fields',
        '',
      ].join('\n'),
    );
    mkdirSync(join(root, 'projects/P26-agent-ready-sites/tasks/T91-2026-08-09-no-fields'),
      { recursive: true });
    writeFileSync(
      join(root, 'projects/P26-agent-ready-sites/tasks/T91-2026-08-09-no-fields/progress.md'),
      [
        '---',
        'type: task',
        'code: T91',
        'status: in-progress',
        '---',
        '',
        '# T91 — no fields',
        '',
      ].join('\n'),
    );

    const tree = listTree({ dailymd: root });
    const p26 = tree.find((p) => p.code === 'P26');
    const t90 = p26.tasks.find((t) => t.code === 'T90');
    const t91 = p26.tasks.find((t) => t.code === 'T91');

    assert.equal(t90.owner, '李雷');
    assert.equal(t90.due, '2026-08-20');
    assert.equal(t90.desc, '带: 冒号的描述', 'desc 里带冒号的值要能正确解引号（复用 meta.mjs 的读法）');
    assert.equal(t90.start, '', 'T90 没写 start，也要给空串不是 undefined');

    assert.equal(t91.desc, '');
    assert.equal(t91.start, '');
    assert.equal(t91.due, '');
    assert.equal(t91.owner, '');

    // 项目对象也一样带上这四个键（P26 的 progress.md 没写这几个字段）
    assert.equal(p26.desc, '');
    assert.equal(p26.start, '');
    assert.equal(p26.due, '');
    assert.equal(p26.owner, '');
  } finally { cleanup(); }
});

test('resolve 在 projects/ 下找到任务目录', () => {
  const { root, cleanup } = tmpDailymd();
  try {
    const p = resolve({
      dailymd: root, project: 'P26-agent-ready-sites', task: 'T70-2026-08-05-three-sites-recon',
    });
    assert.ok(p, '应该找到 T70');
    assert.ok(existsSync(p));
    assert.ok(p.endsWith('T70-2026-08-05-three-sites-recon'));
  } finally { cleanup(); }
});

test('resolve 任务不存在返回 null', () => {
  const { root, cleanup } = tmpDailymd();
  try {
    const p = resolve({
      dailymd: root, project: 'P26-agent-ready-sites', task: 'T99-2099-01-01-not-exist',
    });
    assert.equal(p, null);
  } finally { cleanup(); }
});

test('resolve 能在 archive/ 里找到归档任务（翻旧消息用）', () => {
  const { root, cleanup } = tmpDailymd();
  try {
    mkdirSync(join(root, 'archive/P26-agent-ready-sites/tasks/T50-2026-01-01-old-done'),
      { recursive: true });
    writeFileSync(
      join(root, 'archive/P26-agent-ready-sites/tasks/T50-2026-01-01-old-done/progress.md'),
      '---\ntype: task\ncode: T50\nstatus: done\n---\n\n# T50 — old done\n');
    const p = resolve({
      dailymd: root, project: 'P26-agent-ready-sites', task: 'T50-2026-01-01-old-done',
    });
    assert.ok(p, '归档任务也该能 resolve 到');
    assert.ok(p.includes('archive'));
    assert.ok(existsSync(p));
  } finally { cleanup(); }
});

// createTask 调 scripts/new-task.sh，不自己分配编号。tmpDailymd() 造的骨架没带 scripts/，
// 这里现拷贝真实仓库的 new-task.sh + 模板进临时目录，让它在隔离环境里真跑一遍——
// 不碰 小明 真实 dailymd 的 assets/codes.md。
function withNewTaskScript(root) {
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'assets/templates'), { recursive: true });
  const script = readFileSync(join(REPO_ROOT, 'scripts/new-task.sh'), 'utf-8');
  writeFileSync(join(root, 'scripts/new-task.sh'), script);
  chmodSync(join(root, 'scripts/new-task.sh'), 0o755);
  const template = readFileSync(join(REPO_ROOT, 'assets/templates/task-progress-plain.md'), 'utf-8');
  writeFileSync(join(root, 'assets/templates/task-progress-plain.md'), template);
}

const HAS_DAILYMD = existsSync(join(REPO_ROOT, 'scripts/new-task.sh'));

test('createTask 调 new-task.sh 建任务，不自己分配编号', { skip: !HAS_DAILYMD && '本机没有 dailymd 库，跳过' }, () => {
  const { root, cleanup } = tmpDailymd();
  try {
    withNewTaskScript(root);
    const created = createTask({ dailymd: root, project: 'P00-misc', slug: 'mailroom-test-task' });
    assert.match(created.code, /^T\d+$/, 'code 应该是 new-task.sh 分配的，不是我们自己编的');
    assert.ok(created.dir.includes('mailroom-test-task'));
    assert.ok(existsSync(created.path), '任务目录应该真的建出来了');
    assert.ok(existsSync(join(created.path, 'progress.md')));

    // 建完立刻能在清单里扫到——3 秒缓存不能挡住刚建的任务
    const tree = listTree({ dailymd: root });
    const p00 = tree.find((p) => p.code === 'P00');
    assert.ok(p00, '应该扫到 P00-misc');
    assert.ok(p00.tasks.some((t) => t.code === created.code), '刚建的任务应该立刻出现在清单里');
  } finally { cleanup(); }
});
