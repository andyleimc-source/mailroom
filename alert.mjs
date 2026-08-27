// 把「有事要机主处理」这件事送到人眼前：macOS 通知 / 语音 / Bark 推手机。
//
// 为什么有这个文件：mailroom 跑在终端里，loop 一轮轮滚屏，机主在别的窗口干活时
// 新消息一滚就错过。通知中心不会滚走，这就是主通道；语音和 Bark 是可选加强。
//
// ⚠ 这里只对机主本人报信，**没有任何发消息给别人的能力**（发送只在 bin/send.mjs）。
// ⚠ 仿照 notify.mjs：报信是锦上添花，任何通道失败只留一行日志，绝不影响主链。
// ⚠ 三个开关存在 ~/.mailroom/config.json 的 alert 段，notify 默认开、voice/bark 默认关。

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { alertSwitches, configPath } from './config.mjs';
import { stateDir } from './paths.mjs';
import { log, inTest } from './lib.mjs';

export const CHANNELS = ['notify', 'voice', 'bark'];

// 通知横幅和语音都不是读长文的地方，超了就砍。
const MAX_TEXT = 300;
const MAX_VOICE = 60;

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'ignore', timeout: 15000, ...opts });
}

// 真正报一次信。exec 可注入（测试用），生产走系统命令。
export function sendAlert({ title, text, voice }, opts = {}) {
  const { switches = alertSwitches(), exec = run } = opts;
  // 自查里绝不真弹通知 / 真出声 / 真推手机——除非测试自己注入了假 exec。
  if (inTest() && exec === run) return { notify: false, voice: false, bark: false };

  title = String(title || '').trim() || 'mailroom';
  text = String(text || '').trim().slice(0, MAX_TEXT);
  const voiceLine = String(voice || title).trim().slice(0, MAX_VOICE);
  const done = { notify: false, voice: false, bark: false };

  if (switches.notify) {
    try {
      // 优先走带 mailroom 图标的通知应用（scripts/build-alert-app.sh 建的）；
      // 没建过就退回 osascript（图标是脚本编辑器的，但通知照弹）。
      const applet = opts.applet !== undefined
        ? opts.applet
        : (inTest() ? null : join(stateDir(), 'MailroomAlert.app', 'Contents', 'MacOS', 'applet'));
      if (applet && existsSync(applet)) {
        exec(applet, [], { env: { ...process.env, MR_TITLE: title, MR_BODY: text } });
      } else {
        // 标题正文走 argv 传参，不拼进 AppleScript 源码——消息内容里一个引号就能把脚本弄坏。
        exec('osascript', [
          '-e', 'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"\nend run',
          title, text,
        ]);
      }
      done.notify = true;
    } catch (e) {
      log('alert 系统通知失败（不影响主链）：', String((e && e.message) || e).slice(0, 200));
    }
  }

  if (switches.voice) {
    try {
      exec('/usr/bin/say', [voiceLine]);
      done.voice = true;
    } catch (e) {
      log('alert 语音失败（不影响主链）：', String((e && e.message) || e).slice(0, 200));
    }
  }

  if (switches.bark) {
    try {
      // key 在 ~/.zshrc.local（不进 git），只能 source 拿。内容在 node 里先 URL 编码，
      // 经环境变量进 bash——消息正文永远不进 shell 源码。两台（iPhone/iPad）都推。
      const script = 'source ~/.zshrc.local >/dev/null 2>&1 || true\n'
        + 'ok=1\n'
        + 'for K in "${BARK_KEY:-}" "${BARK_KEY_IPAD:-}"; do\n'
        + '  [ -n "$K" ] || continue\n'
        + '  curl -sf --max-time 10 "https://api.day.app/$K/$MR_TITLE/$MR_BODY?group=mailroom&level=timeSensitive" >/dev/null || ok=0\n'
        + 'done\n'
        + 'exit $((1 - ok))';
      exec('/bin/bash', ['-c', script], {
        env: {
          ...process.env,
          MR_TITLE: encodeURIComponent(title),
          MR_BODY: encodeURIComponent(text || title),
        },
      });
      done.bark = true;
    } catch (e) {
      log('alert Bark 推送失败（不影响主链）：', String((e && e.message) || e).slice(0, 200));
    }
  }

  return done;
}

// 拨开关：改的是配置文件本体（configPath() 指到哪改哪），改完下个进程自然生效。
export function setSwitch(channel, on) {
  if (!CHANNELS.includes(channel)) throw new Error(`没有这个通道：${channel}。可用：${CHANNELS.join(' / ')}`);
  const p = configPath();
  let raw = {};
  if (existsSync(p)) raw = JSON.parse(readFileSync(p, 'utf-8'));
  raw.alert = { ...(raw.alert || {}), [channel]: Boolean(on) };
  writeFileSync(p, JSON.stringify(raw, null, 2) + '\n');
  return raw.alert;
}

export function formatSwitches(sw = alertSwitches()) {
  const mark = (v) => (v ? '开' : '关');
  return `通知 ${mark(sw.notify)} · 语音 ${mark(sw.voice)} · Bark ${mark(sw.bark)}`;
}
