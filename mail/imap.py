#!/usr/bin/env python3
# IMAP/SMTP 助手。**只做 IO 和 MIME 解析，不做任何业务判断**
# （值不值得回、内外部、要不要屏蔽，全在 node 那边）。
#
# 协议：stdin 一个 JSON {op, ...}，stdout 一个 JSON {ok, ...}。
# 出错吐 {ok: false, error: 人话, auth: true/false}——auth 那一栏决定上层是
# 「喊 Andy 换授权码」还是「这一轮跳过、下一轮重收」，绝不许把登录失败
# 混成「零封新邮件」。
#
# ⚠ 授权码只有这个进程读得到（直接从钥匙串取），不经过命令行参数，
#   也就不会出现在 ps 输出和 shell 历史里。
#
# ⚠ 非致命的清理/扩展命令（登录后发 ID、收尾 logout/quit）失败时用
#   contextlib.suppress 吞掉，不用裸 except:pass——那是老系统「登录失败
#   当没新邮件」的模子，会被下面这条正经规矩盯上：真正影响结果的错误
#   （登录失败、fetch 失败、写草稿失败……）一律不许吞，必须往上抛，
#   由 main() 统一分类成 auth / 非 auth 两种回给 node。
import email
import imaplib
import json
import smtplib
import ssl
import subprocess
import sys
from contextlib import suppress
from email.header import decode_header, make_header
from email.message import EmailMessage
from email.utils import parsedate_to_datetime, formatdate, make_msgid


class Auth(Exception):
    pass


def secret(acc=None):
    if acc is None:
        acc = {}
    service = acc.get('keychainService') or ('mailroom-%s' % acc.get('id', ''))
    address = acc.get('address', '')
    r = subprocess.run(
        ['security', 'find-generic-password', '-s', service, '-a', address, '-w'],
        capture_output=True, text=True)
    pw = (r.stdout or '').strip()
    if not pw:
        raise Auth('钥匙串里没有这个邮箱的客户端授权码（%s / %s）' % (service, address))
    return pw


def connect_imap(acc=None):
    if acc is None:
        acc = {}
    imap_cfg = acc.get('imap') or {}
    host = imap_cfg.get('host') or ''
    port = int(imap_cfg.get('port') or 993)
    address = acc.get('address') or ''
    M = imaplib.IMAP4_SSL(host, port, ssl_context=ssl.create_default_context())
    try:
        M.login(address, secret(acc))
    except imaplib.IMAP4.error as e:
        raise Auth('IMAP 登录被拒：%s' % str(e)[:200])
    # ⚠ 部分企业邮箱要求登录后发 ID 命令，否则部分操作被拒。imaplib 不认这个命令名，
    #   要走 _simple_command 绕；这一步失败不影响后续操作（实测），只是扩展
    #   握手，不是「取数」，所以用 suppress 吞掉，不算业务错误。
    with suppress(Exception):
        M._simple_command('ID', '("name" "mailroom" "version" "1.0")')
        M.response('ID')
    return M


def dec(s):
    if not s:
        return ''
    try:
        return str(make_header(decode_header(s)))
    except Exception:
        return str(s)


def addr_list(msg, field):
    raw = msg.get_all(field, [])
    out = []
    for one in raw:
        for part in email.utils.getaddresses([str(one)]):
            if part[1]:
                out.append({'name': dec(part[0]), 'address': part[1]})
    return out


def body_parts(msg):
    text, html, names = '', '', []
    for part in msg.walk():
        if part.get_content_maintype() == 'multipart':
            continue
        disp = str(part.get('Content-Disposition') or '')
        fn = part.get_filename()
        if fn or 'attachment' in disp:
            names.append(dec(fn) if fn else '(未命名附件)')
            continue
        payload = part.get_payload(decode=True)
        if payload is None:
            continue
        charset = part.get_content_charset() or 'utf-8'
        try:
            body = payload.decode(charset, 'replace')
        except LookupError:
            body = payload.decode('utf-8', 'replace')
        if part.get_content_type() == 'text/plain' and not text:
            text = body
        elif part.get_content_type() == 'text/html' and not html:
            html = body
    return text, html, names


def parse(uid, raw):
    msg = email.message_from_bytes(raw)
    text, html, names = body_parts(msg)
    try:
        at = parsedate_to_datetime(msg.get('Date')).astimezone().isoformat()
    except Exception:
        at = ''
    froms = addr_list(msg, 'From')
    refs = (msg.get('References') or '').split()
    return {
        'id': uid,
        # 线程根：References 的第一个，没有就退回自己的 Message-ID
        'threadId': (refs[0] if refs else (msg.get('Message-ID') or uid)).strip(),
        'messageIdHeader': (msg.get('Message-ID') or '').strip(),
        'at': at,
        'subject': dec(msg.get('Subject')),
        'from': froms[0] if froms else {'name': '', 'address': ''},
        # Reply-To：回信真正会送到的地址，跟 From 常常不是同一个人（工单系统、
        # 转发网关、邮件列表）。两个传输层的 ParsedMail 形状要一致，Graph 那侧
        # 取的是 m.replyTo。外部判定靠它，缺了就会把客户当成内部同事直发。
        'replyTo': addr_list(msg, 'Reply-To'),
        'to': addr_list(msg, 'To'),
        'cc': addr_list(msg, 'Cc'),
        'bcc': [],
        'text': text,
        'html': html,
        'attachmentNames': names,
    }


def op_fetch(req, acc=None):
    if acc is None:
        acc = req.get('account') or {}
    M = connect_imap(acc)
    try:
        typ, data = M.select('INBOX', readonly=True)
        if typ != 'OK':
            raise RuntimeError('打不开 INBOX：%s' % data)
        uid_validity = M.response('UIDVALIDITY')[1][0].decode()
        since = str(req.get('since_uid') or '')
        prev_validity = str(req.get('uid_validity') or '')
        # uidValidity 变了 = 服务端重建了邮箱，旧 UID 全部作废。重新建基线，不倒历史。
        if prev_validity and prev_validity != uid_validity:
            since = ''
        if not since:
            typ, d = M.uid('search', None, 'ALL')
            uids = (d[0] or b'').split()
            last = uids[-1].decode() if uids else '0'
            return {'ok': True, 'uidValidity': uid_validity, 'lastUid': last,
                    'messages': [], 'baseline': True}
        typ, d = M.uid('search', None, 'UID', '%d:*' % (int(since) + 1))
        uids = [u.decode() for u in (d[0] or b'').split() if int(u) > int(since)]
        # ⚠ 必须切「最旧的前 N 个」不能切「最新的后 N 个」：uids 是升序，
        #   若积压超过 limit，切尾部会把中间一大段直接跳过——而 lastUid 还是
        #   会推到本批最大值，水位线一过，跳过的那段就永久够不着了，
        #   跟登录失败一样是「消息静默消失」，只是发生在成功路径上、没有任何报错。
        #   切头部则下一轮从未取到的那段接着补，水位线只推进到真正取到的地方。
        uids = uids[:int(req.get('limit') or 50)]
        msgs = []
        for u in uids:
            typ, d = M.uid('fetch', u, '(BODY.PEEK[])')
            if typ != 'OK' or not d or not d[0]:
                raise RuntimeError('取第 %s 封失败' % u)
            msgs.append(parse(u, d[0][1]))
        last = uids[-1] if uids else since
        return {'ok': True, 'uidValidity': uid_validity, 'lastUid': last, 'messages': msgs}
    finally:
        with suppress(Exception):
            M.logout()


def op_mark_read(req, acc=None):
    if acc is None:
        acc = req.get('account') or {}
    M = connect_imap(acc)
    try:
        M.select('INBOX')
        for u in req.get('uids') or []:
            M.uid('store', u, '+FLAGS', '(\\Seen)')
        return {'ok': True}
    finally:
        with suppress(Exception):
            M.logout()


def build(req, acc=None):
    if acc is None:
        acc = req.get('account') or {}
    m = EmailMessage()
    m['From'] = acc.get('address') or ''
    m['To'] = ', '.join(req.get('to') or [])
    if req.get('cc'):
        m['Cc'] = ', '.join(req['cc'])
    m['Subject'] = req.get('subject') or ''
    m['Date'] = formatdate(localtime=True)
    m['Message-ID'] = make_msgid()
    if req.get('in_reply_to'):
        m['In-Reply-To'] = req['in_reply_to']
    if req.get('references'):
        m['References'] = req['references']
    # ⚠ 一律 HTML：纯文本的换行和列表在各家客户端里会变形。
    m.set_content('（本邮件为 HTML 格式）')
    m.add_alternative(req.get('html') or '', subtype='html')
    return m


def drafts_folder(M):
    # ⚠ 按 \Drafts 特殊标志找，不写死名字。实测某些企业邮箱那个文件夹叫 &g0l6P3ux-
    #   （modified-UTF-7 的「草稿箱」），写死等于赌服务端不改名。
    typ, data = M.list()
    for line in data or []:
        s = line.decode('utf-8', 'replace')
        if '\\Drafts' in s:
            return s.split(' "/" ')[-1].strip().strip('"')
    raise RuntimeError('找不到草稿箱文件夹（LIST 里没有 \\Drafts 标志）')


def op_save_draft(req, acc=None):
    if acc is None:
        acc = req.get('account') or {}
    M = connect_imap(acc)
    try:
        folder = drafts_folder(M)
        msg = build(req, acc)
        typ, d = M.append(folder, '(\\Draft)', None, msg.as_bytes())
        if typ != 'OK':
            raise RuntimeError('草稿写入失败：%s' % d)
        return {'ok': True, 'folder': folder}
    finally:
        with suppress(Exception):
            M.logout()


def op_smtp_send(req, acc=None):
    if acc is None:
        acc = req.get('account') or {}
    msg = build(req, acc)
    smtp_cfg = acc.get('smtp') or {}
    host = smtp_cfg.get('host') or ''
    port = int(smtp_cfg.get('port') or 465)
    use_ssl = smtp_cfg.get('ssl') if 'ssl' in smtp_cfg else True
    address = acc.get('address') or ''
    try:
        if use_ssl:
            S = smtplib.SMTP_SSL(host, port,
                                 context=ssl.create_default_context(), timeout=60)
        else:
            S = smtplib.SMTP(host, port, timeout=60)
            S.starttls(context=ssl.create_default_context())
    except Exception as e:
        raise RuntimeError('连不上 SMTP：%s' % str(e)[:200])
    try:
        try:
            S.login(address, secret(acc))
        except smtplib.SMTPAuthenticationError as e:
            raise Auth('SMTP 登录被拒：%s' % str(e)[:200])
        S.send_message(msg)
        return {'ok': True}
    finally:
        with suppress(Exception):
            S.quit()


OPS = {'fetch': op_fetch, 'mark_read': op_mark_read,
       'save_draft': op_save_draft, 'smtp_send': op_smtp_send}


def main():
    try:
        req = json.loads(sys.stdin.read() or '{}')
        acc = req.get('account')
        if not acc or not isinstance(acc, dict):
            raise RuntimeError('未提供账号配置')
        fn = OPS.get(req.get('op'))
        if not fn:
            raise RuntimeError('不认识的 op：%s' % req.get('op'))
        print(json.dumps(fn(req, acc), ensure_ascii=False))
    except Auth as e:
        print(json.dumps({'ok': False, 'auth': True, 'error': str(e)}, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({'ok': False, 'auth': False,
                          'error': '%s: %s' % (type(e).__name__, str(e)[:300])},
                         ensure_ascii=False))


# ⚠ 必须有这道守卫：没有它 import 这个模块（比如给分页逻辑写单测，monkeypatch
#   connect_imap 之后 import imap）就会当场跑 main()，卡死在 sys.stdin.read()
#   上（没喂 stdin）或者把 op 当成 import 的副作用执行掉（喂了 stdin）。
if __name__ == '__main__':
    main()
