// alert（报到人眼前）的自查。
//
// ⚠ 全程不许真弹通知、真出声、真推 Bark：所有「会执行」的断言都注入假 exec；
//   不注入的那条恰恰在验证「测试环境下默认一个通道都不跑」这道门本身。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sendAlert, setSwitch, formatSwitches, CHANNELS } from '../alert.mjs';
import { alertSwitches, resetConfigCache } from '../config.mjs';
import { tmpState } from './helpers.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test('开关默认值：三个通道全关（别替新用户做主弹通知）', () => {
  const t = tmpState();
  try {
    resetConfigCache();
    const sw = alertSwitches();
    assert.equal(sw.notify, false);
    assert.equal(sw.voice, false);
    assert.equal(sw.bark, false);
  } finally { t.cleanup(); resetConfigCache(); }
});

test('测试环境下不注入假 exec 就一个通道都不跑', () => {
  // 三个开关全开也不行——这道门挡的就是「自查真弹通知/真推手机」。
  const done = sendAlert(
    { title: 't', text: 'x' },
    { switches: { notify: true, voice: true, bark: true } },
  );
  assert.deepEqual(done, { notify: false, voice: false, bark: false });
});

test('开关各自独立：关掉的通道不执行，开着的执行', () => {
  const calls = [];
  const exec = (cmd) => calls.push(cmd);
  const done = sendAlert(
    { title: '2 件事', text: '甲 · 私信 · 找你', voice: '甲找你' },
    { switches: { notify: true, voice: false, bark: false }, exec },
  );
  assert.deepEqual(done, { notify: true, voice: false, bark: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0], 'osascript');
});

test('三个通道全开时依次执行，内容经 argv/env 传递而不是拼进脚本源码', () => {
  const calls = [];
  const exec = (cmd, args, opts) => calls.push({ cmd, args, opts });
  sendAlert(
    { title: '标题"带引号"', text: '正文 & 特殊字符', voice: '念这句' },
    { switches: { notify: true, voice: true, bark: true }, exec },
  );
  assert.deepEqual(calls.map((c) => c.cmd), ['osascript', '/usr/bin/say', '/bin/bash']);
  // 通知：标题正文走 argv，AppleScript 源码里不出现消息内容
  assert.ok(calls[0].args.includes('标题"带引号"'));
  assert.ok(!calls[0].args[1].includes('带引号'));
  // 语音：念的是 --voice 那句
  assert.deepEqual(calls[1].args, ['念这句']);
  // Bark：内容 URL 编码后经环境变量进 bash，脚本源码里不出现原文
  assert.equal(calls[2].opts.env.MR_TITLE, encodeURIComponent('标题"带引号"'));
  assert.ok(!calls[2].args.join(' ').includes('标题'));
});

test('通知优先走带图标的通知应用：payload 落文件、open 启动；应用不存在就退回 osascript', () => {
  const t = tmpState();
  try {
    const calls = [];
    const exec = (cmd, args, o) => calls.push({ cmd, args, o });
    // 拿一个真实存在的文件冒充应用（内容无所谓，只看「存在就走它」）
    const fake = fileURLToPath(import.meta.url);
    sendAlert({ title: '标题', text: '正文' },
      { switches: { notify: true, voice: false, bark: false }, exec, applet: fake });
    // ⚠ 启动必须走 open（直跑二进制会被 TCC 记成 sshd/终端，通知静默丢）
    assert.deepEqual(calls[0], { cmd: 'open', args: ['-W', '-a', fake], o: undefined });
    // ⚠ 内容必须走文件（AppleScript 读环境变量不按 UTF-8 解码，中文全乱码）
    assert.equal(readFileSync(join(t.dir, 'alert-payload.txt'), 'utf-8'), '标题\n正文');
    // 指了不存在的应用 → 退回 osascript
    calls.length = 0;
    sendAlert({ title: 't' },
      { switches: { notify: true, voice: false, bark: false }, exec, applet: '/no/such/applet' });
    assert.equal(calls[0].cmd, 'osascript');
  } finally { t.cleanup(); }
});

test('某个通道抛错只算失败，不打断其他通道', () => {
  const calls = [];
  const exec = (cmd) => {
    calls.push(cmd);
    if (cmd === 'osascript') throw new Error('boom');
  };
  const done = sendAlert(
    { title: 't' },
    { switches: { notify: true, voice: true, bark: false }, exec },
  );
  assert.deepEqual(done, { notify: false, voice: true, bark: false });
  assert.deepEqual(calls, ['osascript', '/usr/bin/say']);
});

test('setSwitch 写回配置文件且只动 alert 段', () => {
  const t = tmpState();
  try {
    resetConfigCache();
    setSwitch('voice', true);
    resetConfigCache();
    assert.equal(alertSwitches().voice, true);
    assert.equal(alertSwitches().notify, false); // 没动的保持默认（关）
    const raw = JSON.parse(readFileSync(join(t.dir, 'config.json'), 'utf-8'));
    assert.equal(raw.identity.callName, '小明'); // 其他段原样还在
    assert.throws(() => setSwitch('siren', true)); // 不存在的通道直接拒绝
  } finally { t.cleanup(); resetConfigCache(); }
});

test('formatSwitches 是人话', () => {
  assert.equal(formatSwitches({ notify: true, voice: false, bark: false }), '通知 开 · 语音 关 · Bark 关');
  assert.deepEqual(CHANNELS, ['notify', 'voice', 'bark']);
});

test('守卫：alert 链路里没有任何发消息给别人的能力', () => {
  // 「发送只有一条路（bin/send.mjs）」是全库铁律。alert 只对机主报信，
  // 谁往这里加 send / hap chat 相关调用，这条测试就该红。
  for (const f of ['alert.mjs', join('bin', 'alert.mjs')]) {
    const src = readFileSync(join(ROOT, f), 'utf-8');
    // 注释里可以提 send.mjs（指路用），但不许 import 它、不许碰 sendVia / hap CLI。
    assert.ok(!/from\s+['"][^'"]*send|sendVia|chat send|['"]hap['"]/.test(src), `${f} 里出现了发送相关调用`);
  }
});
