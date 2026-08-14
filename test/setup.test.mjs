// 配置向导。这份测试盯住三件事，都是「装不上」的常见死法：
//   ① 只配邮箱、不配明道云，也要能走完（组织没开 CLI 开关的人只有这条路）
//   ② 只配明道云、不配邮箱，同样要能走完
//   ③ 向导**只写一个文件**，绝不碰知识库、绝不往钥匙串里塞东西
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpState, tmpDailymd } from './helpers.mjs';
import { runSetup } from '../bin/setup.mjs';

// 假的问答终端：按顺序把预先写好的答案喂回去。
// 问题文本一起收集起来，用来断言「该问的问了、不该问的没问」。
// tmpState() 会先写一份测试配置进去，而向导见到已有配置会先问「要重新配一遍吗」。
// 这几条测的是**新装**那条路，所以先把它清掉。
function fresh() {
  const st = tmpState();
  rmSync(join(st.dir, 'config.json'), { force: true });
  return st;
}

function fakeRl(answers) {
  const asked = [];
  let i = 0;
  return {
    asked,
    question: async (q) => {
      asked.push(q);
      const a = answers[i++];
      return a === undefined ? '' : a;
    },
    close: () => {},
  };
}

test('非交互模式：给什么写什么，一句都不问', async () => {
  const st = tmpState();
  try {
    const cfgFile = join(st.dir, 'given.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(cfgFile, JSON.stringify({ identity: { callName: '阿强' } }));
    const r = await runSetup(['--non-interactive', '--config', cfgFile]);
    assert.equal(r.ok, true);
    const written = JSON.parse(readFileSync(r.file, 'utf-8'));
    assert.equal(written.identity.callName, '阿强');
    // 没给的部分要落到默认值上，而不是缺字段
    assert.equal(written.policy.autoMaxChars, 60);
    assert.equal(written.knowledgeBase.fallbackProject, 'P00-misc');
  } finally { st.cleanup(); }
});

test('只配邮箱、不接明道云：照样走完，hap 那一路是关的', async () => {
  const st = fresh();
  const kb = tmpDailymd();
  try {
    const rl = fakeRl([
      '小明',                    // 怎么称呼自己
      'n',                       // 要接明道云吗 → 不
      'y',                       // 要接邮箱吗 → 要
      'acme.com',                // 内部域名
      '1',                       // IMAP
      'me@acme.com',             // 地址
      'work',                    // 代号
      'imap.acme.com',           // IMAP 主机
      'smtp.acme.com',           // SMTP 主机
      'n',                       // 还有别的邮箱吗 → 没有
      kb.root,                   // 知识库
      'y',                       // 只在工作日发
      'n',                       // 🟢 自动回复 → 不开
    ]);
    const r = await runSetup([], { rl });
    const c = r.cfg;
    assert.equal(c.hap.enabled, false, '没接明道云就该是关的');
    assert.equal(c.mail.enabled, true);
    assert.equal(c.mail.accounts.length, 1);
    assert.equal(c.mail.accounts[0].transport, 'imap');
    assert.equal(c.mail.accounts[0].keychainService, 'mailroom-work');
    assert.equal(c.identity.callName, '小明');
    // 🟢 默认关：替你说话的工具，默认就该是问过你才发
    assert.equal(c.policy.autoMaxPerWindow, 0);
    assert.equal(c.knowledgeBase.root, kb.root);
  } finally { st.cleanup(); kb.cleanup(); }
});

test('只接明道云、不配邮箱：照样走完，邮件那一路是空的', async () => {
  const st = fresh();
  const kb = tmpDailymd();
  try {
    const rl = fakeRl([
      '小明',
      'n',        // 明道云：这台机器上 hap 未必登录，测试里一律走「不接」，不去碰真 hap
      'n',        // 不配邮箱
      kb.root,
      'n',        // 不限工作时段
      'n',        // 不开自动回复
    ]);
    const r = await runSetup([], { rl });
    assert.equal(r.cfg.mail.enabled, false);
    assert.deepEqual(r.cfg.mail.accounts, []);
    // 明确说了不限时段 = workHours 整节删掉（config.mjs 认这个形状）
    assert.equal(r.cfg.policy.workHours, undefined);
  } finally { st.cleanup(); kb.cleanup(); }
});

test('⚠ 向导只写配置这一个文件，绝不碰知识库', async () => {
  const st = fresh();
  const kb = tmpDailymd();
  const before = JSON.stringify(readdirSync(kb.root).sort());
  try {
    const rl = fakeRl(['小明', 'n', 'n', kb.root, 'y', 'n']);
    const r = await runSetup([], { rl });
    assert.equal(JSON.stringify(readdirSync(kb.root).sort()), before, '知识库目录被动过了');
    // 状态目录里除了配置文件，不该多出别的东西
    const extras = readdirSync(st.dir).filter((f) => f !== 'config.json');
    assert.deepEqual(extras, [], `向导多写了文件：${extras.join(', ')}`);
    assert.ok(existsSync(r.file));
  } finally { st.cleanup(); kb.cleanup(); }
});

test('⚠ 授权码不经过向导：只打印让你自己跑的那条命令', async () => {
  const st = fresh();
  const kb = tmpDailymd();
  const printed = [];
  const orig = console.log;
  console.log = (...a) => printed.push(a.join(' '));
  try {
    const rl = fakeRl([
      '小明', 'n', 'y', 'acme.com', '1', 'me@acme.com', 'work',
      'imap.acme.com', 'smtp.acme.com', 'n', kb.root, 'y', 'n',
    ]);
    await runSetup([], { rl });
  } finally {
    console.log = orig;
    st.cleanup(); kb.cleanup();
  }
  const all = printed.join('\n');
  assert.match(all, /security add-generic-password -U -s mailroom-work/,
    '要把存授权码的命令打出来让用户自己跑');
  assert.doesNotMatch(all, /-w '[^<]/, '绝不许把真的授权码拼进打印出来的命令里');
});
