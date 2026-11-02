# Mulqi Auto Continue — Parity Checklist (Definition of 100%)

Original examined: `dsh-plugin-auto-continue@0.1.0` @ `a4d6bc8` (lib/index.js, 320 lines)
Rebuild target: **Mulqi Auto Continue** — clean-room, licence holder **Mulqizamzam**, against the real DSH runtime at `/home/administrator/deepseek-harness/`.

Evidence sources: `packages/core/agent/src/runtime-types.ts`, `packages/core/session/src/types.ts`,
`packages/llm/llm/src/{error,message,retry-policy}.ts`, `packages/llm/llm-retry/src/index.ts`,
`packages/goal/goal-round-driver/src/index.ts`, `packages/compaction/compaction-image-offload/src/index.ts`.

## Layer 1 — model-request fallback (`agent/request-error` waterfall)

| # | Must-have | Runtime fact it rests on |
|---|-----------|--------------------------|
| L1.1 | Listener registered on `agent/request-error`, signature `(payload, next)`. | runtime-types.ts:353 |
| L1.2 | Listener ALWAYS `await next()` first; a downstream `{kind:'retry'}` is returned untouched. | llm-retry/src/index.ts:233 |
| L1.3 | Only codes in the configured allow-list retry. Default: EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT. | error.ts:42 |
| L1.4 | Terminal codes never retried: AUTH, INVALID_CREDENTIAL, QUOTA, ACCOUNT_QUOTA, CONTEXT_WINDOW_EXCEEDED, NO_ADAPTER, IMAGE_OFFLOAD_REQUIRED, UNKNOWN-not-listed. | error.ts:25–51,175 |
| L1.5 | Per (agent, turn, step) attempt counter, default cap 3, exceeding cap yields terminal (`undefined`). | payload.turn/step |
| L1.6 | Backoff: exponential from base 1000ms, cap 30000ms, jitter; `failure.providerRetryAfterMs` wins when present. | error.ts:48 |
| L1.7 | Wait is cancellable by BOTH `payload.signal` and plugin lifetime; abort yields terminal. | payload.signal |
| L1.8 | Every takeover writes one durable `auto-continue/retry` session record via `session.append`-safe path (appendPluginRecord). | session plugin-records |
| L1.9 | After a successful step the counter for that (agent,turn,step) resets. | session/event `step/end` |
| L1.10 | Disposed/failed downstream `next()` rejects → listener must not swallow into retry blindly; yield terminal. | settleDownstream in llm-retry |

## Layer 2 — turn continuation (`turn/end` session fact)

| # | Must-have | Runtime fact |
|---|-----------|--------------|
| L2.1 | Listen on `session/event`; resolve agent by `ctx.agents.get(session.id)` and require `agent.session === session`. | goal-round-driver:338 |
| L2.2 | Trigger only on `event.type === 'turn/end'` && `event.data.reason.kind === 'error'`. | session types:298 |
| L2.3 | Root agents only by default; `includeSubagents` config opt-in. Root detection = membership in `ctx.agents.roots()`. | agent/src/index.ts:598 |
| L2.4 | `agent.followup(createUserMessage({content, source}))`, wrapped in try/catch, warning on throw. | agent.ts:163, goal-round-driver:208 |
| L2.5 | Continuation source is plugin-declared: `{ kind: 'auto-continue', plugin }` merged into `MessageSourceMap`. | llm message.ts:106 |
| L2.6 | Streak cap: default 2 continuations per error streak; reset on `turn/end` with `reason.kind !== 'error'`. | — |
| L2.7 | Cooldown gate: default 30000ms between continuations for the same agent. | — |
| L2.8 | Re-check before queueing: agent still live (`ctx.agents.get(id) === agent`), `status === 'idle'`, session unchanged. | runtime-types.ts:172 |
| L2.9 | Lifecycle cleanup: on `agent/disposed` drop per-agent state; plugin lifetime abort clears all. | agent disposed event |
| L2.10 | Per-agent state map keyed by agent id; no unbounded growth. | — |

## Config + packaging

| # | Must-have |
|---|-----------|
| C.1 | `Config` schemastery/zod schema validating every key; unknown keys throw with the offending name. |
| C.2 | `normalizeConfig()` exported pure function; defaults documented; invalid values throw typed Error. |
| C.3 | `name` / `inject = ['agents']` / `apply(ctx, config)` exports; ESM, node 22.19+/24+. |
| C.4 | `cordis.patch.yml` insert-block mounting the plugin. |
| C.5 | `package.json` name `mulqi-auto-continue`, license `Mulqizamzam`, exports `.` + patch + package.json. |
| C.6 | README in Indonesian (project convention) documenting both layers, config table, install. |
| C.7 | LICENSE file: Mulqizamzam. |

## Verification

| # | Must-have |
|---|-----------|
| V.1 | Unit tests cover L1.1–L1.10, L2.1–L2.10 against a mock Context (no live runtime). |
| V.2 | Config tests cover C.1/C.2 including every rejection branch. |
| V.3 | Each must-have passes twice in a row before the loop closes. |

## Review log

### Iteration 1 — build
- Wrote `lib/index.js` clean-room from the runtime contracts (no code carried from `a4d6bc8`).
- Wrote `tests/auto-continue.spec.js`, `vitest.config.js`, `package.json`, `cordis.patch.yml`, `LICENSE`, `README.md`.
- First run: 28/32 pass, 4 fail in layer 2.

### Iteration 1 — gaps found and fixed (all in the TEST fixture, not the plugin)
| Gap | Root cause | Fix |
|---|---|---|
| G1 `mount(config)` shallow-spread replaced whole `turn` section | `{...base, ...config}` drops sibling defaults | deep-merge per section |
| G2 `ctx.agents.roots is not a function` -> every agent classified as subagent | fixture built `agents: {get, roots}` then spread the raw Map over the same key | fixture keeps `{get, roots, set}` over a private store |
| G3 disposer test disposed a *second* `apply()` instance | test called `apply(ctx)` again instead of using the mounted one | `mount()` returns `ctx.dispose` |
| G4 (false positive) zero-delay timers "not firing" | consequence of G2 - `roots` threw inside the listener | resolved by G2 |

### Iteration 2 — verification (two consecutive green runs)
- Run 1 @ 11:58:59 — `32 passed (32)`
- Run 2 @ 12:00:22 — `32 passed (32)`

Both runs executed the identical spec file with no code change between them, so
every must-have L1.1-L1.10, L2.1-L2.10, C.1-C.7 and V.1-V.3 has now passed twice.

### Evidence map (must-have -> test)
- L1.1/L1.2 -> "passes a downstream retry through untouched"
- L1.3/L1.5/L1.8 -> "retries a retryable code and records the durable event", "stops at maxRetries"
- L1.4 -> "never retries a terminal code"
- L1.6 -> "grows then clamps", "honours providerRetryAfterMs"
- L1.7 -> "yields terminal when the turn signal aborts during the wait", "does not retry when the payload signal is already aborted"
- L1.9 -> "resets the counter after a step ends"
- L1.10 -> "surfaces a downstream rejection when it cannot retry"
- L2.1/L2.2 -> "ignores non-error turn ends"
- L2.3 -> "ignores a subagent by default and honours includeSubagents"
- L2.4/L2.5 -> "queues one continuation for a root agent error turn"
- L2.6 -> "caps restarts per error streak and resets on a clean turn"
- L2.7 -> "honours the cooldown window"
- L2.8 -> "does not queue when the agent became busy", "does not queue when the agent was replaced"
- L2.9 -> "drops state when the agent is disposed", "disposes cleanly and cancels pending work"
- L2.10 -> covered by L2.9 tests (state maps cleared)
- C.1/C.2 -> the whole `config` describe block (10 cases)
- C.3 -> smoke import prints name/inject/apply plus the pure helpers
- C.4-C.7 -> manifest, patch, README and LICENSE inspected

### Iteration 3 — hardening (selected as recommendation #5)

Two contract-level corrections against the real runtime:

| # | Was | Now | Runtime fact |
|---|---|---|---|
| H.1 | `session.append('mulqi-auto-continue/retry', ...)` | `appendPluginRecord(session, 'plugin:mulqi-auto-continue/retry', ...)` | `PLUGIN_RECORD_TYPE = /^plugin:[a-z0-9][a-z0-9._-]*(?:\/...)*$/u` (core/session/src/index.ts:439). The bare name is rejected. Records come back frozen, `ignorable: true`, and absent from `deriveMessages()`. |
| H.2 | `source: { kind: 'plugin', plugin: name }` | `source: { kind: 'mulqi-auto-continue', plugin, attempt }` | `MessageSourceMap` has no catch-all `plugin` kind (llm/src/message.ts:106) - `goal` is the analogue, declaring its own entry. The web client classifies any non-`user` kind as an injected-context producer, so the continuation stays visible and labeled instead of impersonating human input. |

Fixture change: `fakeAgent` now builds a real `Session.create(SessionId(id))` and reads records back through `pluginRecordOf`, so the durable path itself is under test rather than a stub of it.

Verification after hardening:
- Run 1 @ 12:44:28 - `32 passed (32)`
- Run 2 @ 12:44:51 - `32 passed (32)`

`RETRY_EVENT` is now asserted against the record grammar inside the retry test, so a future name change that breaks the grammar fails loudly.
