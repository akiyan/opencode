import { describe, expect, test } from "bun:test"
import { ai } from "@opencode/ai/effect"
import { compileRequest } from "@opencode/ai/testing"
import { Credential } from "@opencode/core/credential"
import { Integration } from "@opencode/core/integration"
import { Model } from "@opencode/core/model"
import { ModelResolver } from "@opencode/core/model-resolver"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { ProviderPlugins } from "@opencode/core/plugin/provider"
import { SakuraAIEnginePlugin } from "@opencode/core/plugin/provider/sakura"
import { Provider } from "@opencode/core/provider"
import { Effect } from "effect"
import { Headers } from "effect/http"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)
const providerID = Provider.ID.make("sakura-ai-engine")
const integrationID = Integration.ID.make("sakura-ai-engine")
const accountToken = "00000000-0000-0000-0000-000000000000:secret"

const addPlugin = Effect.fn(function* () {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin, "test")
  yield* SakuraAIEnginePlugin.effect(host)
})

/** Adds the plugin and connects an account token, which is what makes the provider available at all. */
const connect = Effect.fn(function* () {
  const integrations = yield* Integration.Service
  yield* addPlugin()
  yield* integrations.connection.key({ integrationID, key: accountToken })
})

const model = (id: string) =>
  Effect.gen(function* () {
    const models = yield* Model.Service
    const found = yield* models.get(providerID, Model.ID.make(id))
    if (!found) return yield* Effect.die(new Error(`Missing catalog model ${id}`))
    return found
  })

const variants = (item: Model.Info) => item.variants.map((variant) => String(variant.id))

describe("SakuraAIEnginePlugin", () => {
  test("is registered so the bundled catalog is always applied", () => {
    expect(ProviderPlugins.map((item) => item.id)).toContain("opencode.provider.sakura.ai.engine")
  })

  it.effect("adds the provider with the endpoint, package, and token integration", () =>
    Effect.gen(function* () {
      const providers = yield* Provider.Service
      const integrations = yield* Integration.Service
      yield* addPlugin()

      expect(yield* providers.get(providerID)).toMatchObject({
        id: providerID,
        name: "Sakura AI Engine",
        // An account token decides availability, so the provider stays out of the list until one is connected.
        activation: "auto",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: "https://api.ai.sakura.ad.jp/v1", provider: providerID },
        integrationID,
      })
      expect((yield* integrations.get(integrationID))?.methods).toEqual([
        { type: "key", label: "Paste an account token" },
        { type: "env", names: ["SAKURA_AI_ENGINE_API_KEY"] },
      ])
    }),
  )

  it.effect("lists only the models that accept tool definitions", () =>
    Effect.gen(function* () {
      const models = yield* Model.Service
      yield* connect()

      expect((yield* models.all()).map((item) => String(item.id)).sort()).toEqual([
        "gpt-oss-120b",
        "preview/DeepSeek-V4.1-Flash-1017",
        "preview/GLM-5.3-Flash",
        "preview/Kimi-K2.7-Code",
        "preview/Qwen3.6-35B-A3B",
        "preview/gemma-4-31B-it",
      ])
    }),
  )

  it.effect("uses the published context, output, and vision limits", () =>
    Effect.gen(function* () {
      yield* connect()

      expect(yield* model("gpt-oss-120b")).toMatchObject({
        modelID: "gpt-oss-120b",
        package: "@opencode/ai/providers/openai-compatible",
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        limit: { context: 131_072, output: 32_000 },
      })
      // gpt-oss-120b ignores images instead of rejecting them, so it advertises text input only.
      expect((yield* model("preview/Kimi-K2.7-Code")).capabilities.input).toEqual(["text", "image"])
      expect(yield* model("preview/GLM-5.3-Flash")).toMatchObject({ limit: { context: 1_048_575 } })
      expect(yield* model("preview/Qwen3.6-35B-A3B")).toMatchObject({ limit: { context: 262_144 } })
    }),
  )

  it.effect("offers only the reasoning levels each model accepts", () =>
    Effect.gen(function* () {
      yield* connect()

      // `none` answers 400 on gpt-oss-120b, and Kimi writes reasoning into the answer when it is sent, so neither
      // offers an off switch. DeepSeek rejects `minimal` and `medium` but accepts `xhigh` and `max`.
      expect(variants(yield* model("gpt-oss-120b"))).toEqual(["low", "medium", "high"])
      expect(variants(yield* model("preview/DeepSeek-V4.1-Flash-1017"))).toEqual([
        "none",
        "low",
        "high",
        "xhigh",
        "max",
      ])
      expect(variants(yield* model("preview/GLM-5.3-Flash"))).toEqual(["low", "medium", "high"])
      expect(variants(yield* model("preview/Kimi-K2.7-Code"))).toEqual(["low", "medium", "high"])
      expect(variants(yield* model("preview/Qwen3.6-35B-A3B"))).toEqual(["none", "low", "medium", "high"])
      expect(variants(yield* model("preview/gemma-4-31B-it"))).toEqual(["none", "low", "medium", "high"])
    }),
  )

  it.effect("sends the output limit as max_tokens and the chosen effort as reasoning_effort", () =>
    Effect.gen(function* () {
      yield* connect()
      // The catalog already carries the provider's endpoint and compatibility, so resolving it from the catalog model
      // exercises the same merge the resolver performs for a session.
      const resolved = yield* ModelResolver.resolveModel(
        yield* model("gpt-oss-120b"),
        Model.VariantID.make("high"),
        Credential.Key.make({ type: "key", key: accountToken }),
      )
      const request = ai.request({ model: resolved, prompt: "Hello", maxTokens: 1_024 })
      const prepared = yield* compileRequest(request)
      const headers = yield* resolved.route.auth.apply({
        request,
        method: "POST",
        url: "https://api.ai.sakura.ad.jp/v1/chat/completions",
        body: "{}",
        headers: Headers.empty,
      })

      // The endpoint ignores `max_completion_tokens`, so the limit has to travel as `max_tokens`.
      expect(prepared.body).toMatchObject({ model: "gpt-oss-120b", max_tokens: 1_024, reasoning_effort: "high" })
      expect(prepared.body).not.toHaveProperty("max_completion_tokens")
      expect(prepared.route).toBe("openai-compatible-chat")
      expect(String(resolved.provider)).toBe("sakura-ai-engine")
      expect(resolved.route.endpoint.baseURL).toBe("https://api.ai.sakura.ad.jp/v1")
      expect(headers.authorization).toBe(`Bearer ${accountToken}`)
    }),
  )
})
