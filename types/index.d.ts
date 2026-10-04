/** `unknown`: an MCP tool neither its server nor its name says is read-only. */
export type Cls = 'read' | 'write' | 'destructive' | 'cred' | 'interactive' | 'unknown'

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
  /** Which path the call took: a Bash command or an MCP tool. */
  source: 'cli' | 'mcp'
  /** What ran, for the detail pane: the redacted Bash command, or `tool key=value ...` with allowlisted args. */
  cmd: string
  /** The Bash tool's own one-line `description` of the call, redacted; MCP calls have none. */
  description?: string
  link?: Link
}

export type AwsEvent = EventBase & { tool: 'aws'; scope: AwsScope; service: string; isGlobal: boolean }
export type KubeEvent = EventBase & { tool: 'kubectl'; scope: KubeScope; kind: string }
/** An MCP call no adapter maps to aws/kubectl: `verb` is the tool name, `resource` the target arg. */
export type McpEvent = EventBase & { tool: 'mcp'; server: string }
export type MapEvent = AwsEvent | KubeEvent | McpEvent

export type ProfileInfo = { status: 'pending' | 'ok' | 'error'; account?: string; region?: string }
export type KubeInfo = { status: 'pending' | 'ok' | 'error'; current?: string; ns: Record<string, string> }

declare module 'claude-code' {
  interface PluginState {
    'footprint': {
      events: MapEvent[]
      turnId: string | null
      filter: Filter
      expanded: Record<string, boolean>
      /** Selected row key: every call behind it shows in the detail area. */
      selected: string | null
      profiles: Record<string, ProfileInfo>
      kube: KubeInfo | null
      unparsed: number
      /** Calls the history cap pushed out. */
      dropped: number
    }
  }
}
