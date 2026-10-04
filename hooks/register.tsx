import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { Cls, Filter, MapEvent } from '../types'

import { analyze, CLUSTER_KINDS, CLUSTER_NS, mentionsInfra, normalizeKind, parseManifest, redact } from './parse'
import type { Action } from './parse'
import { isKept, mcpCall } from './mcp'
import { appendEvents, eventsOf, mcpEventOf } from './record'
import { buildMap, detailLines, LOOKED_OPEN, paneRows, traceJsonl } from './view'
import type { Ctx, PaneRow } from './view'

const PANE = 'footprint'
const COMMAND = 'map'
const FILTERS: readonly Filter[] = ['all', 'write', 'turn']
const USAGE =
  '/map toggles the pane; /map all|write|turn filters it; /map collapse folds LOOKED AT; /map export writes every call to a file; /map clear empties the map.'

const events = atom({ plugin: 'footprint', key: 'events' } as const, [] as MapEvent[])
const turn = atom({ plugin: 'footprint', key: 'turnId' } as const, null)
const filter = atom({ plugin: 'footprint', key: 'filter' } as const, 'all')
const expanded = atom({ plugin: 'footprint', key: 'expanded' } as const, {})
const selected = atom({ plugin: 'footprint', key: 'selected' } as const, null)
const profiles = atom({ plugin: 'footprint', key: 'profiles' } as const, {})
const kube = atom({ plugin: 'footprint', key: 'kube' } as const, null)
const unparsed = atom({ plugin: 'footprint', key: 'unparsed' } as const, 0)
const dropped = atom({ plugin: 'footprint', key: 'dropped' } as const, 0)

const COLOR: Record<Cls, string | undefined> = {
  read: undefined,
  write: 'yellow',
  destructive: 'red',
  cred: 'magenta',
  interactive: 'cyan',
  unknown: undefined,
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
async function kick($: EngineInterface, add: readonly ({ tool: 'aws'; scope: { profile: string } } | { tool: 'kubectl' | 'mcp' })[]): Promise<void> {
  const names = new Set(add.flatMap(e => (e.tool === 'aws' ? [e.scope.profile] : [])))
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

/** Appends under the history cap and counts what the cap pushed out, so the pane can say so. */
async function append($: EngineInterface, add: Parameters<typeof appendEvents>[1]): Promise<void> {
  let lost = 0
  await update($, events, list => {
    const next = appendEvents(list, add)
    lost = list.length + add.length - next.length
    return next
  })
  if (lost > 0) await update($, dropped, n => n + lost)
}

async function record($: EngineInterface, command: string, description: string, ok: boolean): Promise<void> {
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
    description: redact(description).trim().slice(0, 200) || undefined,
    awsProfile: hasAws ? await $.env.get('AWS_PROFILE') : undefined,
    awsRegion: hasAws ? (await $.env.get('AWS_REGION')) ?? (await $.env.get('AWS_DEFAULT_REGION')) : undefined,
    profiles: await read($, profiles),
    kube: await read($, kube),
  })
  await append($, add)

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

/**
 * Every recorded call, unfiltered, to `~/.claude/footprint/trace-<session>.jsonl`; a later
 * export of the same session overwrites it. Outside the repo so it never lands in a commit.
 * The path goes on the clipboard of `surface` (the pressing one), else the session's first.
 */
async function exportTrace($: EngineInterface, surface?: RenderSurface): Promise<string> {
  const list = await read($, events)
  if (list.length === 0) return 'Footprint: nothing to export yet.'
  const home = await $.env.get('HOME')
  if (!home) return 'Footprint: HOME is not set; nothing written.'
  const path = `${home}/.claude/footprint/trace-${await $.session.id()}.jsonl`
  try {
    await $.fs.write(path, traceJsonl(list, { profiles: await read($, profiles), kube: await read($, kube) }))
  } catch (err) {
    return `Footprint: export failed: ${err instanceof Error ? err.message : String(err)}`
  }
  const lost = await read($, dropped)
  const copy = await $.ui.copy({ text: path, ...(surface ? { surface } : {}) }).catch(() => ({ isCopied: false as const, reason: 'refused' }))
  const copied = copy.isCopied ? ' Path copied.' : ` Path not copied (${copy.reason}).`
  return `Footprint: ${list.length} calls written to ${path}${lost > 0 ? ` (${lost} older calls were dropped before export)` : ''}.${copied}`
}

const isPaneUp = async ($: EngineInterface) => (await $.ui.panes()).some(p => p.id === PANE)

/** Opens the pane; on a terminal too narrow to seat it, closes it again. */
async function openPane($: EngineInterface): Promise<boolean> {
  const opened = await $.ui.open({ id: PANE, title: 'Footprint' })
  if (opened.isPlaced) return true
  await $.ui.close({ id: PANE }).catch(() => undefined)
  return false
}

const NARROW = 'Footprint: the terminal is too narrow for the pane; widen it or use /map export.'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: COMMAND,
      description: 'Footprint: map of the aws/kubectl and MCP calls this session made',
      argumentHint: '[all|write|turn|collapse|export|clear]',
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
  // No matcher: Bash and every `mcp__*` tool come through here.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    try {
      if (e.tool === 'Bash') {
        const command = String(e.command ?? '')
        if (mentionsInfra(command)) await record($, command, String(e.description ?? ''), ran.isError !== true)
      } else {
        const call = mcpCall(e.tool, e as Readonly<Record<string, unknown>>, ran.isReadOnly === true)
        if (call && isKept(call)) {
          const add = mcpEventOf(call, { ts: await $.clock.now(), turnId: await read($, turn), ok: ran.isError !== true })
          await append($, [add])
        }
      }
    } catch {
      // A map that misses a row beats a tool call that fails.
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
    if (arg === 'export') return { text: await exportTrace($) }
    if (arg === 'collapse') {
      await update($, expanded, () => ({}))
      return { text: 'Footprint: LOOKED AT folded.' }
    }
    if (arg === 'clear') {
      await update($, events, () => [])
      await update($, unparsed, () => 0)
      await update($, dropped, () => 0)
      await update($, selected, () => null)
      // Forget lookups too, so a profile that failed (expired SSO) is asked again.
      await update($, profiles, () => ({}))
      await update($, kube, () => null)
      return { text: 'Footprint: map cleared.' }
    }
    return { text: USAGE }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = await $.ui.resolve(e)
    const list = await read($, events)
    const view = { filter: await read($, filter), expanded: await read($, expanded) }
    const ctx = await ctxOf($, view)
    const chosen = await read($, selected)
    const skipped = await read($, unparsed)
    const lost = await read($, dropped)
    const sections = buildMap(list, ctx)
    const width = Math.max(20, e.props.bodyColumns)
    const fit = (s: string, room = width) => (s.length > room ? `${s.slice(0, Math.max(1, room - 1))}…` : s)
    const marker = (isCurrent: boolean) => <Text color={ACCENT}>{isCurrent ? '•' : ' '}</Text>
    const toggleLooked = () => update($, expanded, m => ({ ...m, [LOOKED_OPEN]: m[LOOKED_OPEN] !== true }))

    // Colour is class only; failure is told by the section a row sits in.
    const drawRow = (r: PaneRow) => {
      if (r.type === 'section') {
        if (!r.isFoldable) {
          return (
            <Box key={`box-${r.key}`}>
              <Text> </Text>
              <Text bold wrap="truncate-end">{r.text}</Text>
            </Box>
          )
        }
        return (
          <Box key={`box-${r.key}`} flexDirection="row">
            {marker(false)}
            <Button key={r.key} plain hotkey="l" label={fit(r.text, width - 2)} onPress={toggleLooked} />
          </Box>
        )
      }
      if (r.type !== 'call') {
        return (
          <Box key={`box-${r.key}`}>
            <Text dimColor={r.type === 'note'} wrap="truncate-end">{` ${r.text}`}</Text>
          </Box>
        )
      }
      const row = r.row
      return (
        <Box key={`box-${r.key}`} flexDirection="row">
          {marker(row.isCurrent)}
          <Button
            key={r.key}
            plain
            label={fit(r.object, Math.max(8, width - 12))}
            dimColor={!row.isCurrent}
            onPress={() => update($, selected, cur => (cur === row.key ? null : row.key))}
          />
          <Text color={COLOR[row.cls]} wrap="truncate-end">{r.text}</Text>
        </Box>
      )
    }

    const row = chosen === null ? undefined : sections.flatMap(s => s.scopes.flatMap(b => b.rows)).find(r => r.key === chosen)
    const detail = row ? detailLines(row) : undefined
    const empty =
      list.length === 0
        ? 'No aws, kubectl or MCP calls yet.'
        : view.filter === 'turn'
          ? 'Nothing in this turn yet.'
          : 'Nothing matches this filter.'
    const isEmpty = sections.every(s => s.rows === 0)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          {FILTERS.map(f => (
            <Button key={`filter-${f}`} label={f} hotkey={f[0]!} variant={f === view.filter ? 'primary' : 'secondary'} onPress={() => update($, filter, () => f)} />
          ))}
          <Button key="collapse" label="collapse" hotkey="c" onPress={() => update($, expanded, () => ({}))} />
          <Button key="export" label="export" hotkey="e" onPress={async press => $.ui.toast(await exportTrace($, press.surface))} />
        </Box>
        {lost > 0 ? (
          <Box key="dropped">
            <Text dimColor>older calls dropped</Text>
          </Box>
        ) : null}
        {isEmpty ? (
          <Box key="empty">
            <Text dimColor>{empty}</Text>
          </Box>
        ) : (
          paneRows(sections, view.expanded).map(drawRow)
        )}
        {skipped > 0 ? (
          <Box key="not-tracked" flexDirection="column">
            <Text> </Text>
            <Text bold> NOT TRACKED</Text>
            <Text dimColor wrap="truncate-end">{`   aws or kubectl commands the map could not read: ${skipped}`}</Text>
          </Box>
        ) : null}
        <Text dimColor>{'─'.repeat(Math.min(width, 48))}</Text>
        {row && detail ? (
          <Box key="detail" flexDirection="column">
            <Text bold wrap="truncate-end">{detail.head}</Text>
            <Text dimColor wrap="truncate-end">{detail.where}</Text>
            {detail.calls.flatMap((c, i) => [
              // Long commands wrap; a light rule keeps each call apart.
              <Box key={`detail-rule-${i}`}>
                <Text dimColor>{`  ${'┄'.repeat(Math.max(1, Math.min(width, 48) - 2))}`}</Text>
              </Box>,
              <Box key={`detail-call-${i}`}>
                <Text wrap="wrap">{`  ${c.head}`}</Text>
              </Box>,
              <Box key={`detail-cmd-${i}`}>
                <Text dimColor wrap="wrap">{`    ${c.cmd}`}</Text>
              </Box>,
            ])}
          </Box>
        ) : (
          <Text dimColor wrap="truncate-end">Select a row to see every call behind it.</Text>
        )}
      </Box>
    )
  })
}
