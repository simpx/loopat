# 02 — personal 权限

## 证明什么

权限跟着 **personal 走,与 host 无关**:host 能访问 kn/notes/personal,**不代表** loop 能工作。
loop 的每个 git 操作只认 personal 自己的 vault key,没有就失败 —— 所以一个"空 personal"的
账号即使在一台 host 权限齐全的机器上,也跑不动 loop。

## 前提行为(本 case 驱动的实现约束)

- **bootstrap**(首次 clone + 解密 personal repo 本身)→ 用 host deploy-key。
- **loop 工作**(kn/notes/repos/personal 的 fetch/clone/promote/pull)→ **只用 vault key;
  没有就失败,绝不 fallback host**。这是 case 成立的前提(否则会蹭 host 权限)。

## Fixture

- 一个 git-over-ssh server,3 个 repo:`kn`、`notes`、`personal`,**各自独立授权**(per-repo)。
- host 的 key 授权访问全部 3 个(模拟"host 有权限")。
- 用户的 vault key 分阶段授权,以制造下面的三档失败/成功。

## 步骤 + 断言

1. **启动** → host key 展示 clone `kn`/`notes` 成功,能看到初始化(host 有权限)。
2. 建账号,**空 personal**(无 vault key)→ 创建 loop **失败**(连不上,不蹭 host)。
3. vault 配好 key + personal config 声明 `kn`/`notes`,但 `personal` repo 尚未授权该 key
   → 创建 loop **依旧失败**(personal 自身连不上)。
4. 三个 repo 都给该 vault key 授权 → 创建 loop **成功**。

→ 整条链证明:能不能跑 loop,只取决于 personal 这把 key 在各 repo 的授权,host 无关。

## 实现

`scripts/e2e/...`(待实现)。难点:需要 **per-repo 授权**的 ssh fixture(多账号 / 多 server /
gitolite 三选一),以区分"kn/notes 已授权、personal 未授权"。

## 状态

⬜ 待实现。
- ① fallback 语义收紧 → **已完成**:`sshCommandForUser` 改为 vault-key-only,host deploy-key
  仅 `bootstrapSshCommand`(首次 clone personal)使用。
- ② per-repo 授权 ssh fixture → 待做。
