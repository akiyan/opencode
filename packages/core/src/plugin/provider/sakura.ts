import { define } from "@opencode/plugin/effect/plugin"
import { Money } from "@opencode/schema/money"
import { Effect } from "effect"
import { Integration } from "../../integration.js"
import { Model } from "../../model.js"
import { Provider } from "../../provider.js"
import { Variant } from "../../variant.js"
import type { PluginInternal } from "../internal.js"

const providerID = Provider.ID.make("sakura-ai-engine")
const integrationID = Integration.ID.make("sakura-ai-engine")
const baseURL = "https://api.ai.sakura.ad.jp/v1"
const providerPackage = "@opencode/ai/providers/openai-compatible"

type ChatModel = {
  readonly id: string
  readonly name: string
  readonly family: string
  readonly context: number
  /** `reasoning_effort` values the endpoint accepts for this model, in the order OpenCode lists them. */
  readonly efforts: readonly string[]
  readonly vision?: boolean
}

/**
 * Sakura AI Engine (さくらのAI Engine) chat models, from its published chat-model specification
 * (https://manual.sakura.ad.jp/cloud/ai-engine/chat-models.html). Only models that accept `tools` are listed, because
 * every agent request carries tool definitions and the endpoint rejects `tools` on the others with HTTP 400, which
 * leaves out llm-jp, Phi-4-mini, Qwen3-0.6B and Qwen3-VL.
 *
 * `efforts` is what the endpoint accepts, not what it documents: `gpt-oss-120b` answers 400 for `none`, Kimi mixes its
 * reasoning into the answer when asked for `none`, and GLM keeps reasoning when asked for it, so none of them offer an
 * off switch. DeepSeek rejects `minimal` and `medium` but accepts `xhigh` and `max`.
 *
 * Every model caps output at 32,000 tokens and the endpoint rejects a request whose input plus `max_tokens` exceeds the
 * context window, so `max_tokens` — never `max_completion_tokens`, which it ignores — carries the limit.
 */
const chatModels: readonly ChatModel[] = [
  { id: "gpt-oss-120b", name: "GPT-OSS 120B", family: "gpt-oss", context: 131_072, efforts: ["low", "medium", "high"] },
  {
    id: "preview/DeepSeek-V4.1-Flash-1017",
    name: "DeepSeek V4.1 Flash (preview)",
    family: "deepseek",
    context: 1_048_575,
    efforts: ["none", "low", "high", "xhigh", "max"],
    vision: true,
  },
  {
    id: "preview/GLM-5.3-Flash",
    name: "GLM 5.3 Flash (preview)",
    family: "glm",
    context: 1_048_575,
    efforts: ["low", "medium", "high"],
    vision: true,
  },
  {
    id: "preview/Kimi-K2.7-Code",
    name: "Kimi K2.7 Code (preview)",
    family: "kimi",
    context: 262_144,
    efforts: ["low", "medium", "high"],
    vision: true,
  },
  {
    id: "preview/Qwen3.6-35B-A3B",
    name: "Qwen3.6 35B A3B (preview)",
    family: "qwen",
    context: 262_144,
    efforts: ["none", "low", "medium", "high"],
    vision: true,
  },
  {
    id: "preview/gemma-4-31B-it",
    name: "Gemma 4 31B (preview)",
    family: "gemma",
    context: 262_144,
    efforts: ["none", "low", "medium", "high"],
    vision: true,
  },
]

const output = 32_000
const zero = Money.USDPerMillionTokens.zero

const models: readonly Model.Info[] = chatModels.map((item) => {
  const model = {
    id: Model.ID.make(item.id),
    modelID: Model.ID.make(item.id),
    providerID,
    package: providerPackage,
    name: item.name,
    family: Model.Family.make(item.family),
    capabilities: {
      tools: true,
      input: ["text", ...(item.vision ? ["image"] : [])],
      output: ["text"],
      temperature: true,
    },
    variants: [],
    // The manual publishes no release dates and points at its service site for pricing, which opencode has no
    // catalog for, so models today carry no price and start at the earliest release time.
    time: { released: 0 },
    cost: [{ input: zero, output: zero, cache: { read: zero, write: zero } }],
    status: "active" as const,
    enabled: true,
    limit: { context: item.context, output },
  } satisfies Model.Info
  return {
    ...model,
    variants: Variant.resolve(model, Variant.supports({ supported: true, effort: [...item.efforts] })),
  }
})

export const SakuraAIEnginePlugin = define({
  id: "opencode.provider.sakura.ai.engine",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.integration.transform((integrations) => {
      integrations.update(integrationID, (integration) => {
        integration.name = "Sakura AI Engine"
      })
      integrations.method.update({ integrationID, method: { type: "key", label: "Paste an account token" } })
      // The account token is sent as the bearer token unchanged: `<UUID>:<secret>` is the credential's own format.
      integrations.method.update({ integrationID, method: { type: "env", names: ["SAKURA_AI_ENGINE_API_KEY"] } })
    })
    yield* ctx.provider.transform((providers) => {
      providers.add({
        info: {
          id: providerID,
          integrationID,
          name: "Sakura AI Engine",
          // An account token is required, so the provider becomes available once one is connected or the
          // environment variable is set.
          activation: "auto",
          package: providerPackage,
          settings: { baseURL, provider: providerID },
          // The endpoint honors `max_tokens` and ignores `max_completion_tokens`, and it never requires reasoning to be
          // replayed, which keeps `preview/DeepSeek-V4.1-Flash-1017` from tripping the model-name inference.
          compatibility: { maxTokensField: "max_tokens", requireReasoning: false },
        },
        models,
      })
    })
  }),
} satisfies PluginInternal.InternalPlugin)
