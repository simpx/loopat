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
3. **机器无关、可移植** —— 把 `~/.loopat/<workspace>/` rsync 到别的机器，sandbox 视图不变。
4. **单层** —— 用一个 bwrap 包 Claude CLI driver；它 spawn 的 bash 子进程**继承同一 mount/pid namespace**，不需要嵌套 sandbox。

## 完整架构

### 进程拓扑

```
host
└── loopat server (Bun, port 7787)              ← 1 个，全员共用
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

PTY 和 Claude SDK 走**同一个** `buildOuterBwrapArgs(loopId)`，所以两者**视野完全一致**：terminal 里 `cd /loop` `ls /context` 跟 Claude 的 `Read /personal/memory/...` 看到的是同一个虚拟世界。

### 共用 / 独占矩阵

| 资源 | 实例数 | scope |
|---|---|---|
| host machine | 1 | 全员 |
| loopat server 进程（Bun） | 1 | 全员 |
| port 7787（HTTP+WS） | 1 | 全员 |
| workspace `1001` | 1（MVP）| workspace member |
| LoopSession 内存对象 | N（每 loop 一个）| 同 loop 所有 ws subscriber |
| Claude CLI 进程 | 0 或 1 / loop | 同 loop 全员 |
| outer bwrap (Claude) | 跟 CLI 同生命周期 | 同 loop 全员 |
| messages.jsonl | 1 / loop | 同 loop 全员 |
| .claude/ session JSONL | 1 / loop | 同 loop 全员 |
| PTY bash 进程 | 0 或 1 / loop | 同 loop 所有 term ws 订阅者（**多人共用同一 bash session**） |
| outer bwrap (PTY) | 跟 PTY 同生命周期 | PTY 订阅者 |
| ws connection | N（一 tab 一个）| 独占 per browser tab |
| /context/knowledge | 1 / workspace | workspace 所有 loop 所有 user |
| /context/notes | 1 / workspace | 同上 |
| /context/notes/memory/ | 1 / workspace | team memory，多 user 共写 |
| /personal/`<user>`/ | 1 per (workspace, user) | 一个 user 自己 |
| /personal/`<user>`/memory/ | 1 per user | personal memory，SDK auto-recall |
| `<loopDir>/workdir/` | 1 / loop | 该 loop |

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
     │ ws://host:7787/ws/loop/<id>/term                              
     ▼                                                                
[Hono router @ 7787]                                                  
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
                                                                      
[bun-pty.spawn("bwrap", [...args for THIS id...])]                    
     │     ← argv 里 bind 这 loop 的 workdir，没别 loop                
     ▼                                                                
[Linux process: bwrap]                                                
     │     ← 独立 mount namespace，只挂这 loop 的 paths               
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

- **`/context/*`** —— 多 loop 共享同一物理目录（同一 git repo）
- **`/personal/<user>/`** —— 多 loop（同 user）共享，跨 loop 持久化 memory 等
- **host 网络** —— 多 loop 共用，能互相 bind 端口（v6 不解决）

这些是**设计共享**：team knowledge 协作、user 自己的 memory 跨 loop 累积、网络复用。要硬隔离需要每 sandbox 一个 net namespace + 反向代理，工程量大。

### 多人协作的当前 gap（v6 未解决）

- `/personal` mount 当前指 driver 的 personal。如果 user A 是 driver、user B attach 同 loop：B 在 sandbox 里看到的是 A 的 secrets ❌
- 解法（v6.x 之后）：driver-transfer 时 unlink + relink personal mount + 重启 sandbox；或 read-only attach 模式不让 Claude 跑



## 虚拟路径布局

Claude 在 sandbox 里看到的：

| 路径 | 真路径（host） | 模式 | 说明 |
|---|---|---|---|
| `/loop/<id>/` | `~/.loopat/<ws>/loops/<id>/workdir/` | rw | cwd；为代码 loop 是 git worktree |
| `/loop/<id>/.claude/` | `~/.loopat/<ws>/loops/<id>/.claude/` | rw | SDK session JSONL + settings.json |
| `/context/knowledge/` | `~/.loopat/<ws>/context/knowledge/` | **ro** | 团队沉淀；git repo |
| `/context/notes/` | `~/.loopat/<ws>/context/notes/` | rw | 团队 prose；git repo；保存自动 commit |
| `/personal/` | `~/.loopat/<ws>/personal/<user>/` | rw | 用户私有；含 `memory/`、`secrets/` |

系统路径以 `--ro-bind-try` 逐项暴露：`/usr /etc /lib /lib64 /bin /sbin /opt /var /run`（read-only）。`/tmp` 共享 host（rw，让 socat unix socket / mktemp / IPC 工作）。`$HOME` (`/home/$USER`) 是 tmpfs，**personal-dep 的 symlink 目标会被 re-bind 回 $HOME 原位置**（让 ssh 等工具找到 `$HOME/.ssh`）。

`/proc /dev` 由 bwrap 标准 flag 提供。`--unshare-pid` 给独立 PID namespace。

**关键**：用 per-component `--ro-bind-try` 而**不是** `--ro-bind / /`。后者会让 / 整个 RO，bwrap 之后 mkdir `/loop` `/context` 这种新路径会失败（"Read-only file system"）。前者让 sandbox root 是 fresh tmpfs，bwrap 自由创建虚拟挂载点。

## personal-deps（外部依赖通过 symlink 入沙箱）

约定：用户在 `personal/<user>/` 下放 symlink 指向 host 文件，`buildOuterBwrapArgs` 启动时**递归扫**找所有 symlink，把目标的真路径 `--bind` 回 host 原位置。

例：
```sh
ln -s ~/.ssh ~/.loopat/1001/personal/simpx/secrets/.ssh
```
之后沙箱里：
- `/personal/secrets/.ssh` 可见（因为 `/personal` 已 bind）
- `/home/simpx/.ssh` 也可见（因为 `--bind /home/simpx/.ssh /home/simpx/.ssh`）—— 让 ssh 客户端读 `$HOME/.ssh` 拿到密钥

Sandbox 默认看不到 `~/.ssh` `~/.aws` `~/.config/gh` 这些敏感路径。要 opt-in 必须在 `personal/<user>/` 下显式 ln -s。**目录就是 ACL** 这条原则的体现。

## 网络

**不 `--unshare-net`**，host 网络共享。Claude 调 `api.anthropic.com` / 百炼 / curl / git fetch / npm install / pip install 都直接走。

按域名过滤要做的话，host 上 iptables/nftables 处理（外层），或者 outer sandbox 加 squid/tinyproxy（v6 不做）。

## Memory（auto-recall + 虚拟路径）

SDK 的 auto-memory recall 机制配置在每 loop 的 `<loopDir>/.claude/settings.json`：

```json
{
  "autoMemoryEnabled": true,
  "autoMemoryDirectory": "/personal/memory"
}
```

CLI 读这个 settings（通过 `settingSources: ["user"]`）→ 每 turn 自动扫 `/personal/memory/` → 相关 .md 注入 prompt。

因为 CLI 自己**也**跑在 sandbox 内，`/personal/memory/` 就是它眼里的真路径，**memory_recall 事件里 path 字段也是 `/personal/memory/foo.md`**（不会泄漏 `/home/...`）—— 这就是单层包 CLI 比包 Bash 严格更优的核心原因。

doctrine（CLAUDE.md）规定**两层 memory**：

- **`/personal/memory/`** —— 私有，per-user，SDK 自动召回，频繁、低门槛
- **`/context/notes/memory/`** —— 团队共享（在 notes git repo 里），**不**自动召回；doctrine 教 Claude 复杂 turn 开始时主动 `Read /context/notes/memory/MEMORY.md` 索引；判断 memory 对全团队有用时**自动 promote**（写一份到 team memory，不用问 user）

## System prompt 三层

```
┌────────────────────────────────┐
│ L1: Claude Code preset         │ SDK 内置
├────────────────────────────────┤
│ L2: doctrine                   │ workspace 级，文件 ~/.loopat/<ws>/CLAUDE.md
│   - 沙箱边界、context 约定     │ 静态，跨 loop 复用，cache 友好
│   - memory 模型、行为规则      │
├────────────────────────────────┤
│ L3: per-loop runtime           │ server 算的，title/id/branch/repo
└────────────────────────────────┘
```

L2 + L3 拼接后通过 `systemPrompt: { type:"preset", preset:"claude_code", append: <L2+L3> }` 注入。L2 用 workspace-相对 + 虚拟绝对路径（`/loop/<id>/`、`/context/...`、`/personal/...`），跨 loop 跨 user 跨机器**完全静态**，prompt cache 命中率最大化。

L4（per-loop user nudge，loop dir 根的 CLAUDE.md）+ L5（repo 自带 CLAUDE.md）都规划了但 v6 没启用，等真有需要再加。

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
| Claude 想 `cat ~/.aws/credentials` | tmpfs `/home/$USER` + 没 personal symlink → "No such file" |
| Claude 想 `rm -rf /` | RO bind /usr /etc 等 → 写不动；rw 区域只有 workdir / context/notes / personal |
| Claude 想 ssh 到外网机器 | personal/.ssh 没 ln 进来 → ssh client 找不到 key → 无法连。要 opt-in：用户 `ln -s ~/.ssh personal/secrets/.ssh` |
| Claude 写 memory 时引用真路径 | 不会发生 —— CLI 在 sandbox 内，看到的就是虚拟路径 |
| 多 loop 间数据隔离 | 每 loop 自己的 `/loop/<id>/` 独立 bind；跨 loop 看不见 |
| /tmp 写恶意东西 | 共享 host /tmp，但 tmp 本来就是 ephemeral，无害 |

UX 上**不"完美 docker"的地方**：
- `$HOME=/home/simpx`（不是 `/personal`）—— 因为 ssh 等工具固定读 `$HOME/.ssh`
- `/usr/local` 之类系统路径仍可见（RO）—— sandbox 里的 Claude 不应该感到"在外星系"，常用工具应该都在
- `LOOPAT_INSTALL_DIR`（如 `/home/simpx/workspace/loopat`）有泄漏 —— 因为 claude binary 必须能跑，只能 bind same-to-same

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
sudo apt install -y bwrap socat ripgrep        # bwrap 主体；socat 暂留（不用了，但 Anthropic 内 sandbox-runtime 还在 import）；ripgrep 给 Claude 用
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
echo "kernel.apparmor_restrict_unprivileged_userns=0" | sudo tee /etc/sysctl.d/60-apparmor-namespace.conf
```

Ubuntu 24.04+ 必须关 apparmor 那一项，不然 unprivileged user namespace 起不来，bwrap 跑不动。

## 文件位置（实现）

- `server/src/outer-sandbox.ts` —— `buildOuterBwrapArgs(loopId, extraSetenv)` 构造 argv
- `server/src/personal-deps.ts` —— 递归 walk personal/ 找 symlink，返回真路径列表
- `server/src/session.ts` —— SDK options 里 `spawnClaudeCodeProcess` callback 包 CLI；`sandbox: { enabled: false }` 关 SDK 内置 sandbox-runtime
- `server/src/term.ts` —— PTY 同样走 `buildOuterBwrapArgs`，bash 进沙箱
- `~/.loopat/<ws>/CLAUDE.md` —— L2 doctrine
- `<loopDir>/.claude/settings.json` —— `autoMemoryDirectory: /personal/memory`
