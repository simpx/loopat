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
- [x] 4-tab shell，signal 驱动切换
- [x] Loop 列表 + fork 演示（点 fork → 新 loop 出现在列表顶部）
- [ ] Loop chat（含 driver-transfer 系统标记）
- [ ] Loop attach UI（多 client mirror 演示）
- [ ] Focus tab（pinned / focus / active loops 三段，复杂真实 mock）
- [ ] Context tab（Knowledge / Agents / Repos sub-nav）
- [ ] Chat tab（channels + DMs + spawn loop）

## 跟根目录文档的关系

详细概念定义、阶段性目标、设计决策见根目录：

- `../1001-story.md` —— 对外故事
- `../1001-mvp.md` —— 内部 MVP 工作文档（Phase 1-4 目标）
