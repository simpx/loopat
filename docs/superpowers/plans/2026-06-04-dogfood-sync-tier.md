# dogfood/sync — context-flow across two independent loopat servers

新增第 4 层 **sync**:两个完全独立的 loopat server(各自 LOOPAT_HOME/backend/vite)共享一个 fixture sshd origin,验 context flow 收敛。

## Harness(扩 first-run/dogfood 单 server → 双 server)
- config 挑端口:`A_back A_vite B_back B_vite sshd`(24001+),mkdtemp 两个 HOME,写 .test-meta。
- setup:build+run 一个 fixture sshd = 共享 origin;seed kn/notes/roster1。两 server 各 register 用户、建 vault。pubkey 都进 authorized_keys。两 backend + 两 vite 起。两 storageState。
- integration truth = `podman exec <fixture> git -C /srv/git/*.git log`,B 端 worktree/UI 复核。

## S1 共享 personal repo
两 server 同一 personal repo(同 kn/notes 指针)。A UI 改 notes → push origin → B 刷新 context 看到;personal config 改同步。验全收敛。

## S2 不同 personal、同 kn
各自 personal,config 指同一 kn。A 改 kn → B 看到;personal 隔离不串。

## S3 AI 改也同步
S1 把 UI 改换成 loop 内 AI 改 → B 看到。同构。

## S4 不同文件并发(99%)
两端改不同文件 → 都 push → git 自动 merge → 两端都全。

## S5 同文件冲突·held-back(灵魂)
两端 UI 改同处 → 先到者 land,后者 ff 失败 → keep-local + 告知 + 不进 SoT。

先 harness+S1 跑通,再 S5,再 S2/S3/S4。全绿、env 传 url/key、不暴露 endpoint。
