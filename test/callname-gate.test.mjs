// 称呼硬门：**一条路只读一次通讯录**。
//
// ⚠⚠ 2026-08-08 评审实跑复现的 fail-open：
//   `lib.mjs` 的 `contacts()` 是模块级缓存，而 `if (_contacts) return _contacts` 里
//   **`[]` 是 truthy** —— 只要「第一次用到通讯录时恰好读不到」（别的工具正在重写
//   contacts.json、git 操作的一瞬），这个常驻的审批台进程就把空表**永久**缓存住了。
//   而 GATE-DOWN 那道检查（callNameGate）是**自己重新读文件**的，看到文件好好的
//   就判「门武装着」放行。文件恢复正常之后，同一进程里「金总您好」查出 0 条违规、
//   门说放行 —— 那正是 2026-08-07 那类事故的输入。
//
//   修法：让那道检查把它读到的那份名单**显式传下去**给 checkCallName，
//   一条路只读一次，两处不再分家。比给缓存加 TTL 硬。
//
// ⚠ 这份文件故意**不**往 `__test` 里塞假通讯录（塞了就走测试钩子那条路，
//   等于把要测的东西绕过去了）。传输层仍然是假的（`__test.adapter`），一个字不外发。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { tmpState, tmpDailymd } from './helpers.mjs';

// ⚠ 顺序要紧：这两个开关必须在 import server/send 之前设好。
//   MAILROOM_TEST=1 才认 __test.adapter（不认的话就会去打**真** hap CLI）。
process.env.MAILROOM_TEST = '1';
process.env.MAILROOM_ROLE = 'approval-desk';

const st = tmpState();
const dm = tmpDailymd();
const ROOT = dm.root;

const PEOPLE = [
  { name: '李雷', nickname: '小李', md_account_id: 'acc-jerry' },
  { name: '韩梅', nickname: '梅姐', md_account_id: 'acc-feng' },
];
mkdirSync(join(ROOT, 'contactmd'), { recursive: true });
writeFileSync(join(ROOT, 'contactmd/contacts.json'), JSON.stringify(PEOPLE, null, 2));

// ---------- 先把 lib.mjs 的通讯录缓存**毒死** ----------
//
// 手法就是真实世界里那一瞬：第一次用到通讯录时文件读不到（这里用一个没有 contactmd/
// 的空目录顶替库根），contacts() 读到 0 条并把这个空表缓存住。之后文件一切正常，
// 但这个常驻进程里的缓存再也不会更新 —— 审批台正是常驻进程。
const NOWHERE = mkdtempSync(join(tmpdir(), 'mailroom-nocontacts-'));
process.env.MAILROOM_DAILYMD = NOWHERE;
const { checkCallName } = await import('../lib.mjs');
assert.equal(
  checkCallName('李总您好，这事我看了').length, 0,
  '前提：通讯录读不到时 checkCallName 查不出违规（这就是 fail-open 的来源）',
);
// 文件恢复正常。⚠ 审批台服务的库根必须跟 dailymdRoot() 同源，否则 GATE-DOWN 会直接拒发，
//   那条路已经有测试盯着了，这里要测的是**它放行之后**发生了什么。
process.env.MAILROOM_DAILYMD = ROOT;

const { callNameGate, sendOptsFor } = await import('../bin/send.mjs');
const { sendReply, precheckSend } = await import('../send.mjs');

// ---------- 夹具 ----------

function spyAdapter() {
  const calls = [];
  return {
    calls,
    kind: 'mingdao',
    sendVia: (item, body) => { calls.push({ item, body }); return { channel: '私信', to: item.who }; },
    describe: () => '明道云 · 私信',
  };
}

const JERRY_SEG = () => {
  const at = new Date().toISOString();
  return {
    id: 'seg-jerry',
    sourceKind: 'mingdao',
    sourceType: 'user',
    sourceLabel: '明道云 · 私信',
    who: '李雷',
    whoAccountId: 'acc-jerry',
    target: { accountId: 'acc-jerry' },
    msgs: [{ id: 'm1', at, text: '那个方案你看了吗' }],
    firstAt: at,
    lastAt: at,
    filed: null,
    dropped: false,
    waiting: null,
  };
};

// bin/send.mjs 里那条真实路径的逐字复刻：读一次通讯录 → 把这份名单显式带下去。
// ⚠ 复刻而不是直接调 main()：main() 会去读命令行参数、写 stdout、设 MAILROOM_ROLE，
//   而这份文件要盯的是「名单有没有一路传到 checkCallName」这一件事。
//   ⚠⚠ 但**键集合和取值来源必须跟 bin/send.mjs 完全一致**，一旦那边改了这里没跟上，
//      下面那条 sendOptsFor 的键集合断言会先红——那就是提醒。
async function sendLikeCli(item, text, { formalName = false, adapter } = {}) {
  const gate = callNameGate(ROOT);
  if (gate.error) throw new Error(gate.error);
  const opts = sendOptsFor(ROOT, formalName, gate.people);
  if (adapter) opts.__test = { adapter };
  return sendReply(item, text, { source: 'approval-desk-button' }, opts);
}

// ---------- 正题 ----------

test('缓存被毒死之后，称呼门仍然拦得住「李总您好」（门读到的名单要显式传下去）', async () => {
  const adapter = spyAdapter();
  let err = null;
  try {
    await sendLikeCli(JERRY_SEG(), '李总您好，那个方案我看过了，明天给你答复', { adapter });
  } catch (e) { err = e; }
  assert.ok(err, '称呼门必须拦下来 —— 放行的话就是以前「李总您好」那条事故重演');
  assert.equal(err.code, 'CALLNAME');
  assert.match(String(err.message), /小李/, '要告诉他该叫什么');
  assert.equal(adapter.calls.length, 0, '一个字都不许发出去');
});

test('同一份名单也要喂给预检：发之前那一眼就该红着，不能等真发了才说', () => {
  const gate = callNameGate(ROOT);
  const pre = precheckSend('李总您好，那个方案我看过了', JERRY_SEG(),
    sendOptsFor(ROOT, false, gate.people));
  assert.equal(pre.callName.ok, false,
    '预检跟真发那道门必须同源：预检说没问题、按下去被拦，是最伤信任的行为');
});

test('sendOptsFor 的键集合定死：多一个键就是多一条夹带的路', () => {
  const opts = sendOptsFor(ROOT, true, PEOPLE);
  assert.deepEqual(Object.keys(opts).sort(), ['allowFormalName', 'dailymd', 'people'],
    '多一个键就是多一条夹带的路');
  assert.equal(opts.people, PEOPLE, 'people 只认第三个参数（门刚读到的那份）');
  assert.equal(opts.dailymd, ROOT);
});

test('传进来的名单是空的 = 门大开，宁可拒发也不许静默放行', async () => {
  await assert.rejects(
    () => sendReply(JERRY_SEG(), '李总您好', { source: 'approval-desk-button' },
      { dailymd: ROOT, people: [] }),
    /通讯录|拒绝发送/,
    '空名单让 checkCallName 一条违规都查不出来，等于门大开 —— 必须当场拒发',
  );
});

test('通讯录整个读不到时，门当场拒发（不是放行）', () => {
  const gate = callNameGate('/根本不是这个库');
  assert.ok(gate.error, '库根对不上就该拒发');
  assert.equal(gate.people, null);
});

test.after(() => { dm.cleanup(); st.cleanup(); });
