#!/usr/bin/env python3
# 纯逻辑测试：op_fetch 的分页/水位线该不该丢消息。
# ⚠ 不连真邮箱、不碰钥匙串——把 mail/imap.py 的 connect_imap 整个换成假对象，
#   假对象自己吐预设的 uid 列表和报文，跟真实 IMAP 协议没有任何交互。
#
# 这条测试锁的正是 Task 4 fix report 里记的那处真 bug：分页切错方向会在积压超过
# limit 时让中间一段消息永久够不着，而且不报错——跟登录失败被吞掉是同一类「消息
# 静默消失」，只是发生在成功路径上。回归它。
import importlib.util
import pathlib
import sys
import unittest
from email.utils import formatdate

MODULE_PATH = pathlib.Path(__file__).resolve().parent.parent / 'mail' / 'imap.py'


def load_imap_module():
    # 用文件路径动态加载，不走包导入——mail/ 不是一个 python 包，也不想为了一个
    # 测试给仓库添 __init__.py。这一步顺带回归 imap.py 的 `if __name__ == '__main__'`
    # 守卫：没有那道守卫，加载时就会卡在 sys.stdin.read() 上或者把某个 op 当 import
    # 副作用跑掉。
    spec = importlib.util.spec_from_file_location('mailroom_imap_under_test', MODULE_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def fake_message_bytes(uid):
    # 一封能被 email.message_from_bytes 正常解析的最小报文，字段够 parse() 跑完就行。
    raw = (
        'From: feng.zhang@corp-mail.com\r\n'
        'To: me@corp-mail.com\r\n'
        'Subject: 测试邮件 %s\r\n'
        'Date: %s\r\n'
        'Message-ID: <%s@test>\r\n'
        '\r\n'
        '正文 %s\r\n'
    ) % (uid, formatdate(localtime=True), uid, uid)
    return raw.encode('utf-8')


class FakeIMAP:
    """假 IMAP4_SSL 连接：只实现 op_fetch 用到的四个方法，数据全是预设好的。"""

    def __init__(self, all_uids, uid_validity):
        self.all_uids = all_uids  # 升序字符串列表，模拟服务端 UID SEARCH 的返回顺序
        self.uid_validity = uid_validity
        self.logged_out = False

    def select(self, mailbox, readonly=False):
        return 'OK', [b'1']

    def response(self, name):
        if name == 'UIDVALIDITY':
            return 'OK', [self.uid_validity.encode()]
        return 'OK', [None]

    def uid(self, command, *args):
        if command == 'search':
            # 不管具体搜索条件是 ALL 还是 UID N:*，都吐全量积压——真正的「只要比
            # since 大」由 op_fetch 自己过滤，跟真服务器行为等价，测试只关心分页切片。
            return 'OK', [' '.join(self.all_uids).encode()]
        if command == 'fetch':
            u = args[0]
            return 'OK', [(b'1 (BODY[] {1})', fake_message_bytes(u))]
        raise AssertionError('测试没预期到的 uid 命令：%s' % command)

    def logout(self):
        self.logged_out = True


class OpFetchPaginationTest(unittest.TestCase):
    def setUp(self):
        self.imap_mod = load_imap_module()

    def patch_connect(self, fake):
        self.imap_mod.connect_imap = lambda *a: fake

    def test_积压超过limit分两轮取不丢不重(self):
        backlog = [str(n) for n in range(1, 101)]  # 1..100，模拟积压 100 封
        fake = FakeIMAP(backlog, uid_validity='100')
        self.patch_connect(fake)

        r1 = self.imap_mod.op_fetch({'since_uid': '0', 'uid_validity': '100', 'limit': 50})
        self.assertTrue(r1['ok'])
        self.assertFalse(r1.get('baseline'))
        got1 = [m['id'] for m in r1['messages']]
        self.assertEqual(got1, [str(n) for n in range(1, 51)], '第一轮该取最旧的 50 个，不是最新的 50 个')
        self.assertEqual(r1['lastUid'], '50', 'lastUid 只该推进到真正取到的那一封')

        r2 = self.imap_mod.op_fetch({'since_uid': r1['lastUid'], 'uid_validity': '100', 'limit': 50})
        got2 = [m['id'] for m in r2['messages']]
        self.assertEqual(got2, [str(n) for n in range(51, 101)], '第二轮该接着补剩下那一半')
        self.assertEqual(r2['lastUid'], '100')

        # 两轮合起来一封不丢、一封不重
        self.assertEqual(sorted(got1 + got2, key=int), backlog)
        self.assertEqual(len(set(got1) & set(got2)), 0, '两轮之间不该有重叠')

    def test_uidValidity变了走重建基线(self):
        backlog = [str(n) for n in range(1, 21)]
        fake = FakeIMAP(backlog, uid_validity='999')  # 服务端已经是新的 uidValidity
        self.patch_connect(fake)

        # 客户端带着旧的 uid_validity='100' 和 since_uid='10' 来，服务端已经变成 999
        r = self.imap_mod.op_fetch({'since_uid': '10', 'uid_validity': '100', 'limit': 50})
        self.assertTrue(r['ok'])
        self.assertTrue(r['baseline'], 'uidValidity 不匹配必须重建基线，不能当成普通增量')
        self.assertEqual(r['messages'], [], '重建基线这一轮不倒历史')
        self.assertEqual(r['uidValidity'], '999')
        self.assertEqual(r['lastUid'], '20', 'lastUid 该是当前邮箱里最新那封')

    def test_首轮没有since_uid建基线不倒历史(self):
        backlog = [str(n) for n in range(1, 6)]
        fake = FakeIMAP(backlog, uid_validity='1')
        self.patch_connect(fake)

        r = self.imap_mod.op_fetch({'since_uid': '', 'uid_validity': '', 'limit': 50})
        self.assertTrue(r['ok'])
        self.assertTrue(r['baseline'])
        self.assertEqual(r['messages'], [])
        self.assertEqual(r['lastUid'], '5')


class ParseReplyToTest(unittest.TestCase):
    """parse() 的 Reply-To 提取——外部判定（connect/mail.mjs 的 isExternalReply）靠它兜底。

    这一行被删掉或改名，网易那条路的 replyTo 就永远是空数组：From 内部同事、
    Reply-To 指向外部客户的邮件（工单系统、转发网关）会静默恢复成「直接发给客户」，
    而且不报错——正是 Task 8 花了一整轮堵的洞。Graph 那侧（mail/graph.mjs 的
    toParsed）已经有变异测试盯着，这里补网易这一侧，两边才对称。
    """

    def setUp(self):
        self.imap_mod = load_imap_module()

    def test_带ReplyTo头能解析出地址(self):
        raw = (
            'From: crm-notify@corp-mail.com\r\n'
            'To: me@corp-mail.com\r\n'
            'Reply-To: "Bob at Client" <bob@client-corp.com>\r\n'
            'Subject: 工单更新\r\n'
            'Date: %s\r\n'
            'Message-ID: <replyto-test-1@test>\r\n'
            '\r\n'
            '正文\r\n'
        ) % formatdate(localtime=True)
        parsed = self.imap_mod.parse('1', raw.encode('utf-8'))
        self.assertEqual(
            parsed['replyTo'],
            [{'name': 'Bob at Client', 'address': 'bob@client-corp.com'}],
            'From 内部 + Reply-To 外部这种邮件，replyTo 解不出来就会被当成内部邮件直发',
        )

    def test_没有ReplyTo头时replyTo是空数组(self):
        raw = (
            'From: feng.zhang@corp-mail.com\r\n'
            'To: me@corp-mail.com\r\n'
            'Subject: 没有 Reply-To 的普通邮件\r\n'
            'Date: %s\r\n'
            'Message-ID: <replyto-test-2@test>\r\n'
            '\r\n'
            '正文\r\n'
        ) % formatdate(localtime=True)
        parsed = self.imap_mod.parse('2', raw.encode('utf-8'))
        self.assertEqual(parsed['replyTo'], [])


if __name__ == '__main__':
    unittest.main()
