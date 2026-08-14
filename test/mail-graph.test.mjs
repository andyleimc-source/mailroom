// ms365 传输层。⚠ 不连微软：fetch 和钥匙串读写全部注入掉。
//   这里测的是令牌刷新的分支、Graph 请求拼得对不对、以及「草稿不许调 /send」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpState } from './helpers.mjs';
import {
  bootstrapFromMcp, deviceCodeLogin, accessToken, graphFetch, graphMarkRead, graphSaveDraft, graphSend,
} from '../mail/graph.mjs';
import { MailAuthError } from '../lib.mjs';

tmpState();

const MCP_CACHE = JSON.stringify({
  Account: { k: { username: 'me@acme.com', realm: 'tenant-1' } },
  RefreshToken: { k: { client_id: 'client-1', secret: 'rt-old' } },
});

function deps(over = {}) {
  const store = { 'mailroom-graph': null, 'ms-365-mcp-server': MCP_CACHE };
  return {
    store,
    readKeychain: (service) => store[service],
    writeKeychain: (service, value) => { store[service] = value; },
    fetchImpl: async () => { throw new Error('测试没有注入 fetchImpl'); },
    ...over,
  };
}

test('引导：把 MCP 缓存里的 refresh token 拷进 mailroom 自己那份', () => {
  const d = deps();
  const r = bootstrapFromMcp(d);
  assert.equal(r.address, 'me@acme.com');
  const mine = JSON.parse(d.store['mailroom-graph']);
  assert.equal(mine.refreshToken, 'rt-old');
  assert.equal(mine.clientId, 'client-1');
  assert.equal(mine.tenant, 'tenant-1');
});

test('引导：MCP 那边没登录过就明说，别写一份空的进去', () => {
  const d = deps({ readKeychain: () => null });
  assert.throws(() => bootstrapFromMcp(d), /ms365 MCP/);
});

test('刷新令牌：换回来的新 refresh token 要写回钥匙串', async () => {
  const d = deps();
  bootstrapFromMcp(d);
  d.fetchImpl = async () => ({
    ok: true, status: 200,
    json: async () => ({ access_token: 'at-1', expires_in: 3600, refresh_token: 'rt-new' }),
  });
  const at = await accessToken(d);
  assert.equal(at, 'at-1');
  assert.equal(JSON.parse(d.store['mailroom-graph']).refreshToken, 'rt-new');
});

test('refresh token 失效 → MailAuthError，不是普通报错', async () => {
  const d = deps();
  bootstrapFromMcp(d);
  d.fetchImpl = async () => ({
    ok: false, status: 400,
    text: async () => '{"error":"invalid_grant"}',
  });
  await assert.rejects(() => accessToken(d), MailAuthError);
});

test('取信：拼出带 $filter 的增量查询，并整理成 ParsedMail', async () => {
  const d = deps();
  bootstrapFromMcp(d);
  const urls = [];
  d.fetchImpl = async (url) => {
    urls.push(String(url));
    if (String(url).includes('oauth2')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'at', expires_in: 3600 }) };
    }
    return {
      ok: true, status: 200,
      json: async () => ({ value: [{
        id: 'g1', conversationId: 'c1', receivedDateTime: '2026-08-10T06:34:14Z',
        subject: '关于 G2',
        internetMessageId: '<msg-1@corp-mail.com>',
        from: { emailAddress: { name: '李雷', address: 'lei.li@corp-mail.com' } },
        toRecipients: [{ emailAddress: { name: '', address: 'me@acme.com' } }],
        ccRecipients: [], hasAttachments: false,
        replyTo: [{ emailAddress: { name: 'Bob', address: 'bob@client-corp.com' } }],
        body: { contentType: 'html', content: '<p>你好</p>' },
      }] }),
    };
  };
  const r = await graphFetch({ since: '2026-08-10T00:00:00Z', top: 50, deps: d });
  const q = urls.find((u) => u.includes('messages'));
  assert.match(q, /mailFolders\/inbox\/messages/);
  // ⚠ 过滤器必须是 ge（含等于），不是 gt——同秒到达的边界要靠 seenIds 二次去重，
  //   不能靠 gt 直接把整秒排除在查询之外，否则会静默永久丢信（见 graph.mjs 里的注释）。
  assert.match(q, /receivedDateTime%20ge%202026-08-10T00%3A00%3A00Z/);
  assert.doesNotMatch(q, /receivedDateTime\S*gt\S*2026-08-10/);
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].id, 'g1');
  assert.equal(r.messages[0].threadId, 'c1');
  assert.equal(r.messages[0].at, '2026-08-10T06:34:14Z');
  assert.equal(r.messages[0].from.address, 'lei.li@corp-mail.com');
  assert.equal(r.messages[0].html, '<p>你好</p>');
  assert.equal(r.messages[0].messageIdHeader, '<msg-1@corp-mail.com>');
  // ⚠⚠ Reply-To 必须取出来：回信真正会送到的是它，不是 From（见 connect/mail.mjs 的外部判定）
  assert.deepEqual(r.messages[0].replyTo, [{ name: 'Bob', address: 'bob@client-corp.com' }]);
  assert.match(q, /replyTo/, '$select 里没有 replyTo 的话，Graph 根本不会把这个字段回给我们');
  assert.equal(r.lastReceived, '2026-08-10T06:34:14Z');
  assert.deepEqual(r.seenIds, ['g1']);
});

test('同秒边界不丢消息：分页把同一秒的两封拆开，第二轮靠 seenIds 去重找回真正新的那封', async () => {
  const d = deps();
  bootstrapFromMcp(d);
  const AT = '2026-08-10T06:34:14Z';
  const mk = (id, subject) => ({
    id, conversationId: 'c1', receivedDateTime: AT, subject,
    from: { emailAddress: { name: '', address: 'x@y.com' } },
    toRecipients: [], ccRecipients: [], hasAttachments: false,
    body: { contentType: 'html', content: `<p>${subject}</p>` },
  });
  const A = mk('a1', 'A');
  const B = mk('b1', 'B');
  let call = 0;
  d.fetchImpl = async (url) => {
    if (String(url).includes('oauth2')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'at', expires_in: 3600 }) };
    }
    call += 1;
    // 第一轮模拟 $top 把同一秒的两封拆到了页边界两侧，服务端只吐出 A；
    // 第二、三轮模拟 ge 把这一秒的 A、B 都重新带回来。
    return { ok: true, status: 200, json: async () => ({ value: call === 1 ? [A] : [A, B] }) };
  };

  // ⚠ 这里必须给一个真实的 since：since 为空走的是「建基线」那条分支（倒序取最新一封、
  //   不产消息），跟本用例要验的同秒边界无关。
  const r1 = await graphFetch({ since: '2026-08-10T00:00:00Z', seenIds: [], top: 1, deps: d });
  assert.deepEqual(r1.messages.map((m) => m.id), ['a1']);
  assert.equal(r1.lastReceived, AT);
  assert.deepEqual(r1.seenIds, ['a1']);

  const r2 = await graphFetch({ since: r1.lastReceived, seenIds: r1.seenIds, top: 50, deps: d });
  // A 已经在 seenIds 里，被二次去重掉；B 才是真正的新邮件。
  assert.deepEqual(r2.messages.map((m) => m.id), ['b1']);
  assert.equal(r2.lastReceived, AT);
  assert.ok(r2.seenIds.includes('a1'));
  assert.ok(r2.seenIds.includes('b1'));

  const r3 = await graphFetch({ since: r2.lastReceived, seenIds: r2.seenIds, top: 50, deps: d });
  // 第三轮 A、B 都已经在 seenIds 里了，不许再冒出来一次。
  assert.deepEqual(r3.messages.map((m) => m.id), []);
});

test('建基线（since 为空）：倒序取最新一封、一条消息都不产，水位线落在最新那封上', async () => {
  const d = deps();
  bootstrapFromMcp(d);
  const OLDEST = {
    id: 'oldest', conversationId: 'c0', receivedDateTime: '2025-12-04T11:25:00Z', subject: '很久以前',
    from: { emailAddress: { name: '', address: 'x@y.com' } },
    toRecipients: [], ccRecipients: [], hasAttachments: false, body: { contentType: 'text', content: '' },
  };
  const NEWEST = { ...OLDEST, id: 'newest', receivedDateTime: '2026-08-11T03:19:13Z', subject: '刚到' };
  let q = '';
  d.fetchImpl = async (url) => {
    if (String(url).includes('oauth2')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'at', expires_in: 3600 }) };
    }
    q = String(url);
    // 服务端按请求里的 orderby 决定顺序：desc 就该把最新那封放在第一条。
    const desc = q.includes('desc');
    return { ok: true, status: 200, json: async () => ({ value: desc ? [NEWEST] : [OLDEST, NEWEST] }) };
  };

  const r = await graphFetch({ since: '', seenIds: [], top: 50, deps: d });
  assert.match(q, /desc/, '建基线必须倒序查，正序会把水位线钉在收件箱最旧那页');
  assert.match(q, /%24top=1/.test(q) ? /%24top=1/ : /\$top=1/, '建基线只需要最新一封');
  assert.deepEqual(r.messages, [], '建基线不产候选，否则第一轮会把整个收件箱倒出来');
  assert.equal(r.lastReceived, '2026-08-11T03:19:13Z', '水位线要落在最新那封上，不是最旧那封');
  assert.deepEqual(r.seenIds, ['newest']);
  assert.equal(r.baseline, true);
});

test('seenIds 上限 200：喂 250 个只保留最近的 200 个', async () => {
  const d = deps();
  bootstrapFromMcp(d);
  d.fetchImpl = async (url) => {
    if (String(url).includes('oauth2')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'at', expires_in: 3600 }) };
    }
    return { ok: true, status: 200, json: async () => ({ value: [] }) };
  };
  const oldIds = Array.from({ length: 250 }, (_, i) => `old-${i}`);
  const r = await graphFetch({ since: '2026-08-10T00:00:00Z', seenIds: oldIds, top: 50, deps: d });
  assert.equal(r.seenIds.length, 200);
  assert.deepEqual(r.seenIds, oldIds.slice(-200));
});

test('一封都没抓到：lastReceived 原样退回入参 since，不倒退也不会被清空', async () => {
  const d = deps();
  bootstrapFromMcp(d);
  d.fetchImpl = async (url) => {
    if (String(url).includes('oauth2')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'at', expires_in: 3600 }) };
    }
    return { ok: true, status: 200, json: async () => ({ value: [] }) };
  };
  const r = await graphFetch({ since: '2026-08-10T00:00:00Z', seenIds: ['x'], top: 50, deps: d });
  assert.equal(r.lastReceived, '2026-08-10T00:00:00Z');
  assert.deepEqual(r.messages, []);
  assert.deepEqual(r.seenIds, ['x']);
});

test('标已读走 PATCH isRead', async () => {
  const d = deps();
  bootstrapFromMcp(d);
  const calls = [];
  d.fetchImpl = async (url, opt) => {
    if (String(url).includes('oauth2')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'at', expires_in: 3600 }) };
    }
    calls.push({ url: String(url), method: opt.method, body: opt.body });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  await graphMarkRead(['g1'], { deps: d });
  assert.equal(calls[0].method, 'PATCH');
  assert.match(calls[0].url, /\/me\/messages\/g1$/);
  assert.deepEqual(JSON.parse(calls[0].body), { isRead: true });
});

test('存草稿：createReply 之后只 PATCH 正文，绝不调 /send', async () => {
  const d = deps();
  bootstrapFromMcp(d);
  const urls = [];
  d.fetchImpl = async (url, opt) => {
    const u = String(url);
    if (u.includes('oauth2')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'at', expires_in: 3600 }) };
    }
    urls.push(`${(opt && opt.method) || 'GET'} ${u}`);
    return { ok: true, status: 200, json: async () => ({ id: 'draft-1', webLink: 'https://outlook/x' }) };
  };
  const r = await graphSaveDraft({ replyToId: 'g1', html: '<p>好的</p>' }, { deps: d });
  assert.equal(r.ok, true);
  assert.ok(urls.some((u) => u.includes('/createReply')));
  assert.ok(urls.some((u) => u.startsWith('PATCH')));
  assert.ok(!urls.some((u) => u.includes('/send')), '存草稿这条路绝不许碰 /send');
});

test('正文一律 html，不许 text', async () => {
  const d = deps();
  bootstrapFromMcp(d);
  let patched = null;
  d.fetchImpl = async (url, opt) => {
    const u = String(url);
    if (u.includes('oauth2')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'at', expires_in: 3600 }) };
    }
    if ((opt && opt.method) === 'PATCH') patched = JSON.parse(opt.body);
    return { ok: true, status: 200, json: async () => ({ id: 'draft-1' }) };
  };
  await graphSaveDraft({ replyToId: 'g1', html: '<p>x</p>' }, { deps: d });
  assert.equal(patched.body.contentType, 'html');
});

test('传输层里不许出现身份声明和称呼门（那两样只在 send.mjs）', () => {
  const src = readFileSync(new URL('../mail/graph.mjs', import.meta.url), 'utf-8');
  assert.doesNotMatch(src, /enforceAgentPrefix|checkCallName/);
});

test('真 IO 面接了闸：没注入 readKeychain/fetchImpl 时，测试环境下必须拒绝真跑', () => {
  // bootstrapFromMcp 不传 deps.readKeychain → 落到默认实现（真读钥匙串），
  // 必须被 assertNoRealIO 挡在门口，不许真的去敲 macOS 钥匙串。
  assert.throws(() => bootstrapFromMcp({}), /不许真跑|MAILROOM_ALLOW_REAL_IO/);
});

test('设备码登录 · 正常路径：onPrompt 接收信息，轮询 pending 后拿到令牌并写入钥匙串', async () => {
  let promptReceived = null;
  const sleptMs = [];
  let writtenKey = null;
  let writtenVal = null;

  let tokenCall = 0;
  const mockFetch = async (url) => {
    const u = String(url);
    if (u.includes('/devicecode')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          device_code: 'dc-123',
          user_code: 'UC-4567',
          verification_uri: 'https://microsoft.com/devicelogin',
          expires_in: 900,
          interval: 5,
          message: '请在浏览器打开验证',
        }),
      };
    }
    if (u.includes('/token')) {
      tokenCall += 1;
      if (tokenCall === 1) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: 'authorization_pending', error_description: 'Waiting' }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'at-device-1',
          refresh_token: 'rt-device-1',
          expires_in: 3600,
        }),
      };
    }
    throw new Error(`Unexpected URL: ${u}`);
  };

  const res = await deviceCodeLogin({
    account: { id: 'test', address: 'user@acme.com' },
    clientId: 'client-xyz',
    tenant: 'common',
    onPrompt: (info) => { promptReceived = info; },
    sleep: async (ms) => { sleptMs.push(ms); },
    deps: {
      fetchImpl: mockFetch,
      writeKeychain: (service, val) => {
        writtenKey = service;
        writtenVal = JSON.parse(val);
      },
    },
  });

  assert.equal(res.ok, true);
  assert.equal(res.address, 'user@acme.com');
  assert.deepEqual(promptReceived, {
    verificationUri: 'https://microsoft.com/devicelogin',
    userCode: 'UC-4567',
    expiresIn: 900,
    message: '请在浏览器打开验证',
  });
  assert.deepEqual(sleptMs, [5000]);
  assert.equal(writtenKey, 'mailroom-test');
  assert.equal(writtenVal.clientId, 'client-xyz');
  assert.equal(writtenVal.refreshToken, 'rt-device-1');
  assert.equal(writtenVal.accessToken, 'at-device-1');
});

test('设备码登录 · slow_down：轮询间隔加 5 秒，断言 sleep 传入时间变大', async () => {
  const sleptMs = [];
  let tokenCall = 0;
  const mockFetch = async (url) => {
    const u = String(url);
    if (u.includes('/devicecode')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          device_code: 'dc-123',
          user_code: 'UC-4567',
          verification_uri: 'https://microsoft.com/devicelogin',
          expires_in: 900,
          interval: 5,
        }),
      };
    }
    if (u.includes('/token')) {
      tokenCall += 1;
      if (tokenCall === 1) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: 'slow_down' }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 }),
      };
    }
    throw new Error(`Unexpected URL: ${u}`);
  };

  await deviceCodeLogin({
    clientId: 'cid-slow',
    onPrompt: () => {},
    sleep: async (ms) => { sleptMs.push(ms); },
    deps: { fetchImpl: mockFetch, writeKeychain: () => {} },
  });

  assert.equal(sleptMs.length, 1);
  assert.equal(sleptMs[0], 10000);
  assert.ok(sleptMs[0] > 5000);
});

test('设备码登录 · expired_token：抛出异常且绝对不写钥匙串', async () => {
  let keychainWritten = false;
  const mockFetch = async (url) => {
    const u = String(url);
    if (u.includes('/devicecode')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ device_code: 'dc-exp', user_code: 'UC-EXP', expires_in: 900, interval: 5 }),
      };
    }
    if (u.includes('/token')) {
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: 'expired_token', error_description: 'Code expired' }),
      };
    }
    throw new Error(`Unexpected URL: ${u}`);
  };

  await assert.rejects(
    () => deviceCodeLogin({
      clientId: 'cid-exp',
      onPrompt: () => {},
      sleep: async () => {},
      deps: {
        fetchImpl: mockFetch,
        writeKeychain: () => { keychainWritten = true; },
      },
    }),
    /已过期/,
  );

  assert.equal(keychainWritten, false, 'expired_token 绝不许写入钥匙串');
});

test('设备码登录 · 没给 clientId：抛出错误指导如何去 Azure / Entra ID 注册应用', async () => {
  await assert.rejects(
    () => deviceCodeLogin({ clientId: '' }),
    /Entra ID.*公共客户端/,
  );
});
