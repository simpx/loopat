#!/usr/bin/env bash
# Build loopat for macOS (x86_64 + arm64).
#
# Prerequisites:
#   - Rust (rustup) with macOS targets:
#       rustup target add x86_64-apple-darwin aarch64-apple-darwin
#   - cargo-zigbuild (for cross-compiling Rust to macOS from Linux):
#       cargo install cargo-zigbuild
#   - zig compiler (used by cargo-zigbuild):
#       https://ziglang.org/download/
#   - Bun (for building the server binary)
#   - Homebrew on Linux (for fetching macOS git-crypt bottles):
#       /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
#   - Node.js (for patching Mach-O dylib paths in git-crypt)
#   - Xcode CLI tools (for Tauri on macOS native builds)
#
# Usage:
#   bash scripts/build-macos.sh          # build all
#   bash scripts/build-macos.sh x64      # build only x86_64
#   bash scripts/build-macos.sh arm64    # build only ARM
#   bash scripts/build-macos.sh tauri    # build Tauri app (macOS only)
#
# Output:
#   dist-macos-x64/    (server + sandbox for Intel Macs)
#   dist-macos-arm64/  (server + sandbox for Apple Silicon)
#   dist-macos-tauri/  (native resources staged for the Tauri .app bundle)
set -euo pipefail
cd "$(dirname "$0")/.."

ARCH="${1:-all}"

# Version of the claude-agent-sdk whose optional platform package ships the
# native claude CLI binary. Must match what the project's lockfile pins.
CLAUDE_SDK_VERSION="0.2.138"

# Version of mise (per-loop toolchain manager) to bundle.
# https://github.com/jdx/mise/releases
MISE_VERSION="2026.5.11"

# Version of git-crypt (encrypted vault secrets) and its dependency.
# https://github.com/AGWA/git-crypt/releases
GIT_CRYPT_VERSION="0.7.1"
OPENSSL_VERSION="3.4.1"

build_arch() {
  local target="$1"
  local outdir="$2"

  echo "==> Building sandbox for $target..."

  # On macOS native we use cargo build directly (zigbuild is for Linux cross-compile).
  # On Linux we use cargo zigbuild to cross-compile macOS binaries.
  if [[ "$(uname)" == "Darwin" ]]; then
    cargo build --manifest-path loopat-sandbox/Cargo.toml --release --target "$target"
  else
    cargo zigbuild --manifest-path loopat-sandbox/Cargo.toml --release --target "$target"
  fi

  echo "==> Building server binary for $target..."
  local bun_target
  local claude_pkg
  local misc_arch
  case "$target" in
    x86_64-apple-darwin) bun_target="bun-darwin-x64";  claude_pkg="claude-agent-sdk-darwin-x64";  misc_arch="x64" ;;
    aarch64-apple-darwin) bun_target="bun-darwin-arm64"; claude_pkg="claude-agent-sdk-darwin-arm64"; misc_arch="arm64" ;;
  esac
  mkdir -p "$outdir"
  bun build --compile --target="$bun_target" --outfile="$outdir/loopat-server" server/src/index.ts

  cp "loopat-sandbox/target/$target/release/loopat-sandbox" "$outdir/loopat-sandbox"
  cp scripts/install-macos.sh "$outdir/install.sh"

  # Bundle the native claude CLI binary from the SDK's optional platform package.
  bundle_claude_binary "$outdir" "$claude_pkg"
  # Bundle mise (per-loop toolchain manager) and git-crypt (encrypted vault secrets).
  bundle_mise_binary "$outdir" "$misc_arch"
  # On macOS native, git-crypt can be installed via brew directly.
  bundle_git_crypt_binary "$outdir" "$target"

  echo "==> $outdir:"
  ls -lh "$outdir/loopat-server" "$outdir/loopat-sandbox" "$outdir/claude" "$outdir/mise" "$outdir/git-crypt" "$outdir/install.sh"
}

# Download the platform-specific claude CLI binary from the npm registry and
# copy it into the output directory so loopat can find it via binaryDir().
bundle_claude_binary() {
  local outdir="$1"
  local pkg="$2"
  local tarball="/tmp/${pkg}.tgz"
  local extract="/tmp/${pkg}_extract"

  echo "==> Bundling claude binary from @anthropic-ai/${pkg}..."

  if [ -f "$outdir/claude" ]; then
    echo "  (already present, skipping)"
    return
  fi

  rm -rf "$extract"
  curl -sL "https://registry.npmjs.org/@anthropic-ai/${pkg}/-/${pkg}-${CLAUDE_SDK_VERSION}.tgz" -o "$tarball"
  mkdir -p "$extract"
  tar xzf "$tarball" -C "$extract"

  if [ -f "$extract/package/claude" ]; then
    cp "$extract/package/claude" "$outdir/claude"
    chmod +x "$outdir/claude"
    echo "  -> $outdir/claude ($(du -h "$outdir/claude" | cut -f1))"
  else
    echo "  WARNING: claude binary not found in $pkg tarball"
  fi
  rm -rf "$extract" "$tarball"
}

# Download the mise binary from GitHub releases and place it in the output
# directory so the server can find it via binaryDir().
bundle_mise_binary() {
  local outdir="$1"
  local arch="$2"  # "x64" or "arm64"

  local url="https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-macos-${arch}.tar.gz"

  if [ -f "$outdir/mise" ]; then
    echo "  mise already present, skipping"
    return
  fi

  echo "==> Bundling mise ${MISE_VERSION} (macos-${arch})..."
  curl -sL "$url" -o "/tmp/mise-${arch}.tar.gz"

  rm -rf /tmp/mise_extract
  mkdir -p /tmp/mise_extract
  tar xzf "/tmp/mise-${arch}.tar.gz" -C /tmp/mise_extract
  if [ -f /tmp/mise_extract/mise/bin/mise ]; then
    cp /tmp/mise_extract/mise/bin/mise "$outdir/mise"
  elif [ -f /tmp/mise_extract/bin/mise ]; then
    cp /tmp/mise_extract/bin/mise "$outdir/mise"
  elif [ -f /tmp/mise_extract/mise ]; then
    cp /tmp/mise_extract/mise "$outdir/mise"
  else
    found=$(find /tmp/mise_extract -name mise -type f | head -1)
    if [ -n "$found" ]; then
      cp "$found" "$outdir/mise"
    else
      echo "  WARNING: mise binary not found in tarball"
      rm -rf /tmp/mise_extract "/tmp/mise-${arch}.tar.gz"
      return
    fi
  fi
  chmod +x "$outdir/mise"
  rm -rf /tmp/mise_extract "/tmp/mise-${arch}.tar.gz"
  echo "  -> $outdir/mise ($(du -h "$outdir/mise" | cut -f1))"
}

# Download git-crypt and its OpenSSL dependency from Homebrew bottles, patch the
# dylib load path to use @loader_path so the binary is relocatable, and copy
# both into the output directory.
# Requires: brew (Homebrew on Linux — https://brew.sh)
bundle_git_crypt_binary() {
  local outdir="$1"
  local target="$2"  # e.g. "x86_64-apple-darwin" or "aarch64-apple-darwin"

  if [ -f "$outdir/git-crypt" ]; then
    echo "  git-crypt already present, skipping"
    return
  fi

  echo "==> Bundling git-crypt..."

  if [[ "$(uname)" == "Darwin" ]]; then
    bundle_git_crypt_native "$outdir"
  else
    bundle_git_crypt_bottle "$outdir" "$target"
  fi
}

# On macOS native: install git-crypt via brew directly and copy from Cellar.
bundle_git_crypt_native() {
  local outdir="$1"

  if ! command -v brew &>/dev/null; then
    echo "  WARNING: brew not found — git-crypt will not be bundled"
    return
  fi

  echo "  Installing git-crypt and openssl@3 via brew..."
  brew install git-crypt openssl@3 2>&1 | sed 's/^/  brew: /'

  local gc_path
  gc_path="$(brew --prefix git-crypt 2>/dev/null)/bin/git-crypt"
  if [ ! -f "$gc_path" ]; then
    gc_path="$(brew --cellar git-crypt 2>/dev/null)"
    gc_path="$(ls -d "$gc_path"/*/bin/git-crypt 2>/dev/null | head -1)"
  fi

  if [ -z "$gc_path" ] || [ ! -f "$gc_path" ]; then
    echo "  WARNING: git-crypt binary not found after brew install — will not be bundled"
    return
  fi

  cp "$gc_path" "$outdir/git-crypt"
  chmod 644 "$outdir/git-crypt"

  # Patch dylib load path: /opt/homebrew/opt/openssl@3/lib/libcrypto.3.dylib
  # or /usr/local/opt/openssl@3/lib/libcrypto.3.dylib → @loader_path/libcrypto.3.dylib
  local ossl_lib
  ossl_lib="$(brew --prefix openssl@3 2>/dev/null)/lib/libcrypto.3.dylib"
  if [ ! -f "$ossl_lib" ]; then
    echo "  WARNING: libcrypto.3.dylib not found — git-crypt may not work"
    return
  fi

  node -e '
    const fs = require("fs");
    const p = "'"$outdir"'/git-crypt";
    let buf = fs.readFileSync(p);
    // Try both Homebrew prefixes (Apple Silicon and Intel)
    const patterns = [
      "/opt/homebrew/opt/openssl@3/lib/libcrypto.3.dylib",
      "/usr/local/opt/openssl@3/lib/libcrypto.3.dylib",
    ];
    const next = "@loader_path/libcrypto.3.dylib";
    let found = false;
    for (const old of patterns) {
      const idx = buf.indexOf(old);
      if (idx !== -1) {
        buf.fill(0, idx, idx + old.length);
        buf.write(next, idx, "utf8");
        found = true;
        console.log("  Patched dylib load path");
        break;
      }
    }
    if (!found) {
      console.error("  WARNING: openssl prefix pattern not found in git-crypt binary");
      process.exit(1);
    }
    fs.writeFileSync(p, buf);
  '
  chmod 755 "$outdir/git-crypt"

  cp "$ossl_lib" "$outdir/libcrypto.3.dylib"
  chmod 755 "$outdir/libcrypto.3.dylib"

  echo "  -> $outdir/git-crypt ($(du -h "$outdir/git-crypt" | cut -f1))"
  echo "  -> $outdir/libcrypto.3.dylib ($(du -h "$outdir/libcrypto.3.dylib" | cut -f1))"
}

# On Linux: fetch macOS bottles and extract binaries (cross-compile path).
bundle_git_crypt_bottle() {
  local outdir="$1"
  local target="$2"

  local bottle_suffix
  case "$target" in
    x86_64-apple-darwin)  bottle_suffix="sonoma" ;;
    aarch64-apple-darwin) bottle_suffix="arm64_sonoma" ;;
    *) echo "  WARNING: unknown target $target for git-crypt"; return ;;
  esac

  echo "  Fetching ${bottle_suffix} bottles via brew..."

  # Fetch macOS bottles via Homebrew on Linux
  brew fetch --bottle-tag "$bottle_suffix" git-crypt 2>&1 | sed 's/^/  brew: /'
  brew fetch --bottle-tag "$bottle_suffix" openssl@3 2>&1 | sed 's/^/  brew: /'

  local brew_cache
  brew_cache="$(brew --cache 2>/dev/null)" || brew_cache="$HOME/.cache/Homebrew/downloads"

  local gc_bottle ossl_bottle
  gc_bottle="$(ls "$brew_cache"/git-crypt--*."${bottle_suffix}".bottle.tar.gz 2>/dev/null | head -1)"
  ossl_bottle="$(ls "$brew_cache"/openssl@3--*."${bottle_suffix}".bottle.tar.gz 2>/dev/null | head -1)"

  if [ -z "$gc_bottle" ] || [ -z "$ossl_bottle" ]; then
    echo "  WARNING: could not find cached bottles — git-crypt will not be bundled"
    return
  fi

  # Extract git-crypt binary (bottle layout: <name>/<version>/bin/git-crypt)
  tar xzf "$gc_bottle" -C "$outdir" */bin/git-crypt --strip-components=2
  chmod 644 "$outdir/git-crypt"

  # Patch dylib load path: @@HOMEBREW_PREFIX@@/opt/openssl@3/lib/libcrypto.3.dylib
  # → @loader_path/libcrypto.3.dylib so it works from any location.
  node -e '
    const fs = require("fs");
    const p = "'"$outdir"'/git-crypt";
    let buf = fs.readFileSync(p);
    const old = "@@HOMEBREW_PREFIX@@/opt/openssl@3/lib/libcrypto.3.dylib";
    const next = "@loader_path/libcrypto.3.dylib";
    const idx = buf.indexOf(old);
    if (idx === -1) {
      console.error("  WARNING: HOMEBREW_PREFIX pattern not found in git-crypt binary");
      process.exit(1);
    }
    buf.fill(0, idx, idx + old.length);
    buf.write(next, idx, "utf8");
    fs.writeFileSync(p, buf);
    console.log("  Patched dylib load path");
  '
  chmod 755 "$outdir/git-crypt"

  # Extract OpenSSL dylib
  tar xzf "$ossl_bottle" -C /tmp */lib/libcrypto.3.dylib --strip-components=2
  cp /tmp/lib/libcrypto.3.dylib "$outdir/libcrypto.3.dylib"
  chmod 755 "$outdir/libcrypto.3.dylib"

  echo "  -> $outdir/git-crypt ($(du -h "$outdir/git-crypt" | cut -f1))"
  echo "  -> $outdir/libcrypto.3.dylib ($(du -h "$outdir/libcrypto.3.dylib" | cut -f1))"
}

case "$ARCH" in
  all)
    build_arch x86_64-apple-darwin dist-macos-x64
    build_arch aarch64-apple-darwin dist-macos-arm64
    ;;
  x64|x86_64)
    build_arch x86_64-apple-darwin dist-macos-x64
    ;;
  arm64|aarch64)
    build_arch aarch64-apple-darwin dist-macos-arm64
    ;;
  tauri)
    echo "==> Building Tauri desktop app (requires macOS)..."
    if [[ "$(uname)" != "Darwin" ]]; then
      echo "Tauri can only be built on macOS. Run this script on a Mac."
      exit 1
    fi

    # Detect native arch and pick the right dist directory
    native_arch="$(uname -m)"
    case "$native_arch" in
      x86_64)  dist_src="dist-macos-x64" ;;
      arm64)   dist_src="dist-macos-arm64" ;;
      *)       echo "Unknown arch: $native_arch"; exit 1 ;;
    esac

    echo "  Using binaries from $dist_src/"

    # Auto-build native arch binaries if missing
    required_bins=("loopat-server" "loopat-sandbox" "claude" "mise" "git-crypt" "libcrypto.3.dylib" "install.sh" "install-macos-app.sh")
    need_build=false
    for bin in "${required_bins[@]}"; do
      if [ ! -f "$dist_src/$bin" ]; then
        need_build=true
        break
      fi
    done
    if [ "$need_build" = true ]; then
      echo "  Binaries missing in $dist_src/, building natively first..."
      bash "$0" "$([ "$native_arch" = arm64 ] && echo arm64 || echo x64)"
    fi

    # Ensure cargo-tauri CLI is installed
    if ! cargo tauri --version &>/dev/null; then
      echo "  Installing tauri-cli..."
      cargo install tauri-cli --version "^2"
    fi

    # Stage native-arch resources at the stable path referenced by tauri.conf.json.
    rm -rf dist-macos-tauri
    mkdir -p dist-macos-tauri
    cp "$dist_src/loopat-server" \
       "$dist_src/loopat-sandbox" \
       "$dist_src/claude" \
       "$dist_src/mise" \
       "$dist_src/git-crypt" \
       "$dist_src/libcrypto.3.dylib" \
       dist-macos-tauri/
    cp scripts/install-macos-app.sh dist-macos-tauri/

    tauri_config='{"bundle":{"resources":["../dist-macos-tauri/loopat-server","../dist-macos-tauri/loopat-sandbox","../dist-macos-tauri/claude","../dist-macos-tauri/mise","../dist-macos-tauri/git-crypt","../dist-macos-tauri/libcrypto.3.dylib"]}}'

    # Build the .app bundle + .dmg
    cd src-tauri
    cargo tauri build --bundles dmg --config "$tauri_config"
    echo "==> Tauri bundle: src-tauri/target/release/bundle/dmg/"
    cd ..

    # Add install-macos-app.sh alongside the .app in the DMG
    dmg_path="src-tauri/target/release/bundle/dmg/loopat_*.dmg"
    dmg_file=$(ls $dmg_path 2>/dev/null | head -1)
    if [ -n "$dmg_file" ]; then
      echo "==> Adding install-macos-app.sh to DMG..."
      rw_dmg="/tmp/loopat_rw.dmg"
      mount_point="/tmp/loopat_dmg_mount"
      vol_name="loopat"
      rm -f "$rw_dmg"
      hdiutil convert "$dmg_file" -format UDRW -o "$rw_dmg"
      # Attach without auto-opening in Finder
      hdiutil attach "$rw_dmg" -mountpoint "$mount_point" -nobrowse -noautoopen
      cp scripts/install-macos-app.sh "$mount_point/install-macos-app.sh"

      # Arrange icons via AppleScript: app at top, script below, taller window
      osascript \
        -e "set targetPath to POSIX file \"$mount_point\" as alias" \
        -e "tell application \"Finder\"" \
        -e "  open targetPath" \
        -e "  delay 0.5" \
        -e "  set win to window of targetPath" \
        -e "  set current view of win to icon view" \
        -e "  set toolbar visible of win to false" \
        -e "  set statusbar visible of win to false" \
        -e "  set the bounds of win to {100, 100, 520, 420}" \
        -e "  set iconViewOptions to icon view options of win" \
        -e "  set arrangement of iconViewOptions to not arranged" \
        -e "  set position of item \"loopat.app\" of win to {180, 80}" \
        -e "  set position of item \"install-macos-app.sh\" of win to {180, 200}" \
        -e "  close win" \
        -e "end tell" || echo "  (icon arrangement skipped — osascript failed)"

      hdiutil detach "$mount_point"
      mv "$dmg_file" "${dmg_file}.bak"
      hdiutil convert "$rw_dmg" -format UDZO -o "$dmg_file"
      rm -f "$rw_dmg" "${dmg_file}.bak"
      echo "  -> $dmg_file (updated with install-macos-app.sh)"
    fi

    ;;
  *)
    echo "Usage: $0 [all|x64|arm64|tauri]"
    exit 1
    ;;
esac
