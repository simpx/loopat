# structure-automerge — 异文件并行写,promote 全自动落

**目的**: 冲突链第 1 层(结构先行,~99% 路径):不同 loop 写不同文件,git 自动合并,无需 AI 解冲突。
**步骤**: loop A 的 AI 写 a.md 并 promote → loop B 的 AI 写 b.md 并 promote → 验 origin。
**预期**: origin tree 同时含 a/b 两文件。
