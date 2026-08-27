#!/usr/bin/env node
// alert CLI：把「有事要机主处理」报到人眼前（macOS 通知 / 语音 / Bark）。
//
// 用法：
//   node bin/alert.mjs --title "3 件事要你处理" --text "李雷 · 明道云私信 · 要你确认方案" --voice "李雷私信找你"
//   node bin/alert.mjs status              # 看三个开关
//   node bin/alert.mjs notify on|off       # 系统通知开关（默认开）
//   node bin/alert.mjs voice on|off        # 语音开关（默认关）
//   node bin/alert.mjs bark on|off         # Bark 推手机开关（默认关）

import { sendAlert, setSwitch, formatSwitches, CHANNELS } from '../alert.mjs';
import { alertSwitches } from '../config.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0] || '';

if (cmd === 'status') {
  console.log(`提醒开关：${formatSwitches()}`);
} else if (CHANNELS.includes(cmd)) {
  const v = argv[1];
  if (v !== 'on' && v !== 'off') {
    console.error(`用法：mailroom alert ${cmd} on|off`);
    process.exitCode = 1;
  } else {
    setSwitch(cmd, v === 'on');
    console.log(`✓ 已${v === 'on' ? '打开' : '关闭'} ${cmd}。现在：${formatSwitches(alertSwitches())}`);
  }
} else if (cmd.startsWith('--')) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, '');
    opts[k] = argv[i + 1] || '';
  }
  if (!opts.title && !opts.text) {
    console.error('至少给一个 --title 或 --text。');
    process.exitCode = 1;
  } else {
    const done = sendAlert(opts);
    const fired = Object.entries(done).filter(([, v]) => v).map(([k]) => k);
    console.log(fired.length ? `✓ 已提醒：${fired.join(' + ')}` : '（三个通道都关着或都失败了，什么也没发——mailroom alert status 看开关）');
  }
} else {
  console.error('用法：mailroom alert --title ... --text ... [--voice ...]，或 status / notify|voice|bark on|off');
  process.exitCode = 1;
}
