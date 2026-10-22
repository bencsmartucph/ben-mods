export type OpenIds = string[]
export type Turns = { text: string; at: number; ms?: number; tools: number; agents: number }[]
declare module 'claude-code' { interface PluginState { readable: { open: OpenIds; turns: Turns } } }
