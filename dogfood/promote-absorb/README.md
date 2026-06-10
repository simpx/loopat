# promote-absorb — promote 吸收他人最新 + 不留 loop 分支

**目的**: 验证 ② promote 的两条:落 main 前先 fetch→merge(他人工作被吸收而非覆盖);ungated promote 不在 origin 留 loop/<id> 分支。
**步骤**: Latest 建 loop → 外部写手推 other.md → AI 在 notes 写 mine.md 并 promote(add/commit/fetch/merge/push)→ 验 origin。
**预期**: origin tree 同时含 mine/other 两文件;branch -a 无 loop/<id>。
