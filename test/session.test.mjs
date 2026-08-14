// 会话身份。⚠ 会话名**不许由调用方填**：填的那一刻账本就成了自证材料。
//   身份只从环境变量 + ~/.claude/sessions/ 的登记表来。

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { whoAmI, rememberLoopSession, loopSession } from '../session.mjs';
import { tmpState } from './helpers.mjs';

const SESSION_ENV_KEYS = [
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'MAILROOM_SESSIONS',
  'ANTIGRAVITY_CONVERSATION_ID', 'CODEX_SESSION_ID', 'MAILROOM_SESSION_ID', 'MAILROOM_SESSION_NAME',
];

let box = null;
let dir = null;
const prevEnv = {};
before(() => {
  box = tmpState();
  dir = mkdtempSync(join(tmpdir(), 'mailroom-sessions-'));
  for (const k of SESSION_ENV_KEYS) prevEnv[k] = process.env[k];
  process.env.MAILROOM_SESSIONS = dir;
  writeFileSync(join(dir, '111.json'), JSON.stringify({
    pid: process.pid, sessionId: 'uuid-me', name: 'dailymd-8d', cwd: '/x', status: 'idle',
  }));
  writeFileSync(join(dir, '222.json'), JSON.stringify({
    pid: 999999, sessionId: 'uuid-dead', name: 'mailroom-3f', cwd: '/y', status: 'idle',
  }));
  writeFileSync(join(dir, '333.json'), '这不是 JSON');
});

beforeEach(() => {
  for (const k of [
    'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID',
    'ANTIGRAVITY_CONVERSATION_ID', 'CODEX_SESSION_ID', 'MAILROOM_SESSION_ID', 'MAILROOM_SESSION_NAME',
  ]) delete process.env[k];
  process.env.MAILROOM_SESSIONS = dir;
});

after(() => {
  if (box) box.cleanup();
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test('认得出自己是哪个会话', () => {
  process.env.CLAUDE_CODE_SESSION_ID = 'uuid-me';
  assert.deepEqual(whoAmI(), { sessionId: 'uuid-me', name: 'dailymd-8d' });
});

test('没有环境变量（小明 自己在终端手敲）→ 记成「手工」，不拒发', () => {
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_SESSION_ID;
  assert.deepEqual(whoAmI(), { sessionId: '', name: '手工' });
});

test('环境变量有、登记表里查不到名字 → 名字记「手工」，UUID 照记', () => {
  process.env.CLAUDE_CODE_SESSION_ID = 'uuid-不在表里';
  assert.deepEqual(whoAmI(), { sessionId: 'uuid-不在表里', name: '手工' });
});

// 下面这几条是「不止 Claude Code 一个 harness」之后补的。
// 别的 CLI 没有 ID ↔ 名字对照表，名字自己造，够在总账里分清哪一次跑的就行 ——
// 关键是**不能退成「手工」**：退了就跟真人手敲混在一起，事后查账分不出来。
test('agy（Antigravity）→ 认得出，名字造一个，不退「手工」', () => {
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_SESSION_ID;
  process.env.ANTIGRAVITY_CONVERSATION_ID = 'abc123-def-456';
  assert.deepEqual(whoAmI(), { sessionId: 'abc123-def-456', name: 'agy-abc123' });
  delete process.env.ANTIGRAVITY_CONVERSATION_ID;
});

// ⚠ codex 0.147 实测**不导出**会话 ID，这条测的是「哪天它加了，机制现成」。
//   眼下要让 codex 那一轮进总账，得在包装脚本里自己 export MAILROOM_SESSION_ID。
test('codex → 同样认得出（等它哪天导出会话 ID）', () => {
  delete process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CODEX_SESSION_ID = '9f8e7d6c5b4a';
  assert.deepEqual(whoAmI(), { sessionId: '9f8e7d6c5b4a', name: 'codex-9f8e7d' });
  delete process.env.CODEX_SESSION_ID;
});

test('MAILROOM_SESSION_ID 是逃生口：本表还没收录的 harness 也能进总账', () => {
  delete process.env.CLAUDE_CODE_SESSION_ID;
  process.env.MAILROOM_SESSION_ID = 'zz-999';
  process.env.MAILROOM_SESSION_NAME = '定时轮询';
  assert.deepEqual(whoAmI(), { sessionId: 'zz-999', name: '定时轮询' });
  delete process.env.MAILROOM_SESSION_ID;
  delete process.env.MAILROOM_SESSION_NAME;
});

// ⚠ 这条守的是「身份不许由调用方随便挑」：Claude Code 的 ID 在场时，
//   别的 harness 变量（可能是上一层 CLI 漏下来的）不许把它顶掉。
test('Claude Code 的 ID 在场时优先它，别的 harness 变量顶不掉', () => {
  process.env.CLAUDE_CODE_SESSION_ID = 'uuid-me';
  process.env.ANTIGRAVITY_CONVERSATION_ID = 'abc123-def-456';
  assert.deepEqual(whoAmI(), { sessionId: 'uuid-me', name: 'dailymd-8d' });
  delete process.env.ANTIGRAVITY_CONVERSATION_ID;
});

test('别的 harness 的会话不进 loop 会话表（定时器每轮跑完就没了，戴不了）', () => {
  delete process.env.CLAUDE_CODE_SESSION_ID;
  process.env.ANTIGRAVITY_CONVERSATION_ID = 'abc123-def-456';
  rememberLoopSession();
  assert.equal(loopSession(), null);
  delete process.env.ANTIGRAVITY_CONVERSATION_ID;
});

test('记下跑 loop 的那个会话，之后找得回来', () => {
  process.env.CLAUDE_CODE_SESSION_ID = 'uuid-me';
  rememberLoopSession();
  assert.deepEqual(loopSession(), { sessionId: 'uuid-me', name: 'dailymd-8d' });
});

test('那个会话的进程已经没了 → 返回 null，别去戴一个死会话', () => {
  process.env.CLAUDE_CODE_SESSION_ID = 'uuid-dead';
  rememberLoopSession();
  assert.equal(loopSession(), null);
});

// ⚠ 这条不能只验「手工调完 loopSession() 是 null」——loopSession() 自己就把空
//   sessionId 判成 null，那样写的话 rememberLoopSession() 里的 guard 删掉照样绿。
//   要验的是「已经记着的活会话，不会被手工那次调用顶掉」。
test('「手工」不记成 loop 会话（不许覆盖已经记着的活会话）', () => {
  process.env.CLAUDE_CODE_SESSION_ID = 'uuid-me';
  rememberLoopSession();
  assert.deepEqual(loopSession(), { sessionId: 'uuid-me', name: 'dailymd-8d' });

  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_SESSION_ID;
  rememberLoopSession();
  assert.deepEqual(loopSession(), { sessionId: 'uuid-me', name: 'dailymd-8d' });
});
