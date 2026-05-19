#!/usr/bin/env bash
# loopat macOS .app 安装/修复脚本
# 解决所有可能导致 app 无法启动的常见问题
set -euo pipefail

APP="/Applications/loopat.app"

echo "==> loopat macOS 安装修复"
echo ""

# ── 1. 检查 app 是否存在 ─────────────────────────────────
if [ ! -d "$APP" ]; then
  echo "❌ 未找到 $APP"
  echo "   请先将 loopat.app 拖入 /Applications/ 目录"
  exit 1
fi

# ── 2. 移除 quarantine 属性 ──────────────────────────────
echo "==> 移除 quarantine 属性（Gatekeeper 拦截）…"
xattr -cr "$APP" 2>/dev/null || true
echo "   ✅ xattr -cr 完成"

# ── 3. 对 app 内所有二进制做 ad-hoc 签名 ────────────────
echo "==> 对 app 内嵌的二进制做 ad-hoc 签名（防止代码签名检查失败）…"
find "$APP" -type f \( -name 'loopat-server' -o -name 'loopat-sandbox' -o -name 'claude' -o -name 'mise' -o -name 'git-crypt' \) 2>/dev/null | while read -r bin; do
  echo "   签名: ${bin#$APP/}"
  codesign --force --deep --sign - "$bin" 2>/dev/null || true
done

# 对整个 app 重新签名（包括所有嵌套 bundle）
echo "   签名: loopat.app（整体）"
codesign --force --deep --sign - "$APP" 2>/dev/null || echo "   ⚠️  app 整体签名跳过（不影响运行）"

echo "   ✅ 签名完成"

# ── 4. /loopat 合成挂载点 ────────────────────────────────
echo "==> 检查 /loopat 挂载点…"
if [ -e /loopat ]; then
  echo "   ✅ /loopat 已存在"
else
  ROOT="$HOME/.loopat/macos-root"
  echo "   ⚠️  /loopat 不存在，loopat sandbox 依赖此路径"
  echo "   需要创建 macOS 合成挂载点："
  echo ""
  echo "   请执行以下命令："
  echo "     mkdir -p \"$ROOT\""
  echo "     echo 'loopat	$ROOT' | sudo tee -a /etc/synthetic.conf"
  echo "     sudo reboot"
  echo ""
  echo "   重启后 /loopat 会自动映射到 $ROOT"
  echo ""
  read -r -p "   是否现在创建并追加 synthetic.conf？(y/N) " reply
  if [[ "$reply" =~ ^[Yy]$ ]]; then
    mkdir -p "$ROOT"
    echo "loopat	$ROOT" | sudo tee -a /etc/synthetic.conf
    echo "   ✅ synthetic.conf 已更新，请重启电脑后生效"
  fi
fi


# ── 5. macOS 权限检查 ─────────────────────────────────────
echo "==> 检查必要的系统权限…"

# 完全的磁盘访问权限 — sandbox 需要访问 /loopat 等路径
echo "   ① 完全磁盘访问权限（访达 > 应用程序 > loopat 右键简介 > 权限）"
echo "     如果 sandbox 无法启动，请授予 loopat.app「完全磁盘访问权限」"
echo "     路径: 系统设置 > 隐私与安全性 > 完全磁盘访问权限 > 添加 loopat.app"

# 辅助功能权限 — sandbox-exec 在某些 macOS 版本需要
echo "   ② 辅助功能权限（如果 sandbox 启动失败）"
echo "     路径: 系统设置 > 隐私与安全性 > 辅助功能 > 添加 loopat.app"

echo ""

# ── 6. 验证 ────────────────────────────────────────────────
echo "==> 验证 app 完整性…"
if [ -d "$APP" ]; then
  echo "   ✅ $APP 存在"
  HAS_SERVER=$(find "$APP" -name 'loopat-server' -type f 2>/dev/null | head -1)
  if [ -n "$HAS_SERVER" ]; then
    echo "   ✅ 内含 loopat-server"
  else
    echo "   ⚠️  未找到 loopat-server（app 可能不完整）"
  fi
  HAS_SANDBOX=$(find "$APP" -name 'loopat-sandbox' -type f 2>/dev/null | head -1)
  if [ -n "$HAS_SANDBOX" ]; then
    echo "   ✅ 内含 loopat-sandbox"
  else
    echo "   ⚠️  未找到 loopat-sandbox（app 可能不完整）"
  fi
fi

echo ""
echo "==> 全部完成！现在可以启动 loopat.app 了"
echo "   如果仍然无法启动，请查看:"
echo "     系统设置 > 隐私与安全性 > 仍要打开"
echo "     或尝试: sudo xattr -rd com.apple.quarantine $APP"
