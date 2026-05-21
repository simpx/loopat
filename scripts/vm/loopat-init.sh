#!/bin/bash
# loopat VM init script - runs as PID 1 inside the Linux VM.
# NOTE: Do NOT use set -e here - this script is PID 1 and must never exit.

# 1. Essential pseudo-filesystems
mount -t proc     proc     /proc              2>/dev/null || true
mount -t sysfs    sysfs    /sys               2>/dev/null || true
mount -t devtmpfs devtmpfs /dev               2>/dev/null || \
  mount -t tmpfs  tmpfs    /dev               2>/dev/null || true

mkdir -p /dev/pts /dev/shm /dev/mqueue
mount -t devpts  devpts   /dev/pts           2>/dev/null || true
mount -t tmpfs   tmpfs    /dev/shm           2>/dev/null || true
mount -t mqueue  mqueue   /dev/mqueue        2>/dev/null || true
mount -t tmpfs   tmpfs    /run               2>/dev/null || true
mount -t tmpfs   tmpfs    /tmp               2>/dev/null || true

[ -e /dev/fd ]     || ln -sf /proc/self/fd   /dev/fd
[ -e /dev/stdin ]  || ln -sf /proc/self/fd/0 /dev/stdin
[ -e /dev/stdout ] || ln -sf /proc/self/fd/1 /dev/stdout
[ -e /dev/stderr ] || ln -sf /proc/self/fd/2 /dev/stderr

# Set hostname + /etc/hosts so sudo doesn't warn "unable to resolve host"
hostname loopat 2>/dev/null || true
echo "127.0.0.1 localhost loopat" > /etc/hosts 2>/dev/null || true

echo "[loopat-init] pseudo-filesystems ready"

# 2. Networking
ip link set lo up 2>/dev/null || true

IFACE_FOUND=""
for IFACE in eth0 ens3 enp0s1 enp1s0 enp1s1; do
  if ip link show "$IFACE" >/dev/null 2>&1; then
    ip link set "$IFACE" up 2>/dev/null || true
    # dhclient on Debian: no -timeout flag; use -1 (try once) with lease time
    dhclient -1 -q "$IFACE" 2>/dev/null || true
    IFACE_FOUND="$IFACE"
    break
  fi
done

sleep 2

# Detect primary IP (POSIX-safe, no grep -P)
VM_IP=""
if command -v ip >/dev/null 2>&1; then
  VM_IP=$(ip -4 -o addr show 2>/dev/null | grep -v ' lo ' | awk '{print $4}' | cut -d/ -f1 | head -1)
fi

echo "[loopat-init] network: iface=${IFACE_FOUND:-none} ip=${VM_IP:-unknown}"

# 3. virtiofs: host ~/.loopat -> /home/loopat/.loopat
mkdir -p /home/loopat/.loopat

VIRTIOFS_OK=""
for i in 1 2 3 4 5; do
  if mount -t virtiofs loopat-home /home/loopat/.loopat 2>/dev/null; then
    echo "[loopat-init] virtiofs mounted OK (attempt $i)"
    VIRTIOFS_OK=1
    break
  fi
  sleep 1
done

if [ -z "$VIRTIOFS_OK" ]; then
  echo "[loopat-init] WARNING: virtiofs mount failed - loopat home will be empty"
fi

chown -R loopat:loopat /home/loopat/.loopat 2>/dev/null || true

# 4. Announce server URL to the Tauri host via serial console
if [ -n "$VM_IP" ]; then
  echo "LOOPAT_SERVER_READY=http://${VM_IP}:7787"
else
  echo "[loopat-init] WARNING: no IP address, using localhost fallback"
  echo "LOOPAT_SERVER_READY=http://localhost:7787"
fi

# 5. Server restart loop
export LOOPAT_HOME=/home/loopat/.loopat
export HOST=0.0.0.0
export LOOPAT_SERVE_HOST=0.0.0.0
export PATH=/usr/local/bin:/usr/bin:/bin
export HOME=/home/loopat
export SERVER_LOG=/home/loopat/.loopat/server.log

while true; do
  echo "[loopat-init] starting server ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
  # sudo clears the environment by default, so export vars inside the shell
  # command to ensure HOST/LOOPAT_HOME reach the bun process.
  sudo -u loopat bash -c \
    "export HOST=0.0.0.0 LOOPAT_HOME=${LOOPAT_HOME} LOOPAT_SERVE_HOST=0.0.0.0 HOME=${HOME} PATH=${PATH} && cd /opt/loopat && exec bun run server/src/index.ts 2>&1" \
    2>&1 | tee "$SERVER_LOG" || true
  echo "[loopat-init] server exited - restarting in 3s"
  sleep 3
done
