# loopat 关键路径 E2E — 设计

## 痛点

AI 提交代码很快,但容易 break 基本逻辑;人肉走一遍"前 5 分钟基本体验"就能发现一堆 bug(workdir git 路径错、repos 页面空、ssh key 改名挂、config-hash 漂移)。AI 自测测不出:要么只跑 `bun test`(L4 被 `skipIf` 静默跳过)、要么干脆没真跑——结果永远"假绿"。

这些 bug 共性:都是「真沙箱 + 真配置 + 真 git」的集成问题,L1–L3 逻辑测试天然抓不到。缺的是一条**最高保真、贯通整条关键路径**的 e2e,而且必须**跑不了就红、不能 skip 成绿**。

## 目标

一条 Playwright e2e,完整模拟真实用户,把"前 5 分钟"整条走真:浏览器 → 后端 → fixture sshd git server → podman 真容器 → 真 AI → 在 UI 里点开 terminal 跑 git。一次能炸出本次所有 bug。

## 范围

**测**:已 onboarded 状态下的核心环路——建基于 roster repo 的 loop → 真容器 → UI 打字发消息 → AI 回 → 点开 terminal `git status`/改文件/commit/push 到真 origin。

**不测(明确划出)**:onboarding。它锁死内部 `code.ts`(code.alibaba API、idealab key、dashjump 探测),fixture 模拟不了;靠真环境手动验。e2e 预置"已 onboarded"态绕开它。

## 架构

1. **fixture sshd git server(podman 容器)**:测试起一个 sshd + git 的 podman 容器,`authorized_keys` 塞 fixture 的 `id_ed25519.pub`,ssh 端口 publish 到 host;容器内预置裸仓库:`knowledge`(带 `.loopat/config.json` + `.claude`)、`notes`、`personal/<user>`、若干 roster repo(如 vineyard)。loop 容器走 host 网络连上去,clone / worktree / push 全程真 ssh,把 vault key + known_hosts + 认证一起验。隔离、可复现、跑完即删,不碰 host sshd/端口。
2. **隔离后端**:临时 `LOOPAT_HOME`,gitHost / knowledge 指向 fixture sshd。预置 personal repo(vault: 测试 `id_ed25519` + 配好的 provider key)→ 跳过 onboarding。
3. **浏览器**:Playwright 预登录,dismiss setup 卡,落 `/loop`。
4. **真容器**:podman host 网络,容器直连 host 上 fixture sshd 端口。
5. **UI 真交互**:在 chat 输入框打字发送;点开 terminal 面板敲命令、读输出(不是调 API)。
6. **真实 AI**:真 claude binary + 真 provider(idealab/bailian,key 从 vault),完整模拟用户,不 mock。慢、烧钱、非确定 → 定位发版前/手动高保真验收。

## 关键路径(断言点)

- 登录 → `/loop`,loop 列表可见
- 建一个基于 roster repo(vineyard)的 loop → 容器 running
- chat 输入框发一句 → 真 AI 回复(无 error 事件)
- 点开 terminal → `git status` **不 fatal**(回归本次 workdir gitdir bug)→ 改文件 → commit → `git push` 成功进 fixture origin
- 断言**行为**(真 AI 非确定,不断准文本):loop 建成 / 容器 running / 有回复 / git status exit 0 / origin 收到 push

## 取舍

- **git server**:podman 容器跑 sshd(最真且隔离);不用 host sshd(污染端口)、不用 git daemon / file://(否则 ssh 那套测不到)。
- **git-crypt**:测试用预置 key 解锁(或明文),不搞真 git-crypt。
- **假绿即红**:podman 或 provider key 不可用时 **fail 而非 skip**——这条测试不能假绿。定位发版前/手动,慢可接受。

## 不做

onboarding、`code.ts`、真 gitlab。
