export type BacklogIssue = {
  number: number
  title: string
  labels: string[]
  /** When it was opened, epoch ms. */
  createdAt: number
  comments: number
  /** The first lines of the body, markdown. */
  excerpt: string
}
export type BacklogGroup = { label: string; issues: BacklogIssue[] }
export type BacklogListing = { repo: string; groups: BacklogGroup[]; /** When gh answered, epoch ms. */ fetchedAt?: number }

declare module 'claude-code' {
  interface PluginState {
    backlog: {
      // One listing per /backlog filter (lowercased args), so each row draws its own.
      lists: Record<string, BacklogListing>
      // Expanded rows, as "owner/repo#n".
      open: string[]
      // Rows whose prompt fill the surface refused, so the text is shown to copy.
      unfilled: string[]
      // Per filter: "…" while ↻ runs, or the line saying why it failed.
      refreshing: Record<string, string>
    }
  }
}
