import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BacklogGroup, BacklogIssue, BacklogListing } from '../types'

// Listings by filter, so each /backlog row draws the issues it listed.
const lists = atom({ plugin: 'backlog', key: 'lists' } as const, {} as Record<string, BacklogListing>)
// Expanded issues, and issues whose prompt fill the surface refused, as "owner/repo#n".
const open = atom({ plugin: 'backlog', key: 'open' } as const, [] as string[])
const unfilled = atom({ plugin: 'backlog', key: 'unfilled' } as const, [] as string[])
// Per filter: what the last ↻ press said when it failed, or "…" while it runs.
const refreshing = atom({ plugin: 'backlog', key: 'refreshing' } as const, {} as Record<string, string>)

const UNLABELLED = 'no label'
const FALLBACK_COLUMNS = 100
const EXCERPT_LINES = 6
const CHIP = 'magenta'
// Surface labels get their own columns first; any other label groups the rest.
const SURFACES = ['desktop + terminal', 'desktop', 'terminal'] as const
const MAX_PER_ROW = 3

type GhIssue = {
  number: number
  title: string
  labels?: { name: string }[]
  body?: string
  createdAt?: string
  comments?: unknown[]
}

/** The state key for a run's arguments: the label filter, case folded. */
export const keyOf = (args: string) => args.trim().toLowerCase()

/** The first lines of an issue body, leading blank lines dropped, "…" when cut. */
export function excerpt(body: string, lines = EXCERPT_LINES): string {
  const all = body.replace(/\r/g, '').replace(/^\s*\n/, '').trimEnd().split('\n')
  const head = all.slice(0, lines)
  return all.length > lines ? [...head, '…'].join('\n') : head.join('\n')
}

/** Compact age: 5m, 3h, 4d, 2mo, 1y. */
export function age(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 60) return `${d}d`
  return d < 365 ? `${Math.floor(d / 30)}mo` : `${Math.floor(d / 365)}y`
}

/** gh's issue as kept in state. */
export function toIssue(i: GhIssue): BacklogIssue {
  const t = i.createdAt ? Date.parse(i.createdAt) : NaN
  return {
    number: i.number,
    title: i.title,
    labels: (i.labels ?? []).map(l => l.name),
    createdAt: Number.isFinite(t) ? t : 0,
    comments: Array.isArray(i.comments) ? i.comments.length : 0,
    excerpt: excerpt(i.body ?? ''),
  }
}

/** Which column an issue sits in when no filter is given: its surface, else its first other label. */
export function columnOf(i: BacklogIssue): string {
  const names = i.labels.map(n => n.toLowerCase())
  const d = names.includes('desktop'), t = names.includes('terminal')
  if (d && t) return SURFACES[0]
  if (d) return SURFACES[1]
  if (t) return SURFACES[2]
  return i.labels[0] ?? UNLABELLED
}

/** Groups issues: the filter's label, or surface columns first, then other labels, unlabelled last. */
export function group(issues: BacklogIssue[], filter: string): BacklogGroup[] {
  const f = filter.trim().toLowerCase()
  const groups = new Map<string, BacklogGroup>()
  for (const i of issues) {
    const hit = f ? i.labels.find(n => n.toLowerCase() === f) : columnOf(i)
    if (hit === undefined) continue
    const g = groups.get(hit) ?? { label: hit, issues: [] }
    g.issues.push(i)
    groups.set(hit, g)
  }
  const rank = (l: string) => {
    const s = (SURFACES as readonly string[]).indexOf(l)
    return s >= 0 ? s : l === UNLABELLED ? 99 : 10
  }
  const out = [...groups.values()].sort((a, b) => rank(a.label) - rank(b.label) || a.label.localeCompare(b.label))
  for (const g of out) g.issues.sort((a, b) => a.number - b.number)
  return out
}

/** Age and comment count, as the row and the model text both show them. */
export function meta(i: BacklogIssue, now: number): string {
  const parts = i.createdAt ? [age(now - i.createdAt)] : []
  if (i.comments > 0) parts.push(`${i.comments} comment${i.comments === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

/** The short text the model reads: a header, then a label line and one line per issue, no bodies. */
export function asText(listing: BacklogListing, filter: string, now: number): string {
  const n = listing.groups.reduce((s, g) => s + g.issues.length, 0)
  const head = `${listing.repo}: ${n} open issue${n === 1 ? '' : 's'}${filter.trim() ? ` labelled ${filter.trim()}` : ''}`
  const body = listing.groups.flatMap(g => [`${g.label}:`, ...g.issues.map(i => {
    const m = meta(i, now)
    return `  #${i.number} ${i.title}${m ? ` (${m})` : ''}`
  })])
  return [head, ...body].join('\n')
}

export const prefill = (repo: string, n: number, title: string) => `Work on ${repo}#${n}: ${title}`
export const issueUrl = (repo: string, n: number) => `https://github.com/${repo}/issues/${n}`

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const firstLine = (s: string) => s.trim().split(/\r?\n/)[0] ?? ''
const toggle = (ids: string[] | undefined, id: string) =>
  (ids ?? []).includes(id) ? (ids ?? []).filter(x => x !== id) : [...(ids ?? []), id]

// gh's words for "this folder has no GitHub repo", as opposed to GitHub not answering.
const NO_REPO = /not a git repository|no git remotes|none of the git remotes|no default remote|could not determine/i

/** Why `gh repo view` failed, in one line: no repo here, or GitHub (network, sign-in, rate limit). */
export function whyNoRepo(stderr: string): string {
  const why = clip(firstLine(stderr) || 'gh repo view failed', 120)
  return NO_REPO.test(stderr) ? `no GitHub repo here (${why})` : `couldn't reach GitHub (${why})`
}

/** Runs gh for this folder's repo, or `repo` when known: the listing, or one line saying why not. */
async function fetchListing($: EngineInterface, filter: string, known?: string): Promise<BacklogListing | string> {
  let repo = known ?? ''
  if (!repo) {
    const view = await $.process.run(['gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { timeoutMs: 20_000 })
      .catch((err: unknown) => ({ exitCode: 1, stdout: '', stderr: String(err) }))
    repo = view.stdout.trim()
    if (view.exitCode !== 0 || !repo) return whyNoRepo(view.stderr)
  }
  const list = await $.process.run(
    ['gh', 'issue', 'list', '-R', repo, '--state', 'open', '--limit', '300', '--json', 'number,title,labels,body,createdAt,comments'],
    { timeoutMs: 30_000 },
  ).catch((err: unknown) => ({ exitCode: 1, stdout: '', stderr: String(err) }))
  if (list.exitCode !== 0) {
    return `gh issue list failed for ${repo} (${clip(firstLine(list.stderr) || `exit ${list.exitCode}`, 120)})`
  }
  let issues: GhIssue[]
  try {
    issues = JSON.parse(list.stdout) as GhIssue[]
  } catch {
    return `could not read gh's issue list for ${repo}`
  }
  return { repo, groups: group(issues.map(toIssue), filter), fetchedAt: await $.clock.now() }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'backlog', description: 'This repo’s open GitHub issues as a board; press one to read it, ↻ to refresh. Optional arg: a label.' })
    return next(e)
  })

  on('command.run', { command: 'backlog' }, async ($, e) => {
    const filter = (e.args ?? '').trim()
    const listing = await fetchListing($, filter)
    if (typeof listing === 'string') return { text: listing }
    const now = listing.fetchedAt ?? 0
    if (listing.groups.length === 0) {
      return { text: `no open issues in ${listing.repo}${filter ? ` labelled ${filter}` : ''}` }
    }
    await update($, lists, m => ({ ...(m ?? {}), [keyOf(filter)]: listing }))
    return { text: asText(listing, filter, now) }
  })

  on('ui.render', { component: 'CommandOutput', props: { command: 'backlog' } }, async ($, e, next) => {
    if (e.props.isErrored) return next(e)
    const filter = e.props.args ?? ''
    const key = keyOf(filter)
    const listing = (await read($, lists))[key]
    // Error lines, empty results and a resumed transcript (state gone) draw as plain text.
    if (!listing || !e.props.text.includes(`${listing.repo}: `)) return next(e)
    const opened = await read($, open)
    const refused = await read($, unfilled)
    const status = (await read($, refreshing))[key]
    const now = await $.clock.now()
    const { Box, Button, Text, Markdown, Link } = $.ui.resolve(e)
    const width = Math.max(30, (e.viewport?.columns ?? FALLBACK_COLUMNS) - 8)
    const { repo } = listing
    const total = listing.groups.reduce((s, g) => s + g.issues.length, 0)
    const fetched = listing.fetchedAt ? ` · fetched ${age(now - listing.fetchedAt)} ago` : ''
    const isDesktop = e.surface !== 'terminal'

    const refresh = async () => {
      await update($, refreshing, m => ({ ...(m ?? {}), [key]: '…' }))
      // The repo is known from the first run, so a refresh only asks GitHub for the issues.
      const fresh = await fetchListing($, filter, repo).catch((err: unknown) => clip(String(err), 120))
      if (typeof fresh === 'string') {
        await update($, refreshing, m => ({ ...(m ?? {}), [key]: `↻ failed, showing the last list: ${fresh}` }))
        return
      }
      await update($, lists, m => ({ ...(m ?? {}), [key]: fresh }))
      await update($, refreshing, m => { const { [key]: _gone, ...rest } = m ?? {}; return rest })
    }

    const header = (
      <Box key="hdr" flexDirection="row" gap={1} flexWrap="wrap">
        <Text dimColor>{`${repo} · ${total} open${filter.trim() ? ` · ${filter.trim()}` : ''}${fetched}`}</Text>
        <Button key="refresh" plain label={status === '…' ? '↻ refreshing…' : '↻ refresh'} onPress={() => void refresh()} />
        <Link href={`https://github.com/${repo}/issues`} label="GitHub ↗" />
        {status && status !== '…' ? <Text key="rerr" color="red">{status}</Text> : null}
      </Box>
    )

    // The opened part of a row or card: description, then the two ways onward.
    const detail = (i: BacklogIssue, id: string, fill: string) => (
      <Box key={`x-${i.number}`} flexDirection="column" marginLeft={isDesktop ? 0 : 4} gap={isDesktop ? 1 : 0}>
        <Markdown key={`b-${i.number}`} dimColor text={i.excerpt || '_(no description)_'} />
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key={`w-${i.number}`} variant="secondary" label="work on it" onPress={() => void workOn($, id, fill)} />
          <Link href={issueUrl(repo, i.number)} label="open on GitHub ↗" />
        </Box>
        {refused.includes(id) ? <Text key={`f-${i.number}`}>{fill}</Text> : null}
      </Box>
    )

    if (isDesktop) {
      const perRow = Math.min(listing.groups.length, MAX_PER_ROW)
      const colWidth = `${Math.floor(100 / perRow) - 2}%`
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          <Box key="board" flexDirection="row" flexWrap="wrap" columnGap={2} rowGap={1} alignItems="flex-start">
            {listing.groups.map(g => (
              <Box key={`g-${g.label}`} width={colWidth} flexDirection="column" gap={1} borderStyle="round" borderDimColor paddingX={1} paddingY={1}>
                <Text bold>{`${g.label} · ${g.issues.length}`}</Text>
                {g.issues.map(i => {
                  const id = `${repo}#${i.number}`
                  const isOpen = opened.includes(id)
                  const m = meta(i, now)
                  const others = i.labels.filter(l => l.toLowerCase() !== g.label && !(['desktop', 'terminal'].includes(l.toLowerCase()) && (SURFACES as readonly string[]).includes(g.label)))
                  return (
                    <Box key={`r-${i.number}`} flexDirection="column" borderStyle="single" borderDimColor paddingX={1}>
                      <Box flexDirection="row" gap={1}>
                        <Link href={issueUrl(repo, i.number)} label={`#${i.number}`} />
                        <Button key={`i-${i.number}`} plain label={`${isOpen ? '▾' : '▸'} ${i.title}`}
                          onPress={() => update($, open, ids => toggle(ids, id))} />
                      </Box>
                      <Box flexDirection="row" gap={1} flexWrap="wrap">
                        {others.map(l => <Text key={`c-${i.number}-${l}`} color={CHIP}>{`[${l}]`}</Text>)}
                        {m ? <Text dimColor>{m}</Text> : null}
                      </Box>
                      {isOpen ? detail(i, id, prefill(repo, i.number, i.title)) : null}
                    </Box>
                  )
                })}
              </Box>
            ))}
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {header}
        {listing.groups.map(g => (
          <Box key={`g-${g.label}`} flexDirection="column">
            <Text bold>{g.label}</Text>
            {g.issues.map(i => {
              const id = `${repo}#${i.number}`
              const isOpen = opened.includes(id)
              const m = meta(i, now)
              return (
                <Box key={`r-${i.number}`} flexDirection="column">
                  <Box flexDirection="row" gap={1}>
                    <Button key={`i-${i.number}`} plain
                      label={clip(`${isOpen ? '▾' : '▸'} #${i.number} ${i.title}`, Math.max(20, width - 28))}
                      onPress={() => update($, open, ids => toggle(ids, id))} />
                    {i.labels.map(l => <Text key={`c-${i.number}-${l}`} color={CHIP}>{`[${l}]`}</Text>)}
                    {m ? <Text dimColor>{m}</Text> : null}
                    <Link href={issueUrl(repo, i.number)} label="↗" />
                  </Box>
                  {isOpen ? detail(i, id, prefill(repo, i.number, i.title)) : null}
                </Box>
              )
            })}
          </Box>
        ))}
      </Box>
    )
  })
}

/** Fills the prompt; where the surface refuses, marks the row so it shows the text to copy. */
async function workOn($: EngineInterface, id: string, text: string): Promise<void> {
  const r = await $.prompt.fill({ text, mode: 'replace' }).catch(() => ({ isFilled: false }))
  const isFilled = r.isFilled === true
  await update($, unfilled, ids => isFilled ? (ids ?? []).filter(x => x !== id) : (ids ?? []).includes(id) ? (ids ?? []) : [...(ids ?? []), id])
}
