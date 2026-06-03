# dogfood first-5-minutes 重做 = 真·首次用户全旅程 — 设计

## 目标
first-5-minutes 从"预置 onboarded + storageState 跳过登录"改成**真·首次用户冷启动全旅程**,当 smoke:全空 LOOPAT_HOME → 注册 → 登录 → onboarding gate 拦 → UI 配 personal repo(填地址 + git-crypt key)→ 把 ssh 公钥加到"平台"→ context 出内容(clone)→ 建 loop → AI → terminal。覆盖一个普通用户第一次用 loopat 的完整链路,而且**真测 onboarding**(之前故意划出范围的部分)。

## 核心新增:fixture git-host provider
一个仿 `code.ts`、但**操作 fixture sshd** 的测试 provider,由 setup 写进 `LOOPAT_HOME/extensions/providers/<id>.ts`。duck-typed `GitHostProvider`,**不 import loopat、不含任何内网 endpoint**(全从 env 读):
- `id`/`label`;`gitAuthMode: "ssh-deploy-key"`(personal repo 走 deploy key;team repo kn/notes 走 vault 的 id_ed25519)
- `authenticate(cred)`:用 env 传入的 token/marker 校验,返回 `login`(如 `test`)
- `ensureRepo`:在 fixture sshd 容器里 `git init --bare` 出 personal repo
- `registerDeployKey`:把 personal repo 的 deploy **公钥**塞进 fixture `authorized_keys`(让 loopat 能 clone/push personal repo)
- `seedDefaults`:在 personal repo 工作树里写 `.loopat/config.json`(provider = AI,`baseUrl`/`apiKey` 用 **env-var 引用**,不写实值)+ 在 vault 里 `ssh-keygen` 生成 `id_ed25519`(git-crypt 加密)
- `onboarding(ctx)`:**1:1 抄 code.ts** 三步、尽量真实不简化,驱动 gate:
  1. `!personalRepoImported` → route `/settings/personal-repo`。该页(通用前端 `PersonalRepoPanel`)真实驱动:用户填一个**(假)token** → 前端调 `listRepos`(首次**空**)→ 用户点"创建" → `ensureRepo` 在 fixture 建 personal repo + `registerDeployKey` 塞 deploy 公钥 + `seedDefaults` 备好 `.ssh` key & `config.json`(base url 走 env) → import(git-crypt:用户输 key 解锁)。
  2. 无 AI key → form 要 AI key(值由 env 提供,action `vault-env`)——同 code.ts,用户在跳转的这页填 key。
  3. ssh 探测:vault 的 key 能否 clone fixture kn/notes → **不能** → `info`("把这个公钥加到平台 SSH Keys");**能** → `{done:true}`。
- gate:provider 实现 onboarding ⇒ loopat 强制 onboarding(后端 403 + 前端 Shell 全局拦),done 前进不了主 UI

## 决策(已敲定)
- **git-crypt 真**:personal repo 真加密(`.loopat/vaults/**`),第 5 步用户输 git-crypt key → loopat `saveGitCryptKey` + `git-crypt unlock`。
- **ssh 公钥 = 测试 seed**:第 7 步测试代码把 vault `id_ed25519.pub` 塞进 fixture `authorized_keys`(模拟用户去平台 SSH Keys 手动加 key)。加之前 kn/notes clone 不了,加之后能。
- **endpoint 全 env**:fixture provider baseUrl、AI provider baseUrl+key、fixture repo url 全走环境变量;repo 源码与 fixture 里不出现任何内网 endpoint。
- **第 4 步测"被拦"**:未配置时点 context / 建 loop,断言被 onboarding gate 正确拦住(到不了 context;建 loop 403)。

## 11 步 → Playwright 断言(全真:浏览器 + 真容器 + 真 git + 真 AI)
1. **全空 LOOPAT_HOME**(setup mkdtemp,不预置 user、不预置 onboarded、不写 storageState)。
2. 浏览器**注册**(UI 输 user/pass)→ 成功。
3. 浏览器**登录**(UI)→ 成功,落到 onboarding gate。
4. 点 context / 试建 loop → **被 onboarding gate 拦**(断言看到 onboarding 提示、进不去 context;建 loop API 403)。
5. UI 配 **personal repo**(真走 code.ts 式流程):填(假)token → 列个人 repo(**空**)→ 点"创建" → fixture provider `ensureRepo`+`registerDeployKey`+`seedDefaults` 备好 → 输 git-crypt key → import 解锁。
6. 再看 → 仍被拦(ssh 公钥没加,kn/notes clone 不了),onboarding 仍提示"加公钥"。
7. **测试 seed**:vault `id_ed25519.pub` → fixture `authorized_keys`(模拟平台加 key)。
8. onboarding 重探测 → `done`;进 context → 等后台 clone → 看到 kn/notes 内容。
9. **建 loop** → 容器"准备中" → running。
10. **chat** → 真 AI 回(env key)。
11. **terminal** → `git status` 正常。

## 不做
真 code 平台、内网 endpoint、storageState 跳登录(这条 case 专门走真注册/登录)。其它 case 仍用 storageState(快)。

## 风险
- 目前最大的一条:fixture provider + 真 git-crypt + 整个 onboarding UI 流程,比现有所有 case 都重、selector 多。
- onboarding 的 submit/personal-import 流程沿用现有后端(`/api/onboarding/submit`、personal import、`saveGitCryptKey`);实现时跟随现有代码,别新发明。
- 真 git-crypt 要求跑测试的机器装了 `git-crypt`(bootstrap 已检测)。
- **起点冲突**:first-run 要**全空** LOOPAT_HOME(不预置 onboarded),而其它 case 共享的 setup 预置了 onboarded。故 first-run 需要**自己的 config + setup**(空起点 + 装 fixture provider + 不写 storageState),与其它 case 的 setup 分开。
