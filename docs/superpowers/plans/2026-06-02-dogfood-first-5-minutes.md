# dogfood/first-5-minutes 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development 或 superpowers:executing-plans 逐任务实现。步骤用 `- [ ]` 勾选。

**Goal:** 一条 Playwright e2e,完整模拟真实用户:浏览器建基于 roster repo 的 loop → 真容器 → UI 发消息真 AI 回 → 点开 terminal 跑 git status/commit/push 到 fixture sshd 容器里的真 origin。

**Architecture:** 独立 playwright project `dogfood/`;fixture = 一个 sshd+git 的 podman 容器(裸仓库 knowledge/notes/personal/roster);隔离 LOOPAT_HOME 预置"已 onboarded",gitHost 指向 fixture;真 claude + 真 provider key(来自 dev 机 vault)。podman/key 缺则 fail。

**Tech Stack:** Playwright、podman、bun、现有 e2e/globalSetup pattern。

---

### Task 1: fixture sshd 容器(镜像 + 种子裸仓库)

**Files:**
- Create: `dogfood/first-5-minutes/fixtures/Containerfile`
- Create: `dogfood/first-5-minutes/fixtures/seed.sh`

- [ ] **Step 1:** 写 Containerfile:`FROM alpine`,装 `openssh git`,建 `git` 用户,sshd 配 `AuthorizedKeysFile`,base path `/srv/git`。
- [ ] **Step 2:** 写 seed.sh:把传入的 pubkey 写入 authorized_keys;`git init --bare /srv/git/{knowledge,notes,roster1,personal}.git`;往 knowledge 裸仓库 push 一个含 `.loopat/config.json`(notes 指向 fixture)的初始 commit;roster1 push 几个文件;每个 `--bare` 开 `receive.denyCurrentBranch=updateInstead`/允许 push。
- [ ] **Step 3:** 提交。`git add dogfood/first-5-minutes/fixtures && git commit -m "test: fixture sshd git server image"`

### Task 2: dogfood playwright config + fixture 起停

**Files:**
- Create: `dogfood/playwright.config.ts`(仿 `playwright.config.ts`,testDir=dogfood,globalSetup 起 fixture 容器 + backend)
- Create: `dogfood/setup.ts`、`dogfood/teardown.ts`

- [ ] **Step 1:** setup.ts:`podman build` fixture 镜像 → `podman run -d -p 127.0.0.1:0:22` 拿 host 端口 → 起隔离 LOOPAT_HOME backend(gitHost.baseUrl=ssh fixture,knowledge git=ssh)。
- [ ] **Step 2:** 预置 onboarded:在 LOOPAT_HOME 写 personal/test 的 config.json(provider=真 idealab,apiKey=`${IDEALAB_API_KEY}`)+ vault envs/IDEALAB_API_KEY(从 dev `~/.dashscope`? 用 dev vault 复制)+ vault id_ed25519(pub 已进 fixture authorized_keys)。
- [ ] **Step 3:** teardown.ts:`podman rm -f` fixture,kill backend。
- [ ] **Step 4:** 提交。

### Task 3: README + 建 loop 旅程骨架

**Files:**
- Create: `dogfood/first-5-minutes/README.md`(目的/流程/断言)
- Create: `dogfood/first-5-minutes/journey.spec.ts`

- [ ] **Step 1:** spec:登录态(storageState)→ `/loop` → 建基于 roster1 repo 的 loop → 等容器 running(轮询 status)。断言 loop 出现。
- [ ] **Step 2:** 运行验证(fail:容器/选择器待对)。`bunx playwright test --config dogfood/playwright.config.ts`
- [ ] **Step 3:** 提交。

### Task 4: UI 发消息 + 真 AI

- [ ] **Step 1:** 在 chat 输入框输入"在 workdir 跑 git status 并新建 a.txt"→ 发送 → 断言收到回复、无 error 事件(轮询 SSE/DOM)。
- [ ] **Step 2:** 运行、提交。

### Task 5: terminal git 断言(核心回归)

- [ ] **Step 1:** 点开 terminal → 输 `git status` → 断言**非 fatal**;`echo x>>a.txt; git add -A; git commit`;`git push` → 断言 push 成功。
- [ ] **Step 2:** host 侧验 fixture roster1.git 收到新 commit。
- [ ] **Step 3:** 提交。

### Task 6: 假绿即红 + npm script

- [ ] **Step 1:** podman/IDEALAB_API_KEY 缺 → `throw`(非 skip)。
- [ ] **Step 2:** `package.json` 加 `"dogfood": "playwright test --config dogfood/playwright.config.ts"`。提交。

## Self-Review
- 覆盖:fixture✓ 跳onboarding✓ 建loop✓ UI发消息✓ terminal git✓ 真AI✓ 假绿即红✓
- 待实现时确认:chat/terminal 的真实 selector、dev vault key 复制路径。
