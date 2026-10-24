/** The last main-thread model request: when it landed and how many tokens it cached. */
export type LastRequest = { at: number; tokens: number }

declare module 'claude-code' {
  interface PluginState {
    'cache-timer': { last: LastRequest | null }
  }
}
