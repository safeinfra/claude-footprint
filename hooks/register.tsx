import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Cls, MapEvent } from '../types'

import { analyze, mentionsInfra, redact } from './parse'
import { appendEvents, eventsOf } from './record'
import { bandTokens, buildGroups } from './view'

const events = atom({ plugin: 'footprint', key: 'events' } as const, [] as MapEvent[])
const turn = atom({ plugin: 'footprint', key: 'turnId' } as const, null)
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

async function record($: EngineInterface, command: string, ok: boolean): Promise<void> {
  const found = analyze(command)
  if (found.actions.length === 0 && found.unparsed === 0) return
  if (found.unparsed > 0) await update($, unparsed, n => n + found.unparsed)
  if (found.actions.length === 0) return

  const hasAws = found.actions.some(a => a.tool === 'aws')
  const add = eventsOf(found.actions, {
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
}

export const register: Register = on => {
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

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const list = await read($, events)
    if (list.length === 0) return next(e)
    const groups = buildGroups(list, {
      profiles: await read($, profiles),
      kube: await read($, kube),
      turnId: await read($, turn),
      filter: 'all',
      expanded: {},
    })
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
}
