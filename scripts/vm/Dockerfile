# loopat Linux VM image (booted via macOS Virtualization.framework)
#
# Extends the production Dockerfile with:
# - Linux kernel + initrd for VM boot
# - Custom init script (replaces systemd for simplicity)
# - DHCP client + network utilities
# - virtiofs mount support
#
# Build: scripts/vm/build-image.sh

ARG PLATFORM=linux/arm64
FROM --platform=${PLATFORM} oven/bun:1-slim AS vm-base

# Mirror switch for faster builds in China; safe to remove if not needed
RUN sed -i 's|http://deb.debian.org/debian|http://mirrors.tuna.tsinghua.edu.cn/debian|g' \
      /etc/apt/sources.list.d/debian.sources \
    && sed -i 's|http://security.debian.org|http://mirrors.tuna.tsinghua.edu.cn/debian-security|g' \
      /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
      # Sandbox tools
      bubblewrap git git-crypt \
      # Shell & utilities
      bash fish vim sudo ca-certificates curl \
      # Filesystem & mount tools (virtiofs, overlayfs)
      fuse3 util-linux mount kmod \
      # Networking: DHCP + ip tools
      iproute2 isc-dhcp-client \
    && rm -rf /var/lib/apt/lists/*

# Install Linux kernel + initramfs tools
# Package name: linux-image-arm64 / linux-image-amd64 (Debian naming)
# initramfs-tools generates the initrd; dracut is an alternative.
RUN apt-get update \
    && ARCH=$(dpkg --print-architecture) \
    && apt-get install -y --no-install-recommends \
         "linux-image-${ARCH}" \
         initramfs-tools \
    && rm -rf /var/lib/apt/lists/*

# Explicitly generate initrd using mkinitramfs (lower-level than update-initramfs;
# works inside Docker without a running kernel or mounted /proc).
RUN set -e; \
    KVER=$(ls /boot/vmlinuz-* 2>/dev/null | sort -V | tail -1 | sed 's|/boot/vmlinuz-||') ; \
    echo "Kernel version: $KVER" ; \
    ls -la /boot/ ; \
    # mkinitramfs works in Docker without /proc — unlike update-initramfs
    mkinitramfs -v -o "/boot/initrd.img-${KVER}" "${KVER}" ; \
    ls -lh /boot/ ; \
    # Copy real files (not symlinks) to stable extraction paths
    cp "/boot/vmlinuz-${KVER}"    /boot/vmlinuz-real ; \
    cp "/boot/initrd.img-${KVER}" /boot/initrd-real ; \
    echo "vmlinuz-real: $(ls -lh /boot/vmlinuz-real | awk '{print $5}')" ; \
    echo "initrd-real:  $(ls -lh /boot/initrd-real  | awk '{print $5}')"

# Create loopat user
RUN groupadd -r loopat \
    && useradd -m -g loopat -G sudo -s /bin/bash loopat \
    && echo "loopat ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/loopat \
    && chmod 0440 /etc/sudoers.d/loopat

# Make bwrap SUID so it can unshare namespaces without root
RUN chmod u+s /usr/bin/bwrap

# Install mise (dev tool version manager)
RUN curl -fsSL https://mise.run | MISE_INSTALL_DIR=/usr/local/bin sh

# ── Server code ──────────────────────────────────────────────────────────────
FROM vm-base AS builder

WORKDIR /opt/loopat
COPY package.json bun.lock* ./
COPY server/package.json server/
COPY web/package.json web/
# Install server dependencies only (web workspace satisfies bun's workspace resolution)
RUN bun install --production --frozen-lockfile --filter '@loopat/server'

COPY server server
RUN chown -R loopat:loopat /opt/loopat

# ── Final image ───────────────────────────────────────────────────────────────
FROM vm-base AS final
COPY --from=builder /opt/loopat /opt/loopat

# Custom init script: started as PID 1 via kernel init= parameter.
# Sets up /proc, /sys, /dev, networking, virtiofs, then launches the server.
COPY scripts/vm/loopat-init.sh /usr/local/bin/loopat-init.sh
RUN chmod +x /usr/local/bin/loopat-init.sh

# Announce PATH where bun lives (used by init script and bwrap env)
ENV PATH="/root/.bun/bin:/usr/local/bin:/usr/bin:/bin"

# Allow running the image directly as a container (for testing / dev).
# Inside a VM this is invoked via kernel init= parameter; as a Docker
# container CMD runs the same init script (VM-specific mounts become no-ops).
CMD ["/usr/local/bin/loopat-init.sh"]

# ── Metadata ──────────────────────────────────────────────────────────────────
LABEL org.opencontainers.image.title="loopat-vm"
LABEL org.opencontainers.image.description="loopat Linux VM image for macOS Virtualization.framework"
