/**
 * Per-loop workspace mocks: file tree + file contents.
 *
 * Each loop has its own workdir with realistic-looking files. Artifacts
 * created in chat (knowledge/*.md, CHANGELOG.md, etc.) live as actual
 * entries in fileContents, so clicking the artifact card opens the
 * file in the editor with proper content.
 */
export type FileNode =
  | {
      kind: "folder"
      name: string
      children: FileNode[]
      mount?: "ro" | "rw" | "selective"
      revision?: string
      secret?: boolean
      onSync?: () => void
      display?: "section"
      hint?: string
    }
  | {
      kind: "file"
      name: string
      path: string
      modified?: boolean
      staged?: boolean
      readonly?: boolean
      linkTo?: string
    }

export type LoopWorkspace = {
  fileTree: FileNode[]
  fileContents: Record<string, string>
}

// ----- loopctl: Go CLI for the platform -----

const loopctl: LoopWorkspace = {
  fileTree: [
    {
      kind: "folder",
      name: "cmd",
      children: [
        { kind: "file", name: "runtime.go", path: "cmd/runtime.go", modified: true, staged: true },
        { kind: "file", name: "quota.go", path: "cmd/quota.go" },
        { kind: "file", name: "router.go", path: "cmd/router.go" },
        { kind: "file", name: "root.go", path: "cmd/root.go" },
      ],
    },
    {
      kind: "folder",
      name: "api",
      children: [
        {
          kind: "folder",
          name: "runtime",
          children: [{ kind: "file", name: "list.go", path: "api/runtime/list.go", modified: true, staged: true }],
        },
        {
          kind: "folder",
          name: "quota",
          children: [{ kind: "file", name: "list.go", path: "api/quota/list.go" }],
        },
        { kind: "file", name: "client.go", path: "api/client.go" },
      ],
    },
    {
      kind: "folder",
      name: "internal",
      children: [
        {
          kind: "folder",
          name: "deprecation",
          children: [{ kind: "file", name: "warn.go", path: "internal/deprecation/warn.go" }],
        },
        {
          kind: "folder",
          name: "render",
          children: [{ kind: "file", name: "table.go", path: "internal/render/table.go" }],
        },
      ],
    },
    { kind: "file", name: "go.mod", path: "go.mod" },
    { kind: "file", name: "CHANGELOG.md", path: "CHANGELOG.md", modified: true },
    { kind: "file", name: "README.md", path: "README.md" },
  ],
  fileContents: {
    "cmd/runtime.go": `package cmd

import (
\t"fmt"
\t"os"

\t"loopctl/api"
\t"loopctl/internal/render"
\t"github.com/urfave/cli/v2"
)

func ListShards(c *cli.Context) error {
\tregion := c.String("region")
\tcursor := c.String("cursor")
\tlimit := c.Int("limit")
\tif limit == 0 { limit = 100 }
\tshards, next, err := api.ListShardsCursor(region, cursor, limit)
\tif err != nil { return err }
\tif next != "" {
\t\tfmt.Fprintln(os.Stderr, "next-cursor:", next)
\t}
\treturn render.Table(shards)
}
`,
    "api/runtime/list.go": `package fleet

import (
\t"context"
\t"fmt"

\t"loopctl/internal/api"
\t"loopctl/internal/deprecation"
)

type Shard struct {
\tID     string
\tRegion string
\tStatus string
}

// ListShards 列出指定 region 下所有 shard
// Deprecated: 使用 ListShardsCursor。下个 release 会移除。
func ListShards(region string) ([]Shard, error) {
\tdeprecation.Warn("api.ListShards", "use ListShardsCursor instead")
\tshards, _, err := ListShardsCursor(region, "", 0)
\treturn shards, err
}

// ListShardsCursor 是分页版的 ListShards。
// limit=0 时由服务端默认（当前 100）。
func ListShardsCursor(region, cursor string, limit int) ([]Shard, string, error) {
\treq := &api.FleetReq{
\t\tRegion: region,
\t\tCursor: cursor,
\t\tLimit:  int32(limit),
\t}
\tresp, err := api.FleetClient.ListShards(context.Background(), req)
\tif err != nil { return nil, "", fmt.Errorf("list shards: %w", err) }
\treturn resp.Shards, resp.NextCursor, nil
}
`,
    "api/quota/list.go": `package quota

import (
\t"context"
\t"fmt"

\t"loopctl/internal/api"
)

type Quota struct {
\tName  string
\tLimit int
\tUsed  int
}

// ListQuotas 列出 region 下所有 quota 项
func ListQuotas(region string) ([]Quota, error) {
\treq := &api.QuotaReq{Region: region}
\tresp, err := api.QuotaClient.List(context.Background(), req)
\tif err != nil { return nil, fmt.Errorf("list quotas: %w", err) }
\treturn resp.Items, nil
}
`,
    "CHANGELOG.md": `# CHANGELOG

## [Unreleased]

### Added
- \`loopctl fleet list-shards\` 支持 \`--cursor\` / \`--limit\` 参数
- \`api.ListShardsCursor\` — paginated 版本的 ListShards

### Deprecated
- \`api.ListShards\` (无分页版) — v0.7 将移除，建议改用 \`ListShardsCursor\`

## [0.6.0] - 2026-04-20

### Added
- runtime / router / quota 三个子命令
`,
    "go.mod": `module loopctl

go 1.22

require (
\tgithub.com/urfave/cli/v2 v2.27.5
)
`,
    "README.md": `# loopctl

Loopey 平台运维 CLI。把碎片化的控制台 / API 调用收敛进单一自描述命令。

## 命令

- \`loopctl fleet\` — Runtime 管控
- \`loopctl quota\` — 配额查询
- \`loopctl router\` — 路由配置
`,
  },
}

// ----- gateway-launch: loopey-runtime inference engine (Python) -----

const gatewayLaunch: LoopWorkspace = {
  fileTree: [
    {
      kind: "folder",
      name: "runtime",
      children: [
        { kind: "file", name: "gateway.py", path: "runtime/gateway.py", modified: true, staged: true },
        { kind: "file", name: "rdma_pool.py", path: "runtime/rdma_pool.py", modified: true },
        { kind: "file", name: "scheduler.py", path: "runtime/scheduler.py" },
      ],
    },
    {
      kind: "folder",
      name: "tests",
      children: [
        { kind: "file", name: "test_gateway.py", path: "tests/test_gateway.py", modified: true },
        { kind: "file", name: "test_rdma.py", path: "tests/test_rdma.py" },
      ],
    },
    {
      kind: "folder",
      name: "docs",
      children: [{ kind: "file", name: "gateway-design.md", path: "docs/gateway-design.md" }],
    },
    { kind: "file", name: "pyproject.toml", path: "pyproject.toml" },
    { kind: "file", name: "README.md", path: "README.md" },
  ],
  fileContents: {
    "runtime/gateway.py": `# gateway.py — KV cache layer
from typing import Optional
from .rdma_pool import RdmaPool


class Gateway:
    """KV cache backed by RDMA-registered memory regions."""

    def __init__(self, pool: RdmaPool):
        self.pool = pool

    def register(self, buf):
        # ★ buf must be aligned to 4096 before ibv_reg_mr
        # see knowledge/rdma-mr-register.md
        assert buf.address % 4096 == 0, "buf not 4K aligned"
        return self.pool.register(buf)

    def lookup(self, key: bytes) -> Optional[bytes]:
        ...
`,
    "runtime/rdma_pool.py": `# rdma_pool.py
class RdmaPool:
    def __init__(self, size_mb: int):
        self.size = size_mb * 1024 * 1024

    def register(self, buf):
        ...
`,
    "docs/gateway-design.md": `# Gateway Design

KV cache 设计文档。

## Alignment 约束

ibv_reg_mr 要求 buffer 4K 对齐。
`,
    "README.md": `# loopey-runtime

Loopey 推理服务主仓。
`,
  },
}

// ----- mirror-llama-3: prod traffic mirror experiment -----

const mirrorDpsk: LoopWorkspace = {
  fileTree: [
    {
      kind: "folder",
      name: "deploy",
      children: [
        { kind: "file", name: "mirror-llama.yaml", path: "deploy/mirror-llama.yaml", modified: true },
        { kind: "file", name: "prod-llama.yaml", path: "deploy/prod-llama.yaml" },
      ],
    },
    {
      kind: "folder",
      name: "runtime",
      children: [{ kind: "file", name: "serve.py", path: "runtime/serve.py" }],
    },
    {
      kind: "folder",
      name: "monitor",
      children: [{ kind: "file", name: "sls_query.py", path: "monitor/sls_query.py" }],
    },
    { kind: "file", name: "README.md", path: "README.md" },
  ],
  fileContents: {
    "deploy/mirror-llama.yaml": `apiVersion: apps/v1
kind: Deployment
metadata:
  name: mirror-llama
spec:
  replicas: 2
  template:
    spec:
      containers:
      - name: serve
        image: serving:v4-pro-quant
        args:
          - "--port=8080"
          - "--warm-on-swap=true"
          - "--mirror-pct=10"
`,
    "monitor/sls_query.py": `# SLS metric query helper
import requests

def fetch_p99(env: str, window: str = "1h"):
    ...
`,
    "README.md": `# shadow-llama-3-70b

线上流量镜像，用于无影响验证 quant 模型。
`,
  },
}

// ----- llama-research: long-context research workspace -----

const llamaResearch: LoopWorkspace = {
  fileTree: [
    {
      kind: "folder",
      name: "knowledge",
      children: [
        { kind: "file", name: "llama-3-long-context.md", path: "knowledge/llama-3-long-context.md" },
        { kind: "file", name: "llama-3-attention.md", path: "knowledge/llama-3-attention.md" },
        { kind: "file", name: "llama-3-prefill-followups.md", path: "knowledge/llama-3-prefill-followups.md", modified: true },
      ],
    },
    {
      kind: "folder",
      name: "notebooks",
      children: [{ kind: "file", name: "needle-in-haystack.ipynb", path: "notebooks/needle-in-haystack.ipynb" }],
    },
    {
      kind: "folder",
      name: "traces",
      children: [{ kind: "file", name: "long_context_eval.json", path: "traces/long_context_eval.json" }],
    },
    { kind: "file", name: "README.md", path: "README.md" },
  ],
  fileContents: {
    "knowledge/llama-3-long-context.md": `# Llama-3 Long Context

> 由伊利丹整理，2026-05-04

## 关键发现

- **32k 长度内**: needle-in-haystack 95%+ recall，表现稳定
- **64k–128k**: attention IO 是瓶颈，GPU util 跌到 30-40%
- **超过 64k**: quality 缓慢下降，但 needle 任务仍可用

## 测试方法

- needle-in-haystack on official eval set
- mmlu-pro 长 context 变体
- 自建 RAG 检索任务

## 参考

- Llama-3 tech report (2026-04)
- "Lost in the Middle" 复现实验
`,
    "knowledge/llama-3-attention.md": `# Llama-3 Attention 实现

> 由伊利丹整理，2026-05-04

MLA (Multi-head Latent Attention) 把 KV cache 压缩成 latent vector，
减少 IO 量。

## 核心机制

- 每个 head 的 K/V 通过 latent projection 压缩
- 推理时只需读 latent，不必读 full K/V
- 理论上 IO 减少 5-8x

## 实测瓶颈

但在 64k+ 长度下，attention 自身计算 + latent 解压本身就 IO bound。
量化收益有限。
`,
    "knowledge/llama-3-prefill-followups.md": `# Llama-3 Prefill 优化方向

基于伊利丹的 attention 调研 + 今天的 trace 分析。

## 候选方向

1. **chunked prefill** —— 切 block 流水化，提高 GPU 利用率
2. **shared prefix cache** —— 同 prompt 前缀复用 KV cache
3. **flash-attention v3 + paged kv** —— 减少 IO round-trip

## 优先级

- #1 收益最大也最容易，下午先看
- #2 需要改 dispatcher，复杂
- #3 依赖 cuda 12.4+ 升级

## 关联 loop

- mirror-llama-3-70b (线上验证)
`,
    "README.md": `# llama_research

Llama-3 系列模型的研究 workspace。包含 long-context 评估、attention 实现、prefill 优化方向等。
`,
  },
}

// ----- knowledge-refine: ccx workspace, refining team docs -----

const knowledgeRefine: LoopWorkspace = {
  fileTree: [
    {
      kind: "folder",
      name: "docs",
      children: [
        {
          kind: "folder",
          name: "loopey",
          children: [
            {
              kind: "folder",
              name: "introduction",
              children: [{ kind: "file", name: "llm.md", path: "docs/loopey/introduction/llm.md", modified: true, staged: true }],
            },
            {
              kind: "folder",
              name: "sls",
              children: [{ kind: "file", name: "overview.md", path: "docs/loopey/sls/overview.md", staged: true }],
            },
            {
              kind: "folder",
              name: "runtime",
              children: [{ kind: "file", name: "quota.md", path: "docs/loopey/fleet/quota.md", staged: true }],
            },
            { kind: "file", name: "CLAUDE.md", path: "docs/loopey/CLAUDE.md", modified: true, staged: true },
          ],
        },
      ],
    },
    {
      kind: "folder",
      name: "_audit",
      children: [
        { kind: "file", name: "broken-links-2026-05-05.md", path: "_audit/broken-links-2026-05-05.md", modified: true },
      ],
    },
    { kind: "file", name: "README.md", path: "README.md" },
  ],
  fileContents: {
    "_audit/broken-links-2026-05-05.md": `# Broken internal links (after rename)

按 docs/loopey/ 重新分类后，扫到的内部 broken links：

- docs/loopey/introduction/llm.md L42 → \`[SLS](../sls-overview.md)\` (旧)
- docs/loopey/sls/overview.md L8 → \`[Fleet quota](../fleet-quota.md)\` (旧)
- docs/loopey/fleet/quota.md L31 → \`[introduction](../intro-llm.md)\` (旧)
- docs/loopey/modelboard/draft.md L19 → \`[SLS](../sls-overview.md)\` (旧)
`,
    "docs/loopey/CLAUDE.md": `# Loopey Knowledge Index

> 自动维护索引。reorg 后按主题分类。

## introduction/

- llm.md — LLM 介绍

## sls/

- overview.md — SLS 日志

## runtime/

- quota.md — Fleet 配额
`,
    "docs/loopey/introduction/llm.md": `# LLM 介绍

Loopey 提供的 LLM 模型清单和接入方式。

## SLS 集成

<!-- moved: ../sls-overview.md → ../sls/overview.md -->
日志通过 [SLS](../sls/overview.md) 上报。
`,
    "README.md": `# ccx

Context Complex —— 个人 + 团队的本地 AI 协作 workspace。
`,
  },
}

// ----- 1001-design: 1001 design workspace -----

const designLoop: LoopWorkspace = {
  fileTree: [
    { kind: "file", name: "1001-story.md", path: "1001-story.md" },
    { kind: "file", name: "1001-mvp.md", path: "1001-mvp.md" },
    {
      kind: "folder",
      name: "knowledge",
      children: [
        {
          kind: "folder",
          name: "ai-org",
          children: [
            { kind: "file", name: "1001-philosophy.md", path: "knowledge/ai-org/1001-philosophy.md", modified: true },
          ],
        },
      ],
    },
    {
      kind: "folder",
      name: "thoughts",
      children: [
        { kind: "file", name: "loop.md", path: "thoughts/loop.md" },
        { kind: "file", name: "system-shape.md", path: "thoughts/system-shape.md" },
      ],
    },
    {
      kind: "folder",
      name: "phase1-prototype",
      children: [{ kind: "file", name: "README.md", path: "phase1-prototype/README.md" }],
    },
  ],
  fileContents: {
    "knowledge/ai-org/1001-philosophy.md": `# 1001 Philosophy

## Driver = human

AI has no autonomous desire. The driver — the source of intent — must be human.

## Three scarce resources

人在 AI 时代贡献的三件事：

1. **驱动力** (drive) — 决定做什么 + 过程判断力
2. **注意力** (attention) — 主动选择什么重要
3. **熵减能力** (entropy reduction) — 把混乱整理成清晰

对应工具里三个一级概念：Loop / Focus / Context。
`,
    "1001-story.md": `# 1001 —— 当 AI 是同事，工作空间该长什么样

(详细文档放在仓库里，见 ../1001-story.md)
`,
    "1001-mvp.md": `# 1001 MVP 设计

(详细文档见 ../1001-mvp.md)
`,
    "thoughts/loop.md": `# loop 概念

loop = context + ai + workdir, 绑定一个 driver。
`,
  },
}

// ----- registry -----

export const LOOP_WORKSPACES: Record<string, LoopWorkspace> = {
  loopctl,
  "gateway-launch": gatewayLaunch,
  "mirror-llama-3": mirrorDpsk,
  "llama-research": llamaResearch,
  "knowledge-refine": knowledgeRefine,
  "1001-design": designLoop,
}

export const EMPTY_WORKSPACE: LoopWorkspace = {
  fileTree: [],
  fileContents: {},
}

export function getWorkspace(loopId: string): LoopWorkspace {
  return LOOP_WORKSPACES[loopId] ?? EMPTY_WORKSPACE
}
