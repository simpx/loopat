# loopat — todo / 已知问题

> 记录用,先不动手修这些。当前无人值守任务:「mac 版本完整跑通 + behavior cases 全跑」。
> 最后更新:2026-06-02(session: A2A / per-user repos / onboarding / mcp setup)

## 已知问题

### 凭证 / onboarding
- [ ] **per-user vault key 要能访问 team git 平台**:simpx 的 vault key 没注册到 gitlab → 新建 loop `clone example/knowledge` Permission denied,knowledge 空。已优雅处理(loop 顶部 contextWarnings banner),但缺"把 vault 公钥注册到 git 平台"的引导。并入 onboarding。
- [ ] **UI 两把 key 易混**:deploy key(personal repo 用,comment `loopat:<user>`)vs vault key(team repos 用,comment `loopat:<provider-login>`)。personal-repo 页要同时显示 vault key 并验证能 `git ls-remote`。
- [ ] **onboarding 后续 check**:code.ts 的 `onboarding()` 现有两步(personal repo + AI key)。可加:vault key 注册验证、mcp 认证、git/api 权限探测(都在 code.ts 里加,平台不动)。

### A2A
- [ ] **走的是方案 A(loopback)**:a2a adapter loopback 调自己的 `/api/v1`。已确认对外/对用户一致。**计划方案 C**:把 turn 引擎抽成进程内函数,`/api/v1` 和 `/a2a` 各自绑定,去掉 loopback + "对外 API 调对外 API"的怪味。
- [ ] **A2A `input-required` 未实现**:现在 turn 走 `bypassPermissions` 跳过了"中途要用户输入"。协议两边都支持(A2A input-required ↔ v1 requires_choice),以后做交互式多轮。
- [ ] **contextId→loop 映射在内存**:重启后新会话重开 loop(v1 可接受)。
- [ ] **a2a tool_call/thinking 未透出**:现在只透 assistant 文本到 artifact;以后可把工具调用塞进 artifact。

### per-user 重构遗留
- [ ] **admin profile 管理仍 workspace 级**:`tiers.ts` 的 `listProfilesRich()` / `/api/admin/profiles` 还读 `workspaceProfilesDir`。new-loop 选择器 + 统计已改 per-user(`listProfiles(user)`/`computeLoopStats(user,...)`),admin 那块要统一。
- [ ] **`/api/sync/repos`(单 repo pull/push)对 bare mirror 是空操作**:code repos 现在是 host-only bare mirror(`repo-cache/<name>`),旧的单 repo sync 端点指向旧 working-tree 路径,找不到 → 空。bare mirror 每次建 loop 自动 fetch,基本不需要手动 sync。要的话补 bare 版 fetch。
- [ ] **knowledge/notes 还是 working-tree 缓存,不是 bare mirror**:code repos 已改 bare mirror(`--bare --depth=1` 单分支 + worktree)。knowledge/notes 有 git-crypt、是入口指针,改 bare 风险高,暂缓。用户说过"每个 repo 都这样"。
- [ ] **旧 loops 与 per-user 不兼容**:旧 loops 的 context worktree 派生自 workspace 共享 main repo,沙箱挂载已改 per-user → 旧 loops 打开可能异常。MVP 无迁移,新建即可。

### 其它
- [ ] **serve-rs binary 没编译进 npx 包** → Share Artifact 不可用。CI 编译进包,或 UI 标注不可用。
- [ ] **fatal: not a git repository 噪音**:已修(0.1.27 把 `/api/version` 的 git 改成 `stdio:["ignore","pipe","ignore"]`)。mac mini 0.1.39+ 实测 0 次。若再现 = 旧版本,升级即可。其余 git 调用都走 `execFileP`(捕获 stderr,不泄露)。
- [ ] **npmmirror 同步滞后**:每次发版要手动 `curl -X PUT .../syncs?sync_upstream=true`。mac mini 用 npmjs(加 `npm_config_prefer_online=true` 破缓存),siqian mac 用 npmmirror。
- [ ] **behavior 02 脚本过时**:stage3 假设 personal repo 用 vault key,实际走 deploy key(Model B / per-user);notes 已移进 knowledge config。脚本+断言要重写。

## 准备做的事
- [ ] A2A 方案 C(共享 turn 引擎,去 loopback)
- [ ] onboarding 补 vault-key 注册引导 + 更多 check
- [ ] admin profile 管理统一到 per-user knowledge
- [ ] behavior 02 脚本更新到 Model B / per-user
- [ ] (可选)knowledge/notes 也改 bare mirror

## 本 session 已发布(0.1.32 → 0.1.40)
- 0.1.32 onboarding 完全扩展自管(check→remediation,route/form 两原语)
- 0.1.33/34 profile 列表+统计改 per-user knowledge
- 0.1.35/36/37 loop 建仓提速:depth=1 → bare mirror cache + worktree
- 0.1.38 mcp:通用 authed + 内联 resource + 粘贴 url 解析填值
- 0.1.39 标准 A2A + per-user agent(`/a2a/<user>/...`)+ 可编辑 card/key
- 0.1.40 personal repo 导入已加密 repo 时显示 crypt-key 输入框
- (扩展)code.ts onboarding 判断 AI key 改用 resolved providers(兼容已有 repo)
