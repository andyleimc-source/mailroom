// 项目/任务清单的唯一真相源：直接扫 dailymd 磁盘上的 projects/ 目录。
// ⚠ 网页不许自己存一份任务表——Andy 在终端跑 new-task.sh 建了任务，网页刷新就该看见；
//   任务归档了，网页也该跟着消失。两边各存一份必然漂移，漂移的后果是消息被归到一个
//   已经归档、Andy 再也翻不到的死任务下。
//
// 不扫 archive/：归档掉的任务不许出现在归位可选清单里。但 resolve() 要能在 archive/
// 里找到目录——Andy 翻旧消息时用得上（归档只是从「可选清单」里退出，不是从磁盘消失）。

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { readFields } from './frontmatter.mjs';

// 缓存 3 秒：listTree 这种目录扫描在一次归位流程里可能被反复调用，没必要每次都重新
// 走一遍文件系统。3 秒足够盖住一次归位的耗时，又短到不会让「刚建的任务看不见」发生——
// 别在这做更复杂的失效逻辑（YAGNI）。
const CACHE_MS = 3000;
const cache = new Map(); // dailymd 根路径 -> { at, tree }

// 用 T99 Task 1 的 meta.mjs::readFields 读 frontmatter——跟网页写字段走的是同一套
// 解析（比如 `desc: "带: 冒号的描述"` 能正确解出冒号），不再在这个文件里另起一份
// 不解引号的平铺解析器（那份旧版会把冒号后面的内容错当成新字段切断）。
// relPath 必须是 `projects/...` 形状（readFields 的门只认这个），listTree 只扫
// dailymd/projects/ 下面的目录，天然满足。读不到（没有 frontmatter、文件不存在）
// 就退回空字段，跟旧版 parseProgress 的兜底行为一致。
function readFrontmatter(dailymd, relPath) {
  try {
    const { fields, body } = readFields(dailymd, relPath);
    const h = body.match(/^#\s+(.+)$/m);
    return { fm: fields, title: h ? h[1].trim() : '' };
  } catch {
    return { fm: {}, title: '' };
  }
}

// readMeta() 专用：readFields 的门只认 `dailymd/projects/...` 这一种相对路径形状，
// 而 readMeta() 拿到的是已经解析好的绝对目录（可能来自 archive/，见下方注释），
// 没有 root 可换算相对路径，没法走 readFrontmatter。这里保留一份极简平铺解析，
// 只给 readMeta() 一个调用方用，别的地方都走上面 readFrontmatter。
function parseProgress(path) {
  let text = '';
  try { text = readFileSync(path, 'utf-8'); } catch { return { fm: {}, title: '' }; }
  const fm = {};
  let body = text;
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
      if (kv) fm[kv[1]] = kv[2].trim();
    }
    body = m[2];
  }
  const h = body.match(/^#\s+(.+)$/m);
  return { fm, title: h ? h[1].trim() : '' };
}

function listDirs(path, re) {
  let entries = [];
  try { entries = readdirSync(path, { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => e.isDirectory() && re.test(e.name)).map((e) => e.name).sort();
}

function scanProject(dailymd, dir) {
  const projectPath = join(dailymd, 'projects', dir);
  const { fm, title } = readFrontmatter(dailymd, `projects/${dir}/progress.md`);
  const code = fm.code || (dir.match(/^P\d+/) || [dir])[0];
  const slug = fm.slug || dir.replace(/^P\d+-/, '');
  const tasks = listDirs(join(projectPath, 'tasks'), /^T\d+-/).map((tdir) => {
    const { fm: tfm, title: ttitle } = readFrontmatter(dailymd, `projects/${dir}/tasks/${tdir}/progress.md`);
    const tcode = tfm.code || (tdir.match(/^T\d+/) || [tdir])[0];
    return {
      code: tcode,
      dir: tdir,
      // frontmatter 的 title 是 Andy 定的中文标题，优先级高于一级标题——
      // 历史卡的一级标题大量还是 `T97 — 2026-08-09-g2-review-invitations` 这种英文 slug。
      title: tfm.title || ttitle || tfm.slug || tdir,
      status: tfm.status || 'active',
      // 前端要能直接渲染/编辑这四项，缺了就给空串（不是 undefined），
      // 跟 meta.mjs 的 FIELDS 白名单是同一套键名。
      desc: tfm.desc || '',
      start: tfm.start || '',
      due: tfm.due || '',
      owner: tfm.owner || '',
    };
  });
  return {
    code,
    slug,
    dir,
    name: fm.title || title || slug,
    tasks,
    // ⚠ 项目也要给 status。原来只有任务有，结果左栏「过了截止日期」的警示点在项目行上
    //   只能看日期不看状态——一个已经收尾的项目照样一直亮着红点。
    //   兜底给 'active' 而不是空串：进不了这份清单的项目本来就说明它没归档。
    status: fm.status || 'active',
    desc: fm.desc || '',
    start: fm.start || '',
    due: fm.due || '',
    owner: fm.owner || '',
  };
}

// 字段改完必须把缓存打掉，否则 3 秒内重新拉 /api/tree 看到的还是旧值——
// Andy 会以为「保存没生效」而再按一次。建任务那条路径早就这么做了（见 newTask）。
export function invalidateTree(dailymd) {
  cache.delete(dailymd);
}

// 扫出所有项目及其任务。只看 projects/，不看 archive/——归档的东西不进这份清单。
export function listTree({ dailymd }) {
  const now = Date.now();
  const cached = cache.get(dailymd);
  if (cached && now - cached.at < CACHE_MS) return cached.tree;
  const tree = listDirs(join(dailymd, 'projects'), /^P\d+-/).map((dir) => scanProject(dailymd, dir));
  cache.set(dailymd, { at: now, tree });
  return tree;
}

// 一个任务/项目目录自己的标题和状态。
//
// ⚠ 为什么不让调用方去 listTree() 里捞：那份清单有 3 秒缓存、又**不扫 archive/**，
//   而这个函数是拿着一个已经解析好的目录去问「你叫什么、什么状态」，跟它在哪无关。
//   直接读那个目录的 progress.md，读不到就给空串，别让调用方按目录名瞎拼一个。
export function readMeta(dir) {
  if (!dir) return { code: '', title: '', status: '' };
  const { fm, title } = parseProgress(join(dir, 'progress.md'));
  return {
    code: fm.code || '',
    title: title || fm.slug || '',
    status: fm.status || '',
  };
}

// 给出任务目录的绝对路径。project/task 传目录名（如 'P26-agent-ready-sites' /
// 'T70-2026-08-05-three-sites-recon'，跟 listTree() 里 Project.dir / Task.dir 一致）。
// 先在 projects/ 下找；找不到再去 archive/ 找（archive 镜像 projects/ 结构，见 CLAUDE.md）。
// 两处都没有就是真不存在，返回 null。
export function resolve({ dailymd, project, task }) {
  for (const base of ['projects', 'archive']) {
    const p = join(dailymd, base, project, 'tasks', task);
    if (existsSync(p)) return p;
  }
  return null;
}

// 建新任务。⚠ 必须调 scripts/new-task.sh，不自己分配编号——编号注册表 assets/codes.md
// 由那个脚本维护，自己写编号一定跟它打架。
// title 是中文标题，new-task.sh 那边是必填的——Andy 看到的就是它。
// 判定没给就拿 slug 兜底，让归位不至于因为模型漏填一个字段就整段卡住。
export function createTask({ dailymd, project, slug, title, desc }) {
  const script = join(dailymd, 'scripts', 'new-task.sh');
  const args = [slug, project, '--title', title || slug];
  if (desc) args.push('--desc', desc);
  const out = execFileSync(script, args, { cwd: dailymd, encoding: 'utf-8' });
  const m = out.match(/^✅ created: (.+)\/progress\.md\s+\[(T\d+)\]/m);
  if (!m) throw new Error(`new-task.sh 输出解析失败，看不出建到哪了：${out}`);
  const rel = m[1];
  const code = m[2];
  const dir = rel.split('/').pop();
  cache.delete(dailymd); // 刚建的任务不能被 3 秒缓存挡住，让下一次 listTree() 立刻看见
  return { code, dir, path: join(dailymd, rel) };
}
