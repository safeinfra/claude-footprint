// Pure: parsed actions to stored events. Scope gaps stay open and are filled at draw time.
import type { KubeInfo, MapEvent, ProfileInfo } from '../types'

import type { McpCall } from './mcp'
import type { Action } from './parse'

export const HISTORY_CAP = 500

export type RecordEnv = {
  ts: number
  turnId: string | null
  ok: boolean
  /** Already redacted. */
  cmd: string
  /** Already redacted. */
  description?: string
  /** `AWS_PROFILE` of the Claude Code process, when set. */
  awsProfile?: string
  /** `AWS_REGION` / `AWS_DEFAULT_REGION` of the Claude Code process, when set. */
  awsRegion?: string
  profiles: Record<string, ProfileInfo>
  kube: KubeInfo | null
}

type NewEvent = MapEvent extends infer E ? (E extends MapEvent ? Omit<E, 'id'> : never) : never

export function eventsOf(actions: Action[], env: RecordEnv): NewEvent[] {
  const base = { ts: env.ts, turnId: env.turnId, ok: env.ok, source: 'cli' as const, cmd: env.cmd, ...(env.description ? { description: env.description } : {}) }
  return actions.map((a): NewEvent => {
    if (a.tool === 'aws') {
      const profile = a.profile ?? env.awsProfile ?? 'default'
      return {
        ...base,
        tool: 'aws',
        verb: a.verb,
        resource: a.resource,
        cls: a.cls,
        link: a.link,
        service: a.service,
        isGlobal: a.isGlobal,
        scope: { profile, region: a.region ?? env.awsRegion, account: env.profiles[profile]?.account },
      }
    }
    return {
      ...base,
      tool: 'kubectl',
      verb: a.verb,
      resource: a.resource,
      cls: a.cls,
      link: a.link,
      kind: a.kind,
      scope: { context: a.context ?? env.kube?.current, namespace: a.namespace },
    }
  })
}

export function mcpEventOf(call: McpCall, env: Pick<RecordEnv, 'ts' | 'turnId' | 'ok'>): NewEvent {
  return {
    ts: env.ts,
    turnId: env.turnId,
    ok: env.ok,
    source: 'mcp',
    cmd: call.display,
    tool: 'mcp',
    server: call.server,
    verb: call.name,
    resource: call.target,
    cls: call.cls,
  }
}

/** Appends with fresh ids, keeping the newest `cap`. */
export function appendEvents(list: readonly MapEvent[], add: readonly NewEvent[], cap = HISTORY_CAP): MapEvent[] {
  let id = list.at(-1)?.id ?? 0
  return [...list, ...add.map(e => ({ ...e, id: ++id }) as MapEvent)].slice(-cap)
}
