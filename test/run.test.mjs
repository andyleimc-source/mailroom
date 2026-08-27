// 轮询器：整条链的编排。
//
// ⚠⚠ 这份文件存在的理由本身就是一条教训：老 hap-desk 的 run.mjs 文件底部是一句
//   顶层裸 `main()`，谁 `import` 它都会当场真跑一轮（真打 hap CLI、真写基线、真推 Bark），
//   于是**没有人敢给它写测试**。代价是一行 ReferenceError 被最外层 catch 吞成一句
//   「轮询失败」，收消息整条链死了两天一直在丢消息，而 753 条单元测试全绿。
//   所以这里第一条测试就是「import 它不会跑起来」，第二条盯住入口守卫别被人删掉。
//
// ⚠ 全程不许真调 hap / claude / 走网络：adapters 注入假适配器，judge 顶掉判定，
//   dailymd 用 tmpDailymd()，状态目录用 tmpState()。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDailymd, tmpState } from './helpers.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const POLL = join(ROOT, 'run.mjs');

// ⚠⚠ 整份文件里 watch 水位线一律指向临时文件。回滚那条路会**写**这个文件，
//   不顶掉的话就写到 小明 真的 ~/.hap-watch/mailroom.json 上了。
//   （run.mjs 里还有一道保险：测试环境下没设这个变量就跳过回滚，不碰真的。）
function tmpWatch(content) {
  const dir = mkdtempSync(join(tmpdir(), 'mailroom-watch-'));
  const file = join(dir, 'mailroom.json');
  if (content !== undefined) writeFileSync(file, content);
  const prev = process.env.MAILROOM_WATCH_STATE;
  process.env.MAILROOM_WATCH_STATE = file;
  return {
    file,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      if (prev === undefined) delete process.env.MAILROOM_WATCH_STATE;
      else process.env.MAILROOM_WATCH_STATE = prev;
    },
  };
}

const TASK70 = 'T70-2026-08-05-three-sites-recon';
const P26 = 'P26-agent-ready-sites';
const P12 = 'P12-mpc2026';
const TASK88 = 'T88-2026-08-07-sponsor-zh-pdf-v2';

// 一条私信候选，两条消息。多处复用，每次现造一份（别让上一条测试改到下一条）。
function dm(msgs) {
  return {
    sourceKind: 'mingdao', kind: 'user', who: '李雷', whoAccountId: 'a1',
    target: { accountId: 'a1' },
    msgs: msgs || [
      { id: 'm1', at: '2026-08-08T03:18:00.000Z', text: 'SVCB 那两条 DNSPod 控制台加不了，得走 API' },
      { id: 'm2', at: '2026-08-08T03:19:00.000Z', text: '你先把 target 和端口给我' },
    ],
  };
}

// 假适配器。pull 的返回可以整份指定，用来造 401 / firstRun / noNews 这些结局。
function adapterWith(result, opts = {}) {
  return {
    kind: 'mingdao',
    pull: () => (typeof result === 'function' ? result() : result),
    describe: () => '明道云 · 私信',
    ...opts,
  };
}

const filedTo = (project, task) => async () => ([{
  segIndex: 0, project, task, reason: '测试写死的判定', sure: true, waiting: null,
}]);

// ---------- ① 入口守卫 ----------
//
// ⚠⚠ 这一组存在的理由是一条教训：老 hap-desk 的 poll.mjs 底部是一句顶层裸 `main()`，
//   谁 import 它都会当场真跑一轮（真打 hap、真写基线、真推 Bark），于是没有人敢给它
//   写测试。代价是一行 ReferenceError 被最外层 catch 吞成一句「轮询失败」，收消息整条链
//   死了两天一直在丢消息，而 753 条单元测试全绿。
//   2026-08-09 网页砍掉之后，`main()` 从 run.mjs 搬进了 `bin/` 下那三条命令，
//   所以这一组现在同时盯着 run.mjs（必须是纯库）和每一条 bin 命令（必须有守卫）。

test('run.mjs 被 import 不会自己跑起来（这条排第一：后面每条都要 import 它）', async () => {
  const { dir, cleanup } = tmpState();
  try {
    const m = await import('../run.mjs');
    assert.equal(typeof m.runOnce, 'function');
    assert.equal(typeof m.fileNow, 'function');
    // ⚠ run.mjs 现在是纯库，不许再有 main()——真正的入口在 bin/ 下，那儿才有守卫。
    assert.equal(m.main, undefined, 'run.mjs 是库，入口在 bin/ 下');
    // 没有副作用：光 import 不许在状态目录里留下任何东西（锁文件、日志、segments.json）
    // config.json 是 tmpState() 写的测试夹具，不算 run.mjs 的副作用
    assert.deepEqual(readdirSync(dir).filter((f) => f !== 'config.json'), [],
      'import run.mjs 产生了副作用——它必须只导出函数，不许当场跑一轮');
  } finally { cleanup(); }
});

for (const cmd of ['fetch.mjs', 'file.mjs', 'send.mjs']) {
  test(`bin/${cmd} 入口守卫必须在，且不许有顶层裸 main()`, () => {
    const src = readFileSync(join(ROOT, 'bin', cmd), 'utf-8');
    assert.match(src, /import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href/,
      '入口守卫是硬要求：没有它谁 import 都会当场跑起来，于是没人敢测它');
    // 顶层裸 `main()` / `main().catch(...)`（行首没有缩进、没有 if 包着）一律不许
    const bare = src.split('\n').filter((l) => /^main\s*\(/.test(l));
    assert.deepEqual(bare, [], '顶层裸 main() 正是旧版没人敢写测试的原因');
  });
}

test('run.mjs 不许 import send.mjs——收消息那条链永远不发消息', () => {
  assert.doesNotMatch(readFileSync(POLL, 'utf-8'), /from '\.\/send\.mjs'/);
});

// ⚠⚠ 发送只许有一条路。bin/ 下另外两条命令碰都不许碰 send.mjs——
//   2026-08-08 的事故就是「发送有第二条路」。
for (const cmd of ['fetch.mjs', 'file.mjs']) {
  test(`bin/${cmd} 不许 import send.mjs——唯一发送入口是 bin/send.mjs`, () => {
    const src = readFileSync(join(ROOT, 'bin', cmd), 'utf-8');
    assert.doesNotMatch(src, /from '\.\.\/send\.mjs'/);
    assert.doesNotMatch(src, /MAILROOM_ROLE/,
      '只有 bin/send.mjs 能碰这个变量，它是「本进程有没有资格发送」的唯一锚点');
  });
}

// ---------- ② 401 ----------

test('401 时 runOnce 返回 authError 且一条消息都不处理', async () => {
  const { root, cleanup } = tmpDailymd();
  const { cleanup: cleanupState } = tmpState();
  const lines = [];
  try {
    const { runOnce } = await import('../run.mjs');
    const store = await import('../store.mjs');
    let judged = 0;
    const adapter = adapterWith({
      candidates: [dm()],
      records: [{
        id: 'm1', ts: '2026-08-08 11:18:00.000', dir: 'in', kind: 'user',
        peer: '李雷', peerId: 'a1', text: '不该被归档',
      }],
      firstRun: false, noNews: false, authError: 'token is missing, invalid, or expired',
    });
    const r = await runOnce({
      adapters: [adapter],
      judge: async () => { judged++; return []; },
      dailymd: root,
      onLog: (s) => lines.push(String(s)),
    });

    assert.match(String(r.authError), /token/i, '401 要原样报上去，让调用方去 Bark 喊 小明 登录');
    assert.equal(r.got, 0);
    assert.equal(r.segmented, 0);
    assert.equal(r.filed, 0);
    assert.equal(judged, 0, '401 之后不许再问 claude');
    assert.deepEqual(store.segments(), [], '401 这一轮一条消息都不许入段');
    assert.equal(existsSync(join(root, 'assets/hap-log')), false,
      '401 这一轮连归档都不许写——「一条消息都不处理」是字面意思');
    assert.equal(existsSync(join(root, 'projects', P26, 'tasks', TASK70, 'inbox.md')), false);
    assert.ok(lines.some((l) => /hap auth login/.test(l)),
      '日志里要写清怎么修（跑 hap auth login），不许换通道兜底');
  } finally { cleanup(); cleanupState(); }
});

// ---------- ③ 重复消息 ----------

test('同一条消息收两次不会入两次段', async () => {
  const { root, cleanup } = tmpDailymd();
  const { cleanup: cleanupState } = tmpState();
  try {
    const { runOnce } = await import('../run.mjs');
    const store = await import('../store.mjs');
    const opts = () => ({
      adapters: [adapterWith({
        candidates: [dm()], records: [], firstRun: false, noNews: false, authError: null,
      })],
      judge: filedTo(P26, TASK70),
      dailymd: root,
    });

    const r1 = await runOnce(opts());
    assert.equal(r1.filed, 1);

    // 第二轮：适配器把同样两条消息又给了一遍（明道云的会话时间戳抖一下就会这样）
    const r2 = await runOnce(opts());
    assert.equal(r2.filed, 0, '第二轮一条新消息都没有，不该再归位一次');
    assert.equal(r2.segmented, 0);

    const segs = store.segments();
    assert.equal(segs.length, 1, '同一条线上的重复消息不许变成第二段');
    assert.equal(segs[0].msgs.length, 2, '重复的消息不许被追加进老段里');

    const md = readFileSync(join(root, 'projects', P26, 'tasks', TASK70, 'inbox.md'), 'utf-8');
    assert.equal(md.match(/<!-- seg:/g).length, 1, 'inbox.md 里也只该有一块');
    assert.equal(md.match(/DNSPod/g).length, 1);
  } finally { cleanup(); cleanupState(); }
});

// ---------- ④ split 拆出来的新段必须存下来（Task 5 传下来的硬契约） ----------

test('split 拆出来的新段必须存进 segments.json', async () => {
  // ⚠ fileAll 返回的 all 里才有拆出来的新段——它们不在传进去的那个数组里。
  //   poll 存错一份，拆出来的段就在运行态索引里凭空消失（inbox.md 里却有），
  //   下一轮没人认领它，界面上也翻不到。这条测试就是钉死这件事。
  const { root, cleanup } = tmpDailymd();
  const { cleanup: cleanupState } = tmpState();
  try {
    const { runOnce } = await import('../run.mjs');
    const store = await import('../store.mjs');
    const judge = async () => ([{
      segIndex: 0, project: P26, task: TASK70, reason: '一段里说了两件事', sure: true, waiting: null,
      split: [
        { msgIds: ['m1'], project: P26, task: TASK70, reason: 'DNSPod 那条归 T70' },
        { msgIds: ['m2'], project: P12, task: TASK88, reason: '另一件事归 T88' },
      ],
    }]);
    const r = await runOnce({
      adapters: [adapterWith({
        candidates: [dm()], records: [], firstRun: false, noNews: false, authError: null,
      })],
      judge,
      dailymd: root,
    });

    assert.equal(r.filed, 2, '拆成两片就是两段都归位了');
    const segs = store.segments();
    assert.equal(segs.length, 2, `拆出来的新段没存回 segments.json：${JSON.stringify(segs.map((s) => s.id))}`);
    assert.equal(new Set(segs.map((s) => s.id)).size, 2, '两段的 id 必须两两不同');
    assert.ok(segs.some((s) => /-s1$/.test(s.id)), '拆出来的那一段 id 带 -s1 后缀');

    const md70 = readFileSync(join(root, 'projects', P26, 'tasks', TASK70, 'inbox.md'), 'utf-8');
    const md88 = readFileSync(join(root, 'projects', P12, 'tasks', TASK88, 'inbox.md'), 'utf-8');
    assert.match(md70, /DNSPod/);
    assert.match(md88, /target 和端口/);
  } finally { cleanup(); cleanupState(); }
});

// ---------- ⑤ 归档 ----------

test('records 归档进传进来的那个 dailymd，不碰真实仓库', async () => {
  const { root, cleanup } = tmpDailymd();
  const { cleanup: cleanupState } = tmpState();
  const lines = [];
  try {
    const { runOnce } = await import('../run.mjs');
    await runOnce({
      adapters: [adapterWith({
        candidates: [dm()],
        records: [{
          id: 'm1', ts: '2026-08-08 11:18:00.000', dir: 'in', kind: 'user',
          peer: '李雷', peerId: 'a1', text: 'SVCB 那两条 DNSPod 控制台加不了',
        }],
        firstRun: false, noNews: false, authError: null,
      })],
      judge: filedTo(P26, TASK70),
      dailymd: root,
      onLog: (s) => lines.push(String(s)),
    });
    const jsonl = join(root, 'assets/hap-log/2026-08.jsonl');
    assert.ok(existsSync(jsonl), '归档要落进这个 dailymd 的 assets/hap-log/');
    assert.match(readFileSync(jsonl, 'utf-8'), /DNSPod/);
    assert.ok(lines.some((l) => /归档/.test(l)), '归档了几条要写日志');
  } finally { cleanup(); cleanupState(); }
});

// ---------- ⑥ 首轮 / 无新动静 ----------

test('首轮和无新动静原样报上去，不当成有消息', async () => {
  const { root, cleanup } = tmpDailymd();
  const { cleanup: cleanupState } = tmpState();
  try {
    const { runOnce } = await import('../run.mjs');
    const base = { candidates: [], records: [], authError: null };
    const first = await runOnce({
      adapters: [adapterWith({ ...base, firstRun: true, noNews: false })],
      judge: async () => { throw new Error('首轮不该问 claude'); },
      dailymd: root,
    });
    assert.equal(first.got, 0);
    assert.equal(first.filed, 0);

    const none = await runOnce({
      adapters: [adapterWith({ ...base, firstRun: false, noNews: true })],
      judge: async () => { throw new Error('没新动静不该问 claude'); },
      dailymd: root,
    });
    assert.equal(none.got, 0);
    assert.equal(none.segmented, 0);
  } finally { cleanup(); cleanupState(); }
});

// ---------- ⑦ 装好第一次跑：状态目录还不存在 ----------

test('状态目录还不存在时也能跑完（新机器装好第一轮就是这个样子）', async () => {
  const { root, cleanup } = tmpDailymd();
  const { dir, cleanup: cleanupState } = tmpState();
  const missing = join(dir, '还没建过的子目录');   // tmpState 建了 dir，这一层没有
  process.env.MAILROOM_STATE = missing;
  const lines = [];
  try {
    const { runOnce } = await import('../run.mjs');
    const r = await runOnce({
      adapters: [adapterWith({
        candidates: [dm()], records: [], firstRun: false, noNews: false, authError: null,
      })],
      judge: filedTo(P26, TASK70),
      dailymd: root,
      onLog: (s) => lines.push(String(s)),
    });
    assert.equal(r.filed, 1, `状态目录不存在就整轮空转了：${lines.join(' | ')}`);
    assert.ok(existsSync(join(missing, 'segments.json')));
  } finally { cleanupState(); cleanup(); }
});

test('acquireLock 会自己建状态目录，并且挡住并发的第二轮', async () => {
  // ⚠ 这条是真机验收（Task 13）会当场绊倒的那个洞：~/.mailroom 还不存在时
  //   acquireLock 直接 ENOENT，第一轮整轮空转，第二轮才因为 log() 顺手建了目录而恢复。
  const { dir, cleanup } = tmpState();
  const missing = join(dir, '还没建过的子目录');
  process.env.MAILROOM_STATE = missing;
  try {
    const { acquireLock, releaseLock } = await import('../run.mjs');
    assert.equal(acquireLock(), true, '状态目录不存在时也要能拿到锁');
    assert.ok(existsSync(join(missing, 'poll.lock')));
    assert.equal(acquireLock(), false, '上一轮还没跑完，这轮该让开');
    releaseLock();
    assert.equal(existsSync(join(missing, 'poll.lock')), false);
  } finally { cleanup(); }
});

// ---------- ⑧ 适配器是 async 的 ----------

test('适配器写成 async 也照样收得到（pull 必须 await）', async () => {
  // ⚠ 不 await 的话拿到的是 Promise，它照样过 typeof === 'object' 那道门，
  //   candidates/records/authError 全是 undefined —— 静默零消息、不报错、不 log。
  //   connect/index.mjs 的设计目标是「加一行就接第二个源」，以后接邮件必踩这个。
  const { root, cleanup } = tmpDailymd();
  const { cleanup: cleanupState } = tmpState();
  try {
    const { runOnce } = await import('../run.mjs');
    const asyncAdapter = {
      kind: 'mingdao',
      pull: async () => ({
        candidates: [dm()], records: [], firstRun: false, noNews: false, authError: null,
      }),
      describe: () => '明道云 · 私信',
    };
    const r = await runOnce({
      adapters: [asyncAdapter], judge: filedTo(P26, TASK70), dailymd: root,
    });
    assert.equal(r.got, 1);
    assert.equal(r.filed, 1);
    assert.match(
      readFileSync(join(root, 'projects', P26, 'tasks', TASK70, 'inbox.md'), 'utf-8'), /DNSPod/,
    );
  } finally { cleanup(); cleanupState(); }
});

// ---------- ⑨ 水位线回滚 ----------

const WATCH_BEFORE = JSON.stringify({ updated: '2026-08-08T03:00:00.000Z', seen: { s1: '旧时间' } });
const WATCH_AFTER = JSON.stringify({ updated: '2026-08-08T03:20:00.000Z', seen: { s1: '新时间' } });

test('下游抛错时把 watch 水位线回滚回去，下一轮才真的能再收一次', async () => {
  // ⚠⚠ 这条钉的是老系统那个「消息永久消失」的模子：watch.mjs 在 chat list 一成功
  //   就把新基线写盘了，比 poll 的下游步骤早。中途砸了不回滚 = 那批消息再也不会
  //   被报成「新」，永久进不了 inbox.md，还没人被告知。
  const { root, cleanup } = tmpDailymd();
  const { cleanup: cleanupState } = tmpState();
  const w = tmpWatch(WATCH_BEFORE);
  const lines = [];
  try {
    const { runOnce } = await import('../run.mjs');
    const adapter = {
      kind: 'mingdao',
      // 取数成功（并且像 watch.mjs 那样把水位线推到了新的），下游才砸
      pull: () => {
        writeFileSync(w.file, WATCH_AFTER);
        return {
          candidates: [dm()], records: [], firstRun: false, noNews: false, authError: null,
        };
      },
      describe: () => { throw new Error('describe 不该影响这条'); },
    };
    const r = await runOnce({
      adapters: [adapter],
      // judge 抛错走的是 fileAll 内部的兜底，不算「整轮砸了」，所以这里让存盘那步砸：
      store: {
        segments: () => [],
        saveSegments: () => { throw new Error('磁盘满了' ); },
        stateGet: () => undefined,
        stateSet: () => {},
      },
      judge: filedTo(P26, TASK70),
      dailymd: root,
      onLog: (s) => lines.push(String(s)),
    });
    assert.equal(r.filed, 1, '归位本身是成功的，砸的是存盘那一步');
    assert.equal(readFileSync(w.file, 'utf-8'), WATCH_BEFORE,
      `水位线没回滚，这批消息就永久消失了：${lines.join(' | ')}`);
    assert.ok(lines.some((l) => /回滚/.test(l)), '回滚了要说一声');
  } finally { cleanup(); cleanupState(); w.cleanup(); }
});

test('401 也要回滚水位线（轮中途掉线，那批会话已经从水位线过去了）', async () => {
  const { root, cleanup } = tmpDailymd();
  const { cleanup: cleanupState } = tmpState();
  const w = tmpWatch(WATCH_BEFORE);
  try {
    const { runOnce } = await import('../run.mjs');
    const r = await runOnce({
      adapters: [adapterWith(() => {
        writeFileSync(w.file, WATCH_AFTER);
        return {
          candidates: [], records: [], firstRun: false, noNews: false,
          authError: 'token is missing, invalid, or expired',
        };
      })],
      judge: async () => [],
      dailymd: root,
    });
    assert.ok(r.authError);
    assert.equal(readFileSync(w.file, 'utf-8'), WATCH_BEFORE);
  } finally { cleanup(); cleanupState(); w.cleanup(); }
});

test('适配器报 lost（某个会话取数失败）→ 也要回滚水位线，且取到的那些照常归位', async () => {
  // ⚠⚠ 这条钉的是「三处裸 catch 把 401 和一切 hap 报错吞成零条新消息」那个洞的下半截：
  //   fetch.mjs 现在会抛、pull 会记进 lost，poll 这边必须真的把它当成「这一轮没干净收尾」
  //   —— 否则水位线照样过去，restoreWatch 整套机器一次都不触发。
  const { root, cleanup } = tmpDailymd();
  const { cleanup: cleanupState } = tmpState();
  const w = tmpWatch(WATCH_BEFORE);
  const lines = [];
  try {
    const { runOnce } = await import('../run.mjs');
    const r = await runOnce({
      adapters: [adapterWith(() => {
        writeFileSync(w.file, WATCH_AFTER);   // watch.mjs 早就把水位线推过去了
        return {
          candidates: [dm()], records: [], firstRun: false, noNews: false, authError: null,
          lost: ['会话 李雷(acc-ln)：hap chat messages 失败: ETIMEDOUT'],
        };
      })],
      judge: filedTo(P26, TASK70),
      dailymd: root,
      onLog: (s) => lines.push(String(s)),
    });
    assert.equal(r.filed, 1, '取到的那些照常归位，不许因为别人失败就整批不处理');
    assert.equal(readFileSync(w.file, 'utf-8'), WATCH_BEFORE,
      `有会话没取到数却不回滚水位线 = 那些消息永久消失：${lines.join(' | ')}`);
    assert.ok(lines.some((l) => /没取到数/.test(l)), '要把「哪里没取到」说出来，不许闷着');
  } finally { cleanup(); cleanupState(); w.cleanup(); }
});

test('干净跑完的一轮不许回滚水位线（尤其首轮：回滚了就永远在建基线）', async () => {
  const { root, cleanup } = tmpDailymd();
  const { cleanup: cleanupState } = tmpState();
  const w = tmpWatch();      // 文件不存在 = 还没建过基线
  try {
    const { runOnce } = await import('../run.mjs');
    await runOnce({
      adapters: [adapterWith(() => {
        writeFileSync(w.file, WATCH_AFTER);     // watch.mjs 首轮建基线
        return { candidates: [], records: [], firstRun: true, noNews: false, authError: null };
      })],
      judge: async () => [],
      dailymd: root,
    });
    assert.equal(readFileSync(w.file, 'utf-8'), WATCH_AFTER,
      '首轮建好的基线不许被回滚掉，否则每轮都是首轮、永远收不到消息');
  } finally { cleanup(); cleanupState(); w.cleanup(); }
});

// ---------- ⑨之二 适配器自己的水位线：commit 钩子（只在确认落盘之后才调）----------
//
// ⚠⚠ 邮件适配器（connect/mail.mjs）管两个账号自己的水位线（ms365 的
//   lastReceived/seenIds、网易的 uidValidity/lastUid），跟明道云那条 hap-watch
//   基线是两回事——hap-watch 基线在 watch.mjs 里，被上面 ⑨ 那组测试盯着；
//   适配器自己的水位线现在靠 `got.commit`：runOnce 必须等 `saveAll`
//   （store.saveSegments）真的写盘成功了才调它，没成功就不许调——道理跟 ⑨ 的
//   hap-watch 回滚完全一样，只是这次落点是 store 而不是 watch 基线文件。

test('commit 只有在 saveAll 真的把这一轮写盘成功之后才会被调', async () => {
  const { root, cleanup } = tmpDailymd();
  const { cleanup: cleanupState } = tmpState();
  try {
    const { runOnce } = await import('../run.mjs');
    let committed = 0;
    const r = await runOnce({
      adapters: [adapterWith({
        candidates: [dm()], records: [], firstRun: false, noNews: false, authError: null,
        commit: () => { committed++; },
      })],
      judge: filedTo(P26, TASK70),
      dailymd: root,
    });
    assert.equal(r.filed, 1);
    assert.equal(committed, 1, '这一轮干净落盘了，commit 该被调一次');
  } finally { cleanup(); cleanupState(); }
});

test('落盘失败（saveSegments 抛错）时绝不许调 commit——水位线不能抢跑在落盘前面', async () => {
  const { root, cleanup } = tmpDailymd();
  const { cleanup: cleanupState } = tmpState();
  try {
    const { runOnce } = await import('../run.mjs');
    let committed = 0;
    const r = await runOnce({
      adapters: [adapterWith({
        candidates: [dm()], records: [], firstRun: false, noNews: false, authError: null,
        commit: () => { committed++; },
      })],
      store: {
        segments: () => [],
        saveSegments: () => { throw new Error('磁盘满了'); },
        stateGet: () => undefined,
        stateSet: () => {},
      },
      judge: filedTo(P26, TASK70),
      dailymd: root,
    });
    assert.equal(r.filed, 1, '归位本身是成功的，砸的是存盘那一步');
    assert.equal(committed, 0, '存盘没成功，绝不许调 commit');
  } finally { cleanup(); cleanupState(); }
});

test('适配器没有 commit 字段（比如明道云）：typeof 兜底，行为一个字不变', async () => {
  const { root, cleanup } = tmpDailymd();
  const { cleanup: cleanupState } = tmpState();
  try {
    const { runOnce } = await import('../run.mjs');
    const r = await runOnce({
      adapters: [adapterWith({
        candidates: [dm()], records: [], firstRun: false, noNews: false, authError: null,
      })],
      judge: filedTo(P26, TASK70),
      dailymd: root,
    });
    assert.equal(r.filed, 1, '没有 commit 字段的适配器（明道云）不受这套机制影响');
  } finally { cleanup(); cleanupState(); }
});

// ⚠⚠ 核心断言（用真的 connect/mail.mjs，不是假适配器）：saveSegments 抛错那一轮，
//   邮件水位线必须原地不动；下一轮换回能写盘的 store，同一封邮件要能重新被收到、
//   重新归位——这条链条完全依赖上面三条通用测试之外的东西：mail.mjs 自己怎么
//   构造 commit、run.mjs 怎么调它，两边接得对不对，只有真的把两个模块接在一起跑
//   一遍才测得出来。
test('run.mjs + 真的 connect/mail.mjs：落盘失败时邮件水位线不推进，下一轮同一批还能再收到', async () => {
  const { root, cleanup } = tmpDailymd();
  const { cleanup: cleanupState } = tmpState();
  try {
    const { runOnce } = await import('../run.mjs');
    const realStore = await import('../store.mjs');
    const mail = await import('../connect/mail.mjs');

    realStore.stateSet('mail-seen-work', { lastReceived: '2026-08-08T00:00:00Z', ids: [] });
    realStore.stateSet('mail-seen-corp', { uidValidity: '1', lastUid: '10' });

    const ONE_MAIL = {
      id: 'g1', threadId: 'c1', at: '2026-08-08T03:18:00.000Z', subject: '测试邮件',
      from: { name: '李雷', address: 'lei.li@corp-mail.com' },
      to: [{ name: '', address: 'me@acme.com' }], cc: [], bcc: [],
      text: '不该丢', html: '', attachmentNames: [],
    };
    // ⚠ 故意不管 since/seenIds 参数、每次都原样返回同一封信——真实的 graphFetch
    //   会靠 since/seenIds 自己去重，这里只关心「水位线没推进，mail.pullOne 会不会
    //   拿老的 since 再问一次」，问了几次都返回同一封就够了。
    const mailIo = {
      graphFetch: async () => ({ messages: [ONE_MAIL], lastReceived: ONE_MAIL.at, seenIds: ['g1'] }),
      graphMarkRead: async () => {},
      imapFetch: () => ({ uidValidity: '1', lastUid: '10', baseline: false, messages: [] }),
      imapMarkRead: () => ({ ok: true }),
    };
    const mailAdapter = {
      kind: mail.kind,
      logSubdir: mail.logSubdir,
      describe: mail.describe,
      pull: ({ store }) => mail.pull({ store, io: mailIo }),
    };

    // 第一轮：存盘环节人为砸掉（saveSegments 抛错），模拟「消息聚段了、但落盘半路失败」。
    const boomStore = {
      segments: () => realStore.segments(),
      saveSegments: () => { throw new Error('磁盘满了'); },
      stateGet: (k, d) => realStore.stateGet(k, d),
      stateSet: (k, v) => realStore.stateSet(k, v),
    };
    const r1 = await runOnce({
      adapters: [mailAdapter],
      store: boomStore,
      judge: filedTo(P26, TASK70),
      dailymd: root,
    });
    assert.equal(r1.filed, 1, '归位本身是成功的，砸的是存盘那一步');
    assert.deepEqual(realStore.stateGet('mail-seen-work'),
      { lastReceived: '2026-08-08T00:00:00Z', ids: [] },
      '存盘没成功，邮件水位线不许推进');

    // 第二轮：换回真的能写盘的 store，同一封邮件应该还能再收到（因为水位线没动）。
    const r2 = await runOnce({
      adapters: [mailAdapter],
      store: realStore,
      judge: filedTo(P26, TASK70),
      dailymd: root,
    });
    assert.equal(r2.got, 1, '上一轮没落盘成的那封，这一轮要能再收到');
    assert.equal(r2.filed, 1);
    assert.notDeepEqual(realStore.stateGet('mail-seen-work'),
      { lastReceived: '2026-08-08T00:00:00Z', ids: [] },
      '这一轮真落盘成功了，水位线该推进了');
  } finally { cleanup(); cleanupState(); }
});

// ---------- ⑩ 搁浅的段 ----------

test('收件箱安静时也要把上一轮没归成位的段捞回来', async () => {
  const { root, cleanup } = tmpDailymd();
  const { cleanup: cleanupState } = tmpState();
  try {
    const { runOnce } = await import('../run.mjs');
    const storeMod = await import('../store.mjs');
    // 造一个上一轮归位砸了留下的段：进了 segments.json，但 filed 是空的
    storeMod.saveSegments([{
      id: 'stranded-1', sourceKind: 'mingdao', sourceType: 'user', who: '李雷', whoAccountId: 'a1',
      target: { accountId: 'a1' }, sourceLabel: '明道云 · 私信',
      msgs: [{ id: 'm9', at: '2026-08-08T03:18:00.000Z', text: '上一轮没归成位的 DNSPod 消息' }],
      firstAt: '2026-08-08T03:18:00.000Z', lastAt: '2026-08-08T03:18:00.000Z',
      filed: null, dropped: false, waiting: null,
    }]);

    const r = await runOnce({
      // 这一轮一条新消息都没有
      adapters: [adapterWith({
        candidates: [], records: [], firstRun: false, noNews: true, authError: null,
      })],
      judge: filedTo(P26, TASK70),
      dailymd: root,
    });
    assert.equal(r.segmented, 0, '这一轮没有新段，数字不许虚高');
    assert.equal(r.filed, 1, '搁浅的段要被捞回来归位');
    assert.match(
      readFileSync(join(root, 'projects', P26, 'tasks', TASK70, 'inbox.md'), 'utf-8'),
      /上一轮没归成位/,
    );
    assert.ok(storeMod.segments()[0].filed, '归完位要写回 segments.json');
  } finally { cleanup(); cleanupState(); }
});

// ---------- ⑩之二 判定期间界面上的改动不许被这一轮写盘抹掉 ----------

test('写盘前重读并按段合并：判定期间 小明 在网页上改的落点/丢弃/新拆的段都不许被抹掉', async () => {
  // ⚠⚠ 2026-08-08 评审的 Critical：`segments.json` 是两个进程的整份读-改-写，谁都不加锁。
  //   轮询器在开头读、在最后写，**中间隔着最长 180 秒的 claude 判定**。那 1~3 分钟里
  //   小明 在网页上改落点 / 丢弃 / 拆段，全部会被轮询器那次整份覆盖抹掉，一句日志都没有；
  //   而 moveSegment 已经真把 inbox.md 里那块搬到新任务了 —— 索引说 T70、文件在 T88，
  //   下一轮有新消息还会照旧落点再写一份。前端 45 秒重拉，他会看到自己刚改的东西自己变回去。
  const { root, cleanup } = tmpDailymd();
  const { cleanup: cleanupState } = tmpState();
  const lines = [];
  try {
    const { runOnce } = await import('../run.mjs');
    const clone = (x) => JSON.parse(JSON.stringify(x));
    const at0 = '2026-08-08T03:00:00.000Z';

    // 盘上已有的一段：上一轮归到了 P26/T70
    const disk = [{
      id: 'seg-feng', sourceKind: 'mingdao', sourceType: 'user', who: '李雷', whoAccountId: 'a1',
      target: { accountId: 'a1' }, sourceLabel: '明道云 · 私信',
      msgs: [{ id: 'm1', at: at0, text: '上一轮那条' }],
      firstAt: at0, lastAt: at0,
      filed: {
        project: P26, task: TASK70, reason: '上一轮判的', by: 'auto',
        sure: true, createdTask: false, at: at0,
      },
      dropped: false, waiting: null,
    }];
    const store = {
      segments: () => clone(disk),
      saveSegments: (l) => { disk.length = 0; disk.push(...clone(l)); },
      stateGet: () => undefined,
      stateSet: () => {},
    };

    // judge 跑的那一刻 = 轮询器「已经读完、还没写盘」的那个窗口。
    // 在这儿模拟 小明 在网页上的三个动作，全都直接写盘（server.mjs 就是这么干的）。
    const judge = async () => {
      const cur = clone(disk);
      const feng = cur.find((s) => s.id === 'seg-feng');
      feng.filed = {
        project: P12, task: TASK88, reason: '你在归位台上改的落点', by: 'me',
        sure: true, createdTask: false, at: '2026-08-08T03:02:00.000Z',
      };
      cur.push({                      // 他顺手拆出来的一段
        id: 'seg-feng-s1', sourceKind: 'mingdao', sourceType: 'user', who: '李雷',
        whoAccountId: 'a1', target: { accountId: 'a1' }, sourceLabel: '明道云 · 私信',
        msgs: [{ id: 'm0', at: at0, text: '手动拆出去的那条' }],
        firstAt: at0, lastAt: at0,
        filed: {
          project: P12, task: TASK88, reason: '你在归位台上手动拆的', by: 'me',
          sure: true, createdTask: false, at: at0,
        },
        dropped: false, waiting: null,
      });
      store.saveSegments(cur);
      return [{ segIndex: 0, project: P26, task: TASK70, reason: '新段的判定', sure: true, waiting: null }];
    };

    await runOnce({
      adapters: [adapterWith({
        candidates: [
          // ① 续在 seg-feng 那条线上的新消息（走「已归位就按原落点重写」那条捷径，不进判定）
          {
            sourceKind: 'mingdao', kind: 'user', who: '李雷', whoAccountId: 'a1',
            target: { accountId: 'a1' },
            msgs: [{ id: 'm2', at: '2026-08-08T03:10:00.000Z', text: '这一轮新收的那条' }],
          },
          // ② 另一个人的新段，用它把 judge 拉起来（判定窗口就是靠它撑开的）
          {
            sourceKind: 'mingdao', kind: 'user', who: '李雷', whoAccountId: 'a2',
            target: { accountId: 'a2' },
            msgs: [{ id: 'm3', at: '2026-08-08T03:11:00.000Z', text: '另一条线' }],
          },
        ],
        records: [], firstRun: false, noNews: false, authError: null,
      })],
      judge,
      store,
      dailymd: root,
      onLog: (s) => lines.push(String(s)),
    });

    const feng = disk.find((s) => s.id === 'seg-feng');
    assert.ok(feng, 'seg-feng 不许消失');
    assert.equal(feng.filed.task, TASK88,
      `小明 改的落点被这一轮写盘抹回去了（成了 ${feng.filed.task}）——`
      + `他会看到自己刚改的东西自己变回来：${lines.join(' | ')}`);
    assert.equal(feng.filed.by, 'me', '「人定的」这件事也不许被覆盖成 auto');
    assert.equal(feng.msgs.length, 2, '这一轮新收的消息还是要留在段里，不能为了保人改的就丢消息');

    assert.ok(disk.find((s) => s.id === 'seg-feng-s1'),
      '判定期间他手动拆出来的那一段被整份覆盖掉了 —— inbox.md 里有、索引里没有');
    assert.ok(disk.find((s) => s.filed && s.filed.reason === '新段的判定'),
      '这一轮自己归的位也要在');
    assert.ok(lines.some((l) => /界面/.test(l)), '发现界面上改过要说一声，别闷着合并');
  } finally { cleanup(); cleanupState(); }
});

test('合并的基准是「轮前快照」不是「本轮这份」：本轮自己判出来的丢弃不许被静默撤销', async () => {
  // ⚠⚠ 复审逮到的：判「这一栏人有没有改过」时拿盘上跟**本轮**比是错的基准 ——
  //   只要盘上这一段因为**任何**原因变过，循环就会把所有有差异的 HUMAN_FIELD 从盘上抄回来，
  //   **包括人根本没碰、而是本轮刚判出来的那一栏**。这里的例子：小明 只是把「等我回」销了账，
  //   本轮判定把这一段丢弃了，结果 dropped/droppedAt 被盘上那份（还是 false）抄回去 ——
  //   本轮的丢弃决定被静默撤销。正确的基准只有一个：**盘上 ≠ 轮前**才叫「人改过」。
  const { root, cleanup } = tmpDailymd();
  const { cleanup: cleanupState } = tmpState();
  const lines = [];
  try {
    const { runOnce } = await import('../run.mjs');
    const clone = (x) => JSON.parse(JSON.stringify(x));
    const at0 = '2026-08-08T03:00:00.000Z';
    const disk = [{
      id: 'seg-feng', sourceKind: 'mingdao', sourceType: 'user', who: '李雷', whoAccountId: 'a1',
      target: { accountId: 'a1' }, sourceLabel: '明道云 · 私信',
      msgs: [{ id: 'm1', at: at0, text: '上一轮没归成位的那条' }],
      firstAt: at0, lastAt: at0,
      filed: null, dropped: false,                       // 搁浅的段，这一轮会被捞回来判
      waiting: { since: at0, what: '他等英文版定稿没', resolvedAt: null },
    }];
    const store = {
      segments: () => clone(disk),
      saveSegments: (l) => { disk.length = 0; disk.push(...clone(l)); },
      stateGet: () => undefined,
      stateSet: () => {},
    };

    await runOnce({
      adapters: [adapterWith({
        candidates: [], records: [], firstRun: false, noNews: true, authError: null,
      })],
      // 判定窗口里 小明 只做了一件事：把「等我回」销账（/api/waiting/resolve）
      judge: async () => {
        const cur = clone(disk);
        cur[0].waiting.resolvedAt = '2026-08-08T03:02:00.000Z';
        store.saveSegments(cur);
        return [{ segIndex: 0, drop: true, reason: '群里刷屏', sure: true }];
      },
      store,
      dailymd: root,
      onLog: (s) => lines.push(String(s)),
    });

    const s = disk.find((x) => x.id === 'seg-feng');
    assert.equal(s.dropped, true,
      `本轮判出来的丢弃被盘上那份抄回去撤销了：${lines.join(' | ')}`);
    assert.ok(s.droppedAt, 'droppedAt 一起被撤销的话，「刚归位」那一屏按天筛就漏掉这条');
    assert.equal(s.waiting.resolvedAt, '2026-08-08T03:02:00.000Z',
      '人真的改过的那一栏照旧以人为准');
  } finally { cleanup(); cleanupState(); }
});

test('人在判定窗口里划掉的几条消息，不许被这一轮悄悄加回来（本轮新到的仍要进得来）', async () => {
  // ⚠⚠ 复审逮到的第二条：`POST /api/drop` 带 msgIds 时改的是 seg.msgs/firstAt/lastAt，
  //   而合并对 msgs 一律「以本轮为准」→ 他划掉的那几条会被原样加回来，
  //   而且 say() 只在 HUMAN_FIELDS 变化时才响，**一句日志都没有**。
  //   从他的角度：划掉几条、几分钟后自己回来了、没有任何解释 —— 这比丢消息还伤信任。
  const { root, cleanup } = tmpDailymd();
  const { cleanup: cleanupState } = tmpState();
  const lines = [];
  try {
    const { runOnce } = await import('../run.mjs');
    const clone = (x) => JSON.parse(JSON.stringify(x));
    const t = (m) => `2026-08-08T03:0${m}:00.000Z`;
    const disk = [{
      id: 'seg-feng', sourceKind: 'mingdao', sourceType: 'user', who: '李雷', whoAccountId: 'a1',
      target: { accountId: 'a1' }, sourceLabel: '明道云 · 私信',
      msgs: [
        { id: 'm1', at: t(0), text: '第一条' },
        { id: 'm2', at: t(1), text: '划掉我' },
        { id: 'm3', at: t(2), text: '第三条' },
      ],
      firstAt: t(0), lastAt: t(2),
      filed: {
        project: P26, task: TASK70, reason: '上一轮判的', by: 'auto',
        sure: true, createdTask: false, at: t(0),
      },
      dropped: false, waiting: null,
    }];
    const store = {
      segments: () => clone(disk),
      saveSegments: (l) => { disk.length = 0; disk.push(...clone(l)); },
      stateGet: () => undefined,
      stateSet: () => {},
    };

    await runOnce({
      adapters: [adapterWith({
        candidates: [
          // 这一轮真到了第 4 条，续在同一条线上
          {
            sourceKind: 'mingdao', kind: 'user', who: '李雷', whoAccountId: 'a1',
            target: { accountId: 'a1' },
            msgs: [{ id: 'm4', at: t(9), text: '这一轮新到的第四条' }],
          },
          // 另一条线，用来把 judge 拉起来撑开判定窗口
          {
            sourceKind: 'mingdao', kind: 'user', who: '李雷', whoAccountId: 'a2',
            target: { accountId: 'a2' },
            msgs: [{ id: 'x1', at: t(9), text: '别的事' }],
          },
        ],
        records: [], firstRun: false, noNews: false, authError: null,
      })],
      judge: async () => {
        // 判定窗口里 小明 在网页上划掉了第 2 条（POST /api/drop 带 msgIds）
        const cur = clone(disk);
        const s = cur.find((x) => x.id === 'seg-feng');
        s.msgs = s.msgs.filter((m) => m.id !== 'm2');
        s.firstAt = s.msgs[0].at;
        s.lastAt = s.msgs[s.msgs.length - 1].at;
        store.saveSegments(cur);
        return [{ segIndex: 0, project: P26, task: TASK70, reason: '另一条线', sure: true, waiting: null }];
      },
      store,
      dailymd: root,
      onLog: (s) => lines.push(String(s)),
    });

    const ids = disk.find((x) => x.id === 'seg-feng').msgs.map((m) => m.id);
    assert.ok(!ids.includes('m2'),
      `他划掉的那条自己回来了（现在是 ${ids.join(',')}）：${lines.join(' | ')}`);
    assert.ok(ids.includes('m4'),
      `为了保住「删过的」把这一轮真到的新消息也挡在外面了（现在是 ${ids.join(',')}）`);
    assert.deepEqual(ids, ['m1', 'm3', 'm4']);
    const s = disk.find((x) => x.id === 'seg-feng');
    assert.equal(s.lastAt, t(9), 'lastAt 要跟着剩下的消息走');
    assert.ok(lines.some((l) => /划掉|删/.test(l)),
      `合并时动过消息一定要说一声，否则这件事在日志里查不到：${lines.join(' | ')}`);
  } finally { cleanup(); cleanupState(); }
});

test('没人动过的时候不许瞎合并：盘上跟轮前一模一样，就按这一轮这份写', async () => {
  const { root, cleanup } = tmpDailymd();
  const { cleanup: cleanupState } = tmpState();
  try {
    const { runOnce } = await import('../run.mjs');
    const storeMod = await import('../store.mjs');
    await runOnce({
      adapters: [adapterWith({
        candidates: [dm()], records: [], firstRun: false, noNews: false, authError: null,
      })],
      judge: filedTo(P26, TASK70),
      dailymd: root,
    });
    const segs = storeMod.segments();
    assert.equal(segs.length, 1);
    assert.equal(segs[0].filed.task, TASK70, '这一轮判的落点要照常写进去');
    assert.equal(segs[0].msgs.length, 2);
  } finally { cleanup(); cleanupState(); }
});

// ---------- ⑪ 真 IO 护栏 ----------

test('测试里忘了注入 judge 就当场抛错，不许真去跑 claude（那是花钱的）', async () => {
  const { askClaude } = await import('../file.mjs');
  await assert.rejects(() => askClaude('随便什么提示词'), /测试里不许真跑/);
});

test('测试里忘了注入适配器就当场抛错，不许真打 hap CLI', async () => {
  const { hap } = await import('../lib.mjs');
  assert.throws(() => hap(['chat', 'list']), /测试里不许真跑/);
});

// ---------- ⑫ 错误不许被吞 ----------

test('取数抛错要带上下文 log 出来，不许 catch {} 吞掉', async () => {
  const { root, cleanup } = tmpDailymd();
  const { cleanup: cleanupState } = tmpState();
  const lines = [];
  try {
    const { runOnce } = await import('../run.mjs');
    const boom = {
      kind: 'mingdao',
      pull: () => { throw new Error('watch.mjs 没跑起来'); },
      describe: () => '明道云 · 私信',
    };
    const r = await runOnce({
      adapters: [boom, adapterWith({
        candidates: [dm()], records: [], firstRun: false, noNews: false, authError: null,
      })],
      judge: filedTo(P26, TASK70),
      dailymd: root,
      onLog: (s) => lines.push(String(s)),
    });
    assert.ok(lines.some((l) => /watch\.mjs 没跑起来/.test(l)),
      '错误原文要出现在日志里——「轮询失败」四个字盖掉一切正是那两天丢消息的根因');
    assert.ok(lines.some((l) => /mingdao/.test(l)), '日志要带上是哪个来源出的问题');
    assert.equal(r.filed, 1, '一个来源砸了不许拖垮另一个来源');
  } finally { cleanup(); cleanupState(); }
});

// ---------- ⑬ 交给对话判定（deferJudge）----------
//
// 旧版本这儿是「屏蔽规则」那一组测试，跟 mute.mjs 一起在 2026-08-09 砍掉了。
// 换上来的是新模型的那条岔路：收完不当场判，把段交回给调用方（对话里的 Claude）。

test('deferJudge：收完就停，段照样落盘且 filed 为空——会话断了下一轮捞得回来', async () => {
  const { root, cleanup } = tmpDailymd();
  const { cleanup: cleanupState } = tmpState();
  try {
    const { runOnce } = await import('../run.mjs');
    const store = await import('../store.mjs');
    const r = await runOnce({
      dailymd: root,
      store,
      deferJudge: true,
      adapters: [adapterWith({ candidates: [dm()] })],
      tree: [],
    });
    assert.equal(r.pending.length, 1, '要判的段原样交回给调用方');
    const saved = store.segments();
    assert.equal(saved.length, 1, '段必须已经落盘——先存再返回，中间出岔子也不丢消息');
    assert.ok(!saved[0].filed, '还没判，filed 必须是空的');
    assert.ok(!saved[0].dropped);
  } finally { cleanup(); cleanupState(); }
});

test('deferJudge 停下来的段，下一轮当「搁浅」捞回来重判', async () => {
  const { root, cleanup } = tmpDailymd();
  const { cleanup: cleanupState } = tmpState();
  try {
    const { runOnce } = await import('../run.mjs');
    const store = await import('../store.mjs');
    await runOnce({
      dailymd: root, store, deferJudge: true, tree: [],
      adapters: [adapterWith({ candidates: [dm()] })],
    });
    // 第二轮：一条新消息都没有，但上一轮那个段还搁浅着，必须被捞回来。
    const r2 = await runOnce({
      dailymd: root, store, deferJudge: true, tree: [],
      adapters: [adapterWith({ candidates: [], noNews: true })],
    });
    assert.equal(r2.pending.length, 1, '搁浅的段要被捞回来，不许永远没人管');
  } finally { cleanup(); cleanupState(); }
});

// ⚠⚠ 2026-08-13 事故：那一轮既有新段又有搁浅段，pending 是 `[...新段, ...搁浅段]` 排的，
//   而 fileNow 那边照 segments.json 的存放顺序数 → segIndex 整体错位，判定落到别的段身上
//   （周婷的产品反馈判进了 P11，韩梅的任务回复判进了一封 LinkedIn 广告的落点）。
//   两边必须是同一个顺序，这条测试就是钉这件事。
test('deferJudge：新段和搁浅段混在一轮时，pending 的顺序要跟 fileNow 数的顺序一致', async () => {
  const { root, cleanup } = tmpDailymd();
  const { cleanup: cleanupState } = tmpState();
  try {
    const { runOnce } = await import('../run.mjs');
    const store = await import('../store.mjs');
    // 第一轮：李雷那段落盘、没判，搁浅着。
    await runOnce({
      dailymd: root, store, deferJudge: true, tree: [],
      adapters: [adapterWith({ candidates: [dm()] })],
    });
    // 第二轮：来了一条别人的新消息，于是这一轮是「新段 + 搁浅段」混着。
    const fresh = {
      sourceKind: 'mingdao', kind: 'user', who: '周婷', whoAccountId: 'b2',
      target: { accountId: 'b2' },
      msgs: [{ id: 'n1', at: '2026-08-09T03:18:00.000Z', text: '海报我发你了' }],
    };
    const r2 = await runOnce({
      dailymd: root, store, deferJudge: true, tree: [],
      adapters: [adapterWith({ candidates: [fresh] })],
    });
    assert.equal(r2.pending.length, 2, '两段都得等着判落点');
    // fileNow 那边就是这么数的：存放顺序里 filed/dropped 都为空的那些。
    const asFileNowCounts = store.segments().filter((s) => s && !s.filed && !s.dropped);
    assert.deepEqual(
      r2.pending.map((s) => s.id),
      asFileNowCounts.map((s) => s.id),
      'pending 的顺序必须跟 fileNow 数 segIndex 的顺序一模一样，错位就等于判定落到别的段身上',
    );
    assert.equal(r2.pending[0].who, '李雷', '搁浅的老段在前（它先落的盘）');
  } finally { cleanup(); cleanupState(); }
});

test('deferJudge 时一次 claude 都不许调（判定的人在对话里，不该另起进程）', async () => {
  const { root, cleanup } = tmpDailymd();
  const { cleanup: cleanupState } = tmpState();
  try {
    const { runOnce } = await import('../run.mjs');
    // ⚠ 不注入 judge。真去调 claude 的话 assertNoRealIO 会当场抛错（那是花钱的），
    //   跑得完就证明这条路上压根没碰判定。
    const r = await runOnce({
      dailymd: root, deferJudge: true, tree: [],
      adapters: [adapterWith({ candidates: [dm()] })],
    });
    assert.equal(r.pending.length, 1);
  } finally { cleanup(); cleanupState(); }
});

test('fileNow：把判定文本走原管线写盘，任务号查不到就降级 P00-misc（不许照幻觉建目录）', async () => {
  const { root, cleanup } = tmpDailymd();
  const { cleanup: cleanupState } = tmpState();
  try {
    const { runOnce, fileNow } = await import('../run.mjs');
    const store = await import('../store.mjs');
    await runOnce({
      dailymd: root, store, deferJudge: true, tree: [],
      adapters: [adapterWith({ candidates: [dm()] })],
    });
    const verdict = JSON.stringify([{
      segIndex: 0, project: 'P99-并不存在', task: 'T99-2026-01-01-也不存在',
      newTaskSlug: null, drop: false, reason: '故意给个查不到的', sure: true,
      waiting: null, split: null,
    }]);
    const r = await fileNow(verdict, { dailymd: root, store, tree: [] });
    assert.equal(r.todo, 1);
    assert.equal(r.filed, 0, '查不到的任务号不许当成归位成功');
    assert.equal(r.unsure, 1, '要降级成「拿不准」，不是丢掉');
    assert.ok(!existsSync(join(root, 'projects/P99-并不存在')),
      '⚠⚠ 绝不许照着一个不存在的路径 mkdir——那会造出 小明 永远找不到的目录');
  } finally { cleanup(); cleanupState(); }
});

test('⚠ fileNow：判定有效时必须真归位成功（不是「反正都降级」）', async () => {
  // ⚠⚠ 这条是 2026-08-09 真机第一条消息撞出来的 bug 换来的：fileNow 原本把判定
  //   **原文**丢给 judge，而 judge 的契约是返回**解析好的数组**（askClaude 最后一行
  //   就是 parseVerdicts）。结果每一批都「不是数组 → 整批兜到 P00-misc」，
  //   归位功能全废，还不报错，只在日志里留一行。
  //   上面那条「任务号查不到就降级」抓不到它 —— 两种情况的结果都是 unsure=1。
  //   所以必须有一条盯着**成功路径**：给一个真实存在的落点，就得真落进那个任务的 inbox.md。
  const { root, cleanup } = tmpDailymd();
  const { cleanup: cleanupState } = tmpState();
  try {
    const { runOnce, fileNow } = await import('../run.mjs');
    const store = await import('../store.mjs');
    await runOnce({
      dailymd: root, store, deferJudge: true, tree: [],
      adapters: [adapterWith({ candidates: [dm()] })],
    });
    const verdict = JSON.stringify([{
      segIndex: 0, project: P26, task: TASK70,
      newTaskSlug: null, drop: false, reason: '测试写死的判定', sure: true,
      waiting: null, split: null,
    }]);
    const r = await fileNow(verdict, { dailymd: root, store, tree: [] });
    assert.equal(r.filed, 1, '判定是有效的，就必须真归位成功');
    assert.equal(r.unsure, 0);
    const md = readFileSync(join(root, 'projects', P26, 'tasks', TASK70, 'inbox.md'), 'utf-8');
    assert.match(md, /DNSPod/, '消息要真写进那个任务的 inbox.md');
  } finally { cleanup(); cleanupState(); }
});

test('⚠ fileNow：判定外面裹着客套话/```json 也要解析得出来（模型常这么答）', async () => {
  const { root, cleanup } = tmpDailymd();
  const { cleanup: cleanupState } = tmpState();
  try {
    const { runOnce, fileNow } = await import('../run.mjs');
    const store = await import('../store.mjs');
    await runOnce({
      dailymd: root, store, deferJudge: true, tree: [],
      adapters: [adapterWith({ candidates: [dm()] })],
    });
    const verdict = '好的，这条我判到 [m1] 那个任务：\n```json\n' + JSON.stringify([{
      segIndex: 0, project: P26, task: TASK70, newTaskSlug: null, drop: false,
      reason: '裹着客套话', sure: true, waiting: null, split: null,
    }]) + '\n```\n以上。';
    const r = await fileNow(verdict, { dailymd: root, store, tree: [] });
    assert.equal(r.filed, 1, '前言里的 [m1] 不许把解析打穿');
  } finally { cleanup(); cleanupState(); }
});

// ---- 屏蔽规则 ----
// ⚠ 这层 2026-08-09 砍过一次又在 2026-08-10 按最小形态重建。测试盯住两件事：
//   带 kind 的规则不许溢出去吞同事的私信；mute.json 坏了不许把整轮收消息带崩。

test('屏蔽：notice 规则命中播报，同样的字眼出现在私信里不许被吞', async () => {
  const { __muteTest } = await import('../run.mjs');
  const notice = {
    kind: 'notice', who: '工作流', channel: '工作流通知',
    msgs: [{ id: 'n1', at: '2026-08-10T03:51:00.000Z', text: '短信模板审核 “【明道云】…未通过”' }],
  };
  const rules = [{ pattern: '短信模板审核', kind: 'notice', why: '播报' }];
  assert.equal(__muteTest.muteHit(notice, rules), '播报');
  const pm = { ...dm([{ id: 'm1', at: '2026-08-10T03:51:00.000Z', text: '短信模板审核那事你看了吗' }]) };
  assert.equal(__muteTest.muteHit(pm, rules), null, '真人私信提到同样的字眼不许被静默吞掉');
});

test('屏蔽：坏正则只废掉那一条规则，没有规则时谁都不挡', async () => {
  const { __muteTest } = await import('../run.mjs');
  const notice = { kind: 'notice', who: '工作流', msgs: [{ id: 'n1', text: '短信模板审核 未通过' }] };
  assert.equal(__muteTest.muteHit(notice, []), null);
  assert.equal(
    __muteTest.muteHit(notice, [{ pattern: '(((', why: '坏的' }, { pattern: '短信模板审核', why: '好的' }]),
    '好的',
  );
});

test('屏蔽：整轮跑下来，mute.json 里的播报根本不进段（不是判完再丢）', async () => {
  const { root, cleanup } = tmpDailymd();
  const { dir: stateDir, cleanup: cleanupState } = tmpState();
  const { cleanup: cleanupWatch } = tmpWatch();
  // 规则住在状态目录，所以这条测试自己写一份——不再依赖本机那份个人屏蔽表
  writeFileSync(join(stateDir, 'mute.json'),
    JSON.stringify([{ pattern: '构建完成播报', kind: 'notice', why: '播报' }]));
  try {
    const { runOnce } = await import('../run.mjs');
    const store = await import('../store.mjs');
    const notice = {
      sourceKind: 'mingdao', kind: 'notice', who: '工作流', channel: '工作流通知',
      noticeCategory: 'workflow', target: {}, msgs: [
        { id: 'n1', at: '2026-08-10T03:51:00.000Z', text: '构建完成播报：镜像 v1.2.3 已发布' },
      ],
    };
    const out = await runOnce({
      dailymd: root, store, deferJudge: true, tree: [],
      adapters: [adapterWith({ candidates: [notice, dm()] })],
    });
    assert.equal(out.pending.length, 1, '播报要被挡在聚段之前，只剩私信那一段');
    assert.match(JSON.stringify(out.pending), /DNSPod/);
    assert.doesNotMatch(JSON.stringify(out.pending), /构建完成播报/);
  } finally { cleanup(); cleanupState(); cleanupWatch(); }
});

// ---------- 邮件账号掉线不许拖垮明道云那一路 ----------
//
// ⚠⚠ 2026-08-10 评审实跑：ms365 令牌没引导过、网易授权码没进钥匙串（合并当天两台 Mac
//   都是这个状态），邮件适配器每一轮都稳定报认证失败，老代码一律整轮早退——已经收到的
//   明道云私信既不归档也不入段，命令行给的修复动作还写死成「跑 hap auth login」。

// 一条邮件候选（形状对齐 mail/normalize.mjs 的 toCandidate 产物，只留聚段要用的字段）。
function mailCand() {
  return {
    sourceKind: 'mail', kind: 'mail', account: 'corp', who: '匿名',
    whoAddress: 'anonymous@corp-mail.com',
    external: false,
    target: {
      account: 'corp', external: false, whoAddress: 'anonymous@corp-mail.com',
      messageId: '10241', threadId: 'thread-9', subject: '对账',
      from: 'anonymous@corp-mail.com', to: ['me@corp-mail.com'], cc: [], replyTo: [],
    },
    msgs: [{ id: 'mail-mingdao-10241', at: '2026-08-08T03:18:30.000Z', text: '主题：对账\n\n数我发你了' }],
  };
}

test('邮件账号掉线：明道云的消息照常归档并入段，修复动作指向邮件那边', async () => {
  const { root, cleanup } = tmpDailymd();
  const { cleanup: cleanupState } = tmpState();
  const w = tmpWatch(WATCH_BEFORE);
  const lines = [];
  let committed = 0;
  try {
    const { runOnce } = await import('../run.mjs');
    const store = await import('../store.mjs');
    const hapAdapter = adapterWith(() => {
      writeFileSync(w.file, WATCH_AFTER);       // watch.mjs 收成功就把水位线推过去了
      return {
        candidates: [dm()],
        records: [{
          id: 'm1', ts: '2026-08-08 11:18:00.000', dir: 'in', kind: 'user',
          peer: '李雷', peerId: 'a1', text: 'SVCB 那两条得走 API',
        }],
        firstRun: false, noNews: false, authError: null,
      };
    });
    // 邮件适配器：一个账号掉线（authError），另一个账号照收（candidates 里有它的信）。
    // commit 里只有健康账号的水位线——那是 connect/mail.mjs 的契约，
    // test/mail-adapter.test.mjs 有一条专门钉着。
    const mailAdapter = {
      kind: 'mail',
      logSubdir: 'assets/mail-log',
      describe: () => '邮件 · corp',
      pull: () => ({
        candidates: [mailCand()],
        records: [{
          id: 'mail-mingdao-10241', ts: '2026-08-08T03:18:30.000Z', dir: 'in', kind: 'mail',
          peer: '李雷', peerId: 'lei.li@corp-mail.com', text: '数我发你了',
        }],
        firstRun: false,
        noNews: false,
        authError: 'work：refresh 令牌失效，请重新引导',
        commit: () => { committed++; },
      }),
    };

    const r = await runOnce({
      adapters: [mailAdapter, hapAdapter],     // 掉线那个排在前面，早退的话后面一个都收不到
      judge: async () => [],
      dailymd: root,
      deferJudge: true,
      onLog: (s) => lines.push(String(s)),
    });

    assert.ok(r.authError, '认证失败要如实报上去');
    assert.deepEqual(r.authErrors.map((a) => a.kind), ['mail'], '要说清是哪个来源挂的');
    assert.equal(r.got, 2, '两个来源的候选都要收下（邮件那个账号是健康的）');
    assert.equal(r.pending.length, 2, '两段都得等着判落点');
    assert.equal(store.segments().length, 2, '明道云的消息必须入段——这正是老代码丢掉的');
    assert.ok(existsSync(join(root, 'assets/hap-log/2026-08.jsonl')), '明道云的消息必须归档');
    assert.ok(existsSync(join(root, 'assets/mail-log/2026-08.jsonl')), '健康账号的邮件也要归档');
    assert.equal(committed, 1, '落盘成功了就该提交水位线（掉线那个账号本来就不在 commit 里）');
    assert.equal(readFileSync(w.file, 'utf-8'), WATCH_AFTER,
      '邮件掉线不许回滚明道云的水位线——凭据缺失是稳定状态，回滚就是每轮原地打转');

    const log = lines.join(' | ');
    assert.match(log, /mail-bootstrap/, '修复动作要指向邮件那边');
    assert.doesNotMatch(log, /hap auth login/, '别再让 小明 去跑一个跟这事无关、跑了也修不好的动作');
  } finally { cleanup(); cleanupState(); w.cleanup(); }
});

test('明道云自己 401：整轮停下，行为跟改动前一模一样', async () => {
  const { root, cleanup } = tmpDailymd();
  const { cleanup: cleanupState } = tmpState();
  const lines = [];
  try {
    const { runOnce } = await import('../run.mjs');
    const store = await import('../store.mjs');
    let mailPulled = 0;
    const mailAdapter = {
      kind: 'mail',
      logSubdir: 'assets/mail-log',
      describe: () => '邮件 · corp',
      pull: () => {
        mailPulled++;
        return {
          candidates: [mailCand()], records: [], firstRun: false, noNews: false, authError: null,
        };
      },
    };
    const r = await runOnce({
      adapters: [adapterWith({
        candidates: [dm()],
        records: [{
          id: 'm1', ts: '2026-08-08 11:18:00.000', dir: 'in', kind: 'user',
          peer: '李雷', peerId: 'a1', text: '不该被归档',
        }],
        firstRun: false, noNews: false, authError: 'token is missing, invalid, or expired',
      }), mailAdapter],
      judge: async () => [],
      dailymd: root,
      deferJudge: true,
      onLog: (s) => lines.push(String(s)),
    });

    assert.match(String(r.authError), /token/i);
    assert.deepEqual(r.authErrors.map((a) => a.kind), ['mingdao']);
    assert.equal(r.got, 0, '明道云掉线 = 整轮一条都不处理，字面意思');
    assert.deepEqual(store.segments(), [], '一条都不许入段');
    assert.equal(existsSync(join(root, 'assets/hap-log')), false, '连归档都不许写');
    assert.equal(mailPulled, 0, '明道云掉线就地停住，后面的来源根本不该被拉');
    assert.ok(lines.some((l) => /hap auth login/.test(l)),
      '铁律：明道云掉线只有一条路——喊 小明 自己登录，不许换通道兜底');
  } finally { cleanup(); cleanupState(); }
});

// ---------- bin/fetch.mjs 的话术分来源 ----------

test('authAdvice：hap 掉线 → 停这一轮，喊 hap auth login', async () => {
  const { authAdvice } = await import('../bin/fetch.mjs');
  const r = authAdvice([{ kind: 'mingdao', message: 'token is missing, invalid, or expired' }]);
  assert.equal(r.stop, true, '明道云掉线这一轮真的一条都没处理，必须停');
  assert.match(r.lines.join('\n'), /hap auth login/);
});

test('authAdvice：只有邮件掉线 → 不停这一轮，话术指向邮件的修复动作', async () => {
  const { authAdvice } = await import('../bin/fetch.mjs');
  const r = authAdvice([{ kind: 'mail', message: 'work：refresh 令牌失效' }]);
  assert.equal(r.stop, false, '别的来源已经照常收了，不能把这一轮报成「一条都没处理」');
  const text = r.lines.join('\n');
  assert.match(text, /mail-bootstrap/);
  assert.doesNotMatch(text, /hap auth login/, '指一个修不好的动作比不指还糟');
});

test('authAdvice：网易那个账号掉线 → 话术是补钥匙串授权码，不是 mail-bootstrap', async () => {
  const { authAdvice } = await import('../bin/fetch.mjs');
  const r = authAdvice([{ kind: 'mail', message: 'mingdao：登录被拒，授权码可能过期' }]);
  assert.equal(r.stop, false);
  assert.match(r.lines.join('\n'), /授权码/);
});

test('authAdvice：没有认证失败就一句话都不说', async () => {
  const { authAdvice } = await import('../bin/fetch.mjs');
  assert.deepEqual(authAdvice([]), { stop: false, lines: [] });
});

// ---------- bin/fetch.mjs 每轮兜底汇报（buildOutboxReport）----------
//
// ⚠⚠ 这是「发信总账」任务 6 的核心：即时通知（send.mjs 打的「去 SendMessage
//   戴一下」）靠模型自觉，这一段是它漏掉时的网，必须由脚本自己打。三条钉住：
//   水位线之后才报、自己发的不报、一条都没有就一个字不打。

test('buildOutboxReport：水位线之后的才报，之前的不报', async () => {
  const { buildOutboxReport } = await import('../bin/fetch.mjs');
  const rows = [
    { at: '2026-08-12 09:00:00', sessionId: 'other', to: '老账户', text: '早的那条' },
    { at: '2026-08-12 11:00:00', sessionId: 'other', to: '新账户', text: '新的那条' },
  ];
  const { lines, lastAt } = buildOutboxReport({ rows, since: '2026-08-12 10:00:00', sessionId: 'me' });
  const text = lines.join('\n');
  assert.match(text, /新账户/, '水位线之后的那条要报');
  assert.doesNotMatch(text, /老账户/, '水位线之前的那条不该出现');
  assert.equal(lastAt, '2026-08-12 11:00:00', '水位线要推到报出去的最后一条');
});

test('buildOutboxReport：自己发的不报，别人发的报', async () => {
  const { buildOutboxReport } = await import('../bin/fetch.mjs');
  const rows = [
    { at: '2026-08-12 11:00:00', sessionId: 'me', to: '自己发的', text: '这条是我自己发的' },
    { at: '2026-08-12 11:05:00', sessionId: 'other', to: '别人发的', text: '这条是别人发的' },
  ];
  const { lines } = buildOutboxReport({ rows, since: '', sessionId: 'me' });
  const text = lines.join('\n');
  assert.doesNotMatch(text, /自己发的/, '自己这个会话发的再报一遍是噪音');
  assert.match(text, /别人发的/, '别的会话发的必须报出来');
});

test('buildOutboxReport：一条都没有就一个字都不打', async () => {
  const { buildOutboxReport } = await import('../bin/fetch.mjs');
  assert.deepEqual(buildOutboxReport({ rows: [], since: '', sessionId: 'me' }), { lines: [], lastAt: null });
  // 全被水位线或者「自己发的」过滤掉，结果也必须是空数组，不能打印空标题行。
  const rows = [{ at: '2026-08-12 08:00:00', sessionId: 'me', to: 'x', text: 'x' }];
  assert.deepEqual(buildOutboxReport({ rows, since: '2026-08-12 09:00:00', sessionId: 'me' }),
    { lines: [], lastAt: null });
});

test('buildOutboxReport：草稿和失败绝不许报成「已经发出去了」', async () => {
  // 报告里会带上本人的称呼，那来自配置——所以这条也要有自己的状态目录
  const st = tmpState();
  const { buildOutboxReport } = await import('../bin/fetch.mjs');
  // ⚠⚠ 2026-08-13 修的 Critical：这个函数当时压根不看 result，标题却写「发出去了 N 条」。
  //   外部客户邮件走的是**只存草稿**的物理门，一个字都没到对方那儿——报成已发，
  //   小明 会以为客户收到了，那封信就永远躺在草稿箱里没人管。
  const rows = [
    { at: '2026-08-12 11:00:00', sessionId: 'other', to: '客户甲', text: '报价见附件', result: 'draft' },
    { at: '2026-08-12 11:01:00', sessionId: 'other', to: '同事乙', text: '收到', result: 'sent' },
    { at: '2026-08-12 11:02:00', sessionId: 'other', to: '同事丙', text: '', result: 'failed' },
  ];
  const { lines } = buildOutboxReport({ rows, since: '', sessionId: 'me' });
  const text = lines.join('\n');
  assert.match(text, /客户甲.*📝草稿/, '草稿那行必须带草稿标记');
  assert.match(text, /同事丙.*⚠失败/, '失败那行必须带失败标记');
  assert.doesNotMatch(text, /同事乙.*(📝草稿|⚠失败)/, '真发出去的那行不许被误标');
  assert.doesNotMatch(lines[0], /发出去了 3 条/, '标题不许说 3 条都发出去了——只有 1 条真出去了');
  assert.match(lines[0], /真发出去的只有 1 条/, '标题要如实说清有几条真出去了');

  // 全是 sent 时标题一个字不变（老口径不动）
  const allSent = buildOutboxReport({
    rows: [{ at: '2026-08-12 11:00:00', sessionId: 'other', to: '甲', text: 'x', result: 'sent' }],
    since: '', sessionId: 'me',
  }).lines.join('\n');
  assert.match(allSent, /以 小明 名义发出去了 1 条/);
  assert.doesNotMatch(allSent, /📝草稿|⚠失败/);
  st.cleanup();
});

test('resultFlag：草稿/失败/已发的标记只有这一处口径', async () => {
  const { resultFlag } = await import('../outbox.mjs');
  assert.equal(resultFlag('draft'), '📝草稿');
  assert.equal(resultFlag('failed'), '⚠失败');
  assert.equal(resultFlag('sent'), '');
  assert.equal(resultFlag(''), '', '空的当已发（老账里 result 可能就是空的）');
  assert.equal(resultFlag(undefined), '');
});

// ---------- bin/fetch.mjs：main() 开头记会话那两行不许拖垮收消息 ----------
//
// ⚠⚠ 这两行（rememberLoopSession + migrateAutosendOnce）在 acquireLock()/runOnce()
//   之前。migrateAutosendOnce() 自己有兜底，但 rememberLoopSession() 走到 store.mjs
//   的 write() 时一个 try/catch 都没有——磁盘满/权限出问题会抛，抛出去就是整轮收
//   消息一条都不执行。这条测试**真的**让它抛错（不是断言源码里有 try 这几个字）：
//   把 state.json 占成一个目录，逼 renameSync 落地那一刻必然 EISDIR。
test('bootstrapSession：记会话那步真的抛错时，也不许把异常带出去', async () => {
  const { bootstrapSession } = await import('../bin/fetch.mjs');
  const { rememberLoopSession } = await import('../session.mjs');
  const box = tmpState();
  const prevId = process.env.CLAUDE_CODE_SESSION_ID;
  try {
    process.env.CLAUDE_CODE_SESSION_ID = 'test-throw-session';
    mkdirSync(join(box.dir, 'state.json')); // 逼 stateSet 落盘那步 renameSync 抛 EISDIR

    // 先证明这个条件下 rememberLoopSession() 本身确实会抛——不然下面的 doesNotThrow
    // 测的是个假靶子。
    assert.throws(() => rememberLoopSession(), /EISDIR/,
      '这个前提如果不成立，说明造错的手法失效了，下面那条断言就没有意义');

    assert.doesNotThrow(() => bootstrapSession(),
      '记会话那步抛错，绝不许把整轮收消息带走——这正是本次修复要挡的形状');
  } finally {
    if (prevId === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = prevId;
    box.cleanup();
  }
});

// ---------- ⑭ 已归位的老段又来新消息（2026-08-12 错位事故）----------
//
// ⚠⚠ 那天真炸过：fetch 把「已归位、这一轮只是又追加了几条」的老段也打出来让人判，
//   编号从 0 数起；而 fileNow 的待判队列是 `!filed && !dropped` 过滤的，老段不在里面。
//   两边错位一格 → segIndex 0 的判定落到了下一段身上（顾问群闲聊被写进 T84 的 inbox），
//   而工作流那段追加的两条消息一条都没落进任何 inbox.md。

// 同一个人隔几分钟又说一句：会并进上一轮那个段里。
const dmMore = () => dm([
  { id: 'm3', at: '2026-08-08T03:25:00.000Z', text: '端口 443，target 我发你' },
]);

test('⚠⚠ 已归位的老段追加新消息：不进待判队列（否则 segIndex 跟判定错位）', async () => {
  const { root, cleanup } = tmpDailymd();
  const { cleanup: cleanupState } = tmpState();
  try {
    const { runOnce, fileNow } = await import('../run.mjs');
    const store = await import('../store.mjs');
    await runOnce({
      dailymd: root, store, deferJudge: true, tree: [],
      adapters: [adapterWith({ candidates: [dm()] })],
    });
    await fileNow(JSON.stringify([{
      segIndex: 0, project: P26, task: TASK70, drop: false, reason: '先归好位', sure: true,
    }]), { dailymd: root, store, tree: [] });

    // 第二轮：老段又来一条新消息，外加一段全新的私信。
    const other = {
      sourceKind: 'mingdao', kind: 'user', who: '周婷', whoAccountId: 'a2',
      target: { accountId: 'a2' },
      msgs: [{ id: 'n1', at: '2026-08-08T03:30:00.000Z', text: '赞助合同我发你了' }],
    };
    const r2 = await runOnce({
      dailymd: root, store, deferJudge: true, tree: [],
      adapters: [adapterWith({ candidates: [dmMore(), other] })],
    });
    assert.equal(r2.pending.length, 1, '待判队列里只该有那段新的，老段不许占一个位置');
    assert.equal(r2.pending[0].who, '周婷', '⚠ 错一格，判定就会落到别人身上');
  } finally { cleanup(); cleanupState(); }
});

test('⚠⚠ 老段追加的消息要当场重写进原来那个 inbox.md（这一轮可能压根不跑 file.mjs）', async () => {
  const { root, cleanup } = tmpDailymd();
  const { cleanup: cleanupState } = tmpState();
  try {
    const { runOnce, fileNow } = await import('../run.mjs');
    const store = await import('../store.mjs');
    await runOnce({
      dailymd: root, store, deferJudge: true, tree: [],
      adapters: [adapterWith({ candidates: [dm()] })],
    });
    await fileNow(JSON.stringify([{
      segIndex: 0, project: P26, task: TASK70, drop: false, reason: '先归好位', sure: true,
    }]), { dailymd: root, store, tree: [] });

    const r2 = await runOnce({
      dailymd: root, store, deferJudge: true, tree: [],
      adapters: [adapterWith({ candidates: [dmMore()] })],
    });
    assert.equal(r2.pending.length, 0, '没有要判的了');
    const md = readFileSync(join(root, 'projects', P26, 'tasks', TASK70, 'inbox.md'), 'utf-8');
    assert.match(md, /端口 443/, '追加的那条必须进 inbox.md，不许无声消失');
  } finally { cleanup(); cleanupState(); }
});

test('原落点被归档了：清掉 filed 退回待判队列，不许每轮报错还永不重判', async () => {
  const { root, cleanup } = tmpDailymd();
  const { cleanup: cleanupState } = tmpState();
  try {
    const { runOnce, fileNow } = await import('../run.mjs');
    const store = await import('../store.mjs');
    await runOnce({
      dailymd: root, store, deferJudge: true, tree: [],
      adapters: [adapterWith({ candidates: [dm()] })],
    });
    await fileNow(JSON.stringify([{
      segIndex: 0, project: P26, task: TASK70, drop: false, reason: '先归好位', sure: true,
    }]), { dailymd: root, store, tree: [] });

    // 小明 跑了 finish-task.sh：任务整个搬进 archive/，原落点没了。
    rmSync(join(root, 'projects', P26, 'tasks', TASK70), { recursive: true, force: true });
    const r2 = await runOnce({
      dailymd: root, store, deferJudge: true, tree: [],
      adapters: [adapterWith({ candidates: [dmMore()] })],
    });
    assert.equal(r2.pending.length, 1, '落点没了的段要退回来重判');
    assert.ok(!r2.pending[0].filed, 'filed 必须清掉，否则下一轮又走重写那条死路');
  } finally { cleanup(); cleanupState(); }
});

// ---------- ⑫ 自己那份水位线 ----------
//
// ⚠⚠ 2026-08-13 事故：`~/.hap-watch/mailroom.json` 是全局共享的，别的进程跑一次
//   watch.mjs 就把「有新消息」这个标记消费掉了。Alice 17:36 回的私信，17:40、17:41
//   两轮都报「无新动静」，人问起来才发现。所以 mailroom 自己记一份，只在**干净收尾**时写。

test('干净收尾才写自己那份水位线（`watch-seen`）', async () => {
  const { root, cleanup } = tmpDailymd();
  const { cleanup: cleanupState } = tmpState();
  try {
    const { runOnce } = await import('../run.mjs');
    const store = await import('../store.mjs');
    await runOnce({
      dailymd: root, store, deferJudge: true, tree: [],
      adapters: [adapterWith({ candidates: [dm()], seen: { s1: '新时间' } })],
    });
    assert.deepEqual(store.stateGet('watch-seen'), { s1: '新时间' },
      '干净收尾了，这一轮看到的水位线要存住');
  } finally { cleanup(); cleanupState(); }
});

test('⚠ 这一轮有东西没取到（lost）：绝不写自己那份水位线，下一轮照旧重收', async () => {
  const { root, cleanup } = tmpDailymd();
  const { cleanup: cleanupState } = tmpState();
  try {
    const { runOnce } = await import('../run.mjs');
    const store = await import('../store.mjs');
    await runOnce({
      dailymd: root, store, deferJudge: true, tree: [],
      adapters: [adapterWith({
        candidates: [dm()], seen: { s1: '新时间' }, lost: ['某个会话取数失败'],
      })],
    });
    assert.equal(store.stateGet('watch-seen'), undefined,
      '⚠ 有东西没取到还把水位线推过去 = 那批消息永久收不到，正是这条要防的事');
  } finally { cleanup(); cleanupState(); }
});

// ---------- 已归位的段续上新消息：不进队列，但必须报出来 ----------
//
// 2026-08-14 的真空档：mergeInto 把同一条线 30 分钟内的后续消息追加进已归位的老段，
// rewriteFiled 写进 inbox.md，然后没有任何人被告知 —— 正在等的回复静默入库。
test('collectFollowups：老段被追加了消息，只挑出新来的那几条', async () => {
  const { collectFollowups } = await import('../run.mjs');
  const seg = {
    id: 'a1',
    who: '小李',
    sourceLabel: '明道云 · 私信',
    filed: { project: 'P24-hk-partner-event', task: 'T137-x', sure: true },
    dropped: false,
    msgs: [
      { id: 'm1', at: '2026-08-14T17:28:00+08:00', text: '稍等我看一下设计' },
      { id: 'm2', at: '2026-08-14T17:37:00+08:00', text: '效果很好' },
      { id: 'm3', at: '2026-08-14T17:41:00+08:00', text: '两点建议' },
    ],
  };
  const before = new Map([['a1', new Set(['m1'])]]);
  const out = collectFollowups([seg], before);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].msgs.map((m) => m.text), ['效果很好', '两点建议']);
  assert.equal(out[0].project, 'P24-hk-partner-event');
  assert.equal(out[0].task, 'T137-x');
  assert.equal(out[0].preview, '两点建议');
});

test('collectFollowups：这一轮新建的段不算续聊（它会正常进待判队列）', async () => {
  const { collectFollowups } = await import('../run.mjs');
  const seg = {
    id: 'new1',
    filed: { project: 'P00-misc' },
    msgs: [{ id: 'm1', at: '', text: '你好' }],
  };
  assert.deepEqual(collectFollowups([seg], new Map()), []);
});

test('collectFollowups：没归位的段和丢弃的段都不算续聊', async () => {
  const { collectFollowups } = await import('../run.mjs');
  const before = new Map([['a', new Set()], ['b', new Set()]]);
  const pending = { id: 'a', filed: null, msgs: [{ id: 'm1', text: 'x' }] };
  const dropped = { id: 'b', dropped: true, filed: { project: 'P00-misc' }, msgs: [{ id: 'm2', text: 'y' }] };
  assert.deepEqual(collectFollowups([pending, dropped], before), []);
});

test('collectFollowups：迟到插到中间的消息也认得出来（不是按条数切片）', async () => {
  const { collectFollowups } = await import('../run.mjs');
  const seg = {
    id: 'a1',
    filed: { project: 'P00-misc' },
    // 新来的 m2 时间早，重排后插在 m1 和 m3 中间
    msgs: [
      { id: 'm1', at: '2026-08-14T10:00:00+08:00', text: '一' },
      { id: 'm2', at: '2026-08-14T10:05:00+08:00', text: '迟到的' },
      { id: 'm3', at: '2026-08-14T10:09:00+08:00', text: '三' },
    ],
  };
  const before = new Map([['a1', new Set(['m1', 'm3'])]]);
  const out = collectFollowups([seg], before);
  assert.deepEqual(out[0].msgs.map((m) => m.text), ['迟到的']);
});

test('buildFollowupReport：一段都没有就一个字不打', async () => {
  const { buildFollowupReport } = await import('../bin/fetch.mjs');
  assert.deepEqual(buildFollowupReport([]), []);
  assert.deepEqual(buildFollowupReport(null), []);
  assert.deepEqual(buildFollowupReport([{ project: 'P00-misc', msgs: [] }]), []);
});

test('buildFollowupReport：打出落点、原文，并明说不用再判', async () => {
  const { buildFollowupReport } = await import('../bin/fetch.mjs');
  const lines = buildFollowupReport([{
    project: 'P24-hk-partner-event',
    task: 'T137-x',
    who: '小李',
    sourceLabel: '明道云 · 私信',
    msgs: [{ at: '2026-08-14T17:37:00+08:00', text: '效果很好' }],
  }]);
  const text = lines.join('\n');
  assert.match(text, /不用再判/);
  assert.match(text, /小李/);
  assert.match(text, /P24-hk-partner-event \/ T137-x/);
  assert.match(text, /17:37 效果很好/);
});

// ---------- 收敛期：对方还在一句句敲，先压住别端上去 ----------
//
// 2026-08-14 Andy 提的：设计师的「两点建议」第 1 点和第 2 点隔了 4 分钟，
// 一分钟一收的心跳下会变成三次打扰，而且第一次看到的是半截话。
const settleSeg = (over = {}) => ({
  id: 's1',
  sourceKind: 'mingdao',
  sourceType: 'user',
  who: '小李',
  firstAt: '2026-08-14T17:37:00+08:00',
  lastAt: '2026-08-14T17:37:00+08:00',
  msgs: [{ id: 'm1', at: '2026-08-14T17:37:00+08:00', text: '只有两点建议：1、封面logo可以放大' }],
  ...over,
});
const at = (hhmm) => new Date(`2026-08-14T${hhmm}:00+08:00`).getTime();

test('isSettling：刚说完 30 秒，压住', async () => {
  const { isSettling } = await import('../run.mjs');
  assert.equal(isSettling(settleSeg(), { now: at('17:37') + 30_000 }), true);
});

test('isSettling：安静满 90 秒，放行', async () => {
  const { isSettling } = await import('../run.mjs');
  assert.equal(isSettling(settleSeg(), { now: at('17:39') }), false);
});

test('isSettling：连着说了 8 分钟也得先端一批，不许无限压', async () => {
  const { isSettling } = await import('../run.mjs');
  const seg = settleSeg({
    lastAt: '2026-08-14T17:45:00+08:00',
    msgs: [
      { id: 'm1', at: '2026-08-14T17:37:00+08:00', text: '一' },
      { id: 'm2', at: '2026-08-14T17:45:00+08:00', text: '二' },
    ],
  });
  // 最后一条才过 10 秒（够压），但最老的未报消息已经压了 8 分钟 → 放行
  assert.equal(isSettling(seg, { now: at('17:45') + 10_000 }), false);
});

test('isSettling：邮件和系统通知不压（本来就是整封/一次一条到达）', async () => {
  const { isSettling } = await import('../run.mjs');
  const now = at('17:37') + 10_000;
  assert.equal(isSettling(settleSeg({ sourceKind: 'mail', sourceType: 'mail' }), { now }), false);
  assert.equal(isSettling(settleSeg({ sourceType: 'notice' }), { now }), false);
});

test('isSettling：时间戳坏掉一律放行，不许因为脏数据永远端不上来', async () => {
  const { isSettling } = await import('../run.mjs');
  assert.equal(isSettling(settleSeg({ lastAt: '不是时间' }), { now: at('17:37') }), false);
});

test('collectFollowups：收敛期内的续聊压住，且下一轮还报得出来', async () => {
  const { collectFollowups } = await import('../run.mjs');
  const seg = {
    id: 'a1',
    sourceKind: 'mingdao',
    sourceType: 'user',
    who: '小李',
    filed: { project: 'P24', task: 'T137' },
    firstAt: '2026-08-14T17:37:00+08:00',
    lastAt: '2026-08-14T17:41:00+08:00',
    msgs: [
      { id: 'm1', at: '2026-08-14T17:37:00+08:00', text: '一' },
      { id: 'm2', at: '2026-08-14T17:41:00+08:00', text: '二' },
    ],
  };
  const snap = new Map([['a1', new Set(['m1'])]]);
  // 第一轮：他 10 秒前刚说完 → 压住，且不许写 reported 水位线
  assert.deepEqual(collectFollowups([seg], snap, { now: at('17:41') + 10_000 }), []);
  // 压住时把「到现在为止报过的」固化下来，只含 m1（m2 还没报）
  assert.deepEqual(seg.reported, ['m1']);
  // 第二轮：快照里 m2 已经不是新的了，但因为上一轮没报过，照样要报出来
  const snap2 = new Map([['a1', new Set(['m1', 'm2'])]]);
  const out = collectFollowups([seg], snap2, { now: at('17:43') });
  assert.deepEqual(out.map((f) => f.msgs.map((m) => m.text)), [['二']]);
  assert.deepEqual(seg.reported, ['m1', 'm2']);
});

test('collectFollowups：报过的不再报第二遍', async () => {
  const { collectFollowups } = await import('../run.mjs');
  const seg = {
    id: 'a1',
    sourceKind: 'mingdao',
    sourceType: 'user',
    filed: { project: 'P24' },
    lastAt: '2026-08-14T17:37:00+08:00',
    msgs: [{ id: 'm1', at: '2026-08-14T17:37:00+08:00', text: '一' }],
    reported: ['m1'],
  };
  assert.deepEqual(collectFollowups([seg], new Map([['a1', new Set()]]), { now: at('17:50') }), []);
});

// ⚠ 2026-08-14 现场逮到的：压住的段等的就是「对方不再说话」，而那种轮次
//   按定义一条新消息都没有。当时 collectFollowups 只喂 changed（这一轮变过的段），
//   于是压住的那几条消息永远轮不到被报——收敛期把自己要防的事亲手干了一遍。
test('安静的一轮也要把压住的段端出来（没有新消息 ≠ 没有要报的）', async () => {
  const { root, cleanup } = tmpDailymd();
  const { dir, cleanup: cleanupState } = tmpState();
  try {
    const { saveSegments } = await import('../store.mjs');
    const long = new Date(Date.now() - 20 * 60 * 1000).toISOString().replace('Z', '+00:00');
    saveSegments([{
      id: 'held-1',
      sourceKind: 'mingdao',
      sourceType: 'user',
      sourceLabel: '明道云 · 私信',
      who: '小李',
      filed: { project: 'P24-x', task: 'T137-y', sure: true },
      reported: ['m1'],                       // m1 报过了，m2 是上一轮被压住的
      firstAt: long,
      lastAt: long,                           // 20 分钟前 —— 早过了 90 秒静默线
      msgs: [
        { id: 'm1', at: long, text: '一' },
        { id: 'm2', at: long, text: '二' },
      ],
    }]);
    const { runOnce } = await import('../run.mjs');
    const r = await runOnce({
      adapters: [adapterWith({ candidates: [], records: [], authError: null, noNews: true })],
      judge: async () => { throw new Error('这一轮没有要判的') },
      dailymd: root,
    });
    assert.equal(r.segmented, 0, '这一轮确实一条新消息都没有');
    assert.deepEqual(
      r.followups.map((f) => f.msgs.map((m) => m.text)), [['二']],
      '被压住的那条必须在安静的这一轮报出来，不能等对方再开口',
    );
  } finally { cleanup(); cleanupState(); }
});

// ⚠ 2026-08-18 现场逮到的：一轮里 todo（changed+stranded）恰好是空的（这一轮唯一的
//   动静就是给一个已归位段追加了续聊），runOnce 在 `!todo.length` 那个早退分支直接
//   return，没调 saveAll —— collectFollowups 原地写在段上的 s.reported 水位线跟着
//   丢了，下一轮同一批续聊消息被当成「没报过」再报一遍，连着报了四五轮。
test('已归位段的续聊：报过就要存盘，不能每轮重报', async () => {
  const { root, cleanup } = tmpDailymd();
  const { dir, cleanup: cleanupState } = tmpState();
  try {
    const { saveSegments, segments } = await import('../store.mjs');
    const long = new Date(Date.now() - 20 * 60 * 1000).toISOString().replace('Z', '+00:00');
    saveSegments([{
      id: 'held-1',
      sourceKind: 'mingdao',
      sourceType: 'group',
      sourceLabel: '明道云 · 群「Nocoly Pioneer」',
      who: '韩梅梅',
      filed: { project: 'P11-nocoly-sea-marketing', sure: true },
      reported: ['m1'],
      firstAt: long,
      lastAt: long,
      msgs: [
        { id: 'm1', at: long, text: '一' },
        { id: 'm2', at: long, text: '二' },
        { id: 'm3', at: long, text: '三' },
      ],
    }]);
    const { runOnce } = await import('../run.mjs');
    const opts = {
      adapters: [adapterWith({ candidates: [], records: [], authError: null, noNews: true })],
      judge: async () => { throw new Error('这一轮没有要判的') },
      dailymd: root,
    };
    const r1 = await runOnce(opts);
    assert.deepEqual(
      r1.followups.map((f) => f.msgs.map((m) => m.text)), [['二', '三']],
      '第一轮：没报过的两条要报出来',
    );
    assert.deepEqual(
      segments().find((s) => s.id === 'held-1').reported, ['m1', 'm2', 'm3'],
      '报完必须存盘，水位线要推到最新',
    );
    const r2 = await runOnce(opts);
    assert.deepEqual(r2.followups, [], '第二轮：报过的不该再报一遍');
  } finally { cleanup(); cleanupState(); }
});

// ---------- 收敛期问一句：拿不准他说完没有，就回一句问问 ----------

test('probeReason：最后只甩了个文件没带说明 → 要问', async () => {
  const { probeReason } = await import('../run.mjs');
  const seg = { sourceKind: 'mingdao', sourceType: 'user', lastAt: '2026-08-14T18:00:00+08:00' };
  const r = probeReason(seg, [{ text: '[文件] product-en.html' }], { now: at('18:10') });
  assert.match(r, /文件/);
});

test('probeReason：最后那句以冒号收尾 → 要问', async () => {
  const { probeReason } = await import('../run.mjs');
  const seg = { sourceKind: 'mingdao', sourceType: 'user', lastAt: '2026-08-14T18:00:00+08:00' };
  assert.match(probeReason(seg, [{ text: '调整内容：' }], { now: at('18:10') }), /没说完/);
});

test('probeReason：被 8 分钟上限强推出来的（还没静默）→ 要问', async () => {
  const { probeReason } = await import('../run.mjs');
  const seg = { sourceKind: 'mingdao', sourceType: 'user', lastAt: '2026-08-14T18:09:30+08:00' };
  assert.match(probeReason(seg, [{ text: '可以的' }], { now: at('18:10') }), /还没停/);
});

test('probeReason：话说完了就别问', async () => {
  const { probeReason } = await import('../run.mjs');
  const seg = { sourceKind: 'mingdao', sourceType: 'user', lastAt: '2026-08-14T18:00:00+08:00' };
  assert.equal(probeReason(seg, [{ text: '可以的，就这样改吧。' }], { now: at('18:10') }), null);
});

test('probeReason：一段只问一次，群里一次都不问', async () => {
  const { probeReason } = await import('../run.mjs');
  const done = {
    sourceKind: 'mingdao', sourceType: 'user',
    lastAt: '2026-08-14T18:00:00+08:00', probedAt: '2026-08-14T18:01:00+08:00',
  };
  assert.equal(probeReason(done, [{ text: '调整内容：' }], { now: at('18:10') }), null);
  const group = { sourceKind: 'mingdao', sourceType: 'group', lastAt: '2026-08-14T18:00:00+08:00' };
  assert.equal(probeReason(group, [{ text: '调整内容：' }], { now: at('18:10') }), null,
    '群里追着问「还有吗」太吵，只私信问');
});

test('collectFollowups：问过一次就在段上留痕，不会每轮都问', async () => {
  const { collectFollowups } = await import('../run.mjs');
  const seg = {
    id: 'a1', sourceKind: 'mingdao', sourceType: 'user', who: '小李',
    filed: { project: 'P24' },
    lastAt: '2026-08-14T17:30:00+08:00',
    msgs: [{ id: 'm1', at: '2026-08-14T17:30:00+08:00', text: '调整内容：' }],
  };
  const out = collectFollowups([seg], new Map([['a1', new Set()]]), { now: at('17:40') });
  assert.ok(out[0].probe, '第一次要给出问一句的理由');
  assert.equal(out[0].segId, 'a1', '要带段 id，不然拼不出 send.mjs 的命令');
  assert.ok(seg.probedAt, '问过要在段上留痕');
});

// ---------- 心跳只该被真人踩热 ----------

test('botAddress：认得出各种机器人发件地址', async () => {
  const { botAddress } = await import('../run.mjs');
  for (const a of [
    'noreply-dmarc-support@google.com', 'no-reply@notion.so', 'donotreply@bank.com',
    'mailer-daemon@qq.com', 'notifications@github.com', 'dmarc@google.com',
  ]) assert.equal(botAddress(a), true, a);
});

test('botAddress：真人地址不许误伤', async () => {
  const { botAddress } = await import('../run.mjs');
  for (const a of [
    'xiaoli@acme.com', 'zhang.san@corp.com', 'wang@acme.com', 'alerta.perez@corp.com',
  ]) assert.equal(botAddress(a), false, a);
});

test('humanPeer：DMARC 报告不该把心跳踩回热区', async () => {
  const { humanPeer } = await import('../run.mjs');
  assert.equal(humanPeer([
    { kind: 'mail', who: 'noreply-dmarc-support', whoAddress: 'noreply-dmarc-support@google.com' },
  ]), null);
});

test('humanPeer：真人私信、真人邮件都算；动态通知不算', async () => {
  const { humanPeer } = await import('../run.mjs');
  assert.equal(humanPeer([{ kind: 'user', who: '小李' }]), '小李');
  assert.equal(humanPeer([{ kind: 'mail', who: '张三', whoAddress: 'zhang@acme.com' }]), '张三');
  assert.equal(humanPeer([{ kind: 'post', who: '明道云' }]), null, '动态播报没人在等我回');
  assert.equal(humanPeer([{ kind: 'notice', who: '日程助手' }]), null);
});

test('humanPeer：一堆机器人里夹着一个真人，照样加速', async () => {
  const { humanPeer } = await import('../run.mjs');
  assert.equal(humanPeer([
    { kind: 'mail', whoAddress: 'noreply@x.com' },
    { kind: 'post', who: '明道云' },
    { kind: 'user', who: '小王' },
  ]), '小王');
});

test('humanPeer：对方最后一句是纯回执，话说完了，不加速', async () => {
  const { humanPeer } = await import('../run.mjs');
  for (const text of ['好的', '收到', 'OK', 'ok', '嗯嗯', '👌', '谢谢', '[Good]']) {
    assert.equal(
      humanPeer([{ kind: 'user', who: '小李', msgs: [{ text }] }]),
      null,
      `"${text}" 该判成收尾`,
    );
  }
});

test('humanPeer：带实质内容的长句子，就算带着"好的"也照样加速', async () => {
  const { humanPeer } = await import('../run.mjs');
  assert.equal(
    humanPeer([{ kind: 'user', who: '小李', msgs: [{ text: '好的，那这个方案我们下周二上线' }] }]),
    '小李',
  );
});
