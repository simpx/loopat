---
title: Account Model
tags: [loopat, account, agent, identity]
status: living doc
---

# Account Model

> **Loopat 的身份模型 = OA 系统里"一个人挂多账号 / 公共账号"模式的直接复用。** 没有独立的 agent 数据类型；只是 account 加了"归属"这一个字段，就把"人 / 公共账号 / agent / bot" 全部覆盖。

## 类比：OA 系统里的多账号模式

几乎所有面向组织的 OA 系统都解决过同一个问题 —— **一个自然人需要管理 / 操作多个账号，但这些账号不是同一种东西**。共同抽象：

| OA 系统 | 个人侧 | 非个人侧 | 负责机制 |
|---|---|---|---|
| **Alibaba BUC** | 工号 / 员工账号 | 业务系统账号、服务账号 | 工号挂多业务账号 |
| **钉钉** | 个人钉钉号 | 公共账号、机器人 | 公共账号有"管理员" |
| **企业微信** | 员工 | 应用账号、客服账号 | 应用绑负责人 |
| **飞书** | 个人 | 机器人、自定义应用 | 机器人有 owner |
| **AWS IAM** | IAM User（人）| IAM User with access keys / Service-linked role | 由 root / admin 创建并负责 |
| **GCP** | Google account | Service Account | "owner" 字段指向 user/group |
| **GitHub** | Personal account | Bot account / machine user | 由人 fork / 维护 |

**共同点**：

1. 都没有发明"非人实体"类型 —— 它们都是 account，只是用法不同
2. 都有一个**所有权字段**指向"负责人"
3. 都有两种登录路径 —— 人登（密码 / SSO）+ 程序登（API key / Service token）
4. **公共账号本身有自己的资源**（自己的邮箱、自己的会话、自己的存储），跟个人账号同构

Loopat 走完全相同的路线。**OA 系统验证过几十年的设计，我们没必要发明新词。**

## 核心模型

整个 loopat 只有一种身份名词：**account**（代码里仍叫 `user`，是历史遗留，不影响概念）。两种 account：

- **个人账号** — 一个自然人的账号，用 password 登录
- **公共账号** — 由某个个人账号"负责"的账号，没有人坐在键盘前直接用它，只能通过 API token 访问

> **"公共" 的含义沿用 OA 系统**：不是"多人共有"（公共账号有且仅有一个负责人），而是**"非个人用途"** —— 给程序用、给业务流程用、给共享业务用。

```typescript
type Account = {
  id: string                  // 全局唯一，扁平 (alice, alice-coderev, ...)
  ownerId: string | null      // null = 个人账号；非空指向负责人 account.id
  authMethod: "password" | "token-only"
  personalRepoUrl?: string    // 每个 account 都有自己的 personal repo
  chatBotMode?: {             // 任意 account 可开
    enabled: boolean
    defaultLoopId?: string
  }
  // ...其他字段同现状（status, role, createdAt 等）
}
```

**所有变化都收敛在两个字段上：`ownerId` 和 `chatBotMode`。**

| | 个人账号 | 公共账号 |
|---|---|---|
| `ownerId` | `null` | 指向负责人 account.id |
| 登录方式 | password + cookie | **不能 web 登录**，只能 Bearer token |
| 谁能创建 | 自助 register / admin 邀请 | 由它的负责人通过 API/UI 创建 |
| 谁能颁发 token | 自己（cookie 认证后） | 它的负责人（不能自我繁殖）|
| 能否拥有其他账号 | ✓ | ✗（不套娃）|
| 出现在 User 列表 | ✓ | ✗（在 "Agents" / "公共账号" 视图）|
| 资源结构 | 完整的 personal repo / vault / .claude / memory / loops | 同左，完全同构 |
| OA 类比 | 工号 / 员工账号 / 个人钉钉号 | 业务账号 / 公共账号 / 机器人 / 服务账号 |

**结构上同构** 这一点非常重要：任何对账号生效的代码路径（spawn sandbox、注入 vault、composeLoopClaudeConfig、metadata 注入等）**完全不区分**两种账号，它们走同一份代码。区别只在认证入口的几行：

```
auth.ts: human 走 password 校验 + session cookie
api-tokens.ts: 公共账号走 Bearer token 解析

之后所有路径同一套
```

## 每个 account 拥有什么

不管是个人还是持有，每个 account 都自带：

| 资源 | 物理位置 | 用途 |
|---|---|---|
| **Personal repo** | `personal/<account-id>/` | 全部用户数据的根（用 git 跟踪可同步）|
| **Vault** | `personal/<account-id>/.loopat/vaults/<v>/` | 凭证（API keys、SSH key、env）|
| **.claude overlay** | `personal/<account-id>/.loopat/.claude/` | 个性化 settings、CLAUDE.md、skills |
| **Memory** | `personal/<account-id>/memory/` | 跨 loop 持久化的笔记 |
| **Loops** | `loops/<loop-id>/` (createdBy = account.id) | 这个 account 创建的对话 |
| **Tokens** | `api-tokens.json` 里 entries with `userId = account.id` | 公共账号常用；个人账号也可以颁发给自己 |

Persistent state 一律绑在 account 上 —— 这是把"账号 = 一个完整工作者身份"的设计承诺。

## "Agent" 这个词怎么用

**数据模型里没有 agent**。"Agent" 是公共账号在不同语境的别名 —— 跟 OA 系统里"公共账号"在不同地方叫不同名字一样（钉钉里叫"机器人"，企业微信里叫"应用账号"，AWS 里叫"Service Account"）。

| 场景 | 内部 | 对外文案 |
|---|---|---|
| Settings 页面里"我负责的非个人账号" | account where ownerId = me | "My Agents" / "My Bots" / "公共账号" |
| 公开市场 | public account templates | "Agent Marketplace" |
| 文档 | account with token-only auth | "agent account" / "service account" |
| API 集成方读 | `POST /api/v1/loops` with token | "drive an agent" |
| 后台 / 管理员视图 | account where ownerId IS NOT NULL | "公共账号管理" |

**双面神**：营销层完全自由（"loopat is an agent platform"），实现层零成本（schema 没新概念）。**底层叫 account，UI 跟着语境叫 agent / bot / 公共账号，三者无差别**。

## 行为差异（细节）

### 创建账号

- **个人账号** 通过 `POST /api/auth/register` 或 admin 邀请创建。需要 username + password。
- **公共账号** 通过 `POST /api/v1/me/accounts` 创建（cookie auth，必须是个人账号操作）。
  - body：`{ id, label?, profiles?[], initialVault? }`
  - 创建后服务端 scaffold 它的 personal repo 骨架

### Token 颁发

- 个人账号给自己颁发 token：`POST /api/v1/me/tokens` (cookie auth)
- 个人账号给自己拥有的公共账号颁发 token：`POST /api/v1/me/tokens` body 加 `forAccount: "alice-coderev"`
- 公共账号**不能**给自己或别人颁发 token，即使有 token 也不行

### Loop 操作

- 个人账号的 loop：`createdBy = alice`，driver 是 alice
- 公共账号的 loop：`createdBy = alice-coderev`，driver 是 alice-coderev
- 个人账号能不能"以公共账号身份创建 loop"？**MVP 不做**。如果要，走公共账号自己的 token。

### 操作权限

- 个人账号能改自己资源（vault、.claude、memory）
- 个人账号能改自己拥有的公共账号的资源（owner 全权）
- 公共账号**默认只读自己的配置资源**（vault、.claude）—— "agent 不能自我改写"，避免失控
  - 可由 owner 显式开启 "self-mutable" 标志，未来再说

## UI 呈现

UI 分组是**纯视觉**，不影响 schema：

```
Settings
├── Personal Repo       (我自己的个人账号设置)
├── AI Providers
├── ...
├── API Tokens          (我的 token，可挑给哪个账号用)
└── My Agents / 我的公共账号    ← 列出 ownerId = 我 的所有公共账号
    ├── alice-coderev   (已颁发 token, bot mode on)
    ├── alice-slack
    └── + New           ← 创建一个新的公共账号

Admin
└── All Accounts        (admin 才看到全部 —— 个人账号 + 所有公共账号)
```

跟 OA 系统的视图惯例一致：
- 普通员工面板只能看到自己的"主账号"和"我管理的公共账号"
- HR / 管理员能看到全员账号
- 公共账号有独立 tab，不和员工列表混排

`WHERE ownerId IS NULL` 是默认过滤；切到 admin 视图 / 切到 "公共账号管理" tab 才会改变这个过滤。

## Chat Bot 能力（未来）

`chatBotMode` 字段附在任何 account 上，被 chat 子系统识别：

```
chat 服务收到一条 DM → 目标 account = X
  ↓
查 X.chatBotMode.enabled
  disabled → 普通投递（人会看到）
  enabled  → 把消息 fork 到 X 的 defaultLoopId (或新建一个 loop)
             loop 的 assistant 输出 post 回 chat 当 X 的回复
```

**任何 account 都能开**：
- alice (个人) 度假时开 bot mode → "out of office, my agent answers"
- alice-coderev (公共账号) 永久开着 → 永久 bot
- 临时把 alice-coderev 加进一个 channel → channel 里它就是 bot

这是个**几乎纯属 chat 子系统的 feature**，账号模型上只新增一个 nullable 字段即可承载。等 chat 真要开放再实现。

## API 表面（v1 增量）

```
POST   /api/v1/me/accounts                    创建一个我拥有的公共账号
       body: { id, label?, profiles?[], initialVault?{ envs?, mountsHome? } }
       returns: 该账号的 Account 对象

GET    /api/v1/me/accounts                    列出我拥有的公共账号
       returns: [{ id, label, createdAt, ... }]

DELETE /api/v1/me/accounts/{id}               删除（soft delete）

POST   /api/v1/me/tokens                      支持新字段 forAccount?: string
       默认 forAccount = caller 自己
       forAccount = 我拥有的某个账号 → token 解析回那个账号
       forAccount = 我不拥有的账号 → 403
```

剩下所有 `/api/v1/loops/*` 等端点都**不需要变** —— 它们已经按 `c.get("userId")` 路由资源，那个 userId 是 account.id，本来就工作。

## 这个 model 的优点

1. **零新概念**。schema 加 1 个字段（ownerId）。MVP 之外的 chatBotMode 是单独字段。
2. **结构同构**。任何 account 处理逻辑不需要 if/else 区分人/agent。
3. **凭证隔离**。每个 account 自己有 vault，没有跨 account 借凭证这种事 —— 公共账号泄露不波及 owner 的 secrets。
4. **市场叙事就绪**。未来 marketplace 上架的 "agent" 就是公开的公共账号模板，install = 给 owner clone 一份。
5. **chat bot 顺手**。bot 模式是 account 的一个属性开关，跟 account 类型解耦。
6. **跟现有代码兼容**。`createdBy / driver / userId` 这些字段在代码里早就存在，含义只是从"user"扩展到"account"。

## 实施序列

按从小到大、可以分多次 ship 排：

1. **`Account.ownerId` 字段** + DB/JSON 迁移（现有所有 user 设为 `ownerId: null`）
2. **`POST /api/v1/me/accounts`** + **`GET /api/v1/me/accounts`** + scaffold 公共账号的 personal repo
3. **Token 颁发支持 `forAccount`**（owner 给自己拥有的账号发 token）
4. **Web: Settings → My Agents tab** 列表 + 创建 + 删除（先不做编辑，编辑通过修改对应账号的 personal repo 完成）
5. **`DELETE /api/v1/me/accounts/{id}`**
6. **（独立任务）chat bot mode 字段 + chat 子系统识别** —— 等 chat 子系统启动时一起
7. **（远期）公开 marketplace**

## 跟之前讨论的回顾

我们之前为了"agent" 这个概念前前后后讨论过五版：

1. **不要 agent**（"user 就是 agent"）—— 简，但无法表达一个人多套配置
2. **agent = 命名 profile 组合**（轻）—— 没有真 identity，最终跟 profile 没区分
3. **agent = profile 组合 + vault 引用**（中）—— 凭证寻址别人 namespace，有歧义
4. **agent = 独立实体（自有 vault/memory）** —— 有点重，又怕引入新概念
5. **本文：account 多账号 + 文案叫 agent** —— 概念最少，能力最足

第 5 版是终态。前面四版各解决了不同片面，最后这版把它们都吸进同一个模型里。

## 改这个模型时记得

- **schema 加字段先来这里更新**，再去改 `auth.ts` + `loops.ts` 的 Account/User 类型
- **代码内不要新增 "agent" 类型**，只用 account + ownerId 判别
- **"agent" 这词只能出现在 UI 文案、API 文档对外表述、营销文案** —— 内部 code/comment/doc 用 "account" 或 "owned account"
- **chatBotMode 不要绑定到 account 类型** —— 个人账号也能开
- **公共账号的 personal repo 跟个人的同构** —— 不要造特殊路径

## FAQ

**Q: 跟 OA 系统里的"公共账号"完全一一对应吗？**  
A: 概念上是。差别只在 OA 系统的公共账号可能被多人共用同一登录凭证（一个账号多人登），loopat 的公共账号不允许 web 登录、只能 token 访问。**所以 loopat 公共账号的"共用"是"我和我的 bot 共用"，不是"多个人共用"。**

**Q: 用户能把自己的个人账号转换成公共账号吗？**  
A: MVP 不允许（password 取消 + ownerId 设置是个复杂迁移）。如果真有需要，未来加个 "transfer ownership" 操作 —— 跟 OA 系统里"员工离职，账号转交公共"是同种动作。

**Q: 公共账号能拥有公共账号吗？**  
A: 不能。`ownerId` 必须指向 `ownerId IS NULL` 的 account。代码层强校验。OA 系统也没听说哪个支持公共账号套娃，理由一致：负责人必须是真人。

**Q: Admin 能管理别人的公共账号吗？**  
A: 能查看（admin 视图），但不能默认操作 —— 公共账号的最终责任在 owner。Admin 通过用户管理删除 owner 时，可选 cascade 删除其公共账号（跟"员工离职清理其 owned 账号"同种 ops）。

**Q: 一个公共账号能同时被多个人负责（co-owner）吗？**  
A: 不能。`ownerId` 是单值字段。"团队共享 agent" 通过**公开 / 共享到 workspace knowledge** 实现 —— 别人 install 时各自 clone 一份属于自己的，不共享底层账号。

**Q: 公共账号被删后，它创建的 loop 怎么办？**  
A: soft delete 模式下 loop 继续存在但只读。Hard delete 时连带 loops、vault、memory 一并清掉（admin 操作）。

**Q: Token 颁发为什么必须 cookie auth？**  
A: 公共账号自我繁殖会让 token 泄露后无法收敛。Cookie auth = "必须有个真人在键盘前"，是安全边界。这跟 OA 系统里"机器人 token 必须由管理员（非机器人）颁发"是同一种 design。

**Q: 跟 "subuser" / "subaccount" 这种说法有区别吗？**  
A: 概念上同源（一个 owner 拥有多个账号），但 loopat 文档里**刻意不用 sub-** 前缀，理由：
- "sub" 暗示等级低 / 缩水，但公共账号在资源结构上跟个人账号**完全同构**，没"少"任何东西
- OA 系统的实践里也用"公共账号 / 服务账号 / 机器人账号"这些平级词，不会自降身份说成"subuser"
- 跟代码里继续用 `user` table、`ownerId` 字段一致 —— 没有任何"sub"语义
