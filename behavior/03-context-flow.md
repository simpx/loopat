# 03 — context flow

## 证明什么

在 loop 里(由 AI)做的改动,promote 后能在远端 repo 看到;反过来,外部对 repo 的改动,
新建 loop 时能 pull 看到。`notes` / `knowledge` / `personal` 三层都成立。这是
docs/context-flow.md 的两条边(① pull / ② promote)在真实 loop 上的端到端验证。

## Fixture

- git-over-ssh server,3 个 context repo(`kn`/`notes`/`personal`)作 fixture,已 seed 初始内容。
- vault key 授权;personal config 声明三者的 ssh url(自描述)。
- **真实 loop**:Claude SDK + podman 沙箱(需 API key)。

## 步骤 + 断言

1. 起 loop A,**让 AI 在沙箱里修改** `notes`/`kn`/`personal` 各一处 + promote。
   → assert:远端 repo(三层)能看到该改动。
2. 在远端 repo 直接做一处改动(模拟别的编辑者已 promote)。
3. 起 loop B(新 worktree from origin)。
   → assert:loop B 能看到步骤 2 的改动(三层)。

## 决策

"loop 里让 AI 修改" = **真跑 AI**(Claude SDK + 沙箱),不是模拟 git。

## 实现

`scripts/e2e/context-flow-ai.sh` — 黑盒:`npx loopat@latest` 起 server + v1 REST API
(register → token → createLoop → messages SSE)driving 真 loop;idealab 真 AI 在 podman
沙箱里改 notes + promote;ssh fixture(`git-ssh-server`)+ vault key。

rootless podman 下沙箱与 host 看 ssh server 的地址不同(沙箱只能容器名、host 只能 published
port),所以两条边各用自己可达的 url 指向同一 repo —— 纯 fixture artifact,生产中 ssh host
对所有人同一地址。

## 状态

✅ 已自动化(本机 npx 0.1.7)— ② promote ✓ [AI WAS HERE]、① pull ✓ [EXTERNAL EDIT]。
注:`scripts/e2e/context-flow.ts`(本地 file://,无 AI)+ `context-flow-ssh.ts`(vault key)
是机制层对照;本 case 证真 AI 端到端。
