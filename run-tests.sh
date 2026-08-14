#!/usr/bin/env bash
# 自查。零依赖，几秒钟跑完。
#
# ⚠ 绝不会发出任何真消息：
#   1. `lib.mjs` 的 assertNoRealIO 认 MAILROOM_TEST==='1'，真打 hap / 真跑 claude 之前抛错；
#   2. send 相关的测试全走 `__test.adapter` 假传输层，`sendVia` 只是个返回假回执的函数；
#   3. 所有测试用临时的假 dailymd + 假 ~/.mailroom，跑完删掉，不碰真库。
#      ⚠ 这一条以前只对「记得调 tmpState() 的测试」成立，别的测试的日志会漏进 Andy
#        真实的 ~/.mailroom/mailroom.log（2026-08-13 发现积了 656 行）。现在 lib.mjs 的
#        log() 自己认：在自查里且没显式指定 MAILROOM_STATE 就一个字都不落盘，
#        由 test/connect.test.mjs 的 ⑥ 盯着。
#   `hap chat send-to-one` 对任何 accountId 都回 `Message sent.`，漏一次就是真往同事那儿
#   发一条，而明道云没有撤回接口。**这三条别改松。**
set -euo pipefail
cd "$(dirname "$0")"
node --test 'test/*.test.mjs'

# mail/imap.py 的分页/水位线逻辑是纯 python，node --test 测不到（那条测试全部
# 走 run 注入，不会真的 import mail/imap.py）。有 python3 就顺手跑一遍；两台 Mac
# 里 python3 情况后面归 doctor 兜，这里没有就跳过，不许把整个自查拖挂。
if command -v python3 >/dev/null 2>&1; then
  python3 test/mail-imap-pagination.py
else
  echo "跳过 test/mail-imap-pagination.py：本机没有 python3"
fi
