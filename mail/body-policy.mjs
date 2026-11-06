// Mail-only policy. Never mutate approved content or quoted history.
function unescapeHtml(text) {
  const named = {nbsp:' ', apos:"'", quot:'"', amp:'&', lt:'<', gt:'>', rsquo:"'", lsquo:"'"};
  return text.replace(/&#(x[0-9a-f]+|\d+);?|&(nbsp|apos|quot|amp|lt|gt|rsquo|lsquo);/gi, (all, num, name) => {
    if (name) return named[name.toLowerCase()];
    const n = num[0].toLowerCase() === 'x' ? parseInt(num.slice(1),16) : parseInt(num,10);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
  });
}
export function newEmailText(content) {
  let s = String(content ?? '');
  // Outlook's native reply header marks the start of quoted history.
  const htmlQuote = /<(?:div|hr)\b[^>]*\bid\s*=\s*["']divRplyFwdMsg["'][^>]*>/i.exec(s);
  if (htmlQuote) s = s.slice(0, htmlQuote.index);
  const textQuote = /(?:^|\n)(?:From|发件人)\s*:[^\n]*\n(?:Sent|发送时间|Date|日期)\s*:[\s\S]*?\n(?:To|收件人)\s*:[\s\S]*?\n(?:Subject|主题)\s*:/i.exec(s);
  if (textQuote) s = s.slice(0,textQuote.index);
  return unescapeHtml(s.replace(/<!--[^]*?-->/g,'').replace(/<[^>]*>/g,' '))
    .normalize('NFKC').replace(/[\u200b-\u200d\ufeff]/g,'').replace(/\s+/g,' ').trim();
}
export function assertEmailBody(content) {
  const text = newEmailText(content);
  const bad = /\b(?:sent|written|drafted|generated|prepared)\s+(?:by|with)\b[^.!?。！？]{0,100}\b(?:AI\s*(?:Agent|assistant)|artificial intelligence)\b|(?:我是|我[是为]|以上内容由|本邮件由|此邮件由)[^。！？.!?]{0,80}(?:AI\s*(?:Agent|助手|助理|代理)|人工智能)/iu;
  if (bad.test(text)) {
    const e = new Error('EMAIL_AGENT_DECLARATION: 邮件新正文或签名含 AI Agent 身份声明，已拒绝发送；请移除声明后重新审核。');
    e.code = 'EMAIL_AGENT_DECLARATION';
    throw e;
  }
}
const unverifiable = () => new Error('EMAIL_BODY_UNVERIFIABLE: 无法核验邮件正文，拒绝发送。请使用可检查的 JSON 邮件正文。');
function jsonBody(body) {
  if (body == null || body === '') return {};
  if (typeof body === 'object' && !Buffer.isBuffer(body)) return body;
  try { const value = JSON.parse(body); if (value && typeof value === 'object') return value; } catch {}
  throw unverifiable();
}
function mailPath(endpoint) {
  return /\/(?:me|users\/[^/]+)\/(?:mailFolders\/[^/]+\/)?messages(?:\/|$)|\/(?:me|users\/[^/]+)\/sendMail$/i.test(endpoint);
}
export async function guardGraphMailRequest(endpoint, options = {}, readDraft) {
  const method = (options.method || 'GET').toUpperCase();
  if (!['POST','PATCH','PUT'].includes(method)) return;
  const path = String(endpoint).split('?')[0].replace(/^https:\/\/[^/]+/,'').replace(/^\/(?:v1\.0|beta)(?=\/)/,'');
  if (path === '/$batch') {
    const body = jsonBody(options.body);
    for (const request of body.requests || []) {
      const url = '/' + String(request.url || '').replace(/^\//,'');
      if (mailPath(url) && /\/(?:send|sendMail|reply|replyAll|forward)$/i.test(url)) throw new Error('EMAIL_BATCH_SEND_BLOCKED: 请单独发送邮件以核验持久化正文。');
      await guardGraphMailRequest(url, {method:request.method,body:request.body}, readDraft);
    }
    return;
  }
  if (!mailPath(path) || /\/attachments(?:\/|$)/i.test(path)) return;
  if (/\/messages\/[^/]+\/send$/i.test(path)) {
    if (!readDraft) throw unverifiable();
    const draft = await readDraft(path.replace(/\/send$/i,'') + '?$select=body,isDraft');
    if (draft?.isDraft !== true || typeof draft?.body?.content !== 'string') throw unverifiable();
    assertEmailBody(draft.body.content);
    return;
  }
  const data = jsonBody(options.body);
  const message = data.message || data.Message || data;
  if (message.body?.content != null) assertEmailBody(message.body.content);
  if (data.comment != null || data.Comment != null) assertEmailBody(data.comment ?? data.Comment);
  if (/\/sendMail$/i.test(path) && typeof message.body?.content !== 'string') throw unverifiable();
}
