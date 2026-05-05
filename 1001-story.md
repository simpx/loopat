# 1001 —— 当 AI 是同事，工作空间该长什么样

> 内部代号 **1001**。这是一篇构思阶段的设想，记录把"人 + AI 一起做事"变成工作空间 first-class 概念的过程。文档将放在 1001 未来仓库的 `docs/` 下，作为最初的 idea 留档。

---

## 1. 背景：AI 已经是同事，但没有工具为此准备

每天用 1 ~ 3 亿 token。

LLM 早就不是好奇心 demo —— 它是日常协作者。但回头看我每天用的协同工具，全部是为另一个时代设计的：

- **Slack** 假设协作者都是人，靠同步
- **Notion** 假设知识是稳态的，给人写、给人读
- **Jira / 团队 issue tracker** 假设有 PM 在外面摆好流程
- **Claude Code / VSCode** 假设你一个人在写代码

没有一种工具是为"人 + AI 一起推进一件具体的工作"设计的。

这篇文章记录我对这件工具的设想。

---

## 2. 我先后试了几条路，每条都撞了墙

### 第一次：分层 + 本地（ccx）

最早我写了一套 ccx (Context Complex) 给本地 Claude Code 分层：团队级 knowledge / 项目级 workspace / 任务级 session。这套用得很顺，但从中我得到两条 lesson：

> **Lesson 1**：knowledge 必须人来管。AI 写出来的内容很爽但不收敛 —— 你不主动减熵，它就一直加熵。
>
> **Lesson 2**：Claude Code 这种"为某个目的而生的 session"才是生产力形态。通用聊天机器人（一个会话承载一切，姑且戏称为 *龙虾*）做不了真正的工作 —— 它没有"目的"这个上下文。

ccx 是单人工具。一旦需要协同，立刻撞第一堵墙。

### 第二次：把 todo 升级成原生协同（vineyard）

我自己用 todo.md 记当下关心的事，非常自然有用。但 todo 很快混进了两类东西：

- 我自己在做的：每条挂本地 workspace，跑得动
- 别人在做的：我只想知道进展，但要手动维护 log

后者很痛苦。我做了 vineyard，把 todo 跟团队 issue tracker 自动打通，让别人的工作流回来 —— 还是不够原生。

> **Lesson 3**：todo 不该承担"记别人进展"的职责，那是 view，不是 todo。
>
> **Lesson 4**：用"我现在打开的 Claude Code"代表"我当下在做什么"很自然 —— 这是 *focus*，不是 todo。todo 这个词本身带 GTD 的心理负担；focus 没有。

### 第三次：all-in-chat（workspace/im）

我反方向试了一次：把所有协同放进 chat。
做了一个 demo（workspace/im）用 IRC + Claude Code，想把 channel 当 session、invite 进 channel 当成 session 交接。

撞了第三堵墙：

> **Lesson 5**：chat 做不了生产力。没有目录、没有文件视图、没有持久 dir，channel 当 session 太简陋。
>
> **Lesson 6**：chat 里仍然需要 bot 和 agent —— 但它们不是"工作"本身，是协调和提炼。
>
> **Lesson 7**：所以"工作"和"chat"必须显式分开，但 chat 里要留 bot 这层。

到这一步，1001 的轮廓自然浮现：**显式的工作单元（loop）+ 显式的协调通道（chat）**。

### 与此同时：loopctl 的启发

并行做的另一件事 —— loopctl，把整个推理平台的运维能力收敛进一个 CLI。做着做着我意识到：**这就是 context 压缩**。把分散的文档、流程、命令收敛进一个自描述接口，AI 消费起来 footprint 就小。

> **Lesson 8**：好的"runtime"会反过来压缩 knowledge —— 但只有人会主动这么做。AI 不会主动追求简洁。

这跟 Lesson 1 合流，构成 *Context* 这个概念的哲学基础。

### 最后一块：loop 怎么交接？

如果 loop 是 first-class 工作单元，团队协作就要回答"loop 怎么交给别人"。
我先后想过手动 save & load、整目录打包通过 IM 传 —— 都太傻。最后想到：local-first 的 c/s 架构 Claude Code，loop 跑在我本地、开端口让队友 attach。
local-first 不丢，又能交接。

> **Lesson 9**：local-first 和团队协作不是对立的，缺的只是一个 attach 协议。

---

## 3. 1001 的设想

把这些 lesson 拼起来，得到一个 model。

中心问题：**当 AI 是同事，人在协作里到底贡献什么？**

回答：**人贡献三件 AI 做不了的事。**

| 人贡献的稀缺资源 | 含义 |
|---|---|
| **驱动力** | 决定做 X 的欲望 drive，加上过程里"这事做得对不对、下一步选 A 还是 B"的执行级判断力 feedback。AI 没有自主欲望，也没有内生判断标准 |
| **注意力** | 在万千事项里识别"什么重要、什么不该做"。不是 attention scarcity 那种被动稀缺，是主动取舍的能力 —— focus 就是这种注意力的物化，"我们眼下选这件事、不选那件事" |
| **熵减能力** | 把混乱整理成清晰。AI 能产生 token，但不会自发追求简洁 |

这三件事对应工具里三个一级概念 —— 驱动力 ↔ Loop，注意力 ↔ Focus，熵减 ↔ Context。这就是 1001 的全部哲学。

> 顺手把一个常见的反命题处理掉：agent 看起来"自驱"，其实只是被定时器、event 或人 mention 触发的执行者。真正的 driver 永远是人。

---

## 4. 概念与架构

> 还没实现。这部分尽量短。

### 4 个一级概念

| 概念 | 一句话 | 对应稀缺资源 |
|---|---|---|
| **Loop** | first-class 工作单元 = dir + 持续 chat + 一个 driver | 驱动力 |
| **Focus** | 团队当下"什么重要"的 view，自动消减 | 注意力 |
| **Context** | team's distilled materials（Knowledge / Agents / Repos）| 熵减能力 |
| **Chat** | 协调通道，不是工作通道 | （sync 轴，非稀缺资源轴）|

简短补充：

- **Loop** 是 ccx session 的协同版。每个 loop 是一个长程任务，配套 dir、chat 历史、driver、artifact。
- **Focus** 是 todo 的反面 —— 不强调"清单完成"，强调"我们眼下判断什么重要"。pinned 永不过期，非 pinned 8 天无活动自动归档。
- **Context** 三种形态都是"被人精炼过的原料"：Knowledge 是 markdown 给人读，Agents 是封装了流程的可执行 prompt，Repos 是 git 资产。**Agent = 把"读 doc 然后做事"这套流程编码进可执行外壳**。
- **Chat** 里聊出值得深做的事，`spawn` 成 loop 接着干；loop 进展回流进 chat 让团队感知。chat 不替代 loop，loop 也不替代 chat。

### 概念之间

```
chat ──[spawn]──→ loop ──[沉淀]──→ knowledge / focus
                    │
                    ├──→ repo (git worktree)
                    │
                    └──→ agent (反复出现的 pattern → 长期值班)
```

### 两个关键架构选择

**1) 约定大于配置**

一个号称帮人减熵的工具自己却"什么都能配"，是最大的反讽。1001 的目录结构、文件命名、frontmatter、agent persona、API 端点 —— 都是约定，不是配置项。

> 配置是用户的负担；约定是设计者的负担。
>
> AI 时代这一点格外重要：配置爆炸 = AI 上下文爆炸 = 不能跨 team 复用。

**2) 统一的 C/S 架构 —— cloud 和 local 是同一种东西**

我个人不喜欢纯云端 IDE / agent，但纯本地解决不了协作。1001 把 cloud 和 local 统一进同一个 C/S 模型：**每个 loop 跑在某个 server 上 —— server 既可以是你本机，也可以是云端 host，client 走同一套 attach 协议**。

- loop 跑在本机 → 工作不丢、用本地工具链
- 队友 attach 你的 loop → 共享过程，但天然有安全 trade-off（暴露端口、权限边界、账户）—— 这是协作绕不开的妥协，不是"local-first" 这个标签能化解的
- 想完全云端共享 → 把 server 跑在云上，client 不变

参考：VSCode Live Share / tmux + ttyd 是这个模型的局部实例。

> 关键洞察：把 cloud-only 和 local-only 都视为 C/S 架构的两种部署，问题就从"选哪边"变成"server 放哪、client 怎么 attach"。

### 顶层组织

10 人左右共享一个 **workspace**（这个名字还在斟酌 —— 也许 *team* 更直接，但 workspace 强调"空间"而非"组织"，可跨 team 复用）。Workspace 是隔离边界，跨 workspace 的 loop / context / focus 不互通。

---

## 5. 还没解决的问题

1. **Loop 共享的安全边界**：C/S 架构定了，但 attach 协议的权限模型、本机 server 暴露端口的安全 trade-off 还没想清楚
2. **Workspace 隔离 + 权限**：账户系统怎么搭
3. **Agent 提炼回流的触发机制**：被动 / 定时 / on-demand
4. **Knowledge 的 wikilink + backlinks 持久化索引**

---

## 写在最后

我每天 1 ~ 3 亿 token 跟 AI 协作。
我用的工具不应该假装我还活在没有 AI 的 2020。

1001 是这件工具的一个尝试。原型在做，文档先放在这里。
