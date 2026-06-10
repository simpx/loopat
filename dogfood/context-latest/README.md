# context-latest — Latest vs Cached 的真实行为差

**目的**: 验证 ① pull 的 freshness 不是摆设:origin 在本地 clone 之后推进一笔,Latest(origin/HEAD)建的 loop 能看到,Cached(HEAD)建的看不到。
**步骤**: 建 warm loop 物化 clone → 外部向 notes origin 推 marker → Cached 建 loop,AI ls notes 报告 → Latest 建 loop,AI 再报告。
**预期**: Cached 回 NO_MISSING,Latest 回 YES_SEEN。
