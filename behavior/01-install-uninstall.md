# 01 — install / uninstall

## 证明什么

`npx loopat` 装出来的一切都能被 `loopat uninstall` 清干净、**零残留**;而且多个
`LOOPAT_HOME` 并存时各删各的,卸载一个绝不误伤另一个(即便名字是前缀包含关系)。

## Fixture

- 临时的、相互前缀包含的两个 `LOOPAT_HOME`(`/tmp/loopat-e2e-a`、`/tmp/loopat-e2e-a2`)。
- 每个都 provision 一个带真实 sandbox 容器的 workspace(与 server 同代码路径)。
- bun + podman;首次会真建一次 sandbox 镜像。

## 步骤 + 断言

1. 两个 workspace 各起容器后 → 都有 container + image + network + data。
2. `uninstall` 掉 `a` → `a` 的 container / image / network / data **全为 0**。
3. **隔离 + 前缀歧义**:`a2` 仍完好(container/image/network/data 都在),尽管 `a` 是 `a2` 的前缀
   —— 因为删除按 `loopat.workspace` label,不是名字 glob。
4. `uninstall` 掉 `a2` → 也全清。

## 实现

`scripts/e2e/install-uninstall.sh`

## 状态

✅ 已自动化 — 本机实跑 PASS,零残留。
