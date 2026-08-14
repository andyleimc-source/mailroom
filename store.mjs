// ~/.mailroom 下两个 JSON：segments.json（段的运行态索引）/ state.json（杂项状态）
// ⚠ 权威在 dailymd 里：消息原文在 assets/hap-log/，时间线在各任务的 inbox.md。
//   这里这两份删了也只是「下一轮重收一次」，不会丢消息。
// 没有业务逻辑，只有读写。写用「先写 .tmp 再 rename」防半截文件。
import {
  readFileSync, writeFileSync, renameSync, mkdirSync, closeSync, openSync, statSync, unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { stateDir, healTimestamps } from './lib.mjs';

// ⚠ 每次现调 stateDir()，不缓存进变量——它是函数不是常量就是为了让测试能随时
//   顶掉 process.env.MAILROOM_STATE 立刻生效，缓存等于把它变回常量。
function path(name) { return join(stateDir(), name); }
function read(name, dflt) {
  try { return JSON.parse(readFileSync(path(name), 'utf-8')); } catch { return dflt; }
}
function write(name, val) {
  mkdirSync(stateDir(), { recursive: true });
  const tmp = `${path(name)}.tmp`;
  writeFileSync(tmp, JSON.stringify(val, null, 2));
  renameSync(tmp, path(name));
}
export function segments() { return read('segments.json', []); }
// ⚠ 同 appendSegment：运行态索引也在门口自愈，免得 UTC 串在这儿存下来，
//   下一轮渲染时又被切成早 8 小时的时间。
export function saveSegments(list) { write('segments.json', healTimestamps(list, 'segments.json')); }
export function stateGet(key, dflt) { const s = read('state.json', {}); return key in s ? s[key] : dflt; }
export function stateSet(key, val) { const s = read('state.json', {}); s[key] = val; write('state.json', s); }

// 旧版本这儿还有一套「跨进程加锁的读改写」（stateUpdate）——那是给屏蔽规则的命中
// 计数用的，两个常驻进程会同时累加同一个 key。屏蔽规则和常驻进程后来砍了，
// 锁跟着走。现在 state.json 的每个 key 都只有一个一次性进程会写。
