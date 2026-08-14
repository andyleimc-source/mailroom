// bin/mailroom（命令行入口）的护栏。
//
// ⚠⚠ 它是 bash，不是 .mjs —— `test/send.test.mjs` 那两条「谁能 import send.mjs / 谁能设
//   MAILROOM_ROLE」的扫描只看 .mjs 文件，**扫不到它**。所以这个盲区必须在这儿单独堵上：
//   一个 bash 入口里写一行 `hap chat send-to-one ...` 就是第二条发送路，而那正是
//   2026-08-08 事故的形状（3 条以 小明 名义发给同事的消息绕过闸门直接发了，
//   明道云没有撤回接口）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'bin/mailroom');
const src = readFileSync(CLI, 'utf-8');
const code = src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

test('⚠⚠ bin/mailroom 里不许有任何直接发消息的命令', () => {
  assert.doesNotMatch(code, /hap\s+(chat|post)\b/,
    '命令行入口里出现 hap chat/post = 开了第二条发送路，正是 2026-08-08 事故的形状');
  assert.doesNotMatch(code, /MAILROOM_ROLE/,
    '只有 bin/send.mjs 能碰这个变量——它是「本进程有没有资格发送」的唯一锚点');
});

test('send 子命令只是原样转交给 bin/send.mjs，不自己加料', () => {
  const line = code.split('\n').find((l) => /^\s*send\)/.test(l));
  assert.ok(line, '应该有 send 这个分支');
  assert.match(line, /exec node "\$REPO\/bin\/send\.mjs" "\$@"/,
    'send 必须原样 exec 转交：这里一旦开始拼参数或改正文，闸门的判断依据就跟实际发出去的对不上');
});

test('每个子命令指到的文件都真的存在（打错一个字就是运行时才炸）', () => {
  for (const rel of ['bin/fetch.mjs', 'bin/file.mjs', 'bin/send.mjs', 'run-tests.sh']) {
    assert.ok(existsSync(join(ROOT, rel)), `${rel} 不存在，但 bin/mailroom 里引用了它`);
  }
});

test('help 打得出来，且退出码是 0', () => {
  const out = execFileSync(CLI, ['help'], { encoding: 'utf-8' });
  for (const sub of ['fetch', 'pending', 'status', 'doctor', 'log', 'sync', 'test', 'send']) {
    assert.match(out, new RegExp(`mailroom ${sub}`), `帮助里漏了 ${sub}`);
  }
});

test('不认识的子命令要报错退出，不能默默当成 status 跑', () => {
  assert.throws(() => execFileSync(CLI, ['并没有这个命令'], { encoding: 'utf-8', stdio: 'pipe' }));
});

test('⚠ 软链调用时也要找得到仓库根（装在 ~/bin/mailroom 就是这么用的）', () => {
  // 2026-08-09 装好第一次跑就撞上：dirname 拿到的是 ~/bin，往上一层成了 $HOME，
  // 于是 `mailroom fetch` 去跑 ~/bin/fetch.mjs。这条钉死解软链那一段还在。
  assert.match(code, /while \[ -L "\$SELF" \]/,
    '必须先解开软链再取仓库根，否则通过 ~/bin/mailroom 调用时路径全错');
});

// ---------- 转发到 work：全局只许有一份水位线 ----------
//
// ⚠⚠ 水位线是每台机器一个文件，git 同步不过来。两台各跑各的 = 同一条消息被判两遍、
//   回两遍，而明道云没有撤回接口。所以收发固定在 work，别的机器一律转发过去。
//   下面这几条盯的就是「转发这件事没被改漏」。

test('碰状态的子命令全在转发清单里，只看本机环境的一条都不许进去', () => {
  const branch = code.split('\n').find((l) => /forward_to_primary "\$@"/.test(code) && /^\s*status \| "" \|/.test(l));
  assert.ok(branch, '转发的那个 case 分支不见了');
  for (const sub of ['fetch', 'file', 'send', 'pending', 'log', 'status']) {
    assert.match(branch, new RegExp(`\\b${sub}\\b`), `${sub} 碰水位线/发消息，必须转发到 work`);
  }
  for (const sub of ['doctor', 'test', 'sync', 'mail-bootstrap']) {
    assert.doesNotMatch(branch, new RegExp(`\\b${sub}\\b`),
      `${sub} 问的是「这台机器环境对不对」，转走就永远看不到本机缺什么`);
  }
});

test('⚠ 转发出去的命令要带 MAILROOM_LOCAL=1，否则 work 上会再转发一次、无限套娃', () => {
  assert.match(code, /MAILROOM_LOCAL=1 \\\$HOME\/bin\/mailroom/,
    '远端那条命令必须显式关掉转发');
});

test('⚠ 转发真的会发生，且正文里的空格引号原样过去（send --text 天天有）', () => {
  // 假的 scutil（谎报本机是 mkp）、假的 ssh（把远端命令原样打出来）、假的 security
  // （不去读真钥匙串，免得弹系统授权框）。
  const bin = mkdtempSync(join(tmpdir(), 'mailroom-fwd-'));
  const stub = join(bin, 'stub-mailroom');
  writeFileSync(join(bin, 'scutil'), '#!/bin/sh\necho mkp\n');
  writeFileSync(stub, '#!/bin/sh\nfor a in "$@"; do printf "[%s]\\n" "$a"; done\n');
  // 远端登录 shell 是 zsh，所以这里也用 zsh 把那条命令行**真的重新解析一遍**，
  // 只把可执行文件换成上面那个只打印参数的桩——参数还原不回来，这条就红。
  writeFileSync(join(bin, 'ssh'),
    `#!/bin/zsh\nc="\${@: -1}"\nprint -r -- "$c"\neval "\${c//\\\$HOME\\/bin\\/mailroom/${stub}}"\n`);
  writeFileSync(join(bin, 'security'), '#!/bin/sh\nexit 1\n');
  const cfgFile = join(bin, 'config.json');
  writeFileSync(cfgFile, JSON.stringify({ topology: { primaryHost: 'work', primaryHostSsh: 'someone@primary.invalid' } }));
  for (const f of ['scutil', 'ssh', 'security', 'stub-mailroom']) chmodSync(join(bin, f), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, MAILROOM_CONFIG: cfgFile };
  delete env.MAILROOM_TEST;       // 测试模式下是不转发的，这条要测的正是转发本身
  delete env.NODE_TEST_CONTEXT;
  delete env.MAILROOM_LOCAL;
  const out = execFileSync(CLI, ['send', '--seg', 'x1', '--text', "他说 'ok'，明天 9 点"],
    { encoding: 'utf-8', env, stdio: ['ignore', 'pipe', 'ignore'] });

  assert.match(out, /MAILROOM_LOCAL=1/, '没转发，或者远端命令少了防回环那一段');
  assert.match(out, /\[send\]\n\[--seg\]\n\[x1\]\n\[--text\]\n/, '参数在远端被重新分词了');
  assert.match(out, /\[他说 'ok'，明天 9 点\]/,
    '正文在远端还原不出来——参数必须逐个包单引号再拼，别用 printf %q');
  rmSync(bin, { recursive: true, force: true });
});

test('MAILROOM_LOCAL=1 时不转发（自查靠它，人也靠它临时在本机跑）', () => {
  assert.match(code, /if \[ -z "\$\{MAILROOM_LOCAL:-\}" \] && \[ "\$TESTING" = 0 \]/,
    '转发的前置条件里必须同时有 MAILROOM_LOCAL 逃生口和测试模式短路');
});

// ---------- out：翻发信总账 ----------

test('out 子命令指到的文件真的存在，且在转发名单里', () => {
  assert.ok(existsSync(join(ROOT, 'bin/outbox-report.mjs')),
    'bin/mailroom 引用了 bin/outbox-report.mjs');
  const line = code.split('\n').find((l) => /status \| "" \| fetch/.test(l));
  assert.match(line, /\bout\b/,
    'out 读的是 ~/.mailroom 里的状态，必须跟 status/pending 一样转发到 work —— '
    + '收发状态全局只有 work 那一份');
});

test('⚠⚠ bin/mailroom 里不许有任何直接发消息的命令（含 hap task）', () => {
  assert.doesNotMatch(code, /hap\s+(chat|post|task)\b/,
    '命令行入口里出现 hap chat/post/task = 开了第二条发送路');
});

// ---------- 第一次跑的那道门 ----------
//
// 没有这道门的时候，刚装好的人跑一句 `mailroom` 会看到一屏**看起来一切正常**的状态：
// 知识库那行是兜底默认路径、hap 那行读的是系统级登录态——两样都跟「你配没配过」无关。
// 于是他以为装好了，接着跑 fetch，撞一串莫名其妙的错。
//
// ⚠ 这几条必须把 NODE_TEST_CONTEXT / MAILROOM_TEST 从子进程环境里摘掉：留着的话
//   bin/mailroom 会走测试模式，而测试模式正是要绕开这道门的，等于什么都没测。
function runCli(args, { config }) {
  const env = { ...process.env, MAILROOM_CONFIG: config };
  delete env.NODE_TEST_CONTEXT;
  delete env.MAILROOM_TEST;
  try {
    return { code: 0, out: execFileSync(CLI, args, { env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { code: e.status ?? -1, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

test('没配置就跑 → 引导去 setup，不装作一切正常', () => {
  const d = mkdtempSync(join(tmpdir(), 'mailroom-firstrun-'));
  try {
    const r = runCli([], { config: join(d, '不存在.json') });
    assert.match(r.out, /还没配过/, '第一次跑必须说清楚「你还没配」');
    assert.match(r.out, /mailroom setup/, '必须指出下一步敲什么');
    assert.match(r.out, /怎么称呼你/, '要说清为什么问——称呼是身份声明那句话的原料');
    assert.doesNotMatch(r.out, /上次收/, '不许在没配置时还打那屏正常状态，那正是误导人的地方');
    assert.notEqual(r.code, 0, '非交互场景下要以非 0 退出，别让脚本里的调用方以为成功了');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('help / doctor / test 不被这道门拦（没配置时它们本来就该能跑）', () => {
  const d = mkdtempSync(join(tmpdir(), 'mailroom-firstrun-'));
  try {
    const r = runCli(['help'], { config: join(d, '不存在.json') });
    assert.doesNotMatch(r.out, /还没配过/, 'help 是用来查怎么配的，被拦住就成了死循环');
    assert.match(r.out, /mailroom setup/, 'help 里本来就列着 setup');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
