import share from "./stats-icons/share.svg?url"
import gauge from "./stats-icons/gauge.svg?url"
import database from "./stats-icons/database.svg?url"
import "./stats.css"
import { useQuery } from "@tanstack/solid-query"
import { createMemo, Show } from "solid-js"
import { getFilename } from "@opencode/util/path"
import { TokenUsage } from "@opencode/schema/token-usage"
import { useLanguage } from "@/runtime/i18n/language"
import { useData } from "@/runtime/server/current"
import { useServerSDK } from "@/runtime/server/client"

/** Session-wide metrics stay outside the editor so they never become prompt content. */
export function SessionComposerStats(props: { sessionID?: string; directory?: string }) {
  const language = useLanguage()
  const data = useData()
  const server = useServerSDK()
  const info = createMemo(() => (props.sessionID ? data.session.get(props.sessionID) : undefined))
  const directory = () => info()?.location.directory ?? props.directory ?? ""
  const vcs = createMemo(() => {
    const location = directory() ? { directory: directory() } : undefined
    return location ? data.location.vcs.info(location) : undefined
  })
  const stats = useQuery(() => ({
    queryKey: [server.url, props.sessionID, "composer-stats", info()?.time.idle],
    queryFn: () => server.api.session.composerStats({ sessionID: props.sessionID ?? "" }),
    enabled: !!info() && server.connection.status() === "connected",
    refetchInterval: props.sessionID && data.session.status(props.sessionID) === "running" ? 5_000 : 30_000,
    retry: false,
  }))
  const repository = () => vcs()?.repository ?? getFilename(directory())
  const branch = () => vcs()?.branch.current
  const input = () => {
    const tokens = info()?.tokens
    return tokens ? tokens.input + tokens.cache.read + tokens.cache.write : 0
  }
  const cache = () => {
    if (input() === 0) return "—"
    const percent = ((info()?.tokens.cache.read ?? 0) / input()) * 100
    return `${percent < 100 && percent >= 99.5 ? percent.toFixed(1).replace(/100\.0/, "99.9") : Math.round(percent)}%`
  }
  const total = () => {
    const tokens = info()?.tokens
    if (!tokens) return props.sessionID ? "—" : "0"
    const value = TokenUsage.total(tokens)
    if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`
    if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}K`
    return String(value)
  }
  const activity = () =>
    !props.sessionID ? { turns: 0, steps: 0, tokensPerSecond: null } : stats.isError ? undefined : stats.data

  return (
    <div data-component="session-composer-stats">
      <div class="composer-stats-location" dir="ltr">
        <span class="composer-stats-icon" style={{ "mask-image": `url("${share}")` }} aria-hidden="true" />
        <div class="composer-stats-location-text">
          <span class="truncate" title={`${repository()}${branch() ? `:${branch()}` : ""}`}>
            {repository()}
            <Show when={branch()}>{(name) => <>:{name()}</>}</Show>
          </span>
          <span aria-hidden="true">·</span>
          <span class="truncate" title={directory()}>
            {directory()}
          </span>
        </div>
      </div>
      <div class="composer-stats-metrics">
        <div class="composer-stats-group" title={language.t("session.stats.activityDescription")}>
          <span class="composer-stats-icon" style={{ "mask-image": `url("${gauge}")` }} aria-hidden="true" />
          <div class="composer-stats-values">
            <Show when={activity()} fallback={<span>—</span>}>
              {(value) => (
                <>
                  <span>{language.plural("session.stats.turns", value().turns)}</span>
                  <span>{language.plural("session.stats.steps", value().steps)}</span>
                </>
              )}
            </Show>
            <span aria-hidden="true">·</span>
            <span title={language.t("session.stats.speedDescription")}>
              {language.t("session.stats.speed", {
                value: activity()?.tokensPerSecond == null ? "—" : Math.round(activity()!.tokensPerSecond!),
              })}
            </span>
          </div>
        </div>
        <div class="composer-stats-group" title={language.t("session.stats.usageDescription")}>
          <span class="composer-stats-icon" style={{ "mask-image": `url("${database}")` }} aria-hidden="true" />
          <div class="composer-stats-values">
            <span>{language.t("session.stats.tokens", { value: total() })}</span>
            <span aria-hidden="true">·</span>
            <span>{language.t("session.stats.cache", { value: cache() })}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
