import { describe, expect, test } from "bun:test"

import type { ModelEntry, ProviderDisk } from "../src/api"

type ProviderDraftForTest = {
  models: ModelEntry[]
  baseUrl: string
  enabled: boolean
  apiKeyNewValue: string
  apiKeyStored: boolean
}

describe("provider order persistence", () => {
  test("serializes providers in explicit fallback order while keeping default first", async () => {
    const { buildProvidersDiskFromDraft } = await import("../src/pages/SettingsPage")

    const draft = {
      default: "beta/beta-model",
      providers: {
        alpha: {
          models: [{ id: "alpha-model" }],
          baseUrl: "https://alpha.example",
          enabled: true,
          apiKeyNewValue: "",
          apiKeyStored: true,
        },
        beta: {
          models: [{ id: "beta-model", maxContextTokens: 123 }],
          baseUrl: "https://beta.example",
          enabled: false,
          apiKeyNewValue: "",
          apiKeyStored: true,
        },
      } satisfies Record<string, ProviderDraftForTest>,
    }

    const providersOut = buildProvidersDiskFromDraft(draft, ["beta", "alpha", "missing"])

    expect(Object.keys(providersOut)).toEqual(["default", "beta", "alpha"])
    expect(providersOut.default).toBe("beta/beta-model")
    expect(providersOut.beta as ProviderDisk).toEqual({
      baseUrl: "https://beta.example",
      apiKey: "${BETA_API_KEY}",
      models: [{ id: "beta-model", maxContextTokens: 123 }],
      enabled: false,
    })
    expect(providersOut.alpha as ProviderDisk).toEqual({
      baseUrl: "https://alpha.example",
      apiKey: "${ALPHA_API_KEY}",
      models: [{ id: "alpha-model" }],
    })
  })
})
