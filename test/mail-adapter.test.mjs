// 邮件适配器的编排：水位线、首轮基线、两账号互不牵连、标已读的时机。
// ⚠ 传输层（graphFetch / imapFetch / 标已读）全部注入假的，不连任何邮箱。
//
// ⚠⚠ pull() 返回值里的 `commit` 是显式钩子：正常收信（非首轮）的水位线和
//   mail-pending-read **不会**在 pull() 返回前自己落盘，得由调用方在确认这一轮
//   candidates/records 已经安全落盘之后手动调 `r.commit()`。这份测试里凡是要看
//   水位线有没有推进的地方，都得先调一次 `r.commit()`——这不是偷懒，是契约本身：
//   审阅 run.mjs 时发现「pull() 自己判断该不该提交」堵不住 saveAll 写盘失败那条洞
//   （详见 connect/mail.mjs 顶部注释和 run.mjs 的 commitPulled），提交权必须彻底
//   交给调用方。真正「调用方到底什么时候调 commit」那部分行为在 test/run.test.mjs
//   里用真的 run.mjs + 真的 connect/mail.mjs 端到端验证。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpState } from './helpers.mjs';
import * as mail from '../connect/mail.mjs';
import { adapterFor, listAdapters } from '../connect/index.mjs';
import { MailAuthError } from '../lib.mjs';

tmpState();

function memStore() {
  const s = {};
  return { stateGet: (k, d) => (k in s ? s[k] : d), stateSet: (k, v) => { s[k] = v; }, _s: s };
}

// 水位线必须**相对现在**算，不能写死日期：connect/mail.mjs 的 clampSince 会把
// 落后超过 MAX_CATCHUP_DAYS（7 天）的水位线往前推，写死的日期总有一天会滑出窗口，
// 那条「水位线原样传给 graphFetch」的断言就会在某个普通的早上突然变红，
// 而且报错长得像收信逻辑坏了。（2026-08-19 踩到：写死的 2026-08-10 过期了。）
const WATERMARK = new Date(Date.now() - 2 * 86400 * 1000).toISOString();

const ONE = {
  id: 'g1', threadId: 'c1', at: '2026-08-10T06:34:14Z', subject: '关于 G2',
  from: { name: '李雷', address: 'lei.li@corp-mail.com' },
  to: [{ name: '', address: 'me@acme.com' }], cc: [], bcc: [],
  text: '你好', html: '', attachmentNames: [],
};

// ⚠ 默认 graphFetch 也带上 seenIds，跟 mail/graph.mjs 真实返回的形状对齐——
//   否则测试永远测不到「seenIds 有没有被存回去、下一轮有没有传回去」这条链。
function io(over = {}) {
  return {
    graphFetch: async () => ({ messages: [], lastReceived: '', seenIds: [] }),
    graphMarkRead: async () => {},
    imapFetch: () => ({ uidValidity: '1', lastUid: '10', baseline: true, messages: [] }),
    imapMarkRead: () => ({ ok: true }),
    ...over,
  };
}

test('适配器注册进去了', () => {
  assert.ok(listAdapters().includes('mail'));
  assert.equal(adapterFor('mail').kind, 'mail');
  assert.equal(adapterFor('mail').logSubdir, 'assets/mail-log');
});

test('describe 按账号给标签', () => {
  assert.equal(mail.describe({ account: 'work' }), '邮件 · work');
  assert.equal(mail.describe({ account: 'corp' }), '邮件 · corp');
  assert.equal(mail.describe({}), '邮件');
});

test('首轮只建基线，一条都不当成新邮件；lastReceived 和 ids 当场落盘（不用等 commit）', async () => {
  const store = memStore();
  const r = await mail.pull({
    store,
    io: io({
      graphFetch: async () => ({ messages: [ONE], lastReceived: ONE.at, seenIds: ['g1'] }),
      imapFetch: () => ({ uidValidity: '1', lastUid: '10', baseline: true, messages: [] }),
    }),
  });
  assert.equal(r.candidates.length, 0);
  assert.equal(r.records.length, 0);
  // ⚠ 首轮基线是唯一在 pull() 内部当场提交的例外：没有候选、没有「消息还没落盘」
  //   的风险；反过来押到 commit() 里的话，只要这一轮没人调 commit()，下一轮
  //   since/lastUid 还是空的，永远建不成基线。不需要调 r.commit() 就该已经落盘。
  assert.equal(store._s['mail-seen-work'].lastReceived, ONE.at);
  assert.deepEqual(store._s['mail-seen-work'].ids, ['g1']);
  assert.equal(store._s['mail-seen-corp'].lastUid, '10');
});

test('第二轮起才产候选；水位线要等调用方调 commit() 才落盘', async () => {
  const store = memStore();
  store.stateSet('mail-seen-work', { lastReceived: WATERMARK, ids: [] });
  store.stateSet('mail-seen-corp', { uidValidity: '1', lastUid: '10' });
  let since = null;
  const r = await mail.pull({
    store,
    io: io({
      graphFetch: async ({ since: s }) => {
        since = s;
        return { messages: [ONE], lastReceived: ONE.at, seenIds: ['g1'] };
      },
    }),
  });
  assert.equal(since, WATERMARK);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].sourceKind, 'mail');
  assert.equal(r.candidates[0].account, 'work');
  assert.equal(r.records.length, 1);
  assert.equal(typeof r.commit, 'function');
  // 还没调 commit()：水位线原地不动，这正是本轮修改要锁死的行为。
  assert.equal(store._s['mail-seen-work'].lastReceived, WATERMARK);
  r.commit();
  assert.equal(store._s['mail-seen-work'].lastReceived, ONE.at);
});

test('seenIds 一路传回去：上一轮存的 ids 会喂给下一轮的 graphFetch，返回的新 ids 存回去（调 commit 之后）', async () => {
  const store = memStore();
  store.stateSet('mail-seen-work', { lastReceived: WATERMARK, ids: ['old-1', 'old-2'] });
  store.stateSet('mail-seen-corp', { uidValidity: '1', lastUid: '10' });
  let seenIdsSeen = null;
  const r = await mail.pull({
    store,
    io: io({
      graphFetch: async ({ seenIds }) => {
        seenIdsSeen = seenIds;
        return { messages: [ONE], lastReceived: ONE.at, seenIds: ['old-1', 'old-2', 'g1'] };
      },
    }),
  });
  assert.deepEqual(seenIdsSeen, ['old-1', 'old-2'], '上一轮存的 ids 要原样传给 graphFetch 做二次去重');
  assert.equal(r.candidates.length, 1);
  r.commit();
  assert.deepEqual(store._s['mail-seen-work'].ids, ['old-1', 'old-2', 'g1'], 'graphFetch 返回的新 ids 要存回去');
});

test('同一封不会连收两轮（commit 之后水位线推过去了）', async () => {
  const store = memStore();
  store.stateSet('mail-seen-work', { lastReceived: WATERMARK, ids: [] });
  store.stateSet('mail-seen-corp', { uidValidity: '1', lastUid: '10' });
  const first = await mail.pull({
    store,
    io: io({ graphFetch: async () => ({ messages: [ONE], lastReceived: ONE.at, seenIds: ['g1'] }) }),
  });
  assert.equal(first.candidates.length, 1);
  first.commit();
  const second = await mail.pull({
    store,
    io: io({
      graphFetch: async ({ since }) => ({
        messages: since >= ONE.at ? [] : [ONE], lastReceived: since, seenIds: ['g1'],
      }),
    }),
  });
  assert.equal(second.candidates.length, 0);
});

test('没调 commit() 就再收一轮：同一封还能再收到（模拟落盘失败、下一轮重收）', async () => {
  const store = memStore();
  store.stateSet('mail-seen-work', { lastReceived: WATERMARK, ids: [] });
  store.stateSet('mail-seen-corp', { uidValidity: '1', lastUid: '10' });
  const first = await mail.pull({
    store,
    io: io({ graphFetch: async () => ({ messages: [ONE], lastReceived: ONE.at, seenIds: ['g1'] }) }),
  });
  assert.equal(first.candidates.length, 1);
  // ⚠ 故意不调 first.commit()——模拟 run.mjs 那边落盘没成功。
  const second = await mail.pull({
    store,
    io: io({ graphFetch: async () => ({ messages: [ONE], lastReceived: ONE.at, seenIds: ['g1'] }) }),
  });
  assert.equal(second.candidates.length, 1, '上一轮没提交，水位线没推进，同一封要能再收到');
});

test('标已读押到下一轮开头，本轮不标（本轮有没有落盘成，pull 不知道）', async () => {
  const store = memStore();
  store.stateSet('mail-seen-work', { lastReceived: WATERMARK, ids: [] });
  store.stateSet('mail-seen-corp', { uidValidity: '1', lastUid: '10' });
  const marked = [];
  const first = await mail.pull({
    store,
    io: io({
      graphFetch: async () => ({ messages: [ONE], lastReceived: ONE.at, seenIds: ['g1'] }),
      graphMarkRead: async (ids) => { marked.push(...ids); },
    }),
  });
  assert.equal(first.candidates.length, 1);
  assert.deepEqual(marked, [], '本轮不许标已读');
  // commit 之前，mail-pending-read 也还没落盘。
  assert.ok(!(store._s['mail-pending-read'] || {}).work);
  first.commit();
  assert.deepEqual(store._s['mail-pending-read'].work, ['g1']);

  await mail.pull({
    store,
    io: io({ graphMarkRead: async (ids) => { marked.push(...ids); } }),
  });
  assert.deepEqual(marked, ['g1'], '下一轮开头才标');
  assert.deepEqual(store._s['mail-pending-read'].work, []);
});

test('mail-pending-read 是并集，不是覆盖：上一轮标已读失败留下的 id 不会被这一轮的新 id 顶掉', async () => {
  const store = memStore();
  store.stateSet('mail-seen-work', { lastReceived: WATERMARK, ids: [] });
  store.stateSet('mail-seen-corp', { uidValidity: '1', lastUid: '10' });
  // 模拟上一轮 flushPendingRead 标 'old1' 没成功，留在了 state 里。
  store.stateSet('mail-pending-read', { work: ['old1'] });

  const marked = [];
  const r = await mail.pull({
    store,
    io: io({
      // 这一轮标已读继续失败（'old1' 还留着），同时取到一封新邮件。
      graphMarkRead: async () => { throw new Error('网络抖动'); },
      graphFetch: async () => ({ messages: [ONE], lastReceived: ONE.at, seenIds: ['g1'] }),
    }),
  });
  assert.equal(r.candidates.length, 1);
  r.commit();
  const pending = new Set(store._s['mail-pending-read'].work);
  assert.ok(pending.has('old1'), '上一轮没标成的 old1 不许被这一轮的新 id 顶掉');
  assert.ok(pending.has('g1'), '这一轮新取到的 g1 也要在待标列表里');
  assert.equal(pending.size, 2);

  // 下一轮：这次标已读成功，old1 和 g1 都要被标掉。
  const r2 = await mail.pull({
    store,
    io: io({ graphMarkRead: async (ids) => { marked.push(...ids); } }),
  });
  assert.deepEqual(new Set(marked), new Set(['old1', 'g1']));
  assert.deepEqual(store._s['mail-pending-read'].work, []);
});

test('一个账号认证挂了，authError 上报，另一个账号照收；调 commit() 只会应用健康账号的改动', async () => {
  const store = memStore();
  store.stateSet('mail-seen-work', { lastReceived: WATERMARK, ids: [] });
  store.stateSet('mail-seen-corp', { uidValidity: '1', lastUid: '10' });
  const r = await mail.pull({
    store,
    io: io({
      graphFetch: async () => { throw new MailAuthError('refresh 失效'); },
      imapFetch: () => ({
        uidValidity: '1', lastUid: '12', baseline: false,
        messages: [{ ...ONE, id: '12', to: [{ name: '', address: 'me@corp-mail.com' }] }],
      }),
    }),
  });
  assert.match(String(r.authError), /refresh 失效/);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].account, 'corp');
  // ⚠ pull() 自己不再判断「有 authError 就不许提交」——那是 run.mjs 的事
  //   （它靠 authError 提前 return，压根不会走到调 commit 的那一步，见
  //   test/run.test.mjs）。这里单独调 commit() 是为了证明：commit 里确实只包含
  //   mingdao 的改动，work 完全没被影响到（它的 pullOne 在推进 commits 之前
  //   就抛出去了）。
  r.commit();
  assert.equal(store._s['mail-seen-work'].lastReceived, WATERMARK,
    'work 认证失败，它的 pullOne 没走到能推进水位线的地方');
  assert.equal(store._s['mail-seen-corp'].lastUid, '12', 'mingdao 没问题，水位线该推进');
});

test('普通取数失败记进 lost，水位线不推（下一轮重收）；健康账号不受影响', async () => {
  const store = memStore();
  store.stateSet('mail-seen-work', { lastReceived: WATERMARK, ids: [] });
  store.stateSet('mail-seen-corp', { uidValidity: '1', lastUid: '10' });
  const r = await mail.pull({
    store,
    io: io({ graphFetch: async () => { throw new Error('连接超时'); } }),
  });
  assert.equal(r.lost.length, 1);
  assert.match(r.lost[0], /work/);
  r.commit();
  assert.equal(store._s['mail-seen-work'].lastReceived, WATERMARK);
});

test('uidValidity 变了：重新建基线，不倒历史（当场落盘，不用等 commit）', async () => {
  const store = memStore();
  store.stateSet('mail-seen-work', { lastReceived: WATERMARK, ids: [] });
  store.stateSet('mail-seen-corp', { uidValidity: '1', lastUid: '10' });
  const r = await mail.pull({
    store,
    io: io({ imapFetch: () => ({ uidValidity: '2', lastUid: '9999', baseline: true, messages: [] }) }),
  });
  assert.equal(r.candidates.length, 0);
  assert.equal(store._s['mail-seen-corp'].uidValidity, '2');
  assert.equal(store._s['mail-seen-corp'].lastUid, '9999');
});

test('适配器里不许有身份声明和称呼门', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../connect/mail.mjs', import.meta.url), 'utf-8');
  assert.doesNotMatch(src, /enforceAgentPrefix|checkCallName/);
});
