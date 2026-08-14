// 整轮集成测试：假消息进来 → 聚段 → 归位 → 落进任务目录的 inbox.md。
// ⚠ 这条测试现在必须是红的（找不到 ../run.mjs）——这是任务 1 的正确结果，
//   run.mjs 是后面的任务去填，这里不许为了让它变绿而顺手建一个。
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpDailymd, tmpState, fakeAdapter } from './helpers.mjs';

// 两条测试各自的状态目录要互不相同——钉死「stateDir() 是函数、每条测试拿到独立隔离」
// 这件事本身，别只信注释。
let firstStateDir;

test('一整轮：假消息进来 → 聚段 → 归位 → 落进任务目录的 inbox.md', async () => {
  const { root, cleanup } = tmpDailymd();
  const { dir: stateDirPath, cleanup: cleanupState } = tmpState();
  firstStateDir = stateDirPath;
  const lines = [];
  try {
    const { runOnce } = await import('../run.mjs');
    const adapter = fakeAdapter([{
      sourceKind: 'mingdao', kind: 'user', who: '李雷', whoAccountId: 'a1',
      target: { accountId: 'a1' },
      msgs: [
        { id: 'm1', at: '2026-08-08T03:18:00.000Z', text: 'SVCB 那两条 DNSPod 控制台加不了，得走 API' },
        { id: 'm2', at: '2026-08-08T03:19:00.000Z', text: '你先把 target 和端口给我' },
      ],
    }]);
    // judge 注入：把「交给 claude 判断」顶掉，编排逻辑真跑
    const judge = async () => ([{ segIndex: 0, project: 'P26-agent-ready-sites',
      task: 'T70-2026-08-05-three-sites-recon', reason: '命中「SVCB / DNSPod」', sure: true,
      waiting: null }]);
    const r = await runOnce({
      adapters: [adapter], judge, dailymd: root,
      onLog: (s) => lines.push(String(s)),
    });

    assert.equal(r.filed, 1, '应该归位 1 段');
    const md = readFileSync(join(root,
      'projects/P26-agent-ready-sites/tasks/T70-2026-08-05-three-sites-recon/inbox.md'), 'utf-8');
    assert.match(md, /李雷/);
    assert.match(md, /DNSPod/);
    assert.match(md, /<!-- seg:/);
    // 这条已经走了真实的取数→归位→落盘那条路，顺带盯一眼日志里有没有被吞掉的错。
    assert.ok(!lines.some((l) => /失败|Error|undefined|not defined/.test(l)),
      `日志里有被吞掉的错：${lines.join(' | ')}`);
  } finally { cleanup(); cleanupState(); }
});

test('一整轮里不许出现「轮询失败」这种被吞掉的错', async () => {
  // ⚠ 光断言不抛异常抓不住：最外层 catch 会把 ReferenceError 吞成一句日志。
  // ⚠ 必须喂一条真候选（不能是 fakeAdapter([])）——聚段/判定/写盘那条路一次都没跑的话，
  //   这条测试防不住它要防的东西：「最外层 catch 吞掉 ReferenceError」正好发生在那条路上。
  const { root, cleanup } = tmpDailymd();
  const { dir: stateDirPath, cleanup: cleanupState } = tmpState();
  assert.notEqual(stateDirPath, firstStateDir, '两条测试该各自拿到独立的状态目录');
  const lines = [];
  try {
    const { runOnce } = await import('../run.mjs');
    const adapter = fakeAdapter([{
      sourceKind: 'mingdao', kind: 'user', who: '李雷', whoAccountId: 'a1',
      target: { accountId: 'a1' },
      msgs: [
        { id: 'm1', at: '2026-08-08T03:18:00.000Z', text: 'SVCB 那两条 DNSPod 控制台加不了，得走 API' },
        { id: 'm2', at: '2026-08-08T03:19:00.000Z', text: '你先把 target 和端口给我' },
      ],
    }]);
    const judge = async () => ([{ segIndex: 0, project: 'P26-agent-ready-sites',
      task: 'T70-2026-08-05-three-sites-recon', reason: '命中「SVCB / DNSPod」', sure: true,
      waiting: null }]);
    const r = await runOnce({
      adapters: [adapter], judge, dailymd: root,
      onLog: (s) => lines.push(String(s)),
    });
    assert.ok(!lines.some((l) => /失败|Error|undefined|not defined/.test(l)),
      `日志里有被吞掉的错：${lines.join(' | ')}`);
  } finally { cleanup(); cleanupState(); }
});
