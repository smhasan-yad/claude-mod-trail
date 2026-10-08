export type TrailFile = { path: string; kind: 'read' | 'write'; at: number; add: number; del: number; count: number }

declare module 'claude-code' {
  interface PluginState {
    'trail': { files: TrailFile[] }
  }
}
