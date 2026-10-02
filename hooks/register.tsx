import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Cls, Filter, MapEvent } from '../types'

import { analyze, CLUSTER_KINDS, CLUSTER_NS, mentionsInfra, normalizeKind, parseManifest, redact } from './parse'
import type { Action } from './parse'
import { appendEvents, eventsOf } from './record'
import { badges, bandTokens, buildGroups, groupHeader, noteText, rowsOf, scopeText } from './view'
import type { Ctx, Row } from './view'

const PANE = 'footprint'
const COMMAND = 'map'
const FILTERS: readonly Filter[] = ['all', 'write', 'turn']
const USAGE = '/map toggles the pane; /map all|write|turn filters it; /map collapse folds groups; /map clear empties the map.'

const events = atom({ plugin: 'footprint', key: 'events' } as const, [] as MapEvent[])
const turn = atom({ plugin: 'footprint', key: 'turnId' } as const, null)
const filter = atom({ plugin: 'footprint', key: 'filter' } as const, 'all')
const expanded = atom({ plugin: 'footprint', key: 'expanded' } as const, {})
const selected = atom({ plugin: 'footprint', key: 'selected' } as const, null)
const profiles = atom({ plugin: 'footprint', key: 'profiles' } as const, {})
const kube = atom({ plugin: 'footprint', key: 'kube' } as const, null)
const unparsed = atom({ plugin: 'footprint', key: 'unparsed' } as const, 0)

const COLOR: Record<Cls | 'failed', string | undefined> = {
  read: undefined,
  write: 'yellow',
  destructive: 'red',
  cred: 'magenta',
  interactive: 'cyan',
  failed: 'red',
}
const ACCENT = 'cyan'

const ACCOUNT_ID = /^\d{12}$/

/** Account id (never the caller ARN) and configured region of one profile, off the tool call's path. */
async function resolveProfile($: EngineInterface, profile: string): Promise<void> {
  const [id, region] = await Promise.all([
    $.process
      .run(['aws', 'sts', 'get-caller-identity', '--profile', profile, '--output', 'json'], { timeoutMs: 15_000 })
      .catch(() => null),
    $.process.run(['aws', 'configure', 'get', 'region', '--profile', profile], { timeoutMs: 5_000 }).catch(() => null),
  ])
  let account: string | undefined
  if (id?.exitCode === 0) {
    try {
      const parsed = (JSON.parse(id.stdout) as { Account?: unknown }).Account
      if (typeof parsed === 'string' && ACCOUNT_ID.test(parsed)) account = parsed
    } catch {
      // Unreadable answer: the account stays unknown.
    }
  }
  const configured = region?.exitCode === 0 ? region.stdout.trim() : ''
  await update($, profiles, m => ({
    ...m,
    [profile]: {
      status: account ? ('ok' as const) : ('error' as const),
      ...(account ? { account } : {}),
      ...(configured ? { region: configured } : {}),
    },
  }))
}

/** Current context and each context's default namespace, from the kubeconfig. */
async function resolveKube($: EngineInterface): Promise<void> {
  const [cur, view] = await Promise.all([
    $.process.run(['kubectl', 'config', 'current-context'], { timeoutMs: 5_000 }).catch(() => null),
    $.process
      .run(['kubectl', 'config', 'view', '-o', 'jsonpath={range .contexts[*]}{.name}{"\\t"}{.context.namespace}{"\\n"}{end}'], {
        timeoutMs: 5_000,
      })
      .catch(() => null),
  ])
  const current = cur?.exitCode === 0 ? cur.stdout.trim() : ''
  const ns: Record<string, string> = {}
  if (view?.exitCode === 0) {
    for (const line of view.stdout.split('\n')) {
      const [name, namespace] = line.split('\t')
      if (name && namespace) ns[name] = namespace.trim()
    }
  }
  await update($, kube, k => {
    const known = k?.current ?? (current || undefined)
    return { status: known ? ('ok' as const) : ('error' as const), ...(known ? { current: known } : {}), ns }
  })
  // Rows recorded before the answer ran against this context: pin them before a later switch moves them.
  if (current) await update($, events, list => pinContext(list, current))
}

const pinContext = (list: MapEvent[], context: string): MapEvent[] =>
  list.map(e => (e.tool === 'kubectl' && e.scope.context === undefined ? { ...e, scope: { ...e.scope, context } } : e))

/** Starts each lookup once: marks it pending, then runs it from a timer so the tool call never waits. */
async function kick($: EngineInterface, add: readonly { tool: string; scope: { profile?: string } }[]): Promise<void> {
  const names = new Set(add.flatMap(e => (e.tool === 'aws' && e.scope.profile !== undefined ? [e.scope.profile] : [])))
  for (const profile of names) {
    let isMine = false
    await update($, profiles, m => {
      isMine = m[profile] === undefined
      return isMine ? { ...m, [profile]: { status: 'pending' as const } } : m
    })
    if (isMine) $.clock.after(0, () => void resolveProfile($, profile).catch(() => undefined))
  }
  if (add.some(e => e.tool === 'kubectl')) {
    let isMine = false
    await update($, kube, k => {
      isMine = k === null
      return isMine ? { status: 'pending' as const, ns: {} } : k
    })
    if (isMine) $.clock.after(0, () => void resolveKube($).catch(() => undefined))
  }
}

/** `-f file` actions become one action per manifest document; unreadable files stay as `manifest`. */
async function expandManifests($: EngineInterface, actions: Action[]): Promise<Action[]> {
  const out: Action[] = []
  let base: string | undefined
  for (const a of actions) {
    if (a.tool !== 'kubectl' || a.file === undefined) {
      out.push(a)
      continue
    }
    base ??= await $.session.cwd()
    const dir = a.cwd == null ? base : a.cwd.startsWith('/') ? a.cwd : `${base}/${a.cwd}`
    const path = a.file.startsWith('/') ? a.file : `${dir}/${a.file}`
    let docs: ReturnType<typeof parseManifest> = []
    try {
      docs = parseManifest(String(await $.fs.read(path)))
    } catch {
      // Missing, a directory, too big or remote: keep the file name.
    }
    const { file: _file, cwd: _cwd, ...rest } = a
    if (docs.length === 0) {
      out.push(rest)
      continue
    }
    for (const d of docs) {
      const kind = normalizeKind(d.kind)
      const namespace = CLUSTER_KINDS.has(kind) ? CLUSTER_NS : d.namespace ?? a.namespace
      out.push({ ...rest, kind, ...(d.name ? { resource: d.name } : {}), ...(namespace ? { namespace } : {}) })
    }
  }
  return out
}

async function record($: EngineInterface, command: string, ok: boolean): Promise<void> {
  const found = analyze(command)
  if (found.actions.length === 0 && found.unparsed === 0) return
  if (found.unparsed > 0) await update($, unparsed, n => n + found.unparsed)
  if (found.actions.length === 0) return

  const actions = await expandManifests($, found.actions)
  const hasAws = actions.some(a => a.tool === 'aws')
  // Context switches are kubeconfig bookkeeping, not infra: applied below, not drawn.
  const add = eventsOf(actions.filter(a => a.tool !== 'kubectl' || a.kind !== 'config'), {
    ts: await $.clock.now(),
    turnId: await read($, turn),
    ok,
    cmd: redact(command).slice(0, 4000),
    awsProfile: hasAws ? await $.env.get('AWS_PROFILE') : undefined,
    awsRegion: hasAws ? (await $.env.get('AWS_REGION')) ?? (await $.env.get('AWS_DEFAULT_REGION')) : undefined,
    profiles: await read($, profiles),
    kube: await read($, kube),
  })
  await update($, events, list => appendEvents(list, add))

  // `config use-context X`: earlier rows keep the old context, later ones get X.
  const switched = ok ? actions.findLast(a => a.tool === 'kubectl' && a.useContext !== undefined) : undefined
  if (switched?.tool === 'kubectl' && switched.useContext !== undefined) {
    const before = (await read($, kube))?.current
    if (before !== undefined) await update($, events, list => pinContext(list, before))
    const next = switched.useContext
    await update($, kube, k => ({ status: 'ok' as const, ns: k?.ns ?? {}, current: next }))
  }
  await kick($, add)
}

async function ctxOf($: EngineInterface, view: Pick<Ctx, 'filter' | 'expanded'>): Promise<Ctx> {
  return { profiles: await read($, profiles), kube: await read($, kube), turnId: await read($, turn), ...view }
}

const isPaneUp = async ($: EngineInterface) => (await $.ui.panes()).some(p => p.id === PANE)

/** Opens the pane; on a terminal too narrow to seat it, closes it again so the band is the view. */
async function openPane($: EngineInterface): Promise<boolean> {
  const opened = await $.ui.open({ id: PANE, title: 'Footprint' })
  if (opened.isPlaced) return true
  await $.ui.close({ id: PANE }).catch(() => undefined)
  return false
}

const NARROW = 'Footprint: the terminal is too narrow for the pane; the band above the prompt keeps the summary.'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: COMMAND,
      description: 'Footprint: map of the aws/kubectl calls this session made',
      argumentHint: '[all|write|turn|collapse|clear]',
      immediate: true,
    })
    // A hot reload drops pending timers: restart lookups the old module left pending.
    for (const [profile, info] of Object.entries(await read($, profiles))) {
      if (info.status === 'pending') $.clock.after(0, () => void resolveProfile($, profile).catch(() => undefined))
    }
    if ((await read($, kube))?.status === 'pending') $.clock.after(0, () => void resolveKube($).catch(() => undefined))
    return started
  })

  on('turn.start', async ($, e, next) => {
    await update($, turn, () => e.turnId)
    return next(e)
  })

  // Observe only: the call always runs as asked and its result goes back untouched.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    const command = String(e.command ?? '')
    if (ran.deny === undefined && mentionsInfra(command)) {
      try {
        await record($, command, ran.isError !== true)
      } catch {
        // A map that misses a row beats a tool call that fails.
      }
    }
    return ran
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === '') {
      if (await isPaneUp($)) {
        await $.ui.close({ id: PANE })
        return { text: 'Footprint pane closed.' }
      }
      return { text: (await openPane($)) ? 'Footprint pane opened.' : NARROW }
    }
    if ((FILTERS as readonly string[]).includes(arg)) {
      await update($, filter, () => arg as Filter)
      return { text: (await openPane($)) ? `Footprint: showing ${arg}.` : NARROW }
    }
    if (arg === 'collapse') {
      await update($, expanded, () => ({}))
      return { text: 'Footprint: groups folded.' }
    }
    if (arg === 'clear') {
      await update($, events, () => [])
      await update($, unparsed, () => 0)
      await update($, selected, () => null)
      // Forget lookups too, so a profile that failed (expired SSO) is asked again.
      await update($, profiles, () => ({}))
      await update($, kube, () => null)
      return { text: 'Footprint: map cleared.' }
    }
    return { text: USAGE }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const list = await read($, events)
    if (list.length === 0) return next(e)
    const groups = buildGroups(list, await ctxOf($, { filter: 'all', expanded: {} }))
    if (groups.length === 0) return next(e)
    const { tokens, dropped } = bandTokens(groups, e.props.bodyColumns)
    const { Box, Text } = await $.ui.resolve(e)
    const parts: unknown[] = []
    tokens.forEach((t, i) => {
      if (i > 0) parts.push(<Text dimColor> │ </Text>)
      if (t.prefix) parts.push(<Text bold>{t.prefix} </Text>)
      parts.push(<Text>{t.label}</Text>)
      for (const [b, cls] of t.badges) {
        parts.push(<Text color={COLOR[cls]} dimColor={cls === 'read'}> {b}</Text>)
      }
    })
    if (dropped > 0) parts.push(<Text dimColor> +{dropped}</Text>)
    return (
      <Box key="footprint-band">
        <Text wrap="truncate-end">{parts}</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = await $.ui.resolve(e)
    const list = await read($, events)
    const view = { filter: await read($, filter), expanded: await read($, expanded) }
    const ctx = await ctxOf($, view)
    const chosen = await read($, selected)
    const skipped = await read($, unparsed)
    const groups = buildGroups(list, ctx)
    const width = Math.max(20, e.props.bodyColumns)
    const fit = (s: string, room = width) => (s.length > room ? `${s.slice(0, Math.max(1, room - 1))}…` : s)
    const select = (id: number) => () => update($, selected, cur => (cur === id ? null : id))
    const marker = (isCurrent: boolean) => <Text color={ACCENT}>{isCurrent ? '•' : ' '}</Text>
    const badgeTexts = (bs: [string, Cls | 'failed'][]) =>
      bs.map(([b, cls]) => <Text color={COLOR[cls]} dimColor={cls === 'read'}> {b}</Text>)

    const drawRow = (r: Row) => {
      if (r.type === 'links') return <Box><Text wrap="truncate-end">{r.text}</Text></Box>
      if (r.type === 'group') {
        const g = r.group
        const head = groupHeader(g)
        const toggle = () => update($, expanded, m => ({ ...m, [g.key]: m[g.key] !== true }))
        const hotkey = r.index < 9 ? { hotkey: String(r.index + 1) } : {}
        return (
          <Box flexDirection="row">
            {marker(g.isCurrent)}
            <Button key={r.key} plain {...hotkey} label={fit(`${head.marker} ${head.title}`, width - 12)} dimColor={!g.isCurrent && !g.isNotable} onPress={toggle} />
            <Text wrap="truncate-end">
              {badgeTexts(head.badges)}
              <Text dimColor>{head.extra}</Text>
            </Text>
          </Box>
        )
      }
      const l = r.line
      if (l.type === 'more') return <Box><Text dimColor>{` ${r.prefix}    +${l.count} more`}</Text></Box>
      if (l.type === 'res') {
        return (
          <Box flexDirection="row">
            {marker(l.isCurrent)}
            <Text>{`${r.prefix}  `}</Text>
            <Text color={COLOR[l.note.ok ? l.note.cls : 'failed']}>› </Text>
            <Button key={r.key} plain label={fit(noteText(l.note), width - r.prefix.length - 6)} dimColor={!l.isCurrent} onPress={select(l.eventId)} />
          </Box>
        )
      }
      if (l.type === 'reads') {
        return (
          <Box flexDirection="row">
            {marker(l.isCurrent)}
            <Button key={r.key} plain label={fit(`${r.prefix}${l.names.join(', ')}`, width - 20)} dimColor onPress={select(l.eventId)} />
            <Text dimColor wrap="truncate-end">{` · read-only (${l.total})`}</Text>
          </Box>
        )
      }
      const note = l.note
      return (
        <Box flexDirection="row">
          {marker(l.isCurrent)}
          <Button key={r.key} plain label={fit(`${r.prefix}${l.name}`, width - 12)} dimColor={!l.isCurrent} onPress={select(l.eventId)} />
          <Text wrap="truncate-end">
            {badgeTexts(badges(l.counts))}
            {note ? <Text color={COLOR[note.ok ? note.cls : 'failed']}>{` · ${noteText(note)}`}</Text> : null}
          </Text>
        </Box>
      )
    }

    const event = chosen === null ? undefined : list.find(ev => ev.id === chosen)
    const empty =
      list.length === 0
        ? 'No aws or kubectl calls yet.'
        : view.filter === 'turn'
          ? 'Nothing in this turn yet.'
          : 'Nothing matches this filter.'

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          {FILTERS.map(f => (
            <Button key={`filter-${f}`} label={f} hotkey={f[0]!} variant={f === view.filter ? 'primary' : 'secondary'} onPress={() => update($, filter, () => f)} />
          ))}
          <Button key="collapse" label="collapse" hotkey="c" onPress={() => update($, expanded, () => ({}))} />
        </Box>
        {groups.length === 0 ? <Text dimColor>{empty}</Text> : rowsOf(groups).map(drawRow)}
        <Text dimColor>{'─'.repeat(Math.min(width, 48))}</Text>
        {event ? (
          <Box key="detail" flexDirection="column">
            <Text wrap="truncate-end">
              <Text color={COLOR[event.ok ? event.cls : 'failed']}>{`${event.ok ? '' : '✗ '}${event.cls}`}</Text>
              <Text dimColor>{` · ${scopeText(event, ctx)}${event.turnId !== null && event.turnId === ctx.turnId ? ' · this turn' : ''}`}</Text>
            </Text>
            <Box key="detail-cmd">
              <Text wrap="wrap">{`$ ${event.cmd}`}</Text>
            </Box>
          </Box>
        ) : (
          <Text dimColor wrap="truncate-end">
            {`Select a row to see its command.${skipped > 0 ? ` Unparsed: ${skipped}.` : ''}`}
          </Text>
        )}
      </Box>
    )
  })
}
