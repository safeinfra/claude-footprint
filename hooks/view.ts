// Pure view model: events + caches + view state in, rows out. No `$`.
import type { Cls, Filter, KubeInfo, MapEvent, ProfileInfo } from '../types'

import { ALL_NS, CLUSTER_NS } from './parse'

export type Ctx = {
  profiles: Record<string, ProfileInfo>
  kube: KubeInfo | null
  turnId: string | null
  filter: Filter
  expanded: Record<string, boolean>
}

export type Counts = { read: number; write: number; destructive: number; cred: number; interactive: number; failed: number }

export type Note = { verb: string; resource?: string; cls: Cls; ok: boolean }

export type Line =
  | { type: 'svc'; name: string; counts: Counts; note?: Note; isCurrent: boolean; eventId: number }
  | { type: 'reads'; names: string[]; total: number; isCurrent: boolean; eventId: number }
  | { type: 'res'; note: Note; isCurrent: boolean; eventId: number }
  | { type: 'more'; count: number }

export type Section = { label: string | null; lines: Line[] }

export type Mode = 'collapsed' | 'normal' | 'expanded'

export type Group = {
  key: string
  tool: 'aws' | 'kubectl'
  /** Chain-collapsed path: `aws › acct-A (1234…9012) › ap-ne-1`. */
  title: string
  /** Short name for the band. */
  short: string
  counts: Counts
  isNotable: boolean
  isCurrent: boolean
  mode: Mode
  sections: Section[]
  links: string[]
  /** Read service names, for a collapsed header. */
  readNames: string[]
}

const NOTABLE: ReadonlySet<Cls> = new Set(['write', 'destructive', 'cred'])
const RANK: Record<Cls, number> = { destructive: 4, cred: 3, write: 2, interactive: 1, read: 0 }
const TOP_RESOURCES = 3

const zero = (): Counts => ({ read: 0, write: 0, destructive: 0, cred: 0, interactive: 0, failed: 0 })
const add = (c: Counts, e: MapEvent) => {
  c[e.cls]++
  if (!e.ok) c.failed++
}

export const isNotable = (e: MapEvent) => NOTABLE.has(e.cls) || !e.ok

/** `ap-northeast-1` → `ap-ne-1`. */
export function shortRegion(region: string): string {
  return region
    .split('-')
    .map((part, i) =>
      i === 0 ? part : part.replace(/north/g, 'n').replace(/south/g, 's').replace(/east/g, 'e').replace(/west/g, 'w').replace(/central/g, 'c'),
    )
    .join('-')
}

export const shortAccount = (id: string) => (id.length === 12 ? `${id.slice(0, 4)}…${id.slice(8)}` : id)

/** EKS context ARNs to the cluster name; anything else as is. */
export const shortContext = (ctx: string) => /^arn:aws[\w-]*:eks:[^:]*:\d*:cluster\/(.+)$/.exec(ctx)?.[1] ?? ctx

/** ARNs to their last segment, long names cut. */
export function shortResource(r: string): string {
  const s = r.startsWith('arn:') ? r.slice(Math.max(r.lastIndexOf('/'), r.lastIndexOf(':')) + 1) || r : r
  return s.length > 40 ? `${s.slice(0, 39)}…` : s
}

export function badges(c: Counts, withReads = true): [string, Cls | 'failed'][] {
  const out: [string, Cls | 'failed'][] = []
  if (withReads && c.read > 0) out.push([`r${c.read}`, 'read'])
  if (c.write > 0) out.push([`w${c.write}`, 'write'])
  if (c.destructive > 0) out.push([`d${c.destructive}`, 'destructive'])
  if (c.cred > 0) out.push([`cred${c.cred}`, 'cred'])
  if (c.interactive > 0) out.push([`i${c.interactive}`, 'interactive'])
  if (c.failed > 0) out.push([`✗${c.failed}`, 'failed'])
  return out
}

export function filterEvents(events: readonly MapEvent[], filter: Filter, turnId: string | null): MapEvent[] {
  if (filter === 'write') return events.filter(e => e.cls !== 'read')
  if (filter === 'turn') return turnId === null ? [] : events.filter(e => e.turnId === turnId)
  return [...events]
}

type Placed = { group: string; tool: 'aws' | 'kubectl'; head: string; short: string; section: string; leaf: string }

function accountOf(e: MapEvent & { tool: 'aws' }, ctx: Ctx): string | undefined {
  return e.scope.account ?? ctx.profiles[e.scope.profile]?.account
}

function place(e: MapEvent, ctx: Ctx, labelOf: Map<string, string>): Placed {
  if (e.tool === 'aws') {
    const account = accountOf(e, ctx)
    const group = account !== undefined ? `aws:${account}` : `aws:p:${e.scope.profile}`
    if (!labelOf.has(group)) labelOf.set(group, e.scope.profile)
    const name = labelOf.get(group)!
    const status = ctx.profiles[e.scope.profile]?.status
    // Pending and failed lookups stay visibly unknown, never blank.
    const head = account !== undefined ? `${name} (${shortAccount(account)})` : status === 'error' ? `${name} (?)` : status === 'pending' ? `${name} (…)` : name
    const region = e.isGlobal ? 'global' : e.scope.region ?? ctx.profiles[e.scope.profile]?.region
    return { group, tool: 'aws', head, short: name, section: region === undefined ? '?' : shortRegion(region), leaf: e.service }
  }
  const context = e.scope.context ?? ctx.kube?.current ?? '?'
  const ns = e.scope.namespace ?? ctx.kube?.ns[context] ?? 'default'
  const short = shortContext(context)
  return {
    group: `k8s:${context}`,
    tool: 'kubectl',
    head: short,
    short,
    section: ns === ALL_NS ? 'all-ns' : ns === CLUSTER_NS ? 'cluster' : ns,
    leaf: e.kind,
  }
}

function noteOf(e: MapEvent): Note {
  return { verb: e.verb, resource: e.resource === undefined ? undefined : shortResource(e.resource), cls: e.cls, ok: e.ok }
}

/** The most telling event: failed or highest class, newest on ties. */
function latestNotable(list: MapEvent[]): MapEvent | undefined {
  let best: MapEvent | undefined
  for (const e of list) {
    if (!isNotable(e)) continue
    if (best === undefined || RANK[e.cls] >= RANK[best.cls]) best = e
  }
  return best
}

function resourceLines(list: MapEvent[], turnId: string | null): Line[] {
  const seen = new Map<string, MapEvent[]>()
  for (const e of list) {
    const k = `${e.verb}\u0000${e.resource ?? ''}`
    seen.set(k, [...(seen.get(k) ?? []), e])
  }
  const entries = [...seen.values()].sort((a, b) => {
    const ra = Math.max(...a.map(e => RANK[e.cls] + (e.ok ? 0 : 5)))
    const rb = Math.max(...b.map(e => RANK[e.cls] + (e.ok ? 0 : 5)))
    return rb - ra || b.at(-1)!.id - a.at(-1)!.id
  })
  const lines: Line[] = entries.slice(0, TOP_RESOURCES).map(es => {
    const last = es.at(-1)!
    const worst = es.reduce((w, e) => (RANK[e.cls] + (e.ok ? 0 : 5) > RANK[w.cls] + (w.ok ? 0 : 5) ? e : w))
    return { type: 'res', note: noteOf(worst), isCurrent: es.some(e => e.turnId === turnId && turnId !== null), eventId: last.id }
  })
  if (entries.length > TOP_RESOURCES) lines.push({ type: 'more', count: entries.length - TOP_RESOURCES })
  return lines
}

/** The tree: one group per account/context, in first-seen order so hotkeys stay put. */
export function buildGroups(all: readonly MapEvent[], ctx: Ctx): Group[] {
  const events = filterEvents(all, ctx.filter, ctx.turnId)
  const labelOf = new Map<string, string>()
  const groups = new Map<string, { tool: 'aws' | 'kubectl'; head: string; short: string; sections: Map<string, Map<string, MapEvent[]>>; links: string[] }>()

  for (const e of events) {
    const p = place(e, ctx, labelOf)
    let g = groups.get(p.group)
    if (!g) {
      g = { tool: p.tool, head: p.head, short: p.short, sections: new Map(), links: [] }
      groups.set(p.group, g)
    }
    const section = g.sections.get(p.section) ?? new Map<string, MapEvent[]>()
    g.sections.set(p.section, section)
    section.set(p.leaf, [...(section.get(p.leaf) ?? []), e])
    if (e.link) {
      const target =
        e.link.to === 'aws'
          ? `aws ${labelFor(e.link.account, ctx)}${e.link.role ? ` (role ${e.link.role})` : ''}`
          : `k8s ${e.link.context ?? e.link.cluster}`
      if (!g.links.includes(target)) g.links.push(target)
    }
  }

  const out: Group[] = []
  for (const [key, g] of groups) {
    const counts = zero()
    let isCurrent = false
    const readNames: string[] = []
    for (const leaves of g.sections.values()) {
      for (const [name, list] of leaves) {
        list.forEach(e => add(counts, e))
        if (list.some(e => e.turnId === ctx.turnId && ctx.turnId !== null)) isCurrent = true
        if (!list.some(isNotable) && !readNames.includes(name)) readNames.push(name)
      }
    }
    const notable = counts.write + counts.destructive + counts.cred + counts.failed > 0
    const isExpanded = ctx.expanded[key] === true
    const mode: Mode = isExpanded ? 'expanded' : notable ? 'normal' : 'collapsed'
    const tool = g.tool === 'aws' ? 'aws' : 'k8s'
    const isSingle = g.sections.size === 1
    const title = isSingle ? `${tool} › ${g.head} › ${[...g.sections.keys()][0]}` : `${tool} › ${g.head}`

    const sections: Section[] = []
    if (mode !== 'collapsed') {
      for (const [label, leaves] of g.sections) {
        const lines: Line[] = []
        const reads: { name: string; list: MapEvent[] }[] = []
        for (const [name, list] of leaves) {
          const c = zero()
          list.forEach(e => add(c, e))
          const cur = list.some(e => e.turnId === ctx.turnId && ctx.turnId !== null)
          const hasNotable = list.some(isNotable)
          if (mode === 'normal' && !hasNotable) {
            reads.push({ name, list })
            continue
          }
          const top = latestNotable(list) ?? list.at(-1)!
          lines.push({ type: 'svc', name, counts: c, note: hasNotable ? noteOf(top) : undefined, isCurrent: cur, eventId: top.id })
          if (mode === 'expanded') lines.push(...resourceLines(list, ctx.turnId))
        }
        if (reads.length > 0) {
          const flat = reads.flatMap(r => r.list)
          lines.push({
            type: 'reads',
            names: reads.map(r => r.name),
            total: flat.length,
            isCurrent: flat.some(e => e.turnId === ctx.turnId && ctx.turnId !== null),
            eventId: flat.reduce((a, b) => (b.id > a.id ? b : a)).id,
          })
        }
        sections.push({ label: isSingle ? null : label, lines })
      }
    }
    out.push({ key, tool: g.tool, title, short: g.short, counts, isNotable: notable, isCurrent, mode, sections, links: g.links, readNames })
  }
  return out
}

function labelFor(account: string, ctx: Ctx): string {
  for (const [profile, info] of Object.entries(ctx.profiles)) {
    if (info.account === account) return `${profile} (${shortAccount(account)})`
  }
  return shortAccount(account)
}

export type BandToken = { prefix?: string; label: string; badges: [string, Cls | 'failed'][] }

const tokenWidth = (t: BandToken) =>
  (t.prefix ? t.prefix.length + 1 : 0) + t.label.length + t.badges.reduce((n, [b]) => n + b.length + 1, 0)

/**
 * One line: `aws acct-A w1 d1 cred1 │ k8s prod-eks w1 │ acct-B r4`. Notable
 * groups first; read-only ones are dropped first when it does not fit.
 */
export function bandTokens(groups: Group[], columns: number): { tokens: BandToken[]; dropped: number } {
  const ordered = [...groups.filter(g => g.isNotable), ...groups.filter(g => !g.isNotable)]
  const seen = new Set<string>()
  const tokens: BandToken[] = ordered.map(g => {
    const tool = g.tool === 'aws' ? 'aws' : 'k8s'
    const prefix = seen.has(tool) ? undefined : tool
    seen.add(tool)
    return { prefix, label: g.short, badges: badges(g.counts, !g.isNotable) }
  })
  const SEP = 3
  const width = (ts: BandToken[], dropped: number) =>
    ts.reduce((n, t) => n + tokenWidth(t), 0) + SEP * Math.max(0, ts.length - 1) + (dropped > 0 ? ` +${dropped}`.length : 0)
  let dropped = 0
  while (tokens.length > 1 && width(tokens, dropped) > columns) {
    const lastRead = tokens.map((t, i) => [t, i] as const).reverse().find(([, i]) => !ordered[i]!.isNotable)
    tokens.splice(lastRead ? lastRead[1] : tokens.length - 1, 1)
    ordered.splice(lastRead ? lastRead[1] : ordered.length - 1, 1)
    dropped++
  }
  return { tokens, dropped }
}

export type Row =
  | { type: 'group'; key: string; index: number; group: Group }
  | { type: 'line'; key: string; prefix: string; line: Line }
  | { type: 'links'; key: string; text: string }

/**
 * The pane's rows, one per screen line. A group with several regions or
 * namespaces puts the label in a left column instead of a line of its own.
 */
export function rowsOf(groups: Group[]): Row[] {
  const rows: Row[] = []
  groups.forEach((g, index) => {
    rows.push({ type: 'group', key: `group-${index + 1}`, index, group: g })
    const width = Math.max(0, ...g.sections.map(s => (s.label === null ? 0 : s.label.length + 1)))
    g.sections.forEach((s, si) => {
      s.lines.forEach((line, li) => {
        const label = li === 0 && s.label !== null ? s.label : ''
        rows.push({ type: 'line', key: `row-${index + 1}-${si}-${li}`, prefix: `  ${label.padEnd(width)}`, line })
      })
    })
    if (g.mode !== 'collapsed' && g.links.length > 0) {
      rows.push({ type: 'links', key: `links-${index + 1}`, text: `  → link: ${g.links.join(' · ')}` })
    }
  })
  return rows
}

export function groupHeader(g: Group): { marker: string; title: string; badges: [string, Cls | 'failed'][]; extra: string } {
  return {
    marker: g.mode === 'collapsed' ? '▸' : '▾',
    title: g.title,
    badges: badges(g.counts, g.mode === 'collapsed' || !g.isNotable),
    extra: g.mode === 'collapsed' && g.readNames.length > 0 ? ` · ${g.readNames.join(', ')}` : '',
  }
}

export function rowText(r: Row): string {
  if (r.type === 'links') return r.text
  if (r.type === 'line') return r.prefix + lineText(r.line)
  const h = groupHeader(r.group)
  const hk = r.index < 9 ? `${r.index + 1}: ` : ''
  return `${hk}${h.marker} ${h.title}  ${h.badges.map(([b]) => b).join(' ')}${h.extra}`
}

/** Text of the tree as the pane draws it, one string per row; for tests and the line budget. */
export const treeLines = (groups: Group[]): string[] => rowsOf(groups).map(rowText)

/** Where one event ran, caches filled in: `aws acct-a (1234…9012) ap-ne-1` or `k8s prod-eks web`. */
export function scopeText(e: MapEvent, ctx: Pick<Ctx, 'profiles' | 'kube'>): string {
  const p = place(e, { ...ctx, turnId: null, filter: 'all', expanded: {} }, new Map())
  return `${p.tool === 'aws' ? 'aws' : 'k8s'} ${p.head} ${p.section}`
}

export function noteText(n: Note): string {
  return `${n.ok ? '' : '✗ '}${n.verb}${n.resource ? ` ${n.resource}` : ''}`
}

export function lineText(l: Line): string {
  switch (l.type) {
    case 'svc':
      return `${l.name}  ${badges(l.counts).map(([b]) => b).join(' ')}${l.note ? ` · ${noteText(l.note)}` : ''}`
    case 'reads':
      return `${l.names.join(', ')} · read-only (${l.total})`
    case 'res':
      return `  ${noteText(l.note)}`
    case 'more':
      return `  +${l.count} more`
  }
}
