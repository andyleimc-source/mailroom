// 项目/任务 progress.md 的 frontmatter —— 只读。
//
// 前身是 msgfiler 的 meta.mjs（读 + 写）。网页砍掉之后写这一半没有调用方了：
// 改状态/描述/负责人现在是 Andy 在对话里说一句、我直接改 md，用不着这套
// 「只动 --- 头部、正文逐字节不碰」的原子写。**别把写那一半搬回来**——
// 它的全部复杂度都是为了让一个常驻网页进程去改 Andy 的真实库，那个前提没了。
//
// ⚠ 路径校验复用 file.mjs 已经踩过坑的那对门（okName + underProjects + 两个形状
//   正则），不在这里另造一套——两套判据早晚漂移，漂移的后果是路径穿越读到
//   dailymd 外面去。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { okName, underProjects, PROJECT_RE, TASK_RE } from './file.mjs';

function shapeOf(relPath) {
  const segs = String(relPath || '').split('/').filter(Boolean);
  if (segs[0] !== 'projects') return null;
  if (segs.length === 3 && segs[2] === 'progress.md' && okName(segs[1], PROJECT_RE)) {
    return { kind: 'project' };
  }
  if (segs.length === 5 && segs[2] === 'tasks' && segs[4] === 'progress.md'
    && okName(segs[1], PROJECT_RE) && okName(segs[3], TASK_RE)) {
    return { kind: 'task' };
  }
  return null;
}

// 两道门都过了才返回绝对路径，否则抛错——不静默降级。
function resolveTarget(root, relPath) {
  if (!shapeOf(relPath)) throw new Error(`不认这个路径，拒绝读：${relPath}`);
  const abs = join(root, relPath);
  if (!underProjects(root, abs)) throw new Error(`路径跑到 projects/ 外面了，拒绝：${relPath}`);
  return abs;
}

// ---------- frontmatter 解析：跟 tree.mjs 同一套宽容度 ----------
//
// 只认平铺 `key: value`，不是 YAML 解析器。跟 tree.mjs 的 parseProgress 用同一条
// 键名正则（字母/下划线），保证两边「认不认识这一行」的判断一致。
const KV_RE = /^([A-Za-z_]+):\s*(.*)$/;

function parseKv(line) {
  const m = KV_RE.exec(line);
  return m ? { key: m[1], raw: m[2] } : null;
}

// 值可能被加了引号（写的那一侧「有必要时才加」），所以读的一侧不能假设格式。
function decodeValue(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(s);
  if (m) return m[1].replace(/\\(.)/g, '$1');
  return s;
}

function parseDoc(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  return { lines: m[1].split(/\r?\n/), body: m[2] };
}

export function readFields(root, relPath) {
  const abs = resolveTarget(root, relPath);
  const text = readFileSync(abs, 'utf-8');
  const doc = parseDoc(text);
  if (!doc) throw new Error(`没有 frontmatter，读不出字段：${relPath}`);
  const fields = {};
  for (const line of doc.lines) {
    const kv = parseKv(line);
    // 认不出的行（YAML 多行列表之类）直接跳过——读的时候容忍，拿得到的字段照常返回。
    if (kv) fields[kv.key] = decodeValue(kv.raw);
  }
  return { fields, body: doc.body };
}
