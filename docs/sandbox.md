---
title: loopat sandbox
tags: [loopat, architecture, security]
status: draft (review before promoting to knowledge/)
---

# loopat sandbox

每个 loop 跑在一个独立 sandbox 里。本文讲清楚：**为什么、怎么实现、Claude 看到什么、可移植性如何**。

## 设计原则

1. **loop 目录就是 sandbox 的完整描述** —— 沙箱权限不藏在配置文件里，而是从 `loops/<id>/` 目录的物理结构 + symlink 链派生。`ls -laR loops/<id>` 就能看见全部访问范围。
2. **filesystem-first，不引入 DB** —— sandbox 配置、memory、context、状态全是文件，user / Claude / git 都能操作。
3. **机器无关、可移植** —— 把 `$LOOPAT_HOME` 整个 rsync 到别的机器，sandbox 视图不变。
4. **单层** —— 用一个 bwrap 包 Claude CLI driver；它 spawn 的 bash 子进程**继承同一 mount/pid namespace**，不需要嵌套 sandbox。

## 完整架构

### 进程拓扑

```
host
└── loopat server (Bun, port 10001)              ← 1 个，全员共用
    │   ├── Hono HTTP/WS router
    │   │     /api/loops/...        REST
    │   │     /ws/loop/:id          chat ws
    │   │     /ws/loop/:id/term     terminal ws
    │   ├── Map<loopId, LoopSession>             ← chat 状态
    │   └── Map<loopId, Term>                    ← PTY 状态
    │
    ├── LoopSession[loop-A]                      ← 1 / loop
    │   ├── ws subscribers: [browser1, browser2, ...]
    │   ├── Claude CLI subprocess (in bwrap-A1)  ← 1 / loop
    │   │   └── bash subprocesses (inherit bwrap-A1, 跑 Claude 的 Bash tool)
    │   └── (memory recall + auto-commit + history persistence 都在 server 端)
    │
    ├── LoopSession[loop-B]                      ← 同结构
    │
    └── Term[loop-A]                             ← 0 或 1 / loop（按需起）
        └── PTY bash subprocess (in bwrap-A2)    ← 跟 CLI 是不同的 bwrap，同布局
```

**沙箱里的**：claude CLI driver + 它 spawn 的 bash + PTY 的交互式 bash。
**沙箱外的**：loopat server（含 ws server、REST handlers、文件系统 helpers、SDK 驱动调用方）。

PTY 和 Claude SDK 走**同一个** `buildBwrapArgs(loopId)`，所以两者**视野完全一致**：terminal 里 `cd /loop` `ls /context` 跟 Claude 的 `Read /personal/memory/...` 看到的是同一个虚拟世界。

### 共用 / 独占矩阵

| 资源 | 实例数 | scope |
|---|---|---|
| host machine | 1 | 全员 |
| loopat server 进程（Bun） | 1 | 全员 |
| port 10001（HTTP+WS） | 1 | 全员 |
| workspace `loopat` | 1（MVP）| workspace member |
| LoopSession 内存对象 | N（每 loop 一个）| 同 loop 所有 ws subscriber |
| Claude CLI 进程 | 0 或 1 / loop | 同 loop 全员 |
| outer bwrap (Claude) | 跟 CLI 同生命周期 | 同 loop 全员 |
| messages.jsonl | 1 / loop | 同 loop 全员 |
| .claude/ session JSONL | 1 / loop | 同 loop 全员 |
| PTY bash 进程 | 0 或 1 / loop | 同 loop 所有 term ws 订阅者（**多人共用同一 bash session**） |
| outer bwrap (PTY) | 跟 PTY 同生命周期 | PTY 订阅者 |
| ws connection | N（一 tab 一个）| 独占 per browser tab |
| /context/knowledge | **per-loop worktree**（分支 `loop/<id>`），主仓 1 / workspace | 隔离写、显式 publish 到 trunk |
| /context/notes | **per-loop worktree**（分支 `loop/<id>`），主仓 1 / workspace | 同上 |
| /context/notes/memory/ | 通过 notes worktree | team memory，AI 自己 publish 到 trunk 后跨 loop 可见 |
| /personal/`<user>`/ | 1 per (workspace, user) | 一个 user 自己，跨 loop 直接共享 |
| /personal/`<user>`/memory/ | 1 per user | personal memory，SDK auto-recall |
| /personal/`<user>`/.loopat/vaults/`<active>` | 1 per (user, vault)，按 `envs/` + `mounts/home/` 约定自动派发到 sandbox env / $HOME | per-loop 选 active；其他 vault 在 sandbox 里物理可见但 doctrine 不引导访问 |
| `<loopDir>/workdir/` | 1 / loop | 该 loop |
| `<loopDir>/home-upper/` | 1 / loop | 该 loop 的 $HOME container layer，persistent |

### 4 层隔离（loop A 与 loop B 之间）

| 层 | 防什么 | 谁强制 |
|---|---|---|
| 1. URL 路由 + 闭包 | 不同 loop 的请求进同一 server，闭包独立绑 loopId | 应用代码（Hono router） |
| 2. Map 按 loopId 分 | broadcast 只到本 loop 订阅者 | 应用代码（term.ts / session.ts） |
| 3. 每 loop 独立子进程 | Linux process 级隔离 | OS（process model） |
| 4. bwrap mount namespace | 文件系统视图独立 | Linux kernel |

第 1、2 层是应用层逻辑；第 3、4 层是 OS / kernel 给的**硬保证**。即使应用层有 bug，kernel 仍然保证 bash-A 看不到 loop-B 的文件。

### 完整数据流：ws → PTY

```
[Browser Tab]                                                         
     │ ws://host:10001/ws/loop/<id>/term                              
     ▼                                                                
[Hono router @ 10001]                                                  
     │  matches /ws/loop/:id/term → 提取 id                           
     ▼                                                                
[ws handler]   ← 闭包捕获 id；这个连接的所有事件都带这个 id            
     │                                                                
     ├─ onOpen(ws)    → attachTerm(id, ws)                            
     ├─ onMessage(e)  → writeTerm(id, e.data)                         
     └─ onClose()     → detachTerm(id, ws)                            
                                                                      
[term.ts]                                                             
     │  Map<loopId, Term>                                             
     │   "loop-A" → { proc: ptyA, subs: Set(wsA1, wsA2) }             
     │   "loop-B" → { proc: ptyB, subs: Set(wsB1) }                   
     ▼ getOrSpawn(id)                                                 
                                                                      
[bun-pty.spawn("unshare", [-Umr, --, bash -c "mount overlay && exec bwrap ...", ...])]
     │     ← 外层 unshare 提供 user+mount NS，在里面 mount $HOME overlayfs
     ▼                                                                
[Linux process: unshare → bash → exec bwrap]                          
     │     ← bwrap 继承 mount NS，独立 mount namespace，只挂这 loop 的 paths
     ▼                                                                
[Linux process: bash -i] ← inherit bwrap namespace                    
```

**输出方向**：bash stdout → ptyA → `pty.onData` callback (closure 捕获 `t = terms.get("A")`) → 遍历 `t.subscribers` 全 broadcast。**只送给 loop A 的订阅者**。

**输入方向**：browser keystroke → ws → handler (closure 捕获 id="A") → `writeTerm("A", data)` → `terms.get("A").proc.write(data)` → ptyA stdin。**永远不会写到 ptyB**。

### 同 loop 多 ws subscriber 共享行为

Loop A 有两个 tab 都开了 terminal，wsA1 + wsA2。任何一方按键 → 进同一个 ptyA stdin → 同一个 bash 看到 → 同一份 stdout 广播给两人。结果：**同一行光标，两人共用一个 bash**。

含义：
- 同一 user 多 tab → 自己输入实时同步 ✓
- 多 user 同一 loop → 像两人共用键盘，**会乱**（设计接受，"共享" model）

### 故意共享、不隔离的部分

- **`/context/{knowledge,notes}` 主仓**（git repo）—— **不直接共享物理目录**。每 loop 拿自己的 git worktree（分支 `loop/<id>`），AI 在自己 worktree 里写，显式 publish（`git push . HEAD:<trunk>`）到主分支后其他 loop 才看得到。主仓配 `receive.denyCurrentBranch=ignore`，并发 push 由 git ref 原子更新串行化、AI 重试。详见"每 loop 一个 context worktree" 项目 memory
- **`/personal/<user>/`** —— 同一 user 的多 loop 共享物理目录，跨 loop 持久化 memory、vault 等
- **host 网络** —— 多 loop 共用，能互相 bind 端口

这些是**设计共享**：team knowledge 协作通过 publish/pull，user 自己的 memory 跨 loop 累积，网络复用。要硬隔离网络需要每 sandbox 一个 net namespace + 反向代理，工程量大。

### 多人协作的当前 gap（v6 未解决）

- `/personal` mount 当前指 driver 的 personal。如果 user A 是 driver、user B attach 同 loop：B 在 sandbox 里看到的是 A 的 secrets ❌
- 解法（v6.x 之后）：driver-transfer 时 unlink + relink personal mount + 重启 sandbox；或 read-only attach 模式不让 Claude 跑



## 虚拟路径布局

Claude 在 sandbox 里看到的（注意 v6 之后所有 loopat-managed 路径统一前缀 `/loopat/`）：

| 路径 | 真路径（host） | 模式 | 说明 |
|---|---|---|---|
| `/loopat/loop/<id>/workdir/` | `LOOPAT_HOME/loops/<id>/workdir/` | rw | cwd；为代码 loop 是 git worktree |
| `/loopat/loop/<id>/.claude/` | `LOOPAT_HOME/loops/<id>/.claude/` | rw | SDK session JSONL + settings.json |
| `/loopat/context/knowledge/` | `LOOPAT_HOME/loops/<id>/context/knowledge/`（**per-loop worktree**） | ro \| rw（按 `meta.config.knowledge_rw`） | AI 在自己分支 `loop/<id>` 上写，publish 到 trunk 后跨 loop 可见 |
| `/loopat/context/notes/` | `LOOPAT_HOME/loops/<id>/context/notes/`（**per-loop worktree**） | rw | 同上 |
| `/loopat/context/personal/` | `LOOPAT_HOME/personal/<user>/`（symlink） | rw | 用户私有；含 `memory/`、`.loopat/vaults/<name>/` 等。Vault 不以目录形式暴露给 AI，靠 `envs/` + `mounts/home/` 自动派发 |
| `/loopat/context/repos/<name>/` | `LOOPAT_HOME/context/repos/<name>/` | rw | workspace 全员共用的 git repo 集合 |
| `$HOME` (`/home/$USER`) | **overlayfs**：lower=`LOOPAT_HOME/sandbox-home-skel/`，upper=`LOOPAT_HOME/loops/<id>/home-upper/`，merged=`LOOPAT_HOME/loops/<id>/home-merged/` → bind 到 `$HOME` | rw | **docker container-layer 语义**：跨 sandbox 重启持久；pip/npm 安装、shell history 都活下来 |

系统路径以 `--ro-bind-try` 逐项暴露：`/usr /etc /lib /lib64 /bin /sbin /opt /var /run`（read-only）。`/tmp` 共享 host（rw，让 socat unix socket / mktemp / IPC 工作）。`/proc /dev` 由 bwrap 标准 flag 提供。`--unshare-pid` 给独立 PID namespace。

**$HOME overlay 机制**：bwrap 0.9.0（Ubuntu noble）没编 overlay 支持，所以每次 spawn 用 `unshare -Umr -- bash -c "mount -t overlay overlay -o ... && exec bwrap ..."` 包一层 user+mount NS，在 NS 里 mount overlayfs，再 exec bwrap。bwrap 继承 mount NS，把 merged dir bind 到沙箱 `$HOME`。沙箱退出 → NS 死 → overlay 自动卸载；upper dir 在 host 上持久（kernel ≥ 5.11 支持 unprivileged overlayfs）。

**关键**：用 per-component `--ro-bind-try` 而**不是** `--ro-bind / /`。后者会让 / 整个 RO，bwrap 之后 mkdir `/loopat/...` 这种新路径会失败（"Read-only file system"）。前者让 sandbox root 是 fresh tmpfs，bwrap 自由创建虚拟挂载点。

## 三层 mount 权责

> 早期版本有个 personal-deps walker，扫 `personal/<user>/` 的 symlink 把
> target 真路径 bind 进 sandbox。在多 user 场景下 member 可以 symlink 到
> operator 任意 host 路径越权，已删除。现在 mount 入口收敛到三层。

| 层 | 来源 | 谁写 | 决定什么 |
|---|---|---|---|
| **operator** | `~/.example/config.json` `mounts` | host shell 用户 | 任意 host 路径 mount（跨 user 共享缓存如 `/etc/pki/ca-trust`） |
| **admin** | `knowledge/.loopat/.claude/settings.json` + profiles | 团队管理员 | 无 mount 字段 |
| **member** | `vaults/<active>/mounts/home/<rel>/...` 目录布局 | 团队个人 | 自动派生：每个顶层条目 `--bind` 到 `$HOME/<rel>/...`。**无 config 字段**，文件系统布局就是 spec |

权责跟文件系统所有权自然对齐。

**operator 例**（host cache 跨所有 loop 共享）：

```jsonc
// ~/.example/config.json
{
  "mounts": [
    { "src": "$HOME/.cache", "dst": "$HOME/.cache", "rw": true }
  ]
}
```

**member 例**（自己的 ssh + gh + dotfiles）—— 只是放文件，没有配置：

```
personal/<user>/.loopat/vaults/default/mounts/home/
├── .ssh/                  → sandbox 内 $HOME/.ssh/
├── .config/gh/            → sandbox 内 $HOME/.config/gh/
├── .gitconfig             → sandbox 内 $HOME/.gitconfig
└── .secrets/<service>/    → sandbox 内 $HOME/.secrets/<service>/   ← ad-hoc 凭据池
```

Sandbox 默认看不到 host 任意路径。opt-in 由 operator 或 member 显式（前者写 JSON，后者放文件）。**目录所有权 = ACL**。

## Vault（凭据隔离）

Loop = `sandbox × vault` 的笛卡尔积：

- **Sandbox**（admin 拥有）= "用什么工具"。Toolchain + MCP，团队共享。
- **Vault**（member 拥有）= "以什么身份"。一组命名好的凭据，per-user 加密落盘。

每个 loop 在 `meta.config.vault` 上选一个 vault（默认 `"default"`）。Vault 不以目录形式暴露给 sandbox——两个**约定目录**驱动自动派发：

| 目录 | spawn 时做什么 |
|---|---|
| `vaults/<v>/envs/<NAME>` | 文件内容注入成环境变量 `$NAME`（同时驱动 provider `apiKey` 里的 `${VAR}` 替换） |
| `vaults/<v>/mounts/home/<rel>/...` | 每个顶层条目 `--bind` 到 sandbox 的 `$HOME/<rel>/...` |

### 目录结构例

```
personal/<user>/.loopat/vaults/
├── default/
│   ├── envs/
│   │   ├── ANTHROPIC_API_KEY        ← provider apiKey: "${ANTHROPIC_API_KEY}"
│   │   └── MCP_GITHUB_TOKEN         ← .mcp.json: "Authorization: Bearer ${MCP_GITHUB_TOKEN}"
│   └── mounts/home/
│       ├── .ssh/
│       └── .config/gh/
├── dev/
└── prod/
    └── envs/
        ├── ANTHROPIC_API_KEY        ← prod 用不同 key
        └── MCP_GITHUB_TOKEN → ../../default/envs/MCP_GITHUB_TOKEN   ← symlink 共享
```

- **Symlink 在 vault 内 / 跨 vault 都允许**，但 realpath 必须仍落在 `personal/<user>/` 内（不能逃出去指向 host 任意路径）。

### Sandbox 内的视图

整个 `personal/` 是 wholesale bind 进沙箱的，所以技术上 `/loopat/context/personal/.loopat/vaults/<name>/` 仍然物理可见。但 **doctrine 不引导 AI 去看 vault**——AI 只看到 `$HOME` 里的文件（来自 `mounts/home/`）和 env vars（来自 `envs/`），跟一台正常配好的开发机一样。

Vault 这个词在 AI 视角下消失：所有 secret 在它的消费位置（env 或 $HOME 路径）自然出现，不需要 AI 知道它们是从 vault 派生的。

### git-crypt 加密

Auto-init 生成的 `.gitattributes` 覆盖整个 vault 路径：

```
.loopat/vaults/**  filter=git-crypt diff=git-crypt
```

新写进 vault 的任何文件（包括 `envs/*` 和 `mounts/home/*`）都会自动加密。

## 网络

**不 `--unshare-net`**，host 网络共享。Claude 调 `api.anthropic.com` / OpenAI / curl / git fetch / npm install / pip install 都直接走。

按域名过滤要做的话，host 上 iptables/nftables 处理（外层），或者 outer sandbox 加 squid/tinyproxy（v6 不做）。

## Memory（auto-recall + 虚拟路径）

SDK 的 auto-memory recall 机制配置在每 loop 的 `<loopDir>/.claude/settings.json`：

```json
{
  "autoMemoryEnabled": true,
  "autoMemoryDirectory": "/loopat/context/personal/memory"
}
```

CLI 读这个 settings（通过 `settingSources: ["user"]`）→ 每 turn 自动扫 `/loopat/context/personal/memory/` → 相关 .md 注入 prompt。

因为 CLI 自己**也**跑在 sandbox 内，`/loopat/context/personal/memory/` 就是它眼里的真路径，**memory_recall 事件里 path 字段也是 `/loopat/context/personal/memory/foo.md`**（不会泄漏 `/home/...`）—— 这就是单层包 CLI 比包 Bash 严格更优的核心原因。

doctrine（CLAUDE.md）规定**两层 memory**：

- **`/loopat/context/personal/memory/`** —— 私有，per-user，SDK 自动召回，频繁、低门槛
- **`/loopat/context/notes/memory/`** —— 团队共享（在 notes git repo 里），**不**自动召回；doctrine 教 Claude 复杂 turn 开始时主动 `Read /loopat/context/notes/memory/MEMORY.md` 索引；判断 memory 对全团队有用时**自动 promote**（写一份到 team memory，不用问 user）

注意：team memory 写完后 AI 需要走 publish workflow（`git add → commit → merge trunk → push . HEAD:<trunk>`）才能被其他 loop 看到，因为 notes 是 per-loop worktree。

## System prompt 多层

```
┌────────────────────────────────┐
│ L1: Claude Code preset         │ SDK 内置
├────────────────────────────────┤
│ L2: 平台 doctrine              │ bundled，server/templates/CLAUDE.md
│   - 沙箱边界、context 约定     │ 静态，跨 loop 复用，cache 友好
│   - memory 模型、行为规则      │ 通过 systemPrompt.append 注入
│   - publish workflow           │
├────────────────────────────────┤
│ L2+: workspace 团队 supplement │ knowledge/.loopat/.claude/CLAUDE.md（可选）
│                                │ bwrap ro-bind 到 CLAUDE_CONFIG_DIR/CLAUDE.md
│                                │ CC 通过 settingSources:["user"] 自动加载
├────────────────────────────────┤
│ L2++: project tier             │ <workdir>/CLAUDE.md（可选）
│                                │ CC 通过 settingSources:["project"] 自动加载
│                                │ 例：distill loop 的 workdir 落一份 distill-doctrine
├────────────────────────────────┤
│ L3: per-loop runtime block     │ server 算的：title/id/driver/branch/repo + context worktree 信息
│                                │ 通过 systemPrompt.append 注入
└────────────────────────────────┘
```

L2 + L3 拼接后通过 `systemPrompt: { type:"preset", preset:"claude_code", append: <L2+L3> }` 注入。L2 用虚拟绝对路径（`/loopat/loop/<id>/`、`/loopat/context/...`），跨 loop 跨 user 跨机器**完全静态**，prompt cache 命中率最大化。

**Loop kinds**：未来扩展通过 `server/templates/loop-kinds/<kind>/CLAUDE.md`，由对应的 spawn 路径（如 `distillLoop`）拷到 workdir 当 L2++。第一个用上的是 distill。

## 可移植性测试

```sh
# a 机
rsync -a ~/.loopat/ b:.loopat/

# b 机
cd ~/workspace/loopat && bun install
bun run --hot src/index.ts
```

预期 b 机上：
- ✓ 所有 loop 列表保留
- ✓ chat history 保留（messages.jsonl 跟 cwd / 机器无关）
- ✓ session continue 仍 work（CLAUDE_CONFIG_DIR JSONL 里有的是 cwd hash 而 cwd 是虚拟路径 `/loop/<id>`）
- ✓ Claude 之前写的 memory 内容引用 `/personal/memory/X` `/context/notes/Y` 等虚拟路径**仍然有效**，因为 b 机的 sandbox 重生成时 `/personal` 指向 b 机的真 personal 路径
- ✗ `context/repos/loopat -> /home/simpx/workspace/1001/loopat` 这种 host 上的代码 repo 注册 symlink **不可移植**（host-specific），b 机要重新 ln -s 到自己的 repo 路径

## 安全性 vs UX

| 威胁 | 防护 |
|---|---|
| Claude 想 `cat ~/.aws/credentials` | `/home/$USER` 是 overlayfs（lower 是空 skeleton）+ 没 personal symlink → "No such file" |
| Claude 想 `rm -rf /` | RO bind /usr /etc 等 → 写不动；rw 区域只有 workdir / context/notes worktree / personal / $HOME overlay |
| Claude 想 ssh 到外网机器 | personal/.ssh 没 ln 进来 → ssh client 找不到 key → 无法连。要 opt-in：用户 `ln -s ~/.ssh personal/.loopat/vaults/default/.ssh` |
| Claude 写 memory 时引用真路径 | 不会发生 —— CLI 在 sandbox 内，看到的就是虚拟路径 |
| 多 loop 间数据隔离 | 每 loop 自己的 `/loopat/loop/<id>/` 独立 bind；notes/knowledge 是 per-loop git worktree（分支 `loop/<id>`），跨 loop 看不见对方的未 publish 写 |
| /tmp 写恶意东西 | 共享 host /tmp，但 tmp 本来就是 ephemeral，无害 |
| AI 一个 loop 改了 home 的 .bashrc 影响其他 loop | $HOME upper 是 per-loop，不串 |

UX 上**不"完美 docker"的地方**：
- `$HOME=/home/simpx`（不是 `/loopat/context/personal`）—— 因为 ssh 等工具固定读 `$HOME/.ssh`
- `/usr/local` 之类系统路径仍可见（RO）—— sandbox 里的 Claude 不应该感到"在外星系"，常用工具应该都在
- `LOOPAT_INSTALL_DIR`（如 `/home/simpx/workspace/loopat`）有泄漏 —— 因为 claude binary 必须能跑，只能 bind same-to-same
- 只有 `$HOME` 是 overlayfs container layer，`/var`、`/opt` 等不持久（写在沙箱 root tmpfs，下次起新沙箱就丢）—— 故意只覆盖最大痛点，full root overlay 待将来需要时再扩

这些都是**实用主义妥协**。彻底纯化（每层路径都虚拟、$HOME 也虚拟）需要更多 bind 重写 + 可能破坏工具，得不偿失。

## 跟其他方案对比（为什么 bwrap）

调研结论（详见 v6 实现讨论）：

- **Docker / Podman**：spawn 慢（1-3s），需要 image 管理，不必要
- **gVisor**：拦 syscall，bwrap 嵌套（如果以后想做）会废
- **Firejail**：要 SUID，desktop-focused，方向不对
- **systemd-nspawn**：要 root
- **E2B / Modal**：云端 VM，不挂 host 真目录，跟 loopat filesystem-first 哲学冲突
- **Anthropic 自家 sandbox-runtime**：是给"Claude 调用的 Bash 工具"用的，不是包 CLI 自己；v6 之前我们用过，v6 改用直接 bwrap 后弃用

bwrap 是唯一同时满足"轻、快、原生 namespace、无 daemon、Anthropic 已经在用"的方案。代码量 ~80 行 argv 数组生成 + spawn。

## 一次性 host 配置（部署清单）

```sh
sudo apt install -y bubblewrap util-linux socat ripgrep   # bubblewrap=bwrap；util-linux 带 unshare；socat 暂留；ripgrep 给 Claude 用
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
echo "kernel.apparmor_restrict_unprivileged_userns=0" | sudo tee /etc/sysctl.d/60-apparmor-namespace.conf
```

Ubuntu 24.04+ 必须关 apparmor 那一项，不然 unprivileged user namespace 起不来，bwrap 跑不动。

**Kernel 要求**：≥ 5.11，支持 unprivileged overlayfs（用于 $HOME container layer）。Ubuntu noble 24.04+ 默认满足。

**bwrap 版本**：≥ 0.6 就够（用 stock 0.9.0 即可）。bwrap 本身不需要 overlay 编译选项——overlay 在外层 `unshare` 里用 kernel native overlayfs mount，bwrap 只负责 bind 其他东西。

## 文件位置（实现）

- `server/src/bwrap.ts` —— `buildBwrapArgs(loopId, createdBy, extraSetenv, sandboxName, vaultName, knowledgeRw)` 构造 bwrap argv；`prepareSandboxOverlay(loopId)` 异步 mkdir overlay 目录；`buildSandboxSpawnArgv(...)` 同步拼出 `unshare -Umr -- bash -c "mount && exec bwrap ..."` 的最终 argv
- `server/src/sandboxes.ts` —— sandbox catalog (list/read/write/lock/commit)
- `server/src/session.ts` —— SDK options 里 `spawnClaudeCodeProcess` callback 包 CLI；spawn 的 binary 是 `unshare` 不是 `bwrap`（因为外层包了 unshare）；`sandbox: { enabled: false }` 关 SDK 内置 sandbox-runtime
- `server/src/term.ts` —— PTY 同样走 `unshare` + `buildBwrapArgs`，bash 进沙箱
- `server/src/system-prompt.ts` —— L2 doctrine（bundled）+ L3 runtime block 拼接
- `server/src/loops.ts` —— `ensureWorkspaceDirs`（设置 notes/knowledge repo 的 `receive.denyCurrentBranch=ignore`）、`ensureContextMounts`（per-loop git worktree of notes/knowledge）、`distillLoop`
- `server/templates/CLAUDE.md` —— L2 平台 doctrine
- `server/templates/loop-kinds/<kind>/CLAUDE.md` —— L2++ project-tier doctrine（distill 用）
- `knowledge/.loopat/.claude/CLAUDE.md` —— L2+ workspace 团队 supplement（可选）
- `<loopDir>/.claude/settings.json` —— `autoMemoryDirectory: /loopat/context/personal/memory`
- `LOOPAT_HOME/sandbox-home-skel/` —— $HOME overlay 的 lower 层（默认空，可放 dotfiles）
