# context-isolation — pull 仅在创建时,loop 中途隔离

**目的**: 验证 context-flow 的 isolation 不变量:loop 创建后 origin 的新 commit 不会自动进入 loop。
**步骤**: Latest 建 loop → AI 确认就绪 → 外部向 origin 推 marker → AI ls notes。
**预期**: 回 NO_MISSING(中途不自动拉取)。
