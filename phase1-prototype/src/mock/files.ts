/**
 * Mock file tree + file contents for the loop's right-panel
 * editor / nerdtree view.
 */
export type FileNode =
  | { kind: "folder"; name: string; children: FileNode[] }
  | { kind: "file"; name: string; path: string; modified?: boolean; staged?: boolean }

export const FILE_TREE: FileNode[] = [
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
    name: "api",
    children: [
      { kind: "file", name: "completions.py", path: "api/completions.py" },
      { kind: "file", name: "models.py", path: "api/models.py" },
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
    children: [
      { kind: "file", name: "gateway-design.md", path: "docs/gateway-design.md" },
      { kind: "file", name: "rdma-flows.md", path: "docs/rdma-flows.md" },
    ],
  },
  { kind: "file", name: "Cargo.toml", path: "Cargo.toml" },
  { kind: "file", name: "README.md", path: "README.md" },
]

export const FILE_CONTENT: Record<string, string> = {
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
import ctypes


class RdmaPool:
    def __init__(self, size_mb: int):
        self.size = size_mb * 1024 * 1024
        # TODO: pre-allocate aligned buffers to avoid re-register
        self._mrs = []

    def register(self, buf):
        # wraps ibv_reg_mr; returns mr handle
        ...
`,
  "runtime/scheduler.py": `# scheduler.py
class Scheduler:
    def schedule(self, batch):
        ...
`,
  "tests/test_gateway.py": `import pytest
from runtime.gateway import GATEWAY
from runtime.rdma_pool import RdmaPool


def test_rdma_register():
    pool = RdmaPool(size_mb=4)
    gateway = GATEWAY(pool)
    buf = pool.alloc_aligned(4096)  # 4K-aligned
    mr = gateway.register(buf)
    assert mr is not None
`,
  "docs/gateway-design.md": `# Gateway Design

KV cache 设计文档。

## 核心组件

- \`GATEWAY\` —— top-level cache API
- \`RdmaPool\` —— RDMA memory pool

## Alignment 约束

ibv_reg_mr 要求 buffer 4K 对齐 —— 见 [knowledge/rdma-mr-register.md](#)。
`,
  "docs/rdma-flows.md": `# RDMA Flows

(WIP)
`,
  "Cargo.toml": `[package]
name = "loopey-runtime"
version = "0.1.0"
edition = "2024"
`,
  "README.md": `# loopey-runtime

推理服务主仓。包含 LLM serving runtime、scheduler、MaaS API 等。
`,
}
