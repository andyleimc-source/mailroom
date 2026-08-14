// 发信总账。⚠ 这份账是「谁以 小明 名义发了什么、凭什么发」的唯一汇总，
//   2026-08-12 之前这件事散在三个地方（mailroom 日志 / inbox.md / autosend.jsonl），
//   而且都不记「哪个会话发的」。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';

import { outboxFile, readOutbox, logSent, recentOutbox, migrateAutosendOnce } from '../outbox.mjs';
import { tmpState } from './helpers.mjs';

let box = null;
before(() => { box = tmpState(); });
after(() => { if (box) box.cleanup(); });

const BASE = {
  session: 'dailymd-8d',
  sessionId: '00000000-0000-4000-8000-000000000002',
  filed: 'P12-mpc2026/T61-2026-08-04-xxx',
  channel: '私信',
  to: '周婷',
  accountId: 'acc-liyuke',
  seg: 'seg-1',
  tier: '🟡',
  why: '答她包在哪，照实说，无承诺',
  text: '包在文件库里，链接我一会儿发你。',
  result: 'sent',
};

test('logSent 写进去的那一行，字段一个不少', () => {
  const row = logSent(BASE);
  assert.equal(row.session, 'dailymd-8d');
  assert.equal(row.tier, '🟡');
  assert.equal(row.result, 'sent');
  assert.equal(row.chars, [...BASE.text].length, 'chars 由正文算出来，不许调用方自己填');
  assert.match(row.at, /^\d{4}-\d{2}-\d{2}/, 'at 走 localIso()，不是 UTC');
  const rows = readOutbox();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, BASE.text, '正文全文进账，不截断——账本就是给事后翻的');
});

test('账本文件读不到 / 读坏了，一律当空，不抛', () => {
  writeFileSync(outboxFile(), '这不是 JSON\n{"at":"2026-08-12 10:00:00","tier":"🟢"}\n坏行\n');
  const rows = readOutbox();
  assert.equal(rows.length, 1, '坏行跳过，好行照读');
  assert.equal(rows[0].tier, '🟢');
});

test('recentOutbox 只给窗口里的', () => {
  const now = new Date('2026-08-12T12:00:00');
  const rows = [
    { at: '2026-08-12 11:00:00', to: 'A' },
    { at: '2026-08-10 11:00:00', to: 'B' },
    { at: '坏时间', to: 'C' },
  ];
  const got = recentOutbox({ now, hours: 24, rows });
  assert.deepEqual(got.map((r) => r.to), ['A'], '超窗的和时间坏掉的都不算');
});

test('从 autosend.jsonl 一次性迁移，跑第二遍不会翻倍', () => {
  writeFileSync(outboxFile(), '');
  const old = outboxFile().replace(/outbox\.jsonl$/, 'autosend.jsonl');
  writeFileSync(old, JSON.stringify({
    at: '2026-08-12 09:00:00', accountId: 'acc-jerry', who: '赵四',
    chars: 6, why: '纯回执', seg: 'seg-old',
  }) + '\n');

  migrateAutosendOnce();
  let rows = readOutbox();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tier, '🟢', '老账全是 🟢 —— autosend.jsonl 里本来就只记自动发的');
  assert.equal(rows[0].result, 'sent');
  assert.equal(rows[0].to, '赵四');
  assert.ok(!existsSync(old), '迁完原文件要改名，不然下次又迁一遍');
  assert.ok(existsSync(`${old}.bak`), '原文件留一份 .bak，别真删');

  migrateAutosendOnce();
  rows = readOutbox();
  assert.equal(rows.length, 1, '第二遍是空跑');
});

// ⚠ 这条钉的是「**写失败就不许改名、不许留半截**」，**不是原子性**。
//   造错的手法是把落点堵成一个目录，appendFileSync 第一次写就炸——一个字节都没进去，
//   所以它证明不了「写到一半断电会怎样」。真正的原子性（写一半失败）这个仓库目前
//   没有覆盖，下一个人别以为有。migrateAutosendOnce 里「所有行拼成一整块一次写完」
//   那个写法是冲着原子性去的，但没有测试钉着它。
test('迁移写失败：账本一行都不许多，老文件还在原地没被改名', () => {
  rmSync(outboxFile(), { force: true });
  // 把落盘路径占成一个目录，逼 appendFileSync 必然抛错（EISDIR）。
  mkdirSync(outboxFile());

  const old = outboxFile().replace(/outbox\.jsonl$/, 'autosend.jsonl');
  rmSync(`${old}.bak`, { force: true }); // 清掉上一条测试留下的 .bak，别混进来
  writeFileSync(old, JSON.stringify({
    at: '2026-08-12 09:00:00', accountId: 'acc-jerry', who: '赵四',
    chars: 6, why: '纯回执', seg: 'seg-old',
  }) + '\n');

  migrateAutosendOnce();

  assert.equal(readOutbox().length, 0, '写失败了，账本里一行都不许多');
  assert.ok(existsSync(old), '老文件必须还在原地，没被改名');
  assert.ok(!existsSync(`${old}.bak`), '没有 .bak，说明 rename 压根没跑');

  rmSync(outboxFile(), { recursive: true, force: true });
});
