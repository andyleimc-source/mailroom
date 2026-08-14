// CLI 收尾。⚠ 只测「命令存在、帮助里有、doctor 不打印任何凭据值」，不真跑引导。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpState } from './helpers.mjs';

tmpState();
const CLI = fileURLToPath(new URL('../bin/mailroom', import.meta.url));

test('help 里列出了 mail-bootstrap', () => {
  const out = execFileSync(CLI, ['help'], { encoding: 'utf-8' });
  assert.match(out, /mail-bootstrap/);
});

// ⚠⚠ 2026-08-10 评审：这条测试原来是真 exec `doctor`，于是跑一次 ./run-tests.sh 就会
//   真调 `hap auth whoami`（走网络）和三次 `security find-generic-password`（读钥匙串）——
//   `-w` 读非本进程创建的钥匙串项**会弹系统授权框**，测试可能挂在 GUI 弹框上等人点。
//   而当时的断言只看输出里有没有 `python3` / `mailroom-work` 这些字样，缺凭据的分支
//   打印的也是同样的字样，**凭据在不在这条测试都绿**，等于只测了文案还在。
//   现在 doctor 在测试模式下把这两类探测短路成「（测试模式跳过）」，输出是唯一确定的
//   一份，下面的断言才咬得住。
const doctor = (env = {}) => execFileSync(CLI, ['doctor'], {
  encoding: 'utf-8',
  env: { ...process.env, MAILROOM_TEST: '1', ...env },
});

test('doctor 在测试模式下不碰网络、不碰钥匙串（这两处短路掉了）', () => {
  const out = doctor();
  assert.match(out, /hap 登录态（测试模式跳过）/, '没短路 = 每跑一次自查就真打一次 hap');
  assert.match(out, /（测试模式跳过凭据探测）/,
    '没短路 = 真读钥匙串，可能弹系统授权框把测试挂住');
  // 真探测过的话，凭据那几行一定带 ✓ 或「缺令牌/缺授权码」—— 一个都不许出现
  assert.doesNotMatch(out, /缺(令牌|授权码)/, '出现「缺令牌/缺授权码」说明真的去读钥匙串了');
  assert.doesNotMatch(out, /✓ [^\n]*@/, '邮箱那行带 ✓ 说明真的读到钥匙串了');
  assert.doesNotMatch(out, /✓ 已登录/, '这一行有 ✓ 就说明真的去问了 hap');
});

test('doctor 仍然检 python3（这条不碰网络也不碰钥匙串，照检不误）', () => {
  assert.match(doctor(), /python3/);
});

test('doctor 不打印凭据的值', () => {
  // 授权码长这样:带 $ 和混合大小写的 15 位。doctor 里绝不许出现任何这种串。
  assert.doesNotMatch(doctor(), /\$[A-Za-z0-9@$]{10,}/);
});

test('doctor 分段齐全，且每个配了的邮箱都单独占一行', () => {
  const out = doctor();
  for (const sec of ['配置', '知识库', '明道云', '邮件', '接入']) {
    assert.match(out, new RegExp(`^${sec}$`, 'm'), `doctor 少了「${sec}」这一段`);
  }
  // tmpState() 的测试配置里有两个邮箱，两个都得报到
  assert.match(out, /me@acme\.com/);
  assert.match(out, /me@corp-mail\.com/);
});

test('CLI 源码里不许 echo 出凭据（-w 读出来的值不许进 console）', () => {
  const src = readFileSync(CLI, 'utf-8');
  const lines = src.split('\n').filter((l) => /find-generic-password/.test(l));
  for (const l of lines) {
    assert.doesNotMatch(l, /console\.log|echo/, `这一行可能把凭据打出来：${l.trim()}`);
  }
});

// ---------- 开局清单：钥匙串和水位线都是每台 Mac 一份，所以只在 work 上做 ----------
//
// ⚠ 网易那份授权码怎么进钥匙串，原来文档里一个字都没有（ms365 好歹有
//   `mailroom mail-bootstrap`）。没人知道要做什么，邮件那条路就会一直停在
//   「认证失败」。2026-08-10 起收发固定在 work，这一遍也就只在 work 上做一次。
test('README 把「装」讲全了：两样要配的 + 向导 + 自检', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf-8');
  // ⚠ 这条盯的是「新来的人照着 README 能不能装起来」，不是某一句话的措辞。
  //   缺任何一项，读者就会卡在一个 README 没讲的地方。
  assert.match(readme, /mailroom setup/, '配置向导那一步不能缺');
  assert.match(readme, /mailroom doctor/, '装完先自检那一步不能缺');
  assert.match(readme, /hap auth login/, '明道云要登录这件事不能缺');
  assert.match(readme, /security add-generic-password/, 'IMAP 邮箱怎么存授权码不能缺');
  assert.match(readme, /mailroom mail-login/, 'Microsoft 365 怎么登录不能缺');
  // 两个最容易卡住新用户的前提，必须写在 README 里
  assert.match(readme, /CLI 访问/, '组织要开 CLI 开关这件事必须提醒');
  assert.match(readme, /客户端授权码/, '企业邮箱要的是授权码不是密码，必须提醒');
});

test('⚠ README 里的授权码必须是占位符，不许是真的', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf-8');
  for (const line of readme.split('\n').filter((l) => /add-generic-password/.test(l))) {
    const m = line.match(/-w\s+'([^']*)'/);
    assert.ok(m, `这一行的 -w 值没法检查，写成 -w '<占位符>' 的形状：${line}`);
    assert.match(m[1], /^<.*>$/, `-w 后面写的不像占位符，像真的授权码：${line}`);
  }
});
