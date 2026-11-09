import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow } from '../types'

const PANE = 'agent-pane'
const TITLE = 'Agents'
const ENDED = new Set(['completed', 'failed', 'killed'])
const KEEP_FINISHED = 20

// Change the shape tag when AgentRow's fields change.
const agents = atom({ plugin: 'agent-pane', key: 'agents' } as const, [], { shape: 'agents-1' })
const now = atom({ plugin: 'agent-pane', key: 'now' } as const, 0)
const isClosedByUser = atom({ plugin: 'agent-pane', key: 'isClosedByUser' } as const, false)

const isEnded = (a: AgentRow) => ENDED.has(a.status)

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${s}s`
}

/** Drops control characters so agent-supplied text can't carry terminal escape sequences. */
function clean(s: unknown): string {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
}

function shortPath(p: unknown): string {
  const s = clean(p)
  const parts = s.split('/')
  return parts.length > 2 ? parts.slice(-2).join('/') : s
}

function oneLine(s: unknown): string {
  return clean(s).replace(/\s+/g, ' ').trim()
}

/** A short line describing a tool call, for the activity row. */
function describe(e: { tool: string } & Record<string, unknown>): string {
  const t = oneLine(e.tool)
  switch (t) {
    case 'Bash':
      return `Bash  ${oneLine(e.command)}`
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return `${t}  ${shortPath(e.file_path ?? e.notebook_path)}`
    case 'Grep':
    case 'Glob':
      return `${t}  ${oneLine(e.pattern)}`
    case 'WebFetch':
      return `WebFetch  ${oneLine(e.url)}`
    case 'WebSearch':
      return `WebSearch  ${oneLine(e.query)}`
    case 'Agent':
      return `Agent  ${oneLine(e.description)}`
    default:
      return t.startsWith('mcp__') ? t.split('__').slice(1).join(' ') : t
  }
}

const WRITES = new Set(['Write', 'Edit', 'NotebookEdit'])

function patch($: EngineInterface, id: string, fn: (a: AgentRow) => AgentRow) {
  return update($, agents, list => list.map(a => (a.id === id ? fn(a) : a)))
}

/** Pulls status from the engine's own agent list; adds agents spawned before this mod loaded. */
async function reconcile($: EngineInterface): Promise<void> {
  const [live, t] = await Promise.all([$.agent.list(), $.clock.now()])
  await update($, agents, list => {
    const byId = new Map(list.map(a => [a.id, a]))
    for (const info of live) {
      const row = byId.get(info.id)
      if (!row) {
        byId.set(info.id, {
          id: info.id,
          description: oneLine(info.description),
          type: oneLine(info.type),
          parentId: info.parentId,
          startedAt: t,
          endedAt: ENDED.has(info.status) ? t : undefined,
          status: info.status,
          tokens: 0,
          tools: 0,
          errors: 0,
          files: [],
          activity: '',
        })
      } else if (!isEnded(row) && row.status !== info.status) {
        byId.set(info.id, {
          ...row,
          status: info.status,
          endedAt: ENDED.has(info.status) ? t : row.endedAt,
        })
      }
    }
    const all = [...byId.values()]
    const finished = all.filter(isEnded).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    const drop = new Set(finished.slice(KEEP_FINISHED).map(a => a.id))
    return all.filter(a => !drop.has(a.id))
  })
  await update($, now, () => t)
}

async function openPane($: EngineInterface): Promise<void> {
  if (await read($, isClosedByUser)) return
  const panes = await $.ui.panes()
  if (!panes.some(p => p.id === PANE)) void $.ui.open({ id: PANE, title: TITLE })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'agent-pane',
      description: 'Open or close the pane showing what each agent is doing',
    })
    $.clock.every(1000, () => {
      void (async () => {
        const list = await read($, agents)
        const live = await $.agent.list()
        if (list.some(a => !isEnded(a)) || live.some(a => !ENDED.has(a.status))) await reconcile($)
      })()
    })
    return next(e)
  })

  on('command.run', { command: 'agent-pane' }, async $ => {
    const panes = await $.ui.panes()
    if (panes.some(p => p.id === PANE)) {
      await update($, isClosedByUser, () => true)
      await $.ui.close({ id: PANE })
      return { text: 'Agents pane closed. Run /agent-pane to bring it back.' }
    }
    await update($, isClosedByUser, () => false)
    await reconcile($)
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Agents pane opened.' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await update($, isClosedByUser, () => true)
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (!('agentId' in r) || !r.agentId) return r
    const t = await $.clock.now()
    const row: AgentRow = {
      id: r.agentId,
      description: oneLine(e.description),
      type: oneLine(e.subagentType),
      model: 'model' in r && r.model ? oneLine(r.model) : undefined,
      parentId: e.parentAgentId,
      startedAt: t,
      status: 'running',
      tokens: 0,
      tools: 0,
      errors: 0,
      files: [],
      activity: 'Starting…',
    }
    await update($, agents, list => [...list.filter(a => a.id !== row.id), row])
    await update($, now, () => t)
    await openPane($)
    return r
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId) {
      const id = e.agentId
      await patch($, id, a => ({ ...a, activity: 'Thinking…', model: a.model ?? oneLine(e.model) }))
    }
    const r = yield* next(e)
    if (e.agentId && r && 'usage' in r && r.usage) {
      const u = r.usage
      const total =
        u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      await patch($, e.agentId, a => ({ ...a, tokens: total }))
    }
    return r
  })

  on('tool.call', async ($, e, next) => {
    const id = e.agentId
    if (!id) return next(e)
    await patch($, id, a => ({ ...a, tools: a.tools + 1, activity: describe(e as any) }))
    const r = await next(e)
    const isError = 'isError' in r && r.isError === true
    const wrote =
      !isError && !('deny' in r && r.deny) && WRITES.has(String(e.tool))
        ? String((e as any).file_path ?? (e as any).notebook_path ?? '')
        : ''
    await patch($, id, a => ({
      ...a,
      errors: a.errors + (isError || ('deny' in r && r.deny) ? 1 : 0),
      files: wrote && !a.files.includes(wrote) ? [...a.files, wrote] : a.files,
    }))
    return r
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      const t = await $.clock.now()
      const status = e.reason === 'answer' ? 'completed' : e.reason === 'aborted' ? 'killed' : 'failed'
      const first = oneLine(e.answer.split('\n').find(l => l.trim()) ?? '')
      await patch($, e.agentId, a => ({
        ...a,
        status,
        endedAt: t,
        activity: first ? `"${first}"` : status,
      }))
      await update($, now, () => t)
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, agents)
    const t = (await read($, now)) || (await $.clock.now())

    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No agents yet this session.</Text>
        </Box>
      )
    }

    const ids = new Set(list.map(a => a.id))
    const childrenOf = new Map<string | undefined, AgentRow[]>()
    for (const a of list) {
      const p = a.parentId && ids.has(a.parentId) ? a.parentId : undefined
      childrenOf.set(p, [...(childrenOf.get(p) ?? []), a])
    }
    // Running first by start time; finished drop to the bottom, most recent first.
    const order = (xs: AgentRow[]) => [
      ...xs.filter(a => !isEnded(a)).sort((a, b) => a.startedAt - b.startedAt),
      ...xs.filter(isEnded).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)),
    ]

    const running = list.filter(a => !isEnded(a)).length
    const done = list.length - running

    const dot = (a: AgentRow) =>
      a.status === 'completed'
        ? <Text color="green">✓</Text>
        : a.status === 'failed' || a.status === 'killed'
          ? <Text color="red">✗</Text>
          : a.status === 'running'
            ? <Text color="cyan">●</Text>
            : <Text color="yellow">◌</Text>

    const rows: any[] = []
    const walk = (parent: string | undefined, depth: number) => {
      for (const a of order(childrenOf.get(parent) ?? [])) {
        const pad = '  '.repeat(depth)
        const ended = isEnded(a)
        const elapsed = fmtElapsed((a.endedAt ?? t) - a.startedAt)
        const meta = [a.type, a.model].filter(Boolean).join(' · ')
        const counts = [
          `${a.tools} tools`,
          `${a.errors} err`,
          a.files.length ? `${a.files.length} file${a.files.length > 1 ? 's' : ''}` : '',
        ].filter(Boolean).join(' · ')

        rows.push(
          <Box key={a.id} flexDirection="column" marginBottom={1}>
            <Box justifyContent="space-between">
              <Text wrap="truncate-end">
                {pad}{dot(a)} <Text bold={!ended} dimColor={ended}>{a.description || a.type}</Text>
              </Text>
              <Text dimColor>{ended ? `${a.status === 'completed' ? 'done' : a.status} ${elapsed}` : elapsed}</Text>
            </Box>
            <Box justifyContent="space-between">
              <Text dimColor wrap="truncate-end">{pad}  {meta}</Text>
              <Text dimColor>{a.tokens ? `${fmtTokens(a.tokens)} tok` : ''}</Text>
            </Box>
            <Text wrap="truncate-end" dimColor={ended}>{pad}  └ {a.activity || '…'}</Text>
            <Box justifyContent="space-between">
              <Text dimColor>
                {pad}    {counts}{a.errors > 0 ? <Text color="yellow"> ⚠</Text> : ''}
              </Text>
              <Box>
                <Button
                  key={`view-${a.id}`}
                  label="view"
                  onPress={async () => {
                    const r = await $.ui.view({ agentId: a.id })
                    if ('deny' in r && r.deny) $.ui.toast(`Can't view: ${oneLine(r.deny)}`)
                  }}
                />
                {!ended && (
                  <Button
                    key={`stop-${a.id}`}
                    label="stop"
                    onPress={async () => {
                      try {
                        await $.tool.call({
                          tool: 'TaskStop',
                          task_id: a.id,
                          consent: `The user pressed "stop" on agent "${a.description}" in the Agents pane`,
                        })
                        $.ui.toast(`Stopping ${a.description}`)
                      } catch (err) {
                        $.ui.toast(`Couldn't stop ${a.description}: ${oneLine(err)}`)
                      }
                    }}
                  />
                )}
              </Box>
            </Box>
          </Box>,
        )
        walk(a.id, depth + 1)
      }
    }
    walk(undefined, 0)

    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>{running} running</Text>
          <Text dimColor> · {done} done</Text>
        </Text>
        <Text dimColor>{'─'.repeat(Math.max(10, (e.viewport?.columns ?? 44) - 2))}</Text>
        {rows}
      </Box>
    )
  })
}
