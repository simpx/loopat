---
title: 多租户 secrets — 客户端加密 + git 原生
tags: [loopat, design, security, secrets, multi-tenant]
status: future-work (not implemented; record only)
date: 2026-05-12
---

# 多租户 secrets：客户端加密 + git 原生

把 loopat 从单租户（密钥明文落盘，机器主人即可见）演化为多租户（每个用户的密钥只有 ta 自己能看，server 不持久知道）的设计。

**当前状态**：未实现。本文是未来工作的记录，等 loopat 走向多租户/对外提供服务时回来落地。

## 1. 设计目标

1. **server 不持久知道任何用户的密钥** —— 库被偷、运维 root 都看不到
2. **保留"git 管理一切"** —— 加密后的 secrets 仍然走 git commit/push/clone，跨设备同步靠 git
3. **sandbox 内仍然是明文** —— sandbox 里的 cc 直接读 apiKey 就能用，不需要它感知加密
4. **不依赖第三方密钥服务**（Vault / KMS / SOPS server）

## 2. 威胁模型

| 攻击者                      | 拦得住吗 | 怎么 |
|---|---|---|
| 偷服务器磁盘 / 数据库         | ✅ | secrets 在 git 里全是密文，没用户密钥解不开 |
| 云厂商 at-rest 窥探         | ✅ | 同上 |
| 运维 root 翻文件             | ✅ | 用户没主动开 loop 时，server 进程内存里也没有密钥 |
| 拖库 + 钓鱼 1 个用户活跃 session | ⚠️ | 拿到那 1 个用户开 loop 时短暂在内存里的密钥 |
| loop 运行期间 server 被攻破   | ❌ | server 当时内存里有那个 user 的密钥，可 exfil |
| 用户浏览器被 XSS / 恶意扩展     | ❌ | localStorage 是明文，扩展可读 |
| TLS MITM                  | ❌ | 必须强制 TLS |

**核心安全保证 = "server 在用户没主动开 loop 时不知道任何东西"**。这给 server 一个明确的"无知窗口"，是单租户磁盘加密给不了的。

## 3. 架构总览

```
┌─ Browser ──────────────────────────────────────────────────┐
│  localStorage["loopat_key"] = AES-256 master key            │
│                                                             │
│  写 secret: encrypt-in-JS → POST <密文>                      │
│  开 loop:   WS 握手把 key 临时发给 server                    │
└─────────────────────────────────────────────────────────────┘
              ↓ TLS
┌─ Server ────────────────────────────────────────────────────┐
│  at-rest (git 管理):                                         │
│    personal/<user>/.loopat/secrets/provider-keys/anthropic.enc │
│    ← 永远是密文，git commit/push/pull 操作的就是这个         │
│                                                             │
│  startLoop(id, key):                                        │
│    plain = decryptAll(<.enc files>, key)                    │
│    tmpDir = loops/<id>/runtime-secrets/  (tmpfs, mode 0700) │
│    write(tmpDir, plain)                                     │
│    bwrap --bind tmpDir → /loopat/context/personal/.loopat/secrets │
│    onClose: shred(tmpDir); zero(key in process memory)      │
└─────────────────────────────────────────────────────────────┘
              ↓ bwrap bind
┌─ Sandbox (cc 进程) ──────────────────────────────────────────┐
│  /loopat/context/personal/.loopat/secrets/provider-keys/anthropic │
│  ← 看到明文（因为 bind 的是解密好的 tmpfs）                   │
│  loop 结束 → tmpfs 销毁 → 明文消失                            │
└─────────────────────────────────────────────────────────────┘
```

## 4. 为什么这个设计能"git 原生"

加密发生在**应用层**而非 git filter 层（不是 git-crypt 那种）：

- 浏览器把 plaintext 加密成 `.enc` 后才送达 server
- Server 拿到的就是 `.enc` 文件，直接 `git add` / `git commit` / `git push`
- 跨设备同步 = `git pull`，拉的是 `.enc`，本地解密发生在 sandbox 启动时

对比 git-crypt：

| 维度 | git-crypt | 客户端加密 |
|---|---|---|
| 加密位置 | git filter（commit/checkout 时） | 浏览器 JS（写 secret 时） |
| 工作目录状态 | 明文（unlock 后） | 永远密文（除 sandbox tmpfs 解密目标） |
| Server 是否知道密钥 | unlock 状态下持有 `.git/git-crypt/keys/default` | 仅 loop 运行期内在内存 |
| 多租户隔离 | 不支持（all-or-nothing） | 天然支持（每用户一把 master key） |
| Git 原生 | ✅（filter 是 git 标准机制） | ✅（git 操作的是 .enc 文件） |

**结论**：客户端加密是 git-crypt 的多租户演进，保留 git 原生属性，但加密边界从"机器"上移到"用户浏览器"。

## 5. 加密原语

- **AES-256-GCM**
  - 浏览器：`crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext)`（WebCrypto API 原生，零依赖）
  - 服务器：`crypto.createCipheriv("aes-256-gcm", key, iv)`（Node/Bun 内置）
- **文件格式**（每个 `.enc` 文件）：
  ```
  nonce(12 bytes) || ciphertext(N bytes) || auth-tag(16 bytes)
  ```
- 一个 user 一把 master key，加密 ta 所有 secrets

不要自创格式，不要造轮子加密。

## 6. 密钥管理：三个方案

### A. 浏览器随机生成 + 备份短语（MVP 推荐）
```
首次访问：
  key = WebCrypto.generateKey("AES-GCM", 256)
  localStorage["loopat_key"] = base64(key)
  显示 BIP39 24 词给用户抄下来

新设备：
  用户手动输入 24 词 → 还原 key
```
- ✅ 强加密、零密码、可备份
- ❌ 24 词抄写体验差

### B. 密码派生（用户体验最好）
```
用户设密码 → Argon2id(password, salt) → AES key (永不存盘)
每次开 session 都重新 derive
```
- ✅ 用户只需记密码，跨设备零拷贝
- ❌ 密码弱 = 加密弱；忘密码 = 数据没了（除非接受 escrow）

### C. Passkey PRF（最现代，等浏览器普及）
```
WebAuthn passkey + PRF extension → AES key
依赖 Touch ID / Windows Hello / iCloud Keychain 同步
```
- ✅ 硬件支持，多设备自动同步
- ❌ 浏览器支持还在 rolling out，复杂度高

**推荐路线**：先 A，B 做高级选项，C 等成熟。

## 7. 密钥发送给 server 的协议

不要每次 HTTP 请求都带，**只在 loop 启动时**送一次：

```
1. Browser → Server:  WebSocket upgrade
                      first message: { type: "loop-key", id, key }
2. Server 解密所有 .enc → tmpDir → bwrap bind 进 sandbox
3. Loop 运行
4. Loop 关闭 / 用户断开 → server umount tmpDir + 内存 key 清零
```

key 在 server 内存的"驻留窗口" = loop 生命周期。窗口最小化是核心。

进阶：用 Linux `memfd_secret(2)`（kernel ≥ 5.14）创建内核保护的内存页存 key，连同机其他进程的 root 也读不到。Node 没原生绑定，要 FFI，未来再加。

## 8. Sandbox 边界设计选择

**选择 X：每 loop 一个 tmpfs**（推荐）
```
loops/<id>/runtime-secrets/    ← tmpfs，0700，owner=server
  provider-keys/anthropic       ← 明文
bwrap --bind runtime-secrets → /loopat/context/personal/.loopat/secrets
```
- 明文落 **tmpfs**（内存挂载，掉电即失）
- Loop 销毁触发 umount + rm -rf
- 没有 swap 风险（tmpfs 默认不 swap）

**选择 Y：纯 env var 注入**
```
bwrap --setenv ANTHROPIC_API_KEY <plain>
```
- ✅ 零磁盘落地
- ❌ env var 通过 `/proc/<pid>/environ` 暴露，进程列表泄漏，且不能放多行 secret

**实际方案：混合**
- 小 secret（apiKey）走 env var（loopat 当前架构本来就这样）
- 大 secret（cert / 多行 key）走 tmpfs

## 9. 加密 secret 的写流程

```
用户在前端粘贴 anthropic key:
  ↓
浏览器 JS:
  nonce = crypto.getRandomValues(12)
  cipher = AES-GCM(localStorage.key, nonce, plaintext)
  blob = nonce || cipher || tag
  ↓
POST /api/secrets/provider-keys/anthropic
body: <blob>
  ↓
服务器:
  写 personal/<user>/.loopat/secrets/provider-keys/anthropic.enc
  git add + commit + push（自动 / 用户触发）
```

**server 从未看到明文** —— 这是关键路径。任何会让 server 短暂触摸明文的"为了方便"功能都不能加（比如"server 帮你检查这个 key 格式对不对"）。

## 10. 跟当前实现的差异 / 迁移路径

当前（2026-05-12 落地）：
- secrets 在 `personal/<user>/.loopat/secrets/provider-keys/<name>` —— **明文**
- `loadPersonalConfig(user)` 直接读文件填进 `provider.apiKey`
- 单租户假设，server 即用户

未来：
- secrets 改成 `<name>.enc` 后缀（或保持无后缀但内容是密文，靠 magic bytes 识别）
- `loadPersonalConfig(user)` **不再**读 secret 文件，仅读 config.json 的非密部分
- 新增 `decryptPersonalSecrets(user, key) → tmpDir`，loop start 时调用
- `session.ts` 在 `ensureStarted` 里从 WS 握手收 key，调用解密函数，把 tmpDir bind 进 sandbox

迁移要做：
1. 前端加密 UI（输入 secret → 加密 → 上传）
2. 后端 `/api/secrets/*` 路由（仅存密文，不解密）
3. 后端 `startLoop` 路径接受 key
4. bwrap bind 改成 tmpDir
5. 一次性脚本把现有明文 secrets 加密迁过去

迁移**不**做：
- 不写双写逻辑、不做兼容期 fallback —— 走 MVP 不兼容老数据原则，一次性切换

## 11. 开放设计决定（实施时再敲）

1. **A/B/C 哪个先做**？我倾向 A
2. **要不要 server-side encrypted escrow**（忘密码能恢复）？削弱"server 不持久知道"但救小白用户。倾向"先不做，告知用户密钥丢失=数据丢失"
3. **粒度**：一个 user 一把 master key（简单） vs 每个 secret 独立 key（细 ACL 但复杂）？倾向前者
4. **审计**：每次 server 解密留 log，给用户看"我的 key 何时被用过 N 次"？建议做
5. **多并发 loop**：每个 loop 单独传 key vs WS session 期内 server 内存留一段时间？建议**单独**（一致性 > 一次性优化）
6. **密钥 rotation**：rotate master key 时怎么重新加密所有 .enc 文件？前端拉所有密文 → 解 → 用新 key 重新加密 → 推回。设计要预留

## 12. 不做的事

- 不做"server 端密钥托管 + 用户密码解锁"——那退化成密码强度问题，丢"server 不持久知道密钥"的卖点
- 不引入 HSM / KMS / Vault —— 增加运维 + 锁定云厂商
- 不做"AI 在 sandbox 里也能加密"—— sandbox 信任 server 给的明文就够，加这层只增加复杂度
- 不做"加密浏览器历史 commit"—— 已经存在的明文 secret 走 git filter-repo 重写历史 + force push 即可（一次性操作）

## 13. 跟单租户 git-crypt 的关系

短期（个人用，2026 当下）：**git-crypt 够用**。机器主人就是用户，server 信任本机文件系统。

中期（开始有第二个用户）：**git-crypt 撑不住**。git-crypt 是 all-or-nothing 单密钥，无法做 per-user 隔离。

长期（多租户）：**切换到本文方案**。
本文方案是 git-crypt 的**多租户演进**，思想一脉相承（git 原生 + 透明加密），实现层从 git filter 上移到应用层。
