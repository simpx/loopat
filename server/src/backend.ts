/**
 * Backend abstraction layer for loopat.
 *
 * Defines a common interface for AI agent backends (Claude Code SDK, pi-agent, etc.)
 * so that LoopSession can delegate to any backend without knowing the internals.
 */

import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"

/** The backend type identifier. */
export type BackendType = "claude-code" | "pi-agent"

/** Options passed to a backend when starting a session. */
export interface BackendStartOptions {
  loopId: string
  cwd: string
  /** Merged environment variables for the backend process. */
  env: Record<string, string>
  /** System prompt append text. */
  systemPromptAppend?: string
  /** MCP servers config (backend-specific shape). */
  mcpServers?: Record<string, any>
  /** Whether to continue an existing session. */
  continue?: boolean
  /** Permission mode. */
  permissionMode?: string
  /** Model override. */
  model?: string
  /** Backend-specific config from loop meta. */
  backendConfig?: Record<string, any>
}

/**
 * Common interface that all backends must implement.
 *
 * Backends translate between loopat's message protocol (SDKMessage/SDKUserMessage)
 * and their native agent protocol. The LoopSession class uses this interface
 * without knowing which backend is active.
 */
export interface BackendAdapter {
  /** The backend type. */
  readonly type: BackendType

  /**
   * Start or resume the backend session.
   * Returns an async iterable of messages from the AI agent.
   */
  start(opts: BackendStartOptions): AsyncIterable<SDKMessage>

  /**
   * Send a user message to the running backend.
   */
  sendUserMessage(msg: SDKUserMessage): void

  /**
   * Interrupt the current generation.
   */
  interrupt(): Promise<void>

  /**
   * Check if the backend is currently generating a response.
   */
  isGenerating(): boolean

  /**
   * Tear down the backend session and release resources.
   */
  destroy(): Promise<void>

  /**
   * Get the current permission mode (if supported).
   */
  setPermissionMode?(mode: string): Promise<void>

  /**
   * Set max thinking tokens (if supported).
   */
  setMaxThinkingTokens?(tokens: number | null): Promise<void>

  /**
   * Get context usage (if supported).
   */
  getContextUsage?(): Promise<any>
}
