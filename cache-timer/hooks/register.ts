import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { LastRequest } from '../types'

// The prompt cache lives an hour past the last request that touched it.
const TTL_MS = 60 * 60 * 1000
// Toast this long before it goes cold.
const WARN_MS = 10 * 60 * 1000
// Below this many tokens a cold cache costs too little to nag about.
const LARGE_TOKENS = 50_000
const TICK_MS = 15 * 1000
// A prompt held back on a cold cache goes through when sent again within this.
const CONFIRM_MS = 2 * 60 * 1000

const last = atom({ plugin: 'cache-timer', key: 'last' } as const, null)

type Cache =
  | { state: 'none' }
  | { state: 'warm'; leftMs: number; tokens: number }
  | { state: 'cold'; idleMs: number; tokens: number }

async function cacheOf($: EngineInterface): Promise<Cache> {
  const request = await read($, last)
  if (request === null) {
    return { state: 'none' }
  }

  const idleMs = (await $.clock.now()) - request.at
  const leftMs = TTL_MS - idleMs

  return leftMs > 0
    ? { state: 'warm', leftMs, tokens: request.tokens }
    : { state: 'cold', idleMs, tokens: request.tokens }
}

const kTokens = (tokens: number) => `${Math.round(tokens / 1000)}k`
const minutes = (ms: number) => `${Math.ceil(ms / 60_000)}m`

function statusOf(cache: Cache): string {
  switch (cache.state) {
    case 'none':
      return 'cache: –'
    case 'warm':
      return `cache: warm · ${minutes(cache.leftMs)} left · ctx ${kTokens(cache.tokens)}`
    case 'cold':
      return cache.tokens >= LARGE_TOKENS
        ? `cache: COLD · ctx ${kTokens(cache.tokens)} · /clear saves a re-cache`
        : `cache: cold · ctx ${kTokens(cache.tokens)}`
  }
}

// Which request each toast was raised for, so each fires once per request.
let soonWarnedFor = 0
let coldWarnedFor = 0

async function tick($: EngineInterface) {
  const cache = await cacheOf($)
  $.ui.status(statusOf(cache))

  const request = await read($, last)
  if (request === null || cache.state === 'none' || cache.tokens < LARGE_TOKENS) {
    return
  }

  if (cache.state === 'warm' && cache.leftMs <= WARN_MS && soonWarnedFor !== request.at) {
    soonWarnedFor = request.at
    $.ui.toast(
      `Prompt cache goes cold in ${minutes(cache.leftMs)} (${kTokens(cache.tokens)} tokens). ` +
        'Keep going to keep it warm, or /clear if you are done with this task.',
      { timeoutMs: 10_000 },
    )
  }

  if (cache.state === 'cold' && coldWarnedFor !== request.at) {
    coldWarnedFor = request.at
    $.ui.toast(
      `Prompt cache is cold. Your next message re-caches ${kTokens(cache.tokens)} tokens; ` +
        '/clear or /compact first if you are switching tasks.',
      { timeoutMs: 15_000 },
    )
  }
}

export const register: Register = on => {
  let timer: Timer | undefined
  let heldAt = 0

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'cache',
      description: 'Show how long the prompt cache stays warm and how much it holds.',
      immediate: true,
    })

    timer?.cancel()
    timer = $.clock.every(TICK_MS, () => void tick($))
    await tick($)

    return next(e)
  })

  // Every main-thread request refreshes the cache's hour; subagents cache their own prefixes.
  on('turn.step', async function* ($, e, next) {
    const response = yield* next(e)

    if (e.agentId === undefined && response.usage !== null) {
      const { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } =
        response.usage
      const request: LastRequest = {
        at: await $.clock.now(),
        tokens: input_tokens + output_tokens + cache_read_input_tokens + cache_creation_input_tokens,
      }
      await update($, last, () => request)
      await tick($)
    }

    return response
  })

  // A prompt typed onto a large cold cache is held back once, so /clear can come first.
  on('prompt.submit', async ($, e, next) => {
    if (e.command !== undefined || e.isMeta || e.origin.kind !== 'composer') {
      return next(e)
    }

    const cache = await cacheOf($)
    if (cache.state !== 'cold' || cache.tokens < LARGE_TOKENS) {
      return next(e)
    }

    const now = await $.clock.now()
    if (now - heldAt < CONFIRM_MS) {
      heldAt = 0
      return next(e)
    }

    heldAt = now
    return {
      drop:
        `cache-timer: the prompt cache went cold ${minutes(cache.idleMs)} ago, so this message ` +
        `would re-cache ${kTokens(cache.tokens)} tokens. Run /clear (or /compact) to start lighter, ` +
        `or send it again within ${minutes(CONFIRM_MS)} to go ahead.`,
    }
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, last, () => null)
      await tick($)
    }

    return next(e)
  })

  // After compaction the old prefix is gone; the next request starts a fresh cache.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    await update($, last, () => null)
    await tick($)

    return result
  })

  on('command.run', { command: 'cache' }, async $ => {
    const cache = await cacheOf($)

    switch (cache.state) {
      case 'none':
        return { text: 'No model request yet this session, so nothing is cached.' }
      case 'warm':
        return {
          text:
            `Prompt cache is warm: ${minutes(cache.leftMs)} left of its hour, holding ` +
            `${kTokens(cache.tokens)} tokens. Each request starts the hour over.`,
        }
      case 'cold':
        return {
          text:
            `Prompt cache is cold (idle ${minutes(cache.idleMs)}). The next message re-caches ` +
            `${kTokens(cache.tokens)} tokens` +
            (cache.tokens >= LARGE_TOKENS ? ': a good moment to /clear or /compact.' : '.'),
        }
    }
  })
}
