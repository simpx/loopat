# Acme Corp · Engineering baseline

> 全员加载。所有 loop 起来第一件事是 import 这个。

## 我们公司

- 主语言：中文写文档、英文写代码
- 默认 commit 规范：Conventional Commits（`feat: ...` / `fix: ...`）
- Never push to `main`，永远走 PR
- 永远不要 `git push --force` 到任何共享分支

## 安全基线

- 凭据不进仓库，走 `personal/<user>/vaults/`
- 跑生产相关命令前 ask before acting
- 任何破坏性操作（drop table / rm -rf / branch -D）必须先 echo 给用户确认

## 跨 profile 协作

- knowledge 优先就近原则：先看当前 profile/knowledge/，再看 workspace/knowledge/
- 看不到的 profile = 你没有挂它，不要假设那里的东西存在
