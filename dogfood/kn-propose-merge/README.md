# kn-propose-merge — knowledge 的 gated promote 全链路

**目的**: 验证新 gate 模型:kn worktree 可写,AI commit 后停在 loop/<id>(提案);merge 前 origin main 不动;review&merge API 落地。
**步骤**: AI 在 kn 写文件+commit(不 push)→ 验 origin 无此文件 → proposals API 列出提案 → merge API → 验 origin 有了。
**预期**: DONE_COMMITTED;merge 前 origin 干净;merge 后文件落 main。
