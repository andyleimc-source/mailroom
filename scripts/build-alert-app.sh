#!/usr/bin/env bash
# 把 assets/mailroom.svg 打成一个带图标的通知小应用（~/.mailroom/Mailroom.app）。
#
# 为什么要有它：osascript 发的系统通知永远顶着「脚本编辑器」的图标，改不了。
# 通知要想带自己的图标，只能从一个「自己的 app」里发出来。
#
# ⚠⚠ 为什么是 Swift 编译、不是 osacompile 的 AppleScript applet：applet 的
#   `display notification` 没有能力**主动申请**通知权限——在这台机器上（会话经由
#   SSH 起、TCC 把责任方记成 sshd）系统不弹授权框、直接静默丢弃，applet 那条路
#   反复试过（默认身份 / 自定义身份 / 重签 / open 启动）全部无声无息。
#   Swift 走 UNUserNotificationCenter.requestAuthorization，会真正弹出授权框，
#   授权一次永久有效。没有 Xcode（swiftc）的机器跑本脚本会明确报错，
#   那台机器的通知走 osascript 兜底（图标不对但能弹）。
#
# 用法契约（bin/alert.mjs 依赖）：
#   ① 标题正文写进 $STATE/alert-payload.txt（第一行=标题，其余=正文，UTF-8）
#   ② `open -W -a $STATE/Mailroom.app` 启动
# 幂等：重跑就是重建。改了 SVG 或本脚本，重跑一次即可。
set -uo pipefail

cd "$(dirname "$0")/.."
SVG="assets/mailroom.svg"
STATE="${MAILROOM_STATE:-$HOME/.mailroom}"
APP="$STATE/Mailroom.app"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

[ -f "$SVG" ] || { echo "✗ 找不到 $SVG" >&2; exit 1; }
command -v swiftc >/dev/null 2>&1 || {
	echo "✗ 本机没有 swiftc（要装 Xcode 或 Command Line Tools）。" >&2
	echo "  不装也能用：通知会走 osascript 兜底，只是图标是脚本编辑器的。" >&2
	exit 1
}
mkdir -p "$STATE"

# ① SVG → 1024 png（qlmanage 系统自带）→ 各尺寸 → icns
qlmanage -t -s 1024 -o "$WORK" "$SVG" >/dev/null
SRC="$WORK/$(basename "$SVG").png"
[ -f "$SRC" ] || { echo "✗ SVG 渲染失败（qlmanage 没吐出 png）" >&2; exit 1; }
ICONSET="$WORK/Mailroom.iconset"
mkdir "$ICONSET"
for s in 16 32 128 256 512; do
	sips -z "$s" "$s" "$SRC" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
	d=$((s * 2))
	sips -z "$d" "$d" "$SRC" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$WORK/Mailroom.icns"

# ② Swift 源码：读 payload → 申请权限 → 发通知 → 退出
cat > "$WORK/main.swift" <<'EOF'
import AppKit
import UserNotifications

let payloadPath = "__STATE__/alert-payload.txt"
var title = "mailroom"
var body = ""
if let s = try? String(contentsOfFile: payloadPath, encoding: .utf8) {
    var lines = s.components(separatedBy: "\n")
    if !lines.isEmpty {
        title = lines.removeFirst()
        body = lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
let app = NSApplication.shared
let center = UNUserNotificationCenter.current()
center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
    guard granted else { exit(2) }
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.sound = UNNotificationSound.default
    let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
    center.add(req) { _ in
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { exit(0) }
    }
}
// 授权框可能挂着等人点，最多陪 60 秒（点了允许照样发得出去，因为回调在点击后才跑）
DispatchQueue.main.asyncAfter(deadline: .now() + 60) { exit(3) }
app.run()
EOF
sed -i '' "s|__STATE__|$STATE|" "$WORK/main.swift"

# ③ 组装 app 包 + 编译 + ad-hoc 签名 + 注册
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$WORK/Mailroom.icns" "$APP/Contents/Resources/Mailroom.icns"
cat > "$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key><string>app.mailroom.desk</string>
	<key>CFBundleName</key><string>Mailroom</string>
	<key>CFBundleDisplayName</key><string>Mailroom</string>
	<key>CFBundleExecutable</key><string>Mailroom</string>
	<key>CFBundleIconFile</key><string>Mailroom</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>1.0</string>
	<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
	<key>LSMinimumSystemVersion</key><string>11.0</string>
	<key>LSUIElement</key><true/>
	<key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
EOF
swiftc -O "$WORK/main.swift" -o "$APP/Contents/MacOS/Mailroom" -framework AppKit 2>&1 | grep -v "^$" || true
[ -x "$APP/Contents/MacOS/Mailroom" ] || { echo "✗ swiftc 编译失败" >&2; exit 1; }
codesign -f -s - "$APP" 2>/dev/null
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" >/dev/null 2>&1 || true

echo "✓ 已建好 ${APP}（通知将显示 mailroom 图标）"
echo "  第一次跑会弹「允许 Mailroom 发通知吗」，点一次允许，之后永久生效。"
