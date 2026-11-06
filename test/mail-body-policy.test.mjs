import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertEmailBody, guardGraphMailRequest } from '../mail/body-policy.mjs';

const declaration = "Sent by Alex's AI Agent, reviewed.";
test('blocks declarations in text, HTML, entities and Chinese', () => {
  for (const content of [declaration, `Hello\n\n${declaration}`, '<p>Sent by Alex&#39;s <b>AI Agent</b>, reviewed.</p>', 'Sent&nbsp;by Alex’s AI Agent, reviewed.', '我是 Alex 的 AI Agent，以下内容已经过 Alex 本人审核。']) {
    assert.throws(() => assertEmailBody(content), /EMAIL_AGENT_DECLARATION/);
  }
});
test('preserves real quoted history and ordinary discussion of agents', () => {
  for (const content of ['Could we discuss HAP AI agents?', `<p>Hello</p><div id="divRplyFwdMsg">From: A</div>${declaration}`, `Hello\nFrom: A <a@example.com>\nSent: Yesterday\nTo: B\nSubject: Old\n${declaration}`]) assert.doesNotThrow(() => assertEmailBody(content));
});
test('blocks inline mail/reply/patch before any network call', async () => {
  for (const [path, body] of [['/me/sendMail', { message: { body: {content: declaration} } }], ['/me/messages/a/reply', {comment: declaration}], ['/me/messages/a', {body: {content: declaration}}]]) {
    await assert.rejects(guardGraphMailRequest(path, {method:path.endsWith('/a')?'PATCH':'POST', body:JSON.stringify(body)}, () => { throw Error('network reached'); }), /EMAIL_AGENT_DECLARATION/);
  }
});
test('draft send reads persisted draft and refuses bad body', async () => {
  let read = 0;
  await assert.rejects(guardGraphMailRequest('/users/u/messages/d/send', {method:'POST'}, async (path) => { read++; assert.match(path,/messages\/d/); return {isDraft:true,body:{content:declaration}}; }), /EMAIL_AGENT_DECLARATION/);
  assert.equal(read,1);
});
test('clean draft sends, unreadable draft fails closed, non-mail unaffected', async () => {
  await guardGraphMailRequest('/me/messages/d/send',{method:'POST'},async()=>({isDraft:true,body:{content:'Hello'}}));
  await assert.rejects(guardGraphMailRequest('/me/messages/d/send',{method:'POST'},async()=>({})), /EMAIL_BODY_UNVERIFIABLE/);
  await assert.rejects(guardGraphMailRequest('/me/sendMail',{method:'POST',body:'bWltZQ=='}), /EMAIL_BODY_UNVERIFIABLE/);
  await guardGraphMailRequest('/chats/c/messages',{method:'POST',body:JSON.stringify({body:{content:declaration}})});
});
test('batch mail sends cannot bypass persisted-body check', async () => {
  await assert.rejects(guardGraphMailRequest('/$batch',{method:'POST',body:JSON.stringify({requests:[{id:'1',method:'POST',url:'/me/messages/d/send'}]})}), /EMAIL_BATCH_SEND_BLOCKED/);
});

test('Outlook signature marker is not a quote boundary', () => {
  assert.throws(() => assertEmailBody('<div id="appendonsend">Sent by Alex AI Agent, reviewed.</div>'), /EMAIL_AGENT_DECLARATION/);
});
