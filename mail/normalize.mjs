// 一封「已解析的邮件」→ 渠道无关的 candidate + 归档 record。
//
// 两个传输层（Graph / IMAP）各自把原始数据整理成同一个 ParsedMail 形状，
// 从这里往下就分不出是哪个邮箱来的了 —— 跟 fetch.mjs 对明道云做的是同一件事。
//
// ⚠ 这一层不判「值不值得回」，一封不丢地往下交（跟明道云那条路一个原则）。
//   屏蔽在 run.mjs 的 muteHit，不在这儿。

import { isExternalRecipients } from './accounts.mjs';
import { localIso } from '../lib.mjs';

// inbox.md 里一封邮件最多写这么多字，超了截断——邮件正文动辄几千字，
// 全写进任务时间线会把 inbox.md 冲烂。全文在 assets/mail-log/ 里，那才是事实源。
export const BODY_MAX = 2000;

export function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map((l) => l.trim()).join('\n')
    .trim();
}

export function bodyText(m) {
  const t = String((m && m.text) || '').trim();
  if (t) return t;
  return htmlToText((m && m.html) || '');
}

function subjectOf(m) {
  return String((m && m.subject) || '').trim() || '(无主题)';
}

// 这封信在归档/去重里的唯一 id。
//
// ⚠⚠ IMAP 那侧的 `m.id` 是 IMAP 的 UID，而 **UID 只在同一个 uidValidity 里唯一**：
//   服务端重建邮箱之后编号会从头再来，同一个自然月内新邮件就可能跟旧邮件撞 id，
//   而 `archive()` 按 id 去重 —— 撞上就把**新邮件**当成重复静默丢弃，归档里一条不留
//   （inbox.md 里那份是截断过的，长信的后半截就此没了，而且不报错）。
//   所以 IMAP 邮箱的 id 带上 uidValidity。ms365 那侧没有这个字段，id 形状一个字不变。
function mailId(m, account) {
  const uv = String((m && m.uidValidity) || '');
  return `mail-${account.id}-${uv ? `${uv}-` : ''}${(m && m.id) || ''}`;
}

// 归档用的正文。
//
// ⚠⚠ 正文为空**不等于**这封信没内容：主题和附件名都在 `text` 之外，而
//   `archive()` 会把 `text` 为空的记录整条过滤掉（`String(r.text||'').trim()`）。
//   实跑过的样子：主题「明天会议改到下午3点」+ 附件 议程.pdf + 正文空 →
//   `archive()` 返回 0，连 jsonl 都没建。而 skill/SKILL.md 写着「drop 掉也没关系，
//   原文照样在归档里」——对这类邮件那句话是假的，drop 之后哪儿都没有了。
//   所以正文空就退回「主题：…（附件：…）」，保证归档里一定有一条摸得着的记录。
function archiveText(m) {
  const body = bodyText(m);
  if (body) return body;
  const names = (m && m.attachmentNames) || [];
  return `主题：${subjectOf(m)}${names.length ? `\n（附件：${names.join('、')}）` : ''}`;
}

export function toCandidate(m, account) {
  const subject = subjectOf(m);
  const from = (m && m.from) || { name: '', address: '' };
  const names = (m && m.attachmentNames) || [];
  const external = isExternalRecipients({ to: m.to, cc: m.cc, bcc: m.bcc });

  let body = bodyText(m);
  if (body.length > BODY_MAX) {
    body = `${body.slice(0, BODY_MAX)}\n…（正文过长已截断，全文见 assets/mail-log/）`;
  }
  const attachLine = names.length ? `\n（附件：${names.join('、')}）` : '';

  return {
    sourceKind: 'mail',
    kind: 'mail',
    account: account.id,
    who: from.name || from.address || '未知',
    whoAddress: from.address || '',
    external,
    // ⚠⚠ 下面这三样在 target 里**又存了一份**，不是冗余，是必须的：
    //   聚段（segment.mjs 的 toSegments）只把 sourceKind/sourceType/sourceLabel/who/
    //   whoAccountId/target/msgs/firstAt/lastAt/filed/dropped/waiting 带进段里，
    //   candidate 顶层的 external / whoAddress / account 到那一步就掉了。
    //   而回信（connect/mail.mjs 的 sendVia）拿到的正是**段**：只读顶层的话
    //   `item.external` 永远是 undefined，「全内部收件人直发」那条路一次都走不到，
    //   而且不报错——所有邮件都会被当成外部只存草稿，没人会发现门是坏的。
    //   顶层那三个不许删：run.mjs 的 muteHit 读的是 candidate 阶段的 cand.whoAddress。
    target: {
      account: account.id,
      external,
      whoAddress: from.address || '',
      // RFC 的 Message-ID 头，回信保线程用（IMAP 那侧写 In-Reply-To/References；
      // Graph 那侧靠 replyToId，用不上但一并带着，两条路的段形状保持一致）。
      messageIdHeader: (m && m.messageIdHeader) || '',
      // ⚠⚠ Reply-To：**回信真正会送到的地址**，跟 From 常常不是同一个人
      //   （工单系统、转发网关、邮件列表，或者人手设的）。发送那一步的外部判定
      //   靠它兜底（connect/mail.mjs 的 isExternalReply）。
      //   ⚠ 顶层的 external 故意**不**把它算进去：那是 Task 2 的语义、别处也在读，
      //     改它会波及收信侧；门那一层取两个判据里更保守的那个就够了。
      replyTo: ((m && m.replyTo) || []).map((p) => (typeof p === 'string' ? p : (p && p.address) || ''))
        .filter(Boolean),
      messageId: (m && m.id) || '',
      threadId: (m && m.threadId) || (m && m.id) || '',
      subject,
      from: from.address || '',
      to: (m.to || []).map((p) => p.address),
      cc: (m.cc || []).map((p) => p.address),
      hasAttachments: names.length > 0,
      attachmentNames: names,
    },
    msgs: [{
      id: mailId(m, account),
      // ⚠ 这里**必须 localIso**：ParsedMail 的原值 at 是 Graph 给的 UTC（`…Z`），
      //   那份原值是留给增量查询水位线的（见 mail/graph.mjs 的 toParsed 注释）。
      //   段里这个 at 只用来显示（inboxmd 的 shortTime）和按时间聚段，跟水位线无关；
      //   照抄 UTC 的后果是明道云段（本地时间）和邮件段（UTC）混在同一个 segments.json 里，
      //   每轮都被落盘门口的 healTimestamps 自愈一次、日志刷一行「有路绕过去了」。
      //   —— 那行日志就是冲着这儿来的，2026-08-11 查到并堵上。
      at: localIso((m && m.at) || '') || '',
      text: `主题：${subject}\n\n${body}${attachLine}`,
    }],
  };
}

export function toRecord(m, account) {
  const from = (m && m.from) || { name: '', address: '' };
  return {
    id: mailId(m, account),
    // ⚠ Graph 的 receivedDateTime 有时 Z 有时 +08:00，混着存进同一个 inbox.md
    //   排序就乱了（16:59 的邮件排到 09:10 那条之前）。给人看的时间统一走 localIso；
    //   水位线用的是 ParsedMail 的原值 at，不受这里影响。
    ts: localIso((m && m.at) || '') || '',
    dir: 'in',
    kind: 'mail',
    peer: from.name || from.address || '未知',
    peerId: from.address || '',
    // ⚠ 归档是唯一事实源，正文**不截断**。截断只发生在给人看的 inbox.md 那一份。
    //   正文为空时退回主题 + 附件名，见 archiveText —— 空 text 会被 archive() 整条丢掉。
    text: archiveText(m),
    via: `邮件 · ${account.label}`,
    subject: subjectOf(m),
    from: from.address || '',
    to: (m.to || []).map((p) => p.address),
    cc: (m.cc || []).map((p) => p.address),
    threadId: (m && m.threadId) || '',
    account: account.id,
    attachmentNames: (m && m.attachmentNames) || [],
  };
}
