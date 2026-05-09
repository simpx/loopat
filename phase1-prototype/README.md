# 1001 Phase 1 — Hi-Fi Prototype

Phase 1 产出：高保真、可交互（signal 驱动）的 1001 4 个一级概念
（Loop / Focus / Context / Chat）UI 原型。

不是真实实现 —— 数据全是 mock，但 fork / transfer-driver / spawn /
attach 这些动作都通过 signals 串起来，演示起来"像真的"。

## 跑起来

```sh
bun install
bun dev
```

打开 <http://localhost:5173>。

## 技术栈

- Vite + SolidJS + Tailwind v4
- 不用 router（单页 SPA，顶部 tab 切换）
- 不用后端（module-level signals + 内存 mock）

## 目录

```
src/
├── App.tsx        # 4-tab shell
├── state.ts       # 共享 signals（loops / currentLoopId / forkLoop ...）
├── pages/         # 一个 page / 一级概念
│   ├── loop.tsx
│   ├── focus.tsx
│   ├── context.tsx
│   └── chat.tsx
├── components/    # 复用组件（待补）
└── mock/          # 数据 fixtures（待补）
```

## 当前状态

- [x] Vite + Solid + Tailwind 脚手架
- [x] 4-tab shell（左 logo+tabs / 右 user），signal 驱动；🧶 logo + favicon
- [x] Loop tab：
  - chat-first 布局；右 panel 可 toggle（files / editor / terminal）50/50 split
  - 6 个真实 archetype loop：code 讨论（loopctl）/ research（llama-research）/ 线上问题（mirror-llama-3）/ context 整理（ccx-refine）/ 设计（1001-design）/ 上线（gateway-launch，他人 driver）
  - 富 chat 内容：text / diff card / todo card / artifact card / command card / 系统 marker（driver-change / RFD / claim）
  - **driver 状态机**：driver=ME → 显示 "release (RFD)"；rfd=true → 显示 "RFD · 可被认领"；他人 + rfd → "claim drive"
  - **context 显示**：每个 loop 头部 chips 显示 knowledge 范围 + mounted repos
  - **CodeMirror 6 编辑器**（python / markdown / js syntax highlight）
  - fork 永远可用
- [x] Focus tab：pinned / focus（8d expires）/ active loops 三段
- [x] Context tab：Knowledge / Agents / Repos sub-nav；Knowledge 含 wikilink + backlinks
- [x] Chat tab：channels + DMs + 消息流
- [ ] Loop attach UI（多 client mirror 演示）— 还没加
- [ ] 更复杂真实的 Focus mock

## 跟根目录文档的关系

详细概念定义、阶段性目标、设计决策见根目录：

- `../1001-story.md` —— 对外故事
- `../1001-mvp.md` —— 内部 MVP 工作文档（Phase 1-4 目标）
