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

## mac 双平台实测结论(0.1.15,2026-06-01)

- **沙箱 image blocker 可绕过**:本机 `podman build` → `podman save` → scp → VM `podman load`;loopat 检测 hashTag(`loopat-sandbox-<ws>-<containerfile-hash>`)存在即跳过 build。两机 Containerfile hash 一致。VM ping 公网加速 IP 通但 443 refused,模仿 `/etc/hosts` 无效——只能 load。
- **LOOPAT_HOME 必须在 `$HOME` 下**:podman machine 只挂 `$HOME`,`/tmp` 不挂 → bind workdir `statfs … no such file`。e2e 默认 `/tmp/...` 在 mac 不适用。
- **01** ✅ mac PASS(零残留 + label 隔离),与本机一致。
- **02** 🟡 mac 与本机逐字一致;stage3 失败是脚本过时(Model B/per-user:personal 走 deploy key),非 mac、非 loopat bug。
- **03** ✅ mac 真 AI 跑通(0.1.22):沙箱内 linux claude(2.1.159)调 idealab → 回复 "hello from mac"。linux claude 由 loopat **启动时** `--force` 自动装(npx 不跑 postinstall);docker base image 用 save/load;idealab key 手动配。
- e2e 在 mac 跑的适配:rsync repo + `npm i -g bun` + 预 load image + 给临时 workspace `podman build FROM <loaded> --label loopat.workspace=<ws>`(无网络)注入带 label 的 base,让 setup 跳过 build。
