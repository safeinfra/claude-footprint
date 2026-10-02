export type Cls = 'read' | 'write' | 'destructive' | 'cred' | 'interactive'

export type Filter = 'all' | 'write' | 'turn'

/** A cross-link a command creates: assume-role into another account, or kubeconfig for a cluster. */
export type Link =
  | { to: 'aws'; account: string; role?: string }
  | { to: 'k8s'; cluster: string; context?: string }

/** Scope as known when the command ran; gaps are filled from the caches at draw time. */
export type AwsScope = { profile: string; region?: string; account?: string }
export type KubeScope = { context?: string; namespace?: string }

export type EventBase = {
  id: number
  ts: number
  turnId: string | null
  verb: string
  resource?: string
  cls: Cls
  ok: boolean
  /** The whole Bash command, redacted. */
  cmd: string
  link?: Link
}

export type AwsEvent = EventBase & { tool: 'aws'; scope: AwsScope; service: string; isGlobal: boolean }
export type KubeEvent = EventBase & { tool: 'kubectl'; scope: KubeScope; kind: string }
export type MapEvent = AwsEvent | KubeEvent

export type ProfileInfo = { status: 'pending' | 'ok' | 'error'; account?: string; region?: string }
export type KubeInfo = { status: 'pending' | 'ok' | 'error'; current?: string; ns: Record<string, string> }

declare module 'claude-code' {
  interface PluginState {
    'footprint': {
      events: MapEvent[]
      seq: number
      turnId: string | null
      filter: Filter
      expanded: Record<string, boolean>
      selected: number | null
      profiles: Record<string, ProfileInfo>
      kube: KubeInfo | null
      unparsed: number
    }
  }
}
