#!/usr/bin/env bash
# 把 assets/mailroom.svg 打成一个带图标的小通知应用（~/.mailroom/MailroomAlert.app）。
#
# 为什么要有它：osascript 发的系统通知永远顶着「脚本编辑器」的图标，改不了。
# 唯一正路是让通知从一个自己的 app 里发出来——这里用 osacompile 编一个零依赖的
# AppleScript applet，换上 mailroom 的图标。bin/alert.mjs 发现它存在就走它。
#
# 幂等：重跑就是重建。改了 SVG 或这份脚本，重跑一次即可。
# ⚠ 第一次真正弹通知时 macOS 会问「允许 Mailroom 发通知吗」，要点一次允许。
set -euo pipefail

cd "$(dirname "$0")/.."
SVG="assets/mailroom.svg"
STATE="${MAILROOM_STATE:-$HOME/.mailroom}"
APP="$STATE/MailroomAlert.app"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

[ -f "$SVG" ] || { echo "✗ 找不到 $SVG" >&2; exit 1; }
mkdir -p "$STATE"

# ① SVG → 1024 png（qlmanage 是系统自带的，不引依赖）→ 各尺寸 → icns
qlmanage -t -s 1024 -o "$WORK" "$SVG" >/dev/null
SRC="$WORK/$(basename "$SVG").png"
[ -f "$SRC" ] || { echo "✗ SVG 渲染失败（qlmanage 没吐出 png）" >&2; exit 1; }
ICONSET="$WORK/mailroom.iconset"
mkdir "$ICONSET"
for s in 16 32 128 256 512; do
	sips -z "$s" "$s" "$SRC" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
	d=$((s * 2))
	sips -z "$d" "$d" "$SRC" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$WORK/mailroom.icns"

# ② 编 applet：标题正文走环境变量进来，正文永远不进脚本源码
cat > "$WORK/alert.applescript" <<'EOF'
on run
	set t to system attribute "MR_TITLE"
	set b to system attribute "MR_BODY"
	if t is "" then set t to "mailroom"
	display notification b with title t sound name "Glass"
	-- 通知是异步派发的，applet 退太快通知偶尔会丢，稍等半秒
	delay 0.5
end run
EOF
rm -rf "$APP"
osacompile -o "$APP" "$WORK/alert.applescript"

# ③ 换图标、改名，重新 ad-hoc 签名（动过包内文件不重签会被系统拒载）
cp "$WORK/mailroom.icns" "$APP/Contents/Resources/applet.icns"
/usr/libexec/PlistBuddy -c 'Set :CFBundleName Mailroom' "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleDisplayName string Mailroom' "$APP/Contents/Info.plist" 2>/dev/null \
	|| /usr/libexec/PlistBuddy -c 'Set :CFBundleDisplayName Mailroom' "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleIdentifier string app.mailroom.alert' "$APP/Contents/Info.plist" 2>/dev/null \
	|| /usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier app.mailroom.alert' "$APP/Contents/Info.plist"
codesign -f -s - "$APP" 2>/dev/null || true

# ⚠ ${APP} 的花括号不能省：紧跟中文括号时 bash 会把多字节字符吞进变量名，报 unbound variable
echo "✓ 已建好 ${APP}（通知将显示 mailroom 图标）"
echo "  第一次弹通知时 macOS 会问一次「允许 Mailroom 发通知吗」，点允许。"
