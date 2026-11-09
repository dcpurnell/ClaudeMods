export type AgentRow = {
  id: string
  description: string
  type: string
  model?: string
  parentId?: string
  startedAt: number
  endedAt?: number
  /** pending | running | waiting | idle | completed | failed | killed */
  status: string
  /** The latest request's context plus output, as the footer counts it. */
  tokens: number
  tools: number
  errors: number
  files: string[]
  /** What it is doing now, or the first line of its answer once done. */
  activity: string
}

declare module 'claude-code' {
  interface PluginState {
    'agent-pane': {
      agents: Shaped<AgentRow[]>
      now: number
      isClosedByUser: boolean
    }
  }
}
