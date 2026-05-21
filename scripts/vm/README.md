# loopat VM Image Build

This directory contains scripts and Dockerfile to build the Linux VM image
that the loopat macOS Tauri app uses via Apple's **Virtualization.framework**.

## Architecture

```
macOS Host
├── loopat.app  (Tauri)
│   ├── Main Window  → WebKit webview → http://<vm-ip>:7787
│   ├── Logs Window  → streams VM console output
│   └── Rust Backend
│       └── Virtualization.framework  (native — no external vfkit needed)
│           └── virtiofs  (mounts host ~/.loopat into VM)
│
└── Linux VM  (Debian, ARM64 / x86_64)
    ├── bun server  → port 7787 (loopat web API)
    ├── bwrap  (per-loop sandbox environments, works on Linux as usual)
    └── /home/loopat/.loopat  → host ~/.loopat via virtiofs
```

Key properties:
- **Host data lives on macOS**: `~/.loopat` is shared into the VM, never duplicated.
- **bwrap works unchanged**: bwrap/overlayfs is Linux-only; running in a VM solves that.
- **VM is stateless**: only `~/.loopat` persists. The rootfs can be reset without data loss.

## Prerequisites

- macOS (Apple Silicon or Intel)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) with buildx enabled
- [Rust + cargo](https://rustup.rs)
- [Tauri CLI](https://tauri.app/start/): `cargo install tauri-cli`
- **No vfkit needed** — the app uses Virtualization.framework natively via an ObjC bridge compiled into the Rust binary

## Build VM Image

```sh
# From repo root
scripts/vm/build-image.sh
```

Output files are placed in `src-tauri/resources/`:
- `vmlinuz`       – Linux kernel
- `initrd`         – Initial RAM disk
- `rootfs.img.gz` – Compressed root filesystem (ext4, ~200MB compressed)

## Build Tauri App

```sh
# Build web frontend + Tauri app
bun run tauri:build

# The .app bundle is at:
# src-tauri/target/release/bundle/macos/loopat.app
```

## Development

For iterating on Rust/UI code without rebuilding the VM image:

```sh
# Start web dev server (runs at localhost:5173)
bun run dev:web &

# In another terminal, start Tauri in dev mode
cd src-tauri && cargo tauri dev
```

In dev mode, the Tauri window loads from the Vite dev server instead of the VM.
To test against the real VM, run `scripts/vm/build-image.sh --no-compress` first.

## Network

The VM uses Virtualization.framework's NAT network. The VM IP is in the
`192.168.64.x` range. The init script announces the server URL to the
serial console (`LOOPAT_SERVER_READY=http://...`), which the Tauri backend
parses to know which URL to load in the webview.

## virtiofs & overlayfs

The server code stores per-loop overlay directories under
`~/.loopat/loops/<id>/home-{upper,work,merged}`. These reside on the virtiofs
share. Linux ≥ 5.15 supports overlayfs over FUSE/virtiofs. If the VM kernel
is older, bwrap automatically falls back to `--tmpfs $HOME` (loop-local
ephemeral home; persisted data in workdir is unaffected).
