# Loop = 云端共享目录

## 决定（2026-05-04，待最终确认）

**Loop 的物理形式 = 一个云端目录。**

协作 = 给目录加 ACL 让别人能读 / 写。其他都是这个的派生。

## 这个简化解决了什么

| 之前的复杂问题 | "云端 dir"下的解 |
|---|---|
| 协作的物理形式（git remote / fs / SSH …）| **就是个云端 dir** |
| Chat 共享 | chat history 是 dir 里的文件 |
| AI 进共享 loop | AI 本地 mount 跑，看到同一份 dir |
| Read vs write | dir 的 ACL |
| 跟 tracker 衔接 | tracker 是这个 dir 的一种外部 view |

## 现成模式映射

| 模式 | 借鉴 |
|---|---|
| **GitHub repo** | 共享代码 + issues + actions 都在 repo 内 |
| **Replit / Codespaces** | 云端 dir + AI + terminal 一体 |
| **Google Drive 共享文件夹** | dir + 权限 |
| **Slack channel** | 共享 chat 但缺 workspace |

**1001 要的 = GitHub repo + Replit + Slack channel 三者合一**：dir + chat + AI + 权限，全在一个 dir 内。市面没有现成的。

## 心理模型

```
~/workspace/<loop>/          ← 本地 mount / clone
        ↕ (sync)
cloud://loops/<loop>/         ← 云端权威副本，带 ACL
```

每个 loop 在云端有权威副本，本地是 working copy。授权 = 给 cloud 那份加 ACL。

## 工程问题（待选）

| 问题 | 选项 |
|---|---|
| 怎么实现"云端 dir" | git repo / live sync (NFS / S3FS / Syncthing) / 集中 SSH host / 自写 sync |
| 哪个云 | 内网（tracker / S3 / 公司 NAS）/ 公网（GitHub）/ 自建 server |
| Chat 怎么落地 | 单文件 append `chat.log` / 每消息一文件 / SQLite / IRC bridge |
| Discovery | 50 个 loop 怎么 list 出来 |

## 推论

- **tracker 不是协作系统**，是外部任务跟踪 + view 渲染面
- 真正的协作系统 = **可分享的云端 loop dir**
- IRC 是 chat 那一面的现成方案；剩下的是 dir + sync + ACL
- 这个方向有 ready-made 的 building blocks（git、NFS、IRC），关键是组合方式
