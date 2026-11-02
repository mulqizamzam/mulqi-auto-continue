/**
 * Mulqi Auto Continue — automatically continue failed DeepSeek Harness
 * conversations.
 *
 * Two cooperating layers, both subordinate to the harness's own recovery
 * contract:
 *
 *   Layer 1 — model-request fallback (`agent/request-error` waterfall).
 *   The listener consults `next()` FIRST. Whatever a downstream handler
 *   (`dsh-llm-retry`, provider policies) decides wins untouched. This plugin
 *   only acts when the failure would otherwise become terminal, and then it
 *   keeps the SAME turn alive at the SAME step by returning `{ kind: 'retry' }`
 *   after a bounded, cancellable backoff.
 *
 *   Layer 2 — turn continuation (`turn/end` session fact). When a top-level
 *   turn still closes with `reason.kind === 'error'`, the plugin queues one
 *   visible continuation message through `agent.followup()` so a fresh turn
 *   resumes the work. Restarts are capped per error streak, cooldown-gated,
 *   and limited to root agents unless `turn.includeSubagents` is set.
 *
 * Everything the plugin does is recorded: layer 1 writes one durable
 * `mulqi-auto-continue/retry` session event before each wait, layer 2 logs the
 * continuation it queued.
 *
 * @module mulqi-auto-continue
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'

/** Package identity, also used as the plugin name in `cordis.patch.yml`. */
export const name = 'mulqi-auto-continue'

/** The only harness service this plugin consumes. */
export const inject = ['agents']

/**
 * Durable plugin-record type written before every layer-1 retry wait.
 *
 * The `plugin:` prefix and slash-separated segments are the harness's plugin
 * record grammar (`PLUGIN_RECORD_TYPE` in `@deepseek-ai/dsh-session`); a bare
 * `mulqi-auto-continue/retry` is rejected by `appendPluginRecord`.
 */
export const RETRY_EVENT = 'plugin:mulqi-auto-continue/retry'

/**
 * Failure codes worth a bounded fallback: transient transport/provider faults
 * that say nothing about the request's validity.
 */
export const DEFAULT_RETRYABLE_CODES = Object.freeze([
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
])

/**
 * Codes that must never be retried. They are terminal for a reason: retrying
 * burns budget without changing the outcome (bad credentials, exhausted quota,
 * an oversized request, a missing adapter).
 */
export const NEVER_RETRY_CODES = Object.freeze([
  'AUTH',
  'INVALID_CREDENTIAL',
  'QUOTA',
  'ACCOUNT_QUOTA',
  'CONTEXT_WINDOW_EXCEEDED',
  'NO_ADAPTER',
  'IMAGE_OFFLOAD_REQUIRED',
  'BAD_REQUEST',
  'CANCELED',
])

/** Message template placeholders a user may use in `turn.message`. */
const PLACEHOLDER = /\{(code|message|attempt)\}/g

/** Sanity bound on the failure text embedded in a continuation message. */
const MESSAGE_DETAIL_LIMIT = 200

/** Default continuation prompt; written in the project's operating language. */
const DEFAULT_TURN_MESSAGE =
  '[Mulqi Auto Continue] Sesi sebelumnya terputus karena galat ({code}). '
  + 'Lanjutkan dari titik terakhir: periksa dulu kondisi workspace dan hasil tool yang sudah ada, '
  + 'jangan mengulang pekerjaan yang sudah selesai, lalu selesaikan sisa tugasnya.'

/** Fully-resolved default option tree. */
export const DEFAULTS = Object.freeze({
  request: Object.freeze({
    enabled: true,
    maxRetries: 3,
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    codes: DEFAULT_RETRYABLE_CODES,
  }),
  turn: Object.freeze({
    enabled: true,
    maxRestarts: 2,
    delayMs: 2000,
    cooldownMs: 30000,
    includeSubagents: false,
    codes: null,
    message: DEFAULT_TURN_MESSAGE,
  }),
})

//#region config

function fail(message) {
  throw new Error(`${name}: ${message}`)
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be a plain object`)
  }
}

function assertNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) fail(`${label} must be a non-negative integer`)
}

function assertNonNegativeNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(`${label} must be a non-negative finite number`)
  }
}

function assertPositiveNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    fail(`${label} must be a positive finite number`)
  }
}

function assertBoolean(value, label) {
  if (typeof value !== 'boolean') fail(`${label} must be a boolean`)
}

function assertCodeList(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${label} must be a non-empty array of failure-code strings`)
  }
  for (const code of value) {
    if (typeof code !== 'string' || code.length === 0) {
      fail(`${label} must contain only non-empty strings`)
    }
    if (NEVER_RETRY_CODES.includes(code)) {
      fail(`${label} must not contain the terminal code "${code}"`)
    }
  }
  if (new Set(value).size !== value.length) fail(`${label} must not contain duplicates`)
}

/**
 * Merge one option section over its defaults, rejecting unknown keys so a
 * typo can never silently disable a safety net.
 * @param raw - the user's section, or undefined.
 * @param defaults - the resolved defaults for that section.
 * @param label - section name used in error messages.
 * @returns a fresh merged section.
 */
function mergeSection(raw, defaults, label) {
  if (raw === undefined) return { ...defaults }
  assertPlainObject(raw, label)
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(defaults, key)) fail(`unknown ${label} key "${key}"`)
  }
  return { ...defaults, ...raw }
}

/**
 * Validate user configuration and resolve every default.
 *
 * Pure: no side effects, no shared mutable state. A rejected configuration
 * throws with the offending key named.
 *
 * @param config - raw plugin configuration.
 * @returns the fully resolved `{ request, turn }` option tree.
 */
export function normalizeConfig(config = {}) {
  assertPlainObject(config, 'config')
  for (const key of Object.keys(config)) {
    if (key !== 'request' && key !== 'turn') fail(`unknown config key "${key}"`)
  }

  const request = mergeSection(config.request, DEFAULTS.request, 'request')
  assertBoolean(request.enabled, 'request.enabled')
  assertNonNegativeInteger(request.maxRetries, 'request.maxRetries')
  assertPositiveNumber(request.initialDelayMs, 'request.initialDelayMs')
  assertPositiveNumber(request.maxDelayMs, 'request.maxDelayMs')
  if (request.maxDelayMs < request.initialDelayMs) {
    fail('request.maxDelayMs must be greater than or equal to request.initialDelayMs')
  }
  assertCodeList(request.codes, 'request.codes')

  const turn = mergeSection(config.turn, DEFAULTS.turn, 'turn')
  assertBoolean(turn.enabled, 'turn.enabled')
  assertNonNegativeInteger(turn.maxRestarts, 'turn.maxRestarts')
  assertNonNegativeNumber(turn.delayMs, 'turn.delayMs')
  assertNonNegativeNumber(turn.cooldownMs, 'turn.cooldownMs')
  assertBoolean(turn.includeSubagents, 'turn.includeSubagents')
  if (typeof turn.message !== 'string' || turn.message.length === 0) {
    fail('turn.message must be a non-empty string')
  }
  if (turn.codes === null || turn.codes === undefined) {
    turn.codes = [...request.codes, 'UNKNOWN']
  }
  assertCodeList(turn.codes, 'turn.codes')

  return { request, turn }
}

//#endregion
//#region helpers

/**
 * Exponential backoff with symmetric 50% jitter, clamped to the ceiling.
 * @param options - resolved request options.
 * @param attempt - 1-based attempt number.
 * @returns delay in whole milliseconds.
 */
export function backoffDelay(options, attempt) {
  const exponent = Math.min(Math.max(attempt - 1, 0), 16)
  const ceiling = options.maxDelayMs
  const exponential = Math.min(options.initialDelayMs * 2 ** exponent, ceiling)
  const jitter = 0.75 + 0.5 * Math.random()
  return Math.min(Math.round(exponential * jitter), ceiling)
}

/**
 * Resolve the wait before one retry, preferring the provider's own hint.
 * @param options - resolved request options.
 * @param failure - the structured failure facts.
 * @param attempt - 1-based attempt number.
 * @returns delay in whole milliseconds.
 */
export function retryDelay(options, failure, attempt) {
  const hint = failure?.providerRetryAfterMs
  if (typeof hint === 'number' && Number.isFinite(hint) && hint > 0) {
    return Math.min(Math.round(hint), options.maxDelayMs)
  }
  return backoffDelay(options, attempt)
}

/**
 * Resolve after `delayMs`, or immediately-false when either signal aborts.
 * @param delayMs - how long to wait.
 * @param signal - the turn's abort signal.
 * @param lifetime - the plugin lifetime signal.
 * @returns true when the full wait elapsed.
 */
export function cancellableDelay(delayMs, signal, lifetime) {
  if (lifetime.aborted || signal?.aborted) return Promise.resolve(false)
  const fused = signal === undefined ? lifetime : AbortSignal.any([signal, lifetime])
  if (fused.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      fused.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    timer.unref?.()
    function onAbort() {
      clearTimeout(timer)
      resolve(true === false)
    }
    fused.addEventListener('abort', onAbort, { once: true })
  })
}

/** Render any thrown value as a one-line message. */
function renderThrown(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Fill the continuation template's placeholders.
 * @param template - the configured message.
 * @param facts - code, detail, and the 1-based continuation number.
 * @returns the rendered message.
 */
export function renderContinuation(template, { code, detail, attempt }) {
  const trimmed = typeof detail === 'string' && detail.length > MESSAGE_DETAIL_LIMIT
    ? `${detail.slice(0, MESSAGE_DETAIL_LIMIT - 1)}…`
    : (detail ?? '')
  return template
    .replaceAll('{code}', code)
    .replaceAll('{message}', trimmed)
    .replaceAll('{attempt}', String(attempt))
}

/** Normalize a possibly-missing failure into a routable code + message. */
function failureFacts(failure) {
  const code = typeof failure?.code === 'string' && failure.code.length > 0 ? failure.code : 'UNKNOWN'
  const message = typeof failure?.message === 'string' ? failure.message : ''
  return { code, message }
}

/**
 * Message-source kind this plugin declares for its own continuations.
 *
 * The harness has no shared catch-all `plugin` kind: each producer declares its
 * own entry in `MessageSourceMap` and consumers fall through unknown kinds.
 * `goal` is the closest analogue — a plugin-driven continuation round — and the
 * web client renders such a row as an injected-context producer labeled by its
 * durable kind, so a continuation stays visible and attributed without
 * pretending to be human input.
 *
 * @param attempt - 1-based continuation number within the error streak.
 * @returns the declared source attributed to this plugin.
 */
export function continuationSource(attempt) {
  return { kind: 'mulqi-auto-continue', plugin: name, attempt }
}

/**
 * Build the continuation user message for one restart.
 * @param text - rendered continuation text.
 * @param attempt - 1-based continuation number within the error streak.
 * @returns an immutable user message attributed to this plugin.
 */
function continuationMessage(text, attempt) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: continuationSource(attempt),
  })
}

//#endregion
//#region apply

/**
 * Install both continuation layers.
 *
 * The returned disposer (also registered as a context effect) aborts every
 * in-flight wait and clears all per-agent state, so unloading the fiber can
 * never leave a timer behind.
 *
 * @param ctx - the plugin context.
 * @param config - raw plugin configuration, validated here.
 * @returns an idempotent async disposer.
 */
export function apply(ctx, config = {}) {
  const options = normalizeConfig(config)
  const log = ctx.logger ?? console

  /** Layer-1 counters, keyed `${agentId}\0${turn}\0${step}`. */
  const retryCounters = new Map()
  /** Layer-2 streak state per agent id. */
  const streaks = new Map()
  /** Agents with a continuation already scheduled, mapped to their timer. */
  const pending = new Map()
  const lifetime = new AbortController()
  let disposed = false

  function clearAgent(agentId) {
    const prefix = `${agentId}\0`
    for (const key of retryCounters.keys()) {
      if (key.startsWith(prefix)) retryCounters.delete(key)
    }
    streaks.delete(agentId)
    const timer = pending.get(agentId)
    if (timer !== undefined) {
      clearTimeout(timer)
      pending.delete(agentId)
    }
  }

  async function dispose() {
    if (disposed) return
    disposed = true
    lifetime.abort(new Error(`${name}: plugin disposed`))
    for (const timer of pending.values()) clearTimeout(timer)
    pending.clear()
    streaks.clear()
    retryCounters.clear()
  }

  ctx.effect(() => dispose, `${name}: cancel waits and drop state`)

  //#region layer 1 — request-level fallback

  async function recover(payload, next) {
    let downstream
    let downstreamError
    try {
      downstream = await next()
    } catch (error) {
      downstreamError = error
    }

    // Pass-through preserves the downstream outcome exactly.
    const passThrough = () => {
      if (downstreamError !== undefined) throw downstreamError
      return downstream
    }

    if (downstream?.kind === 'retry') return downstream
    if (downstreamError !== undefined) {
      log.warn?.(`${name}: a downstream recovery listener failed; applying the fallback: ${renderThrown(downstreamError)}`)
    }
    if (!options.request.enabled || disposed || lifetime.signal.aborted) return passThrough()

    const { agent, turn, step, provider, failure, signal } = payload
    if (agent === undefined || signal?.aborted) return passThrough()

    const { code, message } = failureFacts(failure)
    if (!options.request.codes.includes(code)) return passThrough()

    const key = `${agent.id}\0${turn}\0${step}`
    const prior = retryCounters.get(key) ?? 0
    if (prior >= options.request.maxRetries) return passThrough()

    const attempt = prior + 1
    retryCounters.set(key, attempt)
    const delayMs = retryDelay(options.request, failure, attempt)

    try {
      // The plugin-record path types the event, freezes it, and keeps it off
      // the model-visible surface — unlike a raw `session.append`.
      appendPluginRecord(agent.session, RETRY_EVENT, {
        turn,
        step,
        provider,
        code,
        attempt,
        maxRetries: options.request.maxRetries,
        delayMs,
        failure: { code, message },
      })
    } catch (error) {
      log.warn?.(`${name}: could not record ${RETRY_EVENT}: ${renderThrown(error)}`)
    }
    log.info?.(
      `${name}: request failed (${code}) for agent "${agent.id}" turn ${turn} step ${step}; `
      + `continuing in ${delayMs}ms (attempt ${attempt}/${options.request.maxRetries})`,
    )

    if (!await cancellableDelay(delayMs, signal, lifetime.signal)) return passThrough()
    if (disposed) return passThrough()
    return { kind: 'retry' }
  }

  ctx.on('agent/request-error', (payload, next) => recover(payload, next))

  //#endregion
  //#region layer 2 — turn continuation

  /** Whether this agent may receive an automatic continuation. */
  function eligibleAgent(agent) {
    if (agent === undefined) return false
    if (options.turn.includeSubagents) return true
    const roots = ctx.agents.roots?.() ?? []
    return roots.some(root => root.id === agent.id)
  }

  function onTurnEnd(session, failure) {
    if (!options.turn.enabled || disposed || lifetime.signal.aborted) return
    const sessionId = session.id
    const agent = ctx.agents.get?.(sessionId)
    if (agent === undefined || agent.session !== session) return
    if (!eligibleAgent(agent)) return
    if (agent.status !== 'idle') return
    if (pending.has(sessionId)) return

    const state = streaks.get(sessionId) ?? { restarts: 0, lastAt: 0 }
    if (state.restarts >= options.turn.maxRestarts) return

    const now = Date.now()
    if (state.lastAt !== 0 && now - state.lastAt < options.turn.cooldownMs) {
      log.info?.(`${name}: agent "${sessionId}" is inside its continuation cooldown; leaving the turn closed`)
      return
    }

    const { code, message } = failureFacts(failure)
    if (!options.turn.codes.includes(code)) return

    const restarts = state.restarts + 1
    streaks.set(sessionId, { restarts, lastAt: now })

    const text = renderContinuation(options.turn.message, { code, detail: message, attempt: restarts })
    const timer = setTimeout(() => {
      pending.delete(sessionId)
      if (disposed || lifetime.signal.aborted) return
      // The agent may have been replaced, detached, or woken again while we waited.
      if (ctx.agents.get?.(sessionId) !== agent) return
      if (agent.status !== 'idle') return
      try {
        agent.followup(continuationMessage(text, restarts))
        log.info?.(
          `${name}: continued agent "${sessionId}" after a failed turn (${code}); `
          + `continuation ${restarts}/${options.turn.maxRestarts}`,
        )
      } catch (error) {
        log.warn?.(`${name}: could not queue a continuation for "${sessionId}": ${renderThrown(error)}`)
      }
    }, options.turn.delayMs)
    timer.unref?.()
    pending.set(sessionId, timer)
  }

  ctx.on('session/event', (session, event) => {
    try {
      const type = event?.type
      if (type === 'turn/end') {
        const reason = event.data?.reason
        if (reason?.kind === 'completed') {
          streaks.delete(session.id)
          clearAgent(session.id)
          return
        }
        if (reason?.kind !== 'error') return
        onTurnEnd(session, reason.error)
        return
      }
      if (type === 'step/end') {
        const { turn, step } = event.data ?? {}
        retryCounters.delete(`${session.id}\0${turn}\0${step}`)
      }
    } catch (error) {
      log.warn?.(`${name}: session-event observer failed: ${renderThrown(error)}`)
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    if (agent?.id !== undefined) clearAgent(agent.id)
  })

  //#endregion

  return dispose
}

//#endregion
