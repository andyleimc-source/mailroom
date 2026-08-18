#!/usr/bin/env bash
# 把定时发送的 launchd 定时器装到**主力机**上（收发状态在哪台，队列就在哪台）。
#
# ⚠ 只装在主力机。两台都装 = 同一条排期被各发一遍，而明道云没有撤回接口。
#   脚本会自己对一下 topology.primaryHost，不是主力机就拒装。
#
# 用法：bash scripts/install-schedule-agent.sh [--uninstall]
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.andy.mailroom-schedule"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/mailroom-schedule.log"

if [ "${1:-}" = "--uninstall" ]; then
	launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
	rm -f "$PLIST"
	echo "已卸载：$LABEL"
	exit 0
fi

PRIMARY="$(node --input-type=module -e "const { topology } = await import('$REPO/config.mjs'); console.log((topology() || {}).primaryHost || '');" 2>/dev/null)"
HERE="$(scutil --get LocalHostName 2>/dev/null)"
if [ -n "$PRIMARY" ] && [ "$PRIMARY" != "$HERE" ]; then
	echo "✗ 这台是 ${HERE}，主力机是 ${PRIMARY}。定时器只装主力机——两台都装会把同一条排期各发一遍。" >&2
	exit 1
fi

NODE="$(command -v node || echo /opt/homebrew/bin/node)"
[ -x "$NODE" ] || { echo "✗ 找不到 node" >&2; exit 1; }

mkdir -p "$HOME/Library/LaunchAgents" "$(dirname "$LOG")"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>$NODE</string>
		<string>$REPO/bin/schedule.mjs</string>
		<string>run</string>
	</array>
	<key>WorkingDirectory</key><string>$REPO</string>
	<!-- 5 分钟一轮。到点误差最多 5 分钟，对「周一早上发个私信」这种精度绰绰有余，
	     再密就是白烧电。 -->
	<key>StartInterval</key><integer>300</integer>
	<key>RunAtLoad</key><true/>
	<key>StandardOutPath</key><string>$LOG</string>
	<key>StandardErrorPath</key><string>$LOG</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
	</dict>
</dict>
</plist>
PLISTEOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
launchctl bootstrap "gui/$(id -u)" "$PLIST" || { echo "✗ launchctl bootstrap 失败" >&2; exit 1; }
# ⚠ 变量后面紧跟中文时必须写成 ${LABEL}：bash 会把「（」当成变量名的一部分，
#   配上 set -u 直接报 unbound variable。
echo "已装上：${LABEL}（每 5 分钟看一眼队列）"
echo "  队列　 mailroom schedule list"
echo "  日志　 $LOG"
echo "  卸载　 bash scripts/install-schedule-agent.sh --uninstall"
