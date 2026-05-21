# loopat Linux VM image (booted via macOS Virtualization.framework)
#
# Optimised for size: multi-stage build, runtime-only packages,
# no kernel headers / build tools in the final image.
#
# Build: scripts/vm/build-image.sh

ARG PLATFORM=linux/arm64

# ── Base: install everything needed to build + generate initrd ──────────────
FROM --platform=${PLATFORM} oven/bun:1-slim AS base

# Mirror switch for faster builds in China; safe to remove if not needed
RUN sed -i 's|http://deb.debian.org/debian|http://mirrors.tuna.tsinghua.edu.cn/debian|g' \
      /etc/apt/sources.list.d/debian.sources \
    && sed -i 's|http://security.debian.org|http://mirrors.tuna.tsinghua.edu.cn/debian-security|g' \
      /etc/apt/sources.list.d/debian.sources

# Install runtime packages + kernel (in one apt run to avoid duplicate fetch)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      # Sandbox tools
      bubblewrap git git-crypt \
      # Shell & utilities (minimal)
      bash sudo ca-certificates curl \
      # Filesystem & mount tools (virtiofs, overlayfs)
      fuse3 util-linux mount kmod \
      # Networking: DHCP + ip tools
      iproute2 isc-dhcp-client \
      # Kernel + initramfs (needed to generate /boot files; purged below)
      "linux-image-$(dpkg --print-architecture)" \
      initramfs-tools \
    && rm -rf /var/lib/apt/lists/*

# Generate initrd from the installed kernel, then purge kernel packages.
# Only /boot/vmlinuz-real and /boot/initrd-real are needed at runtime (extracted
# by build-image.sh into the rootfs), not the build-time packages themselves.
#
# mkinitramfs runs in Docker without access to real hardware, so it cannot auto-
# detect the required storage/console drivers.  We pin them explicitly so the
# kernel can mount the rootfs and initialise the virtio console at boot.
RUN set -e; \
    KVER=$(ls /boot/vmlinuz-* 2>/dev/null | sort -V | tail -1 | sed 's|/boot/vmlinuz-||'); \
    echo "Kernel version: $KVER"; \
    mkdir -p /etc/initramfs-tools; \
    printf '%s\n' \
      virtio_blk virtio_console virtio_net \
      virtio virtio_ring ext4 \
      > /etc/initramfs-tools/modules; \
    mkinitramfs -v -o "/boot/initrd.img-${KVER}" "${KVER}"; \
    cp "/boot/vmlinuz-${KVER}"    /boot/vmlinuz-real; \
    cp "/boot/initrd.img-${KVER}" /boot/initrd-real; \
    apt-get purge -y --auto-remove "linux-image-*" initramfs-tools; \
    rm -rf /var/lib/apt/lists/*; \
    echo "vmlinuz-real: $(ls -lh /boot/vmlinuz-real | awk '{print $5}')"; \
    echo "initrd-real:  $(ls -lh /boot/initrd-real  | awk '{print $5}')"

# Create loopat user, bwrap SUID, and mise in one layer
RUN groupadd -r loopat \
    && useradd -m -g loopat -G sudo -s /bin/bash loopat \
    && echo "loopat ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/loopat \
    && chmod 0440 /etc/sudoers.d/loopat \
    && chmod u+s /usr/bin/bwrap \
    && curl -fsSL https://mise.run | MISE_INSTALL_DIR=/usr/local/bin sh

# ── Builder: install server node_modules ───────────────────────────────────
FROM base AS builder

WORKDIR /opt/loopat
COPY package.json bun.lock* ./
COPY server/package.json server/
COPY web/package.json web/
RUN bun install --production --frozen-lockfile --filter '@loopat/server' \
    && rm -rf /root/.bun/install/cache

COPY server server
COPY web/dist web/dist
RUN chown -R loopat:loopat /opt/loopat

# ── Final image ─────────────────────────────────────────────────────────────
FROM base
COPY --from=builder /opt/loopat /opt/loopat

# Custom init script: started as PID 1 via kernel init= parameter.
COPY scripts/vm/loopat-init.sh /usr/local/bin/loopat-init.sh
RUN chmod +x /usr/local/bin/loopat-init.sh

# Strip docs / man / locale to save space
RUN rm -rf /usr/share/doc /usr/share/man /usr/share/locale /var/log/*

# Announce PATH
ENV PATH="/root/.bun/bin:/usr/local/bin:/usr/bin:/bin"

# Allow running the image directly as a container (for testing / dev).
CMD ["/usr/local/bin/loopat-init.sh"]

LABEL org.opencontainers.image.title="loopat-vm"
LABEL org.opencontainers.image.description="loopat Linux VM image for macOS Virtualization.framework"
