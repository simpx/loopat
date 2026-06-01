# loopat — todo / 已知问题

> 记录用,先不动手修这些。当前无人值守任务是「mac 跑通 + behavior cases 全跑」。
> 最后更新:2026-06-01

## 已知问题

- [ ] **凭证链:per-user 模型下每个 user 的 vault key 要能访问 team git 平台**
  > 现象:simpx 的 vault key 没注册到 gitlab,新建 loop 时 `clone dashscope/knowledge` → `Permission denied (publickey)`,knowledge 空。
  > 现在已优雅处理(loop 顶部黄色 banner 提示 contextWarnings),但缺一个把 vault 公钥注册到 git 平台的流程/引导 → 应并入批5 stage2。

- [ ] **UX 缺陷:UI 只暴露 deploy key,不暴露 team 用的 vault key**
  > Model B 有两把 key:deploy key(host-secrets,personal repo 用,comment `loopat:<user>`)+ vault key(vaults/default,knowledge/notes/team repos 用,comment `loopat:<provider-login>`)。
  > `/settings/personal-repo` 的 "Show SSH public key" 只显示 **deploy key**,用户自然以为注册那把就够 → 注册后 knowledge 仍 `Permission denied`(team 用的是 vault key,没暴露/没注册)。实测踩坑(simpx)。
  > 修:在 personal-repo 页 / `/context/repos` / 批5 stage2 同时显示 **vault key**(team key)并验证它能 `git ls-remote` kn/notes。两把 key comment 还不一致(deploy=user id、vault=provider login),也易混。

- [ ] **serve-rs binary 没编译进 npx 包** → Share Artifact 不可用
  > 启动日志:`serve container failed: serve binary not found at …/serve-rs/target/release/loopat-serve`。
  > 非核心功能;要么 CI 编译进包,要么 UI 显式标注不可用。

- [ ] **旧 loops 与 per-user 重构不兼容**
  > per-user 化后,旧 loops 的 context worktree 派生自 workspace 共享 main repo,而沙箱挂载已改 per-user → 旧 loops 打开可能异常。MVP 无迁移,新建 loop 即可。

- [ ] **workspace.ts 旧 repos 管理仍是 workspace 级**
  > `addRepo/listRepos/pullRepo/readRepoDetail` 仍指 `workspaceReposDir`,与 per-user 模型不一致。待批4b 统一到 knowledge config 的 `repos[]`。

- [ ] **reason 文案改进已 commit 未发版**(47b2425)
  > context warning 抓 "Permission denied" 行而非 git 尾部 boilerplate。攒到下次 `npm version` 一起发。

## 准备做的事(按批次)

- [ ] **批4b — `/context/repos` 可编辑页**
  > 读写 knowledge repo 的 `.loopat/config.json` 的 `repos[]`(+ notes),编辑后 gated promote 回 knowledge repo。替换 workspace.ts 的旧 repos 管理。

- [ ] **批4b — code provider seed**
  > 注册/setup personal repo 时,自动写 personal config 的 `knowledge` 指针 + 初始化 knowledge repo 的 `.loopat/config.json`(notes + repos 预置),省去手动 push(这次是我手动 clone+push 进去的)。

- [ ] **批5 — 注册后 3 阶段验证门引导**
  > ① personal repo(clone/decrypt 通过)② team ssh key(`git ls-remote` kn/notes 通过)③ AI key(真实 API 调用 200)。每阶段 active-verification gate。stage2 顺带解决上面的「vault 公钥注册 git 平台」。

## mac 双平台测试结果(2026-06-01 无人值守跑)

mac:`ssh simpx@30.221.161.254`,podman machine(applehv linux VM),npx loopat@0.1.15。

- ✅ **mac loopat 完整跑通** — 0.1.15 启动 ready、bootstrap 全绿、沙箱容器可运行(fish 3.7 + mise)。
  > docker.io blocker 绕过方案(已验证可行):**本机 build sandbox image → `podman save` → scp → VM `podman load`**;loopat 的 `ensureSandboxImage` 检测 hashTag(`loopat-sandbox-<ws>-<containerfile-hash>`)存在即跳过 build。两机 Containerfile hash 一致(`4cd6b540132396f7`)。VM ping 公网加速 IP 通但 443 refused → 模仿 /etc/hosts 无效,只能 load。
- ✅ **01 install/uninstall** — mac PASS,零残留 + label 隔离(含 prefix 歧义)全过,与本机一致。
- 🟡 **02 personal-permissions** — mac 与本机**逐字一致**(stage1/2 ✓,stage3 ✗)。stage3 失败是 **02 脚本过时**(Model B + per-user 后 personal 走 deploy key,脚本仍授权 vault key 到 personal repo),**非 mac 问题、非 loopat bug**;本机同样失败。→ 见下「02 脚本需更新」。
- ❌ **03 context-flow 真 AI** — mac **blocked**:沙箱是 linux,但 mac npx 只装 `claude-agent-sdk-darwin-arm64`,bind 进沙箱 `Exec format error`。见下新 blocker。

### mac 部署注意(新发现)

- **LOOPAT_HOME 必须在 `$HOME` 下** — podman machine(applehv)只把 `$HOME` 挂进 VM,`/tmp` 不挂 → bind mount workdir `statfs … no such file`。e2e 脚本默认 `/tmp/loopat-e2e-*` 在 mac 不适用(本机 linux rootless 无此限制)。
- **git-ssh-server image(02/03 用)同样要 save/load**(alpine `apk` 也需公网)。
- e2e 在 mac 跑需:rsync repo + `npm i -g bun` + 预 load image + 给临时 workspace 注入带 `loopat.workspace` label 的 base image(`podman build FROM <loaded> --label …`,无网络)让 setup 跳过 build。

## 新 blocker(loopat 真实问题,非测试环境)

- [ ] **mac 上沙箱 AI 需要 linux claude binary,但 npx 按 host 平台只装 darwin claude**
  > 沙箱是 linux VM,loopat 把 host 的 `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` bind 进沙箱 → `Exec format error`。要在 darwin host 上也准备一份 linux-arm64 claude 给沙箱用(额外依赖,或沙箱内自带)。03 真 AI 在 mac 因此跑不通。

- [ ] **02 脚本 + md 需更新到 Model B / per-user 模型**
  > 现 stage3 假设 personal repo 用 vault key,实际走 deploy key(`personalSshCommand`);且 notes 已从 personal config 移进 knowledge config。脚本与断言要重写。本机/ mac 都在 stage3 失败(行为一致,只是脚本过时)。
