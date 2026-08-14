// 测试专用夹具：造一份假 dailymd 骨架 + 一份假状态目录 + 一个假消息来源适配器。
// 整轮集成测试靠这些把「取数 → 归位 → 落盘」这条链真正跑一遍，
// 不碰 小明 真实的 dailymd 和真实的 ~/.mailroom。

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 建一个临时状态目录并顶掉 process.env.MAILROOM_STATE。
// lib.mjs 里的 stateDir() 是函数，每次调用现读环境变量，不是模块加载时定死的常量——
// 所以这个函数可以在任何时候调用，不必抢在 `import '../run.mjs'` 之前，
// 每条测试各自调一次就能拿到互不干扰的状态目录。
// cleanup() 删掉临时目录、把环境变量还原成调用前的值，测试跑完必须调用。
// 测试用的身份。**故意不是任何真人**——夹具里出现真名，一是会跟着代码发布出去，
// 二是断言会跟某个人的名字长度耦合。改这里等于全库测试一起改。
export const TEST_IDENTITY = { name: '王小明', callName: '小明' };

// 写一份测试配置进当前状态目录。tmpState() 默认会调它，单独用于「只想改某几项」的场景。
export function writeTestConfig(dir, overrides = {}) {
  const base = {
    identity: { ...TEST_IDENTITY },
    hap: { enabled: true, accountId: 'test-account-0001' },
    mail: {
      enabled: true,
      internalDomains: ['acme.com', 'corp-mail.com'],
      accounts: [
        { id: 'work', address: 'me@acme.com', transport: 'graph', label: 'work',
          graph: { clientId: 'test-client-id', tenant: 'common' } },
        { id: 'corp', address: 'me@corp-mail.com', transport: 'imap', label: 'corp',
          imap: { host: 'imap.example.com', port: 993 },
          smtp: { host: 'smtp.example.com', port: 465, ssl: true } },
      ],
    },
  };
  const cfg = { ...base, ...overrides };
  for (const k of Object.keys(base)) {
    if (overrides[k] && typeof overrides[k] === 'object' && !Array.isArray(overrides[k])) {
      cfg[k] = { ...base[k], ...overrides[k] };
    }
  }
  writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
  return cfg;
}

export function tmpState(configOverrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mailroom-state-'));
  const prev = process.env.MAILROOM_STATE;
  process.env.MAILROOM_STATE = dir;
  writeTestConfig(dir, configOverrides);
  const cleanup = () => {
    rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.MAILROOM_STATE;
    else process.env.MAILROOM_STATE = prev;
  };
  return { dir, cleanup };
}

// 建一个临时 dailymd 骨架，回来的 root 传给 runOnce({ dailymd: root })。
// cleanup() 删掉整个临时目录，测试跑完必须调用，别在真实 tmp 目录里堆垃圾。
export function tmpDailymd() {
  const root = mkdtempSync(join(tmpdir(), 'mailroom-'));

  const write = (rel, content) => {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  };

  write('projects/P26-agent-ready-sites/progress.md', [
    '---',
    'type: project',
    'code: P26',
    'slug: agent-ready-sites',
    'status: active',
    'goal: G2',
    'created: 2026-08-01',
    '---',
    '',
    '# Progress',
    '',
  ].join('\n'));

  write('projects/P26-agent-ready-sites/tasks/T70-2026-08-05-three-sites-recon/progress.md', [
    '---',
    'type: task',
    'code: T70',
    'slug: 2026-08-05-three-sites-recon',
    'project: P26-agent-ready-sites',
    'status: in-progress',
    'created: 2026-08-05',
    '---',
    '',
    '# T70 — three sites recon',
    '',
  ].join('\n'));

  write('projects/P26-agent-ready-sites/tasks/T89-2026-08-07-help-center-repo-access/progress.md', [
    '---',
    'type: task',
    'code: T89',
    'slug: 2026-08-07-help-center-repo-access',
    'project: P26-agent-ready-sites',
    'status: in-progress',
    'created: 2026-08-07',
    '---',
    '',
    '# T89 — help center repo access',
    '',
  ].join('\n'));

  write('projects/P12-mpc2026/tasks/T88-2026-08-07-sponsor-zh-pdf-v2/progress.md', [
    '---',
    'type: task',
    'code: T88',
    'slug: 2026-08-07-sponsor-zh-pdf-v2',
    'project: P12-mpc2026',
    'status: in-progress',
    'created: 2026-08-07',
    '---',
    '',
    '# T88 — sponsor zh pdf v2',
    '',
  ].join('\n'));

  write('projects/P00-misc/progress.md', [
    '---',
    'type: project',
    'code: P00',
    'slug: misc',
    'status: active',
    'goal: G0',
    'created: 2025-01-01',
    '---',
    '',
    '# Progress',
    '',
  ].join('\n'));

  write('assets/codes.md', [
    '# 编号注册表',
    '',
    '| code | path |',
    '|---|---|',
    '| P26 | projects/P26-agent-ready-sites |',
    '| T70 | projects/P26-agent-ready-sites/tasks/T70-2026-08-05-three-sites-recon |',
    '| T89 | projects/P26-agent-ready-sites/tasks/T89-2026-08-07-help-center-repo-access |',
    '| P12 | projects/P12-mpc2026 |',
    '| T88 | projects/P12-mpc2026/tasks/T88-2026-08-07-sponsor-zh-pdf-v2 |',
    '| P00 | projects/P00-misc |',
    '',
  ].join('\n'));

  const cleanup = () => rmSync(root, { recursive: true, force: true });
  return { root, cleanup };
}

// 假的消息来源适配器：不真连明道云，candidates 是调用方写死的一批「待判断」条目。
// 形状对齐 run.mjs 期待的 adapter 接口——kind/pull/sendVia/describe。
export function fakeAdapter(candidates) {
  return {
    kind: 'mingdao',
    pull: () => ({ candidates, records: [], firstRun: false, noNews: false, authError: null }),
    sendVia: (item, body) => ({ channel: '私信', to: item.who }),
    describe: () => '明道云 · 私信',
  };
}
