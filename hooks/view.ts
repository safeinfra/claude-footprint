// Pure view model: events + caches + view state in, rows out. No `$`.
import type { Cls, Filter, KubeInfo, MapEvent, ProfileInfo } from '../types'

import { shortServer } from './mcp'
import { ALL_NS, CLUSTER_NS } from './parse'

export type Ctx = {
  profiles: Record<string, ProfileInfo>
  kube: KubeInfo | null
  turnId: string | null
  filter: Filter
  expanded: Record<string, boolean>
}

const RANK: Record<Cls, number> = { destructive: 5, cred: 4, write: 3, interactive: 2, unknown: 1, read: 0 }

/** EKS context ARNs to the cluster name; anything else as is. */
export const shortContext = (ctx: string) => /^arn:aws[\w-]*:eks:[^:]*:\d*:cluster\/(.+)$/.exec(ctx)?.[1] ?? ctx

/** ARNs to their last segment, long names cut. */
export function shortResource(r: string): string {
  const s = r.startsWith('arn:') ? r.slice(Math.max(r.lastIndexOf('/'), r.lastIndexOf(':')) + 1) || r : r
  return s.length > 40 ? `${s.slice(0, 39)}…` : s
}

export function filterEvents(events: readonly MapEvent[], filter: Filter, turnId: string | null): MapEvent[] {
  if (filter === 'write') return events.filter(e => e.cls !== 'read')
  if (filter === 'turn') return turnId === null ? [] : events.filter(e => e.turnId === turnId)
  return [...events]
}

const accountOf = (e: MapEvent & { tool: 'aws' }, profiles: Ctx['profiles']) => e.scope.account ?? profiles[e.scope.profile]?.account

// Sections by outcome, then where it ran, then object rows.

export type Outcome = 'changed' | 'maybe' | 'failed' | 'looked'

const SECTIONS: readonly { outcome: Outcome; label: string }[] = [
  { outcome: 'changed', label: 'CHANGED' },
  { outcome: 'maybe', label: 'MAY HAVE CHANGED' },
  { outcome: 'failed', label: 'FAILED, NEVER SUCCEEDED' },
  { outcome: 'looked', label: 'LOOKED AT' },
]

/** `expanded` key that opens the LOOKED AT section. */
export const LOOKED_OPEN = 'looked'

export type CallRow = {
  /** Selection key; stable when the row moves between sections. */
  key: string
  object: string
  /** Empty when the object already names the operation (MCP tool with no target). */
  op: string
  /** Service or kind: `rds`, `pods`. */
  topic: string
  /** Highest class among the row's calls; drives colour only. */
  cls: Cls
  outcome: Outcome
  /** `same call 2 times, last one worked`. */
  says: string
  /** `opens AWS account 210987654321, role Deploy`. */
  links: string[]
  isCurrent: boolean
  /** Oldest first. */
  events: MapEvent[]
  where: string
}

export type ScopeBlock = { key: string; where: string; rows: CallRow[] }
export type MapSection = { outcome: Outcome; label: string; rows: number; scopes: ScopeBlock[]; topics: string[] }

/** Where one event ran, in words: `AWS account 437984728688 · ap-northeast-1`. No level is invented. */
export function whereOf(e: MapEvent, ctx: Pick<Ctx, 'profiles' | 'kube'>): { key: string; text: string } {
  if (e.tool === 'mcp') return { key: `mcp:${e.server}`, text: shortServer(e.server) }
  if (e.tool === 'aws') {
    const info = ctx.profiles[e.scope.profile]
    const account = accountOf(e, ctx.profiles)
    const region = e.isGlobal ? 'global' : e.scope.region ?? info?.region
    const regionText = region ?? 'region unknown'
    if (account !== undefined) return { key: `aws:${account}:${region ?? '?'}`, text: `AWS account ${account} · ${regionText}` }
    // Pending and failed lookups stay visibly unknown, never blank.
    const state = info?.status === 'pending' ? 'account not looked up yet' : 'account unknown'
    return { key: `aws:p:${e.scope.profile}:${region ?? '?'}`, text: `AWS profile ${e.scope.profile} · ${state} · ${regionText}` }
  }
  const context = e.scope.context ?? ctx.kube?.current
  const ns = e.scope.namespace ?? (context !== undefined ? ctx.kube?.ns[context] : undefined) ?? 'default'
  const nsText = ns === ALL_NS ? 'all namespaces' : ns === CLUSTER_NS ? 'cluster-wide' : `namespace ${ns}`
  return { key: `k8s:${context ?? '?'}:${ns}`, text: `Kubernetes ${context !== undefined ? shortContext(context) : 'context unknown'} · ${nsText}` }
}

/** `deployments` → `deployment`, only in front of a name. */
const singular = (kind: string) =>
  kind.endsWith('ies') ? `${kind.slice(0, -3)}y` : kind.endsWith('sses') || kind.endsWith('ches') ? kind.slice(0, -2) : kind.endsWith('s') ? kind.slice(0, -1) : kind

/**
 * Object first, real operation after. AWS calls with no named resource use the service.
 * `topic` (service or kind) names the row in a folded LOOKED AT line.
 */
function objectOf(e: MapEvent): { object: string; op: string; topic: string } {
  const named = e.resource === undefined ? undefined : shortResource(e.resource)
  if (e.tool === 'mcp') return named === undefined ? { object: e.verb, op: '', topic: e.verb } : { object: named, op: e.verb, topic: e.verb }
  if (e.tool === 'aws') return { object: named === undefined ? e.service : `${e.service} ${named}`, op: e.verb, topic: e.service }
  return { object: named === undefined ? e.kind : `${singular(e.kind)} ${named}`, op: e.verb, topic: e.kind }
}

function outcomeOf(list: readonly MapEvent[]): Outcome {
  const worked = list.filter(e => e.ok)
  if (worked.length === 0) return 'failed'
  if (worked.some(e => e.cls === 'write' || e.cls === 'destructive')) return 'changed'
  if (worked.some(e => e.cls !== 'read')) return 'maybe'
  return 'looked'
}

/** Short retry wording for a row: `2 calls, last worked`. Same versus different commands is in the detail. */
export function saysOf(list: readonly MapEvent[]): string {
  const n = list.length
  const last = list.at(-1)!
  if (n === 1) return last.ok ? 'worked' : 'failed'
  if (list.every(e => !e.ok)) return `${n} calls, all failed`
  if (list.every(e => e.ok)) return `${n} calls`
  return `${n} calls, last ${last.ok ? 'worked' : 'failed'}`
}

/** Same call = same stored command string. */
function sameness(list: readonly MapEvent[]): string {
  const distinct = new Set(list.map(e => e.cmd)).size
  return distinct === 1 ? 'same command' : `${distinct} different commands`
}

function linkText(e: MapEvent): string | undefined {
  if (!e.link) return undefined
  if (e.link.to === 'aws') return `opens AWS account ${e.link.account}${e.link.role ? `, role ${e.link.role}` : ''}`
  return `opens Kubernetes ${e.link.context ?? e.link.cluster}`
}

/** Filter, bucket by where + object + operation, then section by outcome. Order: first seen. */
export function buildMap(all: readonly MapEvent[], ctx: Ctx): MapSection[] {
  const events = filterEvents(all, ctx.filter, ctx.turnId)
  const buckets = new Map<string, { scopeKey: string; where: string; object: string; op: string; topic: string; events: MapEvent[] }>()
  for (const e of events) {
    const w = whereOf(e, ctx)
    const { object, op, topic } = objectOf(e)
    const key = `${w.key}\u0000${object}\u0000${op}`
    const b = buckets.get(key) ?? { scopeKey: w.key, where: w.text, object, op, topic, events: [] }
    buckets.set(key, b)
    b.events.push(e)
  }

  const sections = new Map(SECTIONS.map(s => [s.outcome, new Map<string, ScopeBlock>()]))
  for (const [key, b] of buckets) {
    const outcome = outcomeOf(b.events)
    const links = [...new Set(b.events.map(linkText).filter((t): t is string => t !== undefined))]
    const row: CallRow = {
      key,
      object: b.object,
      op: b.op,
      topic: b.topic,
      cls: b.events.reduce((w, e) => (RANK[e.cls] > RANK[w] ? e.cls : w), 'read' as Cls),
      outcome,
      says: saysOf(b.events),
      links,
      isCurrent: ctx.turnId !== null && b.events.some(e => e.turnId === ctx.turnId),
      events: b.events,
      where: b.where,
    }
    const scopes = sections.get(outcome)!
    const block = scopes.get(b.scopeKey) ?? { key: b.scopeKey, where: b.where, rows: [] }
    scopes.set(b.scopeKey, block)
    block.rows.push(row)
  }

  return SECTIONS.map(({ outcome, label }) => {
    const scopes = [...sections.get(outcome)!.values()]
    // Several operations on one object stay together, in first-seen order.
    for (const s of scopes) {
      const order = [...new Set(s.rows.map(r => r.object))]
      s.rows.sort((a, b) => order.indexOf(a.object) - order.indexOf(b.object))
    }
    const rows = scopes.flatMap(s => s.rows)
    return { outcome, label, rows: rows.length, scopes, topics: [...new Set(rows.map(r => r.topic))] }
  })
}

/** `rollback (change), failed`: a failed change may have changed something partway. */
export function rowOpText(r: CallRow): string {
  const tag = r.cls === 'write' || r.cls === 'destructive' ? '(change)' : '(may have changed)'
  const op = r.outcome === 'failed' && r.cls !== 'read' ? `${r.op} ${tag}`.trimStart() : r.op
  return op === '' ? r.says : `${op}, ${r.says}`
}

export type PaneRow =
  | { type: 'section'; key: string; section: MapSection; text: string; isFoldable: boolean }
  | { type: 'scope'; key: string; text: string }
  | { type: 'call'; key: string; row: CallRow; object: string; text: string }
  | { type: 'note'; key: string; text: string }

const MAX_OBJECT = 28

/** The pane's rows, one per screen line. CHANGED always shows; LOOKED AT folds to one line unless opened. */
export function paneRows(sections: readonly MapSection[], expanded: Ctx['expanded'] = {}): PaneRow[] {
  const out: PaneRow[] = []
  for (const s of sections) {
    if (s.rows === 0 && s.outcome !== 'changed') continue
    const isFolded = s.outcome === 'looked' && expanded[LOOKED_OPEN] !== true
    const head = `${s.label} (${s.rows})`
    out.push({
      type: 'section',
      key: `section-${s.outcome}`,
      section: s,
      text: isFolded ? `${head} · ${s.topics.join(', ')}` : head,
      isFoldable: s.outcome === 'looked',
    })
    if (s.rows === 0) out.push({ type: 'note', key: `note-${s.outcome}`, text: '  nothing changed' })
    if (isFolded) continue
    for (const block of s.scopes) {
      out.push({ type: 'scope', key: `scope-${s.outcome}-${block.key}`, text: `  ${block.where}` })
      const width = Math.min(MAX_OBJECT, Math.max(...block.rows.map(r => r.object.length)))
      block.rows.forEach((r, i) => {
        // Several operations on one object: name it once.
        const name = i > 0 && block.rows[i - 1]!.object === r.object ? '' : r.object
        const object = `    ${name.padEnd(width)}  `
        out.push({ type: 'call', key: `call-${r.key}`, row: r, object, text: rowOpText(r) })
        for (const l of r.links) out.push({ type: 'note', key: `link-${r.key}-${l}`, text: `      ${l}` })
      })
    }
    if (s.outcome === 'looked') out.push({ type: 'note', key: 'note-looked', text: '  ran without error; results are not recorded' })
  }
  return out
}

export const paneRowText = (r: PaneRow): string => (r.type === 'call' ? `${r.object}${r.text}`.trimEnd() : r.text)

/** Text of the pane list, one string per row; for tests. */
export const mapLines = (sections: readonly MapSection[], expanded: Ctx['expanded'] = {}): string[] => paneRows(sections, expanded).map(paneRowText)

const hhmm = (ts: number) => {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * Detail for one row: every call behind it, oldest first. The AWS profile is added
 * only when the command does not name it already (`AWS_PROFILE`, default).
 */
export function detailLines(r: CallRow): { head: string; calls: { head: string; cmd: string; ok: boolean }[]; where: string } {
  const n = r.events.length
  const count = n === 1 ? '1 call' : `${n} calls, ${sameness(r.events)}`
  return {
    head: [r.object, r.op, count].filter(Boolean).join(' · '),
    // Time, outcome and the call's own description on one line; the command below it.
    calls: r.events.map(e => {
      const profile = e.tool === 'aws' && !e.cmd.includes(e.scope.profile) ? [`profile ${e.scope.profile}`] : []
      return { ok: e.ok, head: [hhmm(e.ts), e.ok ? 'worked' : 'failed', ...profile, ...(e.description ? [e.description] : [])].join('  '), cmd: e.cmd }
    }),
    where: r.where,
  }
}

/**
 * Every recorded call as JSON lines, scope filled in from the caches, oldest first.
 * Same redacted text the pane shows; tool output is never stored, so never exported.
 */
export function traceJsonl(events: readonly MapEvent[], ctx: Pick<Ctx, 'profiles' | 'kube'>): string {
  return events
    .map(e => {
      const { object, op } = objectOf(e)
      return JSON.stringify({
        time: new Date(e.ts).toISOString(),
        turn: e.turnId,
        outcome: e.ok ? 'worked' : 'failed',
        class: e.cls,
        tool: e.tool === 'mcp' ? `mcp ${e.server}` : e.tool,
        where: whereOf(e, ctx).text,
        ...(e.tool === 'aws' ? { profile: e.scope.profile } : {}),
        object,
        ...(op ? { operation: op } : {}),
        ...(e.description ? { description: e.description } : {}),
        command: e.cmd,
        ...(e.link ? { opens: linkText(e) } : {}),
      })
    })
    .map(line => `${line}\n`)
    .join('')
}
