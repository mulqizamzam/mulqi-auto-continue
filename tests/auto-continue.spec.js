import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Session, SessionId, pluginRecordOf } from '@deepseek-ai/dsh-session'
import {
  apply, normalizeConfig, backoffDelay, retryDelay, renderContinuation,
  DEFAULTS, RETRY_EVENT, NEVER_RETRY_CODES, continuationSource,
} from '../lib/index.js'

/** Minimal fake Context capturing registered listeners and effects. */
function fakeContext() {
  const listeners = new Map()
  const effects = []
  const roots = []
  const store = new Map()
  const logger = { info: vi.fn(), warn: vi.fn() }
  return {
    logger,
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {}
    },
    effect(fn) { effects.push(fn); return () => {} },
    // The real agents service is get(id) / roots(); `set` is a test-only
    // convenience over the same backing store.
    agents: {
      get: (id) => store.get(id),
      roots: () => roots,
      set: (id, agent) => store.set(id, agent),
    },
    emit(event, ...args) {
      for (const handler of listeners.get(event) ?? []) handler(...args)
    },
    listenerCount(event) { return (listeners.get(event) ?? []).length },
    roots, effects, logger, listeners,
  }
}

function fakeAgent(id, { status = 'idle' } = {}) {
  // A real Session, not a stub: appendPluginRecord commits through the
  // session's own path, so a stub would only ever test the stub.
  const session = Session.create(SessionId(id))
  return {
    id, status, session,
    followup: vi.fn(),
    /** Committed plugin records, oldest first. */
    records() {
      return session.snapshotEvents().map(pluginRecordOf).filter(record => record !== undefined)
    },
  }
}

const okFailure = { code: 'SERVER', message: 'boom' }

describe('config', () => {
  it('resolves defaults', () => {
    const cfg = normalizeConfig()
    expect(cfg.request.maxRetries).toBe(3)
    expect(cfg.request.initialDelayMs).toBe(1000)
    expect(cfg.request.maxDelayMs).toBe(30000)
    expect(cfg.request.codes).toEqual(DEFAULTS.request.codes)
    expect(cfg.turn.maxRestarts).toBe(2)
    expect(cfg.turn.cooldownMs).toBe(30000)
    expect(cfg.turn.includeSubagents).toBe(false)
    expect(cfg.turn.codes).toEqual([...DEFAULTS.request.codes, 'UNKNOWN'])
  })

  it('rejects unknown top-level key', () => {
    expect(() => normalizeConfig({ nope: 1 })).toThrow(/unknown config key "nope"/)
  })

  it('rejects unknown section key', () => {
    expect(() => normalizeConfig({ request: { nope: 1 } })).toThrow(/unknown request key "nope"/)
  })

  it('rejects terminal codes in the allow-list', () => {
    expect(() => normalizeConfig({ request: { codes: ['AUTH'] } })).toThrow(/terminal code/)
  })

  it('rejects duplicate codes', () => {
    expect(() => normalizeConfig({ request: { codes: ['SERVER', 'SERVER'] } })).toThrow(/duplicates/)
  })

  it('rejects empty codes', () => {
    expect(() => normalizeConfig({ request: { codes: [] } })).toThrow(/non-empty array/)
  })

  it('rejects maxDelay below initialDelay', () => {
    expect(() => normalizeConfig({ request: { initialDelayMs: 5000, maxDelayMs: 1000 } }))
      .toThrow(/maxDelayMs/)
  })

  it('rejects negative maxRetries', () => {
    expect(() => normalizeConfig({ request: { maxRetries: -1 } })).toThrow(/non-negative integer/)
  })

  it('rejects empty continuation message', () => {
    expect(() => normalizeConfig({ turn: { message: '' } })).toThrow(/non-empty string/)
  })

  it('rejects non-object config', () => {
    expect(() => normalizeConfig(null)).toThrow(/plain object/)
    expect(() => normalizeConfig([])).toThrow(/plain object/)
  })
})

describe('backoff', () => {
  it('grows then clamps', () => {
    const opts = { initialDelayMs: 1000, maxDelayMs: 30000 }
    for (let attempt = 1; attempt <= 10; attempt++) {
      const d = backoffDelay(opts, attempt)
      expect(d).toBeGreaterThan(0)
      expect(d).toBeLessThanOrEqual(30000)
    }
  })

  it('honours providerRetryAfterMs', () => {
    const opts = { initialDelayMs: 1000, maxDelayMs: 30000 }
    expect(retryDelay(opts, { providerRetryAfterMs: 42 }, 1)).toBe(42)
    expect(retryDelay(opts, { providerRetryAfterMs: 999999 }, 1)).toBe(30000)
  })
})

describe('renderContinuation', () => {
  it('fills placeholders and truncates detail', () => {
    const text = renderContinuation('code={code} attempt={attempt} msg={message}', {
      code: 'SERVER', detail: 'x'.repeat(400), attempt: 2,
    })
    expect(text).toContain('code=SERVER')
    expect(text).toContain('attempt=2')
    expect(text.length).toBeLessThan(400)
  })
})

describe('layer 1 — request-error waterfall', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function mount(config = {}) {
    const ctx = fakeContext()
    apply(ctx, {
      request: { initialDelayMs: 1, maxDelayMs: 5, ...config.request },
      turn: { delayMs: 0, ...config.turn },
    })
    return ctx
  }

  async function runWaterfall(ctx, payload, nextImpl = async () => undefined) {
    const handler = ctx.listeners.get('agent/request-error')[0]
    const promise = handler(payload, nextImpl)
    await vi.runAllTimersAsync()
    return promise
  }

  it('passes a downstream retry through untouched', async () => {
    const ctx = mount()
    const agent = fakeAgent('a1')
    const next = vi.fn(async () => ({ kind: 'retry' }))
    const result = await runWaterfall(ctx, { agent, turn: 1, step: 1, provider: 'p', failure: okFailure, signal: new AbortController().signal }, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ kind: 'retry' })
    expect(agent.records()).toHaveLength(0)
  })

  it('retries a retryable code and records the durable event', async () => {
    const ctx = mount()
    const agent = fakeAgent('a1')
    const result = await runWaterfall(ctx, { agent, turn: 1, step: 1, provider: 'p', failure: okFailure, signal: new AbortController().signal })
    expect(result).toEqual({ kind: 'retry' })
    const records = agent.records()
    expect(records).toHaveLength(1)
    expect(records[0].type).toBe(RETRY_EVENT)
    expect(records[0].type).toMatch(/^plugin:[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/)
    expect(records[0].data.code).toBe('SERVER')
    expect(records[0].data.attempt).toBe(1)
    // Bookkeeping, not dialogue: the record stays off the model-visible surface.
    expect(agent.session.deriveMessages()).toHaveLength(0)
  })

  it('never retries a terminal code', async () => {
    const ctx = mount()
    const agent = fakeAgent('a1')
    const result = await runWaterfall(ctx, {
      agent, turn: 1, step: 1, provider: 'p',
      failure: { code: 'AUTH', message: 'bad' }, signal: new AbortController().signal,
    })
    expect(result).toBeUndefined()
    expect(agent.records()).toHaveLength(0)
  })

  it('stops at maxRetries', async () => {
    const ctx = mount({ request: { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 5 } })
    const agent = fakeAgent('a1')
    const payload = { agent, turn: 1, step: 1, provider: 'p', failure: okFailure, signal: new AbortController().signal }
    expect(await runWaterfall(ctx, payload)).toEqual({ kind: 'retry' })
    expect(await runWaterfall(ctx, payload)).toEqual({ kind: 'retry' })
    expect(await runWaterfall(ctx, payload)).toBeUndefined()
    expect(agent.records()).toHaveLength(2)
  })

  it('resets the counter after a step ends', async () => {
    const ctx = mount()
    const agent = fakeAgent('a1')
    const payload = { agent, turn: 1, step: 1, provider: 'p', failure: okFailure, signal: new AbortController().signal }
    await runWaterfall(ctx, payload)
    ctx.emit('session/event', agent.session, { type: 'step/end', data: { turn: 1, step: 1 } })
    await runWaterfall(ctx, payload)
    expect(agent.records()).toHaveLength(2)
  })

  it('yields terminal when the turn signal aborts during the wait', async () => {
    const ctx = mount({ request: { initialDelayMs: 1000, maxDelayMs: 5000 } })
    const agent = fakeAgent('a1')
    const controller = new AbortController()
    const handler = ctx.listeners.get('agent/request-error')[0]
    const promise = handler({ agent, turn: 1, step: 1, provider: 'p', failure: okFailure, signal: controller.signal }, async () => undefined)
    await vi.advanceTimersByTimeAsync(10)
    controller.abort()
    await vi.runAllTimersAsync()
    expect(await promise).toBeUndefined()
  })

  it('does not retry when the payload signal is already aborted', async () => {
    const ctx = mount()
    const agent = fakeAgent('a1')
    const controller = new AbortController()
    controller.abort()
    const result = await runWaterfall(ctx, { agent, turn: 1, step: 1, provider: 'p', failure: okFailure, signal: controller.signal })
    expect(result).toBeUndefined()
  })

  it('surfaces a downstream rejection when it cannot retry', async () => {
    const ctx = mount()
    const agent = fakeAgent('a1')
    const boom = new Error('downstream')
    const handler = ctx.listeners.get('agent/request-error')[0]
    await expect(handler({ agent, turn: 1, step: 1, provider: 'p', failure: { code: 'AUTH', message: 'no' }, signal: new AbortController().signal }, async () => { throw boom }))
      .rejects.toThrow('downstream')
  })

  it('reports an unreachable failure code as terminal', async () => {
    const ctx = mount()
    const agent = fakeAgent('a1')
    const result = await runWaterfall(ctx, { agent, turn: 1, step: 1, provider: 'p', failure: { code: 'NOPE', message: '' }, signal: new AbortController().signal })
    expect(result).toBeUndefined()
  })
})

describe('layer 2 — turn continuation', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function mount(config = {}) {
    const ctx = fakeContext()
    ctx.dispose = apply(ctx, {
      request: { initialDelayMs: 1, maxDelayMs: 5, ...config.request },
      turn: { delayMs: 10, cooldownMs: 0, ...config.turn },
    })
    return ctx
  }

  function turnEnd(ctx, session, error = { code: 'SERVER', message: 'x' }) {
    ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error } } })
  }

  it('queues one continuation for a root agent error turn', async () => {
    const ctx = mount()
    const agent = fakeAgent('s1')
    ctx.agents.set('s1', agent)
    ctx.roots.push(agent)
    turnEnd(ctx, agent.session)
    await vi.runAllTimersAsync()
    expect(agent.followup).toHaveBeenCalledTimes(1)
    const message = agent.followup.mock.calls[0][0]
    expect(message.role).toBe('user')
    expect(message.source).toEqual(continuationSource(1))
    expect(message.source.kind).toBe('mulqi-auto-continue')
    expect(message.source.plugin).toBe('mulqi-auto-continue')
    expect(message.content[0].text).toContain('SERVER')
  })

  it('ignores a subagent by default and honours includeSubagents', async () => {
    const ctx = mount()
    const agent = fakeAgent('s1')
    ctx.agents.set('s1', agent)
    turnEnd(ctx, agent.session)
    await vi.runAllTimersAsync()
    expect(agent.followup).not.toHaveBeenCalled()

    const ctx2 = mount({ turn: { delayMs: 10, cooldownMs: 0, includeSubagents: true } })
    const agent2 = fakeAgent('s2')
    ctx2.agents.set('s2', agent2)
    turnEnd(ctx2, agent2.session)
    await vi.runAllTimersAsync()
    expect(agent2.followup).toHaveBeenCalledTimes(1)
  })

  it('ignores non-error turn ends', async () => {
    const ctx = mount()
    const agent = fakeAgent('s1')
    ctx.agents.set('s1', agent)
    ctx.roots.push(agent)
    ctx.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await vi.runAllTimersAsync()
    expect(agent.followup).not.toHaveBeenCalled()
  })

  it('caps restarts per error streak and resets on a clean turn', async () => {
    const ctx = mount({ turn: { delayMs: 0, cooldownMs: 0, maxRestarts: 1 } })
    const agent = fakeAgent('s1')
    ctx.agents.set('s1', agent)
    ctx.roots.push(agent)
    turnEnd(ctx, agent.session)
    await vi.runAllTimersAsync()
    expect(agent.followup).toHaveBeenCalledTimes(1)
    turnEnd(ctx, agent.session)
    await vi.runAllTimersAsync()
    expect(agent.followup).toHaveBeenCalledTimes(1)

    ctx.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    turnEnd(ctx, agent.session)
    await vi.runAllTimersAsync()
    expect(agent.followup).toHaveBeenCalledTimes(2)
  })

  it('honours the cooldown window', async () => {
    const ctx = mount({ turn: { delayMs: 0, cooldownMs: 60000, maxRestarts: 5 } })
    const agent = fakeAgent('s1')
    ctx.agents.set('s1', agent)
    ctx.roots.push(agent)
    turnEnd(ctx, agent.session)
    await vi.runAllTimersAsync()
    expect(agent.followup).toHaveBeenCalledTimes(1)
    turnEnd(ctx, agent.session)
    await vi.runAllTimersAsync()
    expect(agent.followup).toHaveBeenCalledTimes(1)
  })

  it('does not queue when the agent became busy', async () => {
    const ctx = mount()
    const agent = fakeAgent('s1')
    ctx.agents.set('s1', agent)
    ctx.roots.push(agent)
    turnEnd(ctx, agent.session)
    agent.status = 'running'
    await vi.runAllTimersAsync()
    expect(agent.followup).not.toHaveBeenCalled()
  })

  it('does not queue when the agent was replaced', async () => {
    const ctx = mount()
    const agent = fakeAgent('s1')
    ctx.agents.set('s1', agent)
    ctx.roots.push(agent)
    turnEnd(ctx, agent.session)
    ctx.agents.set('s1', fakeAgent('s1'))
    await vi.runAllTimersAsync()
    expect(agent.followup).not.toHaveBeenCalled()
  })

  it('logs a warning when followup throws', async () => {
    const ctx = mount()
    const agent = fakeAgent('s1')
    agent.followup.mockImplementation(() => { throw new Error('nope') })
    ctx.agents.set('s1', agent)
    ctx.roots.push(agent)
    turnEnd(ctx, agent.session)
    await vi.runAllTimersAsync()
    expect(ctx.logger.warn).toHaveBeenCalled()
  })

  it('drops state when the agent is disposed', async () => {
    const ctx = mount({ turn: { delayMs: 50, cooldownMs: 0, maxRestarts: 5 } })
    const agent = fakeAgent('s1')
    ctx.agents.set('s1', agent)
    ctx.roots.push(agent)
    turnEnd(ctx, agent.session)
    ctx.emit('agent/disposed', { agent })
    await vi.runAllTimersAsync()
    expect(agent.followup).not.toHaveBeenCalled()
  })

  it('disposes cleanly and cancels pending work', async () => {
    const ctx = mount({ turn: { delayMs: 50, cooldownMs: 0 } })
    const agent = fakeAgent('s1')
    ctx.agents.set('s1', agent)
    ctx.roots.push(agent)
    turnEnd(ctx, agent.session)
    expect(typeof ctx.dispose).toBe('function')
    await ctx.dispose()
    await vi.runAllTimersAsync()
    expect(agent.followup).not.toHaveBeenCalled()
  })
})
