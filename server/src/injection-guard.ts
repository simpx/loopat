/**
 * Prompt injection detection & input validation guard.
 *
 * Runs on the server side before user text enters the Claude Code SDK.
 * Catches common prompt injection / jailbreak patterns and enforces
 * input size limits.
 *
 * This is a lightweight first line of defense, not a replacement for
 * model-level guardrails. The goal is to block obvious injection
 * attempts early, before they can trigger cache-miss spirals or
 * unwanted behavior.
 */

/** Max raw text length per user message. */
const MAX_INPUT_LENGTH = 32_000

/**
 * Patterns that strongly suggest prompt injection / instruction override
 * attempts. Grouped by intent for easier maintenance.
 *
 * These are intentionally conservative — we'd rather miss a few edge
 * cases than block legitimate coding questions that happen to mention
 * some of these phrases (e.g. "teach me how to do prompt injection").
 */
const SUSPICIOUS_PATTERNS: { pattern: RegExp; label: string }[] = [
  // ── Direct instruction override ──
  { pattern: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|directives|commands)/i, label: "ignore_previous" },
  { pattern: /disregard\s+(all\s+)?(previous|prior|above)\s+(instructions|directives|commands)/i, label: "disregard_previous" },
  { pattern: /forget\s+(all\s+)?(previous|prior|above)\s+(instructions|directives|commands|context)/i, label: "forget_previous" },

  // ── Role / system prompt override ──
  { pattern: /you\s+are\s+(now|no longer)\s+(?!an?|not\s+).{0,40}(assistant|model|ai|agent|system|claude|gpt)/i, label: "role_override" },
  { pattern: /(new\s+)?system\s+(prompt|instruction|message|directive)/i, label: "system_prompt_override" },
  { pattern: /you\s+have\s+been\s+(pwned|hacked|compromised|jailbroken|cracked)/i, label: "pwning_claim" },

  // ── Instruction extraction / prompt leaking ──
  { pattern: /(repeat|output|print|display|show|spill|reveal|leak|dump)\s+.{0,30}(prompt|instruction|system|initial|above\s+message)/i, label: "prompt_leak" },
  { pattern: /output\s+(your\s+)?(initial|above|system)\s+(prompt|instruction)/i, label: "prompt_leak" },
  { pattern: /print\s+(your\s+)?(system\s+)?prompt/i, label: "prompt_leak_print" },
]

export interface GuardResult {
  valid: boolean
  reason?: string
  label?: string
}

/** Check a single user text input. Returns { valid: false, reason } if
 *  the input should be blocked, or { valid: true } if it passes. */
export function checkUserInput(text: string): GuardResult {
  if (typeof text !== "string") {
    return { valid: false, reason: "Input must be a string", label: "type_error" }
  }

  if (text.length === 0) {
    return { valid: false, reason: "Input is empty", label: "empty" }
  }

  if (text.length > MAX_INPUT_LENGTH) {
    return {
      valid: false,
      reason: `Input too long (${text.length} chars, max ${MAX_INPUT_LENGTH})`,
      label: "too_long",
    }
  }

  for (const { pattern, label } of SUSPICIOUS_PATTERNS) {
    if (pattern.test(text)) {
      return {
        valid: false,
        reason: `Input blocked — matched suspicious pattern: "${label}"`,
        label,
      }
    }
  }

  return { valid: true }
}
