# Loop 的物理形式

## 决定（2026-05-04）

**Loop 的核心三件 = dir + IM + AI bot（universal）。**
**直接 access dir 的方式 = 因角色而异（role-specific）。**

- **dir**：所有人都需要 —— 文件、artifact、workspace
- **IM**：所有人都需要 —— chat / 协调 / 社交层
- **AI bot**：所有人都需要 —— 听 chat + 操作 dir，是非 power user 的主要"代理"
- **直接 access dir**：因角色而异（见下表）

**dir 是统一的 SoT。** 不论用什么入口操作，最后都落到 dir 上。

## 不同角色的 access 层

| 角色 | 直接 access dir |
|---|---|
| 工程师 | **SSH**（vim / shell / git）|
| 设计师 | 文件浏览器 + Figma / Sketch / Photoshop 集成 |
| PM | Web view + 富文本 / 表单 / 表格 |
| 数据分析 | Jupyter / SQL 控制台 |
| 通用 fallback | Web 文件管理器（任意角色都能用）|

**Power user 直接操作；非 power user 通过 AI bot 间接操作（chat）**。

工具只按需启用 —— 一个 loop 可以混合多角色（同 channel 不同人用不同入口）。

## 工程师变体（当前主要 focus）

```
       ┌──────────────┐
IRC ──→│              │
       │  workspace   │
SSH ──→│     dir      │
       │  (SoT)       │
bot ──→│              │
       └──────────────┘
```

| 身份 | 入口 | 能做什么 |
|---|---|---|
| 普通参与者 | IRC client（thelounge / weechat / 手机）| chat、@bot 让 AI 干活、看 bot 报告 |
| Power user | SSH | vim、shell、git、直接跑命令 |
| AI bot | host 上的进程 | 听 IRC + 操作 dir |

**SoT 是 dir。** IRC 和 SSH 都只是工程师场景的入口。

## 最小实现拓扑

```
loop-host:
├── ircd (ergo)
├── sshd
├── /var/loops/<channel>/        ← workspace dirs
└── coo bot                       ← 听 IRC + 操作 /var/loops
```

每个 loop =
- 一个 IRC channel
- 同 host 上一个 dir
- 该 channel 的 IRC ACL
- 该 dir 的 Unix ACL

## 已有 vs 待补（基于 ~/workspace/im）

| | 已有 | 待加 |
|---|---|---|
| IRC server | ✓ ergo | — |
| Web IRC | ✓ thelounge | — |
| AI bot | ✓ coo | 操作公共 dir，而不是 bot 私有 dir |
| Per-channel dir | ✓ bot/conversations/<channel>/workspace/ | 移到 `/var/loops/` + 加 SSH 入口 |
| SSH | sshd 通用 | 每个 channel 一个 unix group + 同步成员 |
| 身份映射 | ❓ | NickServ nick → unix user 映射（手动 / 脚本）|

**差的就是几条胶水脚本。**

## 这个方向解决你关心的所有点

| 之前关心 | 解 |
|---|---|
| 共享 loop（非进展）| 共享 IRC channel + 共享 dir |
| 痛点 b（两人协作）| 私 channel + 私 dir，两人都进 |
| 痛点 a（个人投团队）| 给团队 IRC voice + dir read |
| AI 一阶 | bot 是 channel 成员且能操作 dir |
| 直接操作 dir | SSH |
| 终端友好 | IRC + SSH 都终端原生 |
| filesystem-native | dir 是 SoT |
| 零 lock-in | dir + 开放协议 |
| 跨设备 | thelounge / 手机 IRC / SSH |
| 通知 | IRC mention 自带 |

## MVP 路径：async 优先，IRC 是 phase 2

IRC 太重（实时、server、多客户端）。但**真正承载 chat 的是 `chat.log` 文件**，IRC 只是实时推送层。如果接受 async，整个 IRC 不需要。

**Phase 0（现在能做，50 行级别）**：

```
Loop dir:
├── chat.log          ← append-only 文件 + 约定格式
├── workspace/         ← 工作文件
└── .loop/meta.md     ← 元数据
```

```
[2026-05-04T14:32:15] <simpx> 看下 RDMA trace
[2026-05-04T14:32:50] <claude> 已分析，问题在...
[2026-05-04T15:10:03] <阿尔萨斯> 我也看到了，但是 ...
```

工具：
```bash
loop new <name>     # mkdir; git init; touch chat.log
loop chat           # 启动 claude，hook 把 turn append 到 chat.log
loop sync           # git add/commit/push
loop pull           # git pull
```

**阶段升级**：

| Phase | 形态 | 复杂度 |
|---|---|---|
| 0 | 文件 + git + 本地 Claude Code | 50 行 |
| 1 | + chat.log watcher → mac/手机通知 | 半天 |
| 2 | + IRC 做实时通道（SoT 还是 chat.log）| 复用 ~/workspace/im |
| 3 | 改 Claude Code 原生支持 multi-participant | 大工程 |

**关键**：SoT 永远是 chat.log，传输层（git / IRC / etc）可以替换。

## 关于"Claude Code + IRC"的两件事

a) **让 Claude Code session 同步到 chat.log**：Claude Code 的 jsonl session 是私有的；加 hook 把每 turn export 成 chat.log 行 → 多人能共享。简单。

b) **让 Claude Code TUI 显示别人的输入**：需要 Claude Code 原生支持 multi-participant。大改造，先放一边。

a 是 phase 0 的核心；b 是 phase 3。

## 还要回答的小事

1. **本地编辑**：
   - sshfs mount 远端 dir 到本地 ~/workspace/<loop>/ → 本地 vim 远程文件
   - 离线场景：git clone 本地副本（loop dir 也是 git repo）
2. **多 AI 并存**：
   - 现在一 channel 一 bot（coo）
   - 是否支持每人带自己 AI bot 进 channel？
3. **Discovery**：
   - IRC `/list` 列所有 channel = 所有 loop
   - 可以加 metadata（topic / status / owner）增强

## 替代了哪些之前讨论

- **"云端共享 dir + ACL"**（loop-as-cloud-dir.md）：现在具体化为 SSH 同 host 模式，不需要单独的 cloud 协议
- **"chat 协议待选"**：定为 IRC
- **"AI 进 loop 形式"**：bot 进 channel 已成型
- **"读写权限"**：IRC ACL（chat）+ Unix ACL（dir），双层

## 推论

- 1001 的核心实现 = 把 ~/workspace/im 升级为多人 host
- 不需要造大轮子；都是组合现成 building blocks（ergo、sshd、coo bot、git）
- 每加一个 loop = `/join` channel + 创建 dir + 加 group + 拉 bot 进 channel —— 一行脚本可完成
