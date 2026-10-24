import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const MINUTE = 60_000

function engine(on: On) {
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []

  on('command.register', () => ({ value: { command: 'cache' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: {
        model: 'claude-opus-5-5',
        input_tokens: 2_000,
        output_tokens: 1_000,
        cache_read_input_tokens: 80_000,
        cache_creation_input_tokens: 2_000,
      },
    }
  })

  return { statuses, toasts }
}

async function step($: Parameters<Parameters<typeof test>[1]>[0], agentId?: string) {
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'opus', messageCount: 3, agentId })
  for await (const _ of stream) {
    // drain
  }
  return stream.result
}

test('counts down, warns at ten minutes, then goes cold', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const seen = engine(on)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(seen.statuses.at(-1)).toBe('cache: –')

  await step($)
  expect(seen.statuses.at(-1)).toBe('cache: warm · 60m left · ctx 85k')

  await clock.advance(49 * MINUTE)
  expect(seen.statuses.at(-1)).toBe('cache: warm · 11m left · ctx 85k')
  expect(seen.toasts).toHaveLength(0)

  await clock.advance(2 * MINUTE)
  expect(seen.toasts).toHaveLength(1)
  expect(seen.toasts[0]).toMatch(/goes cold in 10m/)

  await clock.advance(10 * MINUTE)
  expect(seen.statuses.at(-1)).toMatch(/^cache: COLD · ctx 85k/)
  expect(seen.toasts).toHaveLength(2)
  expect(seen.toasts[1]).toMatch(/re-caches 85k tokens/)

  const { text } = await $.command.run({ command: 'cache' })
  expect(text).toMatch(/cold/)
})

test('a subagent request leaves the main cache timer alone', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const seen = engine(on)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await step($)
  await clock.advance(30 * MINUTE)
  await step($, 'agent-1')

  expect(seen.statuses.at(-1)).toBe('cache: warm · 30m left · ctx 85k')
})

test('/clear resets the timer', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const seen = engine(on)
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await step($)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { sessionId: 's1' } as never })

  expect(seen.statuses.at(-1)).toBe('cache: –')
})
