// 主动在某张工作表的某条记录下留讨论（`--record` / `--worksheet` + `--row`）这条入口的护栏。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { synthRecord, confirmToken } from '../dm.mjs';
import { replyViaOf } from '../connect/hap.mjs';
import * as hapAdapter from '../connect/hap.mjs';
import { lineOf, sameLine } from '../recheck.mjs';
import { tierOf } from '../bin/send.mjs';
import { tmpDailymd, tmpState } from './helpers.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WID = 'ws-00000000-0000-4000-8000-000000000001';
const RID = 'row-00000000-0000-4000-8000-000000000002';

let box = null;
before(() => {
  box = tmpState();
  process.env.MAILROOM_TEST = '1';
});
after(() => {
  if (box) box.cleanup();
  delete process.env.MAILROOM_TEST;
});

const PEOPLE = [
  { name: '孙强', nickname: '强哥', md_account_id: 'acc-rocky' },
  { name: '李雷', nickname: '雷哥', md_account_id: 'acc-zhangfeng' },
];

// ---------- 合成段的形状 ----------

test('没给 worksheetId 或 rowId 直接拒绝', () => {
  assert.throws(() => synthRecord({ worksheetId: '', rowId: RID }), /哪条记录/);
  assert.throws(() => synthRecord({ worksheetId: WID, rowId: '' }), /哪条记录/);
});

test('⚠⚠ replyVia=record —— 决定了走 hap worksheet record add-discussion，也决定了这条恒为 🔴', () => {
  const item = synthRecord({ worksheetId: WID, rowId: RID, name: '孙强', accountId: 'acc-rocky' });
  assert.equal(replyViaOf(item), 'record');
  assert.equal(item.kind, 'notice');
  assert.equal(item.target.worksheetId, WID);
  assert.equal(item.target.rowId, RID);
});

test('⚠⚠ sourceType 必须是 notice：不然「发送前重收」那道门认不出同线', () => {
  const item = synthRecord({ worksheetId: WID, rowId: RID });
  assert.deepEqual(lineOf(item), { kind: 'record', key: `${WID}:${RID}` });
  assert.equal(
    sameLine({ sourceType: 'notice', target: { worksheetId: WID, rowId: RID } }, lineOf(item)),
    true,
  );
  assert.equal(
    sameLine({ sourceType: 'notice', target: { worksheetId: WID, rowId: 'other' } }, lineOf(item)),
    false,
  );
});

test('档位：记录讨论恒为 🔴（受众较广，比私信需要更多确认）', () => {
  assert.equal(tierOf({ isRecord: true }), '🔴');
  assert.equal(tierOf({ isRecord: true, auto: '' }), '🔴');
});

test('合成段喂进 sendVia 真的走 hap worksheet record add-discussion', () => {
  const calls = [];
  const item = synthRecord({
    worksheetId: WID, rowId: RID, appId: 'app-1', viewId: 'view-1', replyId: 'inbox-1',
    name: '孙强', accountId: 'acc-rocky', recordName: '物料跟进',
  });
  const r = hapAdapter.sendVia(item, '我是 小明 的 AI Agent，收到。', {
    io: { hap: (args) => { calls.push(args); return ''; } },
  });
  assert.equal(r.channel, '记录讨论');
  assert.deepEqual(calls[0].slice(0, 5), ['worksheet', 'record', 'add-discussion', WID, RID]);
  assert.ok(calls[0].includes('--reply-id'));
});

// ---------- 端到端：真跑 bin/send.mjs ----------

function runCli(args, dailymd) {
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

test('⚠⚠ 第一步只预览、绝不发送：打出确认码，退出码 0，正文已补身份声明', () => {
  const dm = dailymdWithContacts();
  try {
    const r = runCli(['--record', `${WID}/${RID}`, '--text', '强哥，这个物料库存请跟进一下。'], dm.root);
    assert.equal(r.code, 0, `预览不是失败；实际输出：${r.out}`);
    assert.match(r.out, /还没有发出去/);
    assert.match(r.out, /--confirm [a-z0-9-]+/);
    assert.match(r.out, /AI Agent/);
    assert.doesNotMatch(r.out, /已发送|已发出/);
  } finally {
    dm.cleanup();
  }
});

test('⚠ 确认码认的是 worksheetId:rowId：换个记录，同一段正文的码就不一样', () => {
  const body = '🤖 我是 小明 的 AI Agent，以下内容已经过 小明 本人审核。\n\n收到。';
  assert.notEqual(confirmToken(`${WID}:${RID}`, body), confirmToken(`${WID}:other-row`, body));
});

test('确认码对上之后才会走到真发那一步（被 assertNoRealIO 挡在传输层）', () => {
  const dm = dailymdWithContacts();
  try {
    const text = '强哥，这个物料库存请跟进一下。';
    const first = runCli(['--record', `${WID}/${RID}`, '--text', text], dm.root);
    const token = (first.out.match(/--confirm ([a-z0-9-]+)/) || [])[1];
    assert.ok(token, `第一步没给出确认码：${first.out}`);
    const second = runCli(
      ['--record', `${WID}/${RID}`, '--text', text, '--confirm', token, '--off-hours'], dm.root,
    );
    assert.doesNotMatch(second.out, /还没有发出去/, '码对上了就不该再停在预览');
    assert.match(second.out, /测试模式|assertNoRealIO|发送失败/i,
      `应该被测试模式挡在真打 hap 之前；实际输出：${second.out}`);
  } finally {
    dm.cleanup();
  }
});

test('--record 和 --seg / --to / --task 同时给 → 拒绝（四条路只能走一条）', () => {
  const dm = dailymdWithContacts();
  try {
    assert.match(runCli(['--record', `${WID}/${RID}`, '--seg', 'x1', '--text', '话'], dm.root).out, /只能给一个/);
    assert.match(runCli(['--record', `${WID}/${RID}`, '--to', '李雷', '--text', '话'], dm.root).out, /只能给一个/);
    assert.match(runCli(['--record', `${WID}/${RID}`, '--task', 't1', '--text', '话'], dm.root).out, /只能给一个/);
  } finally {
    dm.cleanup();
  }
});

test('⚠⚠ --auto 在这条路上一律拒绝：记录讨论没有 🟢 的口子', () => {
  const dm = dailymdWithContacts();
  try {
    const r = runCli(['--record', `${WID}/${RID}`, '--text', '收到。', '--auto', '纯回执'], dm.root);
    assert.equal(r.code, 1);
    assert.match(r.out, /只用于回复/);
  } finally {
    dm.cleanup();
  }
});

test('用法里要写出 --record（不然这条入口等于不存在）', () => {
  const dm = dailymdWithContacts();
  try {
    const r = runCli([], dm.root);
    assert.equal(r.code, 1);
    assert.match(r.out, /--record/);
  } finally {
    dm.cleanup();
  }
});
