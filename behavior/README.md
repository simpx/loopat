# behavior — 行为测试目录

每个 `NN-<name>.md` 描述**一个 case**:一段 loopat 必须满足的端到端行为,以及它**证明了什么**。
描述与实现分离 —— 规格在这里,可执行实现在 `scripts/e2e/`。

## 约定

- 文件名 `NN-<kebab-name>.md`,两位编号。
- 每个 case 写清:**目的 / 证明什么** → **fixture(前置)** → **步骤 + 断言** → **实现** → **状态**。
- 状态:✅ 已自动化 · 🟡 半自动/手动 · ⬜ 待实现。
- case 的实现尽量自包含、安全(临时 `LOOPAT_HOME`、用完即清),不碰真实 workspace。

## Cases

| # | case | 证明 | 状态 |
|---|------|------|------|
| 01 | install / uninstall | 装完能清干净、零残留;workspace 之间隔离 | ✅ |
| 02 | personal 权限 | 权限跟着 personal 走,与 host 无关 | ✅ |
| 03 | context flow | loop 内改动→外部可见,外部改动→新 loop 可见 | ✅ 真 AI(notes 层) |

## 共享测试基建

- `scripts/e2e/git-ssh-server/` — 最小 key-only git-over-ssh 服务器(podman),用于真测 ssh 凭证。

## 环境前提 / 部署注意

- podman:本机 rootless,或 macOS 的 `podman machine`(applehv VM)。
- **公司内网 macOS 的坑**:podman VM 只能访问内网,拉不到公网 docker.io —— 主机的
  VPN/加速(`/etc/hosts` → 公网加速 IP)**不被 VM 继承**。sandbox base 是 `ubuntu:24.04`
  (docker.io),所以 VM 必须有**内网可达的 docker mirror**(registries.conf 配 mirror +
  可能 `podman login`),否则沙箱建不起来 —— **loopat 本身在这种 mac 上也跑不了沙箱**,
  与测试无关。配好内网 mirror 后,case 1/2/3 才能在 mac 上双平台跑。
- 真 AI 的 case(03)还需 idealab API key(`IDEALAB_KEY`)。
