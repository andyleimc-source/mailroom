// ms365（work）传输层：Microsoft Graph REST，node 内置 fetch，零依赖。
//
// ⚠ 本文件是传输层，不是闸。没有、也永远不许有授权判断和身份声明——那两样在 send.mjs。
// ⚠⚠ 这个文件里**没有「外部收件人直接发信」这条路径**。外部只能走 graphSaveDraft，
//   停在用户自己的草稿箱里等他点发送。判定在 connect/mail.mjs，这里只是不提供那个能力。
//
// 令牌怎么来的：
// 1. 主路径：`deviceCodeLogin` 自带设备码登录。任何人自己在 Azure 注册公共客户端应用后调用。
// 2. 快捷方式：`bootstrapFromMcp` 借 ms365 MCP 的 MSAL 缓存（在钥匙串 `ms-365-mcp-server` / `msal-token-cache` 里）。
//    把里面的 refresh token + client_id + tenant 拷进 mailroom 自己那份（`mailroom-<id>`），
//    之后两边各自刷新，互不干扰。
// ⚠ 不去改 MCP 那份缓存 —— 写坏了用户的 ms365 工具整个就用不了了。

import { execFileSync } from 'node:child_process';
import { assertNoRealIO, MailAuthError, log, ownerName } from '../lib.mjs';

const MCP_SERVICE = 'ms-365-mcp-server';
const MCP_ACCOUNT = 'msal-token-cache';
const SCOPE = [
  'https://graph.microsoft.com/Mail.ReadWrite',
  'https://graph.microsoft.com/Mail.Send',
  'offline_access',
].join(' ');

function serviceFor(acc) {
  if (acc && acc.keychainService) return acc.keychainService;
  if (acc && acc.id) return `mailroom-${acc.id}`;
  return 'mailroom-graph';
}

function accountFor(acc) {
  return (acc && acc.address) || '';
}

function readKeychainReal(service, account) {
  try {
    return execFileSync('security',
      ['find-generic-password', '-s', service, '-a', account, '-w'],
      { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

function writeKeychainReal(service, value, account) {
  execFileSync('security',
    ['add-generic-password', '-U', '-s', service, '-a', account, '-w', value]);
}

// ⚠⚠ 真 IO 面接闸的地方：跟 lib.mjs 的 hap()、mail/imap.mjs 的 defaultRun 一个道理——
//   测试忘了注入 readKeychain/writeKeychain/fetchImpl，就必须在真的敲钥匙串 / 真的打
//   Graph 接口之前被 assertNoRealIO 拦下来，不许悄悄跑真的。默认实现只在这一层接触
//   真 IO，deps 里传了什么就完全信什么、不再多管。
function io(deps = {}) {
  const acc = deps.account;
  const myService = serviceFor(acc);
  const myAccount = accountFor(acc);
  return {
    readKeychain: deps.readKeychain
      || ((service) => {
        assertNoRealIO(`ms365 读钥匙串 ${service}`);
        return readKeychainReal(service, service === MCP_SERVICE ? MCP_ACCOUNT : myAccount);
      }),
    writeKeychain: deps.writeKeychain
      || ((service, value) => {
        assertNoRealIO(`ms365 写钥匙串 ${service}`);
        writeKeychainReal(service, value, myAccount);
      }),
    fetchImpl: deps.fetchImpl
      || ((...args) => {
        assertNoRealIO('ms365 Graph fetch');
        return fetch(...args);
      }),
    service: myService,
    account: myAccount,
  };
}

export function bootstrapFromMcp(deps = {}) {
  const { readKeychain, writeKeychain, service, account } = io(deps);
  const raw = readKeychain(MCP_SERVICE);
  if (!raw) {
    throw new Error('ms365 MCP 还没登录过（钥匙串里没有 msal-token-cache）。'
      + `让 ${ownerName()} 在 Claude 里跑一次 ms365 的 login，再跑 mailroom mail-bootstrap。`);
  }
  let cache;
  try {
    const outer = JSON.parse(raw);
    cache = typeof outer.data === 'string' ? JSON.parse(outer.data) : (outer.data || outer);
  } catch (e) {
    throw new Error(`ms365 MCP 的令牌缓存读不懂：${String(e.message).slice(0, 200)}`);
  }
  const acct = Object.values(cache.Account || {})[0];
  const rt = Object.values(cache.RefreshToken || {})[0];
  if (!acct || !rt || !rt.secret) {
    throw new Error(`ms365 MCP 的令牌缓存里没有可用的 refresh token，让 ${ownerName()} 重新登录一次。`);
  }
  const mine = {
    address: acct.username || account || '',
    tenant: acct.realm || 'common',
    clientId: rt.client_id || '',
    refreshToken: rt.secret,
    accessToken: '',
    expiresAt: 0,
  };
  writeKeychain(service, JSON.stringify(mine));
  log(`ms365 令牌已引导：${mine.address}`);
  return { ok: true, address: mine.address };
}

// ⚠ 参数只有这一套写法：sleep / onPrompt 走具名参数，注入假实现走 deps。
//   别再开第二条「也能从 deps 里传」的路——这个仓库反复吃亏的就是「两套判据」。
export async function deviceCodeLogin({
  account, clientId, tenant = 'common', onPrompt, sleep, deps,
} = {}) {
  if (!clientId) {
    throw new Error('未提供 clientId。请去 Azure / Entra ID 注册公共客户端应用：'
      + 'Entra ID → 应用注册 → 新注册 → 选「公共客户端」→ 「允许公共客户端流」设为是 → API 权限加 Mail.ReadWrite / Mail.Send / offline_access');
  }

  const { fetchImpl, writeKeychain, service } = io({ account, ...deps });
  const sleepFn = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const promptHandler = onPrompt || (({ verificationUri, userCode, message }) => {
    log(message || `去这个网址 ${verificationUri} 输入这个码：${userCode}`);
  });

  const dcBody = new URLSearchParams({
    client_id: clientId,
    scope: SCOPE,
  });

  const dcRes = await fetchImpl(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/devicecode`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: dcBody.toString(),
    },
  );

  let dcData;
  try {
    dcData = await dcRes.json();
  } catch {
    const text = await dcRes.text().catch(() => '');
    throw new Error(`设备码响应解析失败（${dcRes.status}）：${text.slice(0, 200)}`);
  }

  if (!dcRes.ok) {
    const errCode = dcData.error || '';
    const errDesc = dcData.error_description || '';
    const fullErrText = `${errCode} ${errDesc}`;
    if (fullErrText.includes('AADSTS65001') || fullErrText.toLowerCase().includes('consent')) {
      throw new Error('拿不到令牌：你的租户不允许用户自行授权。让管理员在应用注册页点一次「代表组织授予管理员同意」，或者这个邮箱改走 IMAP。');
    }
    const msg = `${errCode} ${errDesc}`.trim() || `status ${dcRes.status}`;
    throw new Error(`请求设备码失败：${msg.slice(0, 200)}`);
  }

  const {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verificationUri,
    expires_in: expiresIn = 900,
    interval: rawInterval = 5,
    message,
  } = dcData;

  await promptHandler({ verificationUri, userCode, expiresIn, message });

  let intervalSec = Number(rawInterval) || 5;
  const startTime = Date.now();
  const endTime = startTime + (Number(expiresIn) * 1000);

  while (Date.now() < endTime) {
    const tokenBody = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: clientId,
      device_code: deviceCode,
    });

    const tokenRes = await fetchImpl(
      `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenBody.toString(),
      },
    );

    let tokenData;
    try {
      tokenData = await tokenRes.json();
    } catch {
      const text = await tokenRes.text().catch(() => '');
      throw new Error(`Token 响应解析失败（${tokenRes.status}）：${text.slice(0, 200)}`);
    }

    if (tokenRes.ok && tokenData.access_token && tokenData.refresh_token) {
      const address = (account && account.address) || '';
      const mine = {
        address,
        tenant,
        clientId,
        refreshToken: tokenData.refresh_token,
        accessToken: tokenData.access_token,
        expiresAt: Date.now() + (Number(tokenData.expires_in || 3600) * 1000),
      };
      writeKeychain(service, JSON.stringify(mine));
      return { ok: true, address: mine.address };
    }

    const errCode = tokenData.error || '';
    const errDesc = tokenData.error_description || '';
    const fullErrText = `${errCode} ${errDesc}`;

    if (errCode === 'authorization_pending') {
      await sleepFn(intervalSec * 1000);
    } else if (errCode === 'slow_down') {
      intervalSec += 5;
      await sleepFn(intervalSec * 1000);
    } else if (errCode === 'expired_token') {
      throw new Error(`设备码已过期：${errDesc || 'expired_token'}`);
    } else if (errCode === 'authorization_declined' || errCode === 'access_denied') {
      throw new Error(`授权被拒绝：${errDesc || errCode}`);
    } else if (fullErrText.includes('AADSTS65001') || fullErrText.toLowerCase().includes('consent')) {
      throw new Error('拿不到令牌：你的租户不允许用户自行授权。让管理员在应用注册页点一次「代表组织授予管理员同意」，或者这个邮箱改走 IMAP。');
    } else {
      const msg = `${errCode} ${errDesc}`.trim() || `status ${tokenRes.status}`;
      throw new Error(`登录失败：${msg.slice(0, 200)}`);
    }
  }

  throw new Error('设备码登录超时，请重新尝试。');
}

function loadMine(readKeychain, service) {
  const raw = readKeychain(service);
  if (!raw) {
    throw new MailAuthError('mailroom 还没有 ms365 令牌，先跑一次：mailroom mail-bootstrap');
  }
  return JSON.parse(raw);
}

export async function accessToken(deps = {}) {
  const { readKeychain, writeKeychain, fetchImpl, service } = io(deps);
  const mine = loadMine(readKeychain, service);
  // 提前 2 分钟换，别卡在边界上
  if (mine.accessToken && mine.expiresAt > Date.now() + 120000) return mine.accessToken;

  const body = new URLSearchParams({
    client_id: mine.clientId,
    grant_type: 'refresh_token',
    refresh_token: mine.refreshToken,
    scope: SCOPE,
  });
  const res = await fetchImpl(
    `https://login.microsoftonline.com/${mine.tenant}/oauth2/v2.0/token`,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() },
  );
  if (!res.ok) {
    const t = await res.text();
    // ⚠ 一律当认证失败往上抛：refresh token 过期/被撤销/管理员改了策略都长这样。
    //   上层据此停下来喊 Andy 重新登录，**不许**降级成「这一轮没有新邮件」。
    throw new MailAuthError(`ms365 令牌刷新失败（${res.status}）：${String(t).slice(0, 200)}。`
      + `让 ${ownerName()} 在 Claude 里重新跑一次 ms365 login，然后 mailroom mail-bootstrap`);
  }
  const tok = await res.json();
  mine.accessToken = tok.access_token;
  mine.expiresAt = Date.now() + (Number(tok.expires_in || 3600) * 1000);
  // Azure 每次刷新都会给一个新的 refresh token，不写回去的话早晚会失效。
  if (tok.refresh_token) mine.refreshToken = tok.refresh_token;
  writeKeychain(service, JSON.stringify(mine));
  return mine.accessToken;
}

async function graph(path, { method = 'GET', json, deps, account } = {}) {
  const options = { account, ...deps };
  const { fetchImpl } = io(options);
  const at = await accessToken(options);
  const res = await fetchImpl(`https://graph.microsoft.com/v1.0${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${at}`,
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(json ? { body: JSON.stringify(json) } : {}),
  });
  if (!res.ok) {
    const t = res.text ? await res.text() : '';
    if (res.status === 401) throw new MailAuthError(`Graph 401：${String(t).slice(0, 200)}`);
    throw new Error(`Graph ${method} ${path} 失败（${res.status}）：${String(t).slice(0, 300)}`);
  }
  return res.json();
}

function addr(x) {
  const e = (x && x.emailAddress) || {};
  return { name: e.name || '', address: e.address || '' };
}

function toParsed(m) {
  const isHtml = ((m.body && m.body.contentType) || '').toLowerCase() === 'html';
  return {
    id: m.id,
    threadId: m.conversationId || m.id,
    // Task 2 的 ParsedMail 形状里带这个字段（imap.py 里叫 Message-ID 头），
    // Graph 对应的是 internetMessageId——两边字段名对齐，归一化层才认得出来。
    messageIdHeader: m.internetMessageId || '',
    // ⚠⚠ 这里**故意保留 Graph 的原值**（通常是 UTC 的 `…Z`），不要 localIso 它：
    //   这个 at 会被回填成增量查询的水位线（`$filter=receivedDateTime ge <since>`），
    //   动它就是在动查询条件。时区归一化放在 normalize.mjs 的 `ts`（给人看的那份）。
    at: m.receivedDateTime || '',
    subject: m.subject || '',
    from: addr(m.from || m.sender),
    // ⚠⚠ Reply-To：**回信真正会送到的地址**。工单系统、转发网关、邮件列表、
    //   以及任何人手设的 Reply-To 都会让它跟 From 不是同一个人——
    //   `From: crm-notify@corp-mail.com` + `Reply-To: bob@client-corp.com` 这种
    //   只看 From 就是内部同事，回过去却落到客户手上。外部判定必须把它算进去
    //   （见 connect/mail.mjs 的 isExternalReply）。
    replyTo: (m.replyTo || []).map(addr),
    to: (m.toRecipients || []).map(addr),
    cc: (m.ccRecipients || []).map(addr),
    bcc: (m.bccRecipients || []).map(addr),
    text: isHtml ? '' : ((m.body && m.body.content) || ''),
    html: isHtml ? ((m.body && m.body.content) || '') : '',
    // Graph 的附件名要另外拉一趟，这里只记「有没有」——附件名不值得每轮多打一趟接口
    attachmentNames: m.hasAttachments ? ['(有附件，去邮箱看)'] : [],
  };
}

// ⚠ replyTo 必须在 $select 里：不点名要，Graph 就不回这个字段，外部判定会拿到空数组，
//   一封 Reply-To 指向客户的邮件就会被当成内部同事的信直发出去。
const SELECT = 'id,conversationId,internetMessageId,receivedDateTime,subject,from,sender,replyTo,'
  + 'toRecipients,ccRecipients,bccRecipients,hasAttachments,body,isRead';

// 水位线最多记这么多个 id。太大占地方，太小盖不住一轮同秒到达的邮件数——
// 200 是设计文档定的数（docs/superpowers/specs/2026-08-10-mailroom-email-design.md）。
const SEEN_IDS_MAX = 200;

// ⚠⚠ 为什么过滤器是 ge（含等于）不是 gt：`receivedDateTime` 精度到秒，
//   一个收件箱里两封邮件落在同一秒完全可能发生（自动化通知尤其常见）。
//   如果用 gt，水位线一旦推进到「这一秒」，下一轮查询会把这一秒**整个跳过**——
//   哪怕这一秒里还有一封因为 $top 分页被截在页外、这一轮根本没捞到的邮件，
//   它就永远捞不回来了、而且不报错，是静默丢信。
//   改成 ge 之后同一秒的边界会被重新连着捞一遍，靠 seenIds 做二次去重去掉
//   已经处理过的那些，只留真正新的——这就是设计文档里「ids 做二次去重
//   （同秒到达的边界）」这句话唯一讲得通的实现方式。
export async function graphFetch({
  since = '', seenIds = [], top = 50, account, deps,
} = {}) {
  const options = { account, ...deps };
  // ⚠⚠ 没有水位线（首轮）时必须**倒序取最新一封**来建基线，不能走下面那条
  //   `asc` 的正常查询。事故：2026-08-10 首次接 work 邮箱，基线走了 asc 分页，
  //   `lastReceived` 落在收件箱里**最旧**那一页的末尾（2025-12），于是往后每一轮
  //   都只往前挪一页 49 封，一路补 2025 年的历史——七个月的积压要 60 轮才爬到今天，
  //   最新的邮件反而一封都收不到。基线的语义是「从现在开始收」，不是「从头开始补」。
  if (!since) {
    const baseParams = [
      '$top=1',
      `$orderby=${encodeURIComponent('receivedDateTime desc')}`,
      `$select=${encodeURIComponent(SELECT)}`,
    ];
    const d = await graph(`/me/mailFolders/inbox/messages?${baseParams.join('&')}`, { deps: options });
    const newest = (d.value || []).map(toParsed)[0];
    return {
      messages: [],
      lastReceived: (newest && newest.at) || new Date().toISOString(), // utc-ok: 水位线
      seenIds: newest ? [newest.id] : [],
      baseline: true,
    };
  }
  // 查询参数分开拼：$top/$orderby/$select 这几个键名前面的 $ 不能被当成表单值
  // 编码掉（会变成 %24top，虽然服务端多半会解码回来，没必要冒这个险）；
  // 真正需要编码的是**值**——尤其 since 这种带冒号的时间戳，直接拼进 URL
  // 靠 fetch 的 URL 解析兜底是个隐患，这里显式 encodeURIComponent。
  const params = [
    `$top=${encodeURIComponent(top)}`,
    `$orderby=${encodeURIComponent('receivedDateTime asc')}`,
    `$select=${encodeURIComponent(SELECT)}`,
  ];
  if (since) params.push(`$filter=${encodeURIComponent(`receivedDateTime ge ${since}`)}`);
  const path = `/me/mailFolders/inbox/messages?${params.join('&')}`;
  const data = await graph(path, { deps: options });
  // Graph 按 receivedDateTime asc 排序返回，fetched 里最后一条就是这一批里最新的。
  const fetched = (data.value || []).map(toParsed);

  const seenSet = new Set(seenIds);
  // 二次去重：ge 带回来的、上一轮已经处理过的那些边界邮件，这里剔掉，
  // 剩下的才是真正要交给上层的新邮件。
  const messages = fetched.filter((m) => !seenSet.has(m.id));

  // lastReceived 按「这一轮抓到的所有邮件」（含被去重掉的）算，不是按 messages 算——
  // 空抓一轮就原样退回 since，绝不倒退、也不会因为 fetched 为空而被清空。
  const lastReceived = fetched.length ? (fetched[fetched.length - 1].at || since) : since;

  // seenIds 滚动窗口：这一轮抓到的 id（含被去重掉的，它们下一轮还会被 ge 带回来，
  // 得继续认得出）追加到旧列表末尾，旧列表里跟这一轮重复的先摘掉再拼，
  // 避免同一个 id 在窗口里出现两次，最后只留最近 200 个。
  const fetchedIds = fetched.map((m) => m.id);
  const fetchedIdSet = new Set(fetchedIds);
  const keptOld = seenIds.filter((id) => !fetchedIdSet.has(id));
  const nextSeenIds = [...keptOld, ...fetchedIds].slice(-SEEN_IDS_MAX);

  return { messages, lastReceived, seenIds: nextSeenIds };
}

export async function graphMarkRead(ids, { account, deps } = {}) {
  const options = { account, ...deps };
  for (const id of ids || []) {
    await graph(`/me/messages/${id}`, { method: 'PATCH', json: { isRead: true }, deps: options });
  }
}

// 存草稿：createReply 建一份带原文和收件人的草稿，再 PATCH 进我们的正文。
// ⚠⚠ 这条路**到此为止**，绝不调 /send。外部收件人的邮件只能停在 Andy 的草稿箱里。
export async function graphSaveDraft({ replyToId, subject, html, to = [], cc = [] }, { account, deps } = {}) {
  const options = { account, ...deps };
  let draftId;
  if (replyToId) {
    const d = await graph(`/me/messages/${replyToId}/createReply`, { method: 'POST', json: {}, deps: options });
    draftId = d.id;
  } else {
    const d = await graph('/me/messages', {
      method: 'POST',
      json: {
        subject: subject || '',
        toRecipients: to.map((a) => ({ emailAddress: { address: a } })),
        ccRecipients: cc.map((a) => ({ emailAddress: { address: a } })),
      },
      deps: options,
    });
    draftId = d.id;
  }
  // ⚠ 一律 html：纯文本换行和列表会变形（Andy 的 CLAUDE.md 里记着这条坑）。
  const patched = await graph(`/me/messages/${draftId}`, {
    method: 'PATCH',
    json: { body: { contentType: 'html', content: html || '' } },
    deps: options,
  });
  return { ok: true, id: draftId, webLink: patched.webLink || '' };
}

// 直发。**只给全内部收件人用**，判定在 connect/mail.mjs。
export async function graphSend({ replyToId, subject, html, to = [], cc = [] }, { account, deps } = {}) {
  const options = { account, ...deps };
  if (replyToId) {
    // ⚠⚠ 这条分支里的 `to` 是**死参数**：`/reply` 的收件人由服务端定（Outlook 自己按
    //   原信的 Reply-To / From 选），我们传什么都不影响它发给谁。所以这里的安全性
    //   不靠 `to`，靠 connect/mail.mjs 的 `isExternalReply` —— 它把 From 和 Reply-To
    //   的**并集**都验一遍，不管服务端最终选中哪一个，都在验过的集合里。
    await graph(`/me/messages/${replyToId}/reply`, {
      method: 'POST',
      json: { message: { body: { contentType: 'html', content: html || '' } } },
      deps: options,
    });
    return { ok: true };
  }
  await graph('/me/sendMail', {
    method: 'POST',
    json: {
      message: {
        subject: subject || '',
        body: { contentType: 'html', content: html || '' },
        toRecipients: to.map((a) => ({ emailAddress: { address: a } })),
        ccRecipients: cc.map((a) => ({ emailAddress: { address: a } })),
      },
      saveToSentItems: true,
    },
    deps: options,
  });
  return { ok: true };
}
