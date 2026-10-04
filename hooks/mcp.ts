// Pure: one MCP tool call to what the map keeps. Arguments are never stored whole:
// only allowlisted identifier keys survive, so message bodies, scripts and payloads stay out.
import type { Cls } from '../types'

import { redact } from './parse'

export type McpCall = {
  server: string
  name: string
  cls: Cls
  /** The arg that names what the call touched: `deploy-api`, `orders-topic`. */
  target?: string
  /** `build_item name=deploy-api`, for the detail pane. */
  display: string
}

// Arguments `tool.call` carries beside the tool's own.
const RESERVED = new Set(['tool', 'tool_use_id', 'agentId'])

// Compared lowercased with `_` and `-` removed. Order is the target preference.
const ID_KEYS = [
  'name', 'fullname', 'jobname', 'job', 'topicname', 'topic', 'clustername', 'cluster', 'context', 'namespace',
  'repo', 'repository', 'owner', 'project', 'workspace', 'workspaceid', 'bucket', 'channel', 'channelid', 'pageid',
  'databaseid', 'issuekey', 'issue', 'number', 'branch', 'ref', 'id', 'region', 'profile', 'account', 'accountid',
  'environment', 'service', 'app', 'application', 'node', 'pod', 'deployment', 'path',
]
const ID_RANK = new Map(ID_KEYS.map((k, i) => [k, i]))
const MAX_VALUE = 60
const MAX_DISPLAY = 400

const READ = new Set(['get', 'list', 'search', 'describe', 'fetch', 'read', 'query', 'show', 'view', 'find', 'lookup', 'inspect', 'status', 'count', 'capture'])
// Worst verb wins, so a noun that doubles as a verb floods writes: `build` is out
// (`get_build_*`); `run` stays (`run_groovy_script`) at the cost of `get_run` noise.
const WRITE = new Set([
  'create', 'update', 'set', 'put', 'patch', 'post', 'send', 'add', 'edit', 'write', 'upload', 'apply', 'deploy', 'restart',
  'trigger', 'schedule', 'move', 'duplicate', 'rename', 'complete', 'start', 'stop', 'cancel', 'run', 'submit',
  'execute', 'exec', 'invoke', 'publish', 'approve', 'merge', 'mark', 'reply', 'comment', 'import', 'enable', 'disable', 'assign',
])
const DESTRUCTIVE = new Set(['delete', 'remove', 'kill', 'destroy', 'drop', 'purge', 'truncate', 'terminate', 'uninstall', 'wipe'])
const CRED = new Set(['token', 'tokens', 'secret', 'secrets', 'credential', 'credentials', 'password', 'apikey'])

/** `mcp__kafka-ui__kafka_ui_get_topic` → server `kafka-ui`, name `kafka_ui_get_topic`; split on the first `__`. */
export function splitTool(tool: string): { server: string; name: string } | undefined {
  if (!tool.startsWith('mcp__')) return undefined
  const rest = tool.slice(5)
  const at = rest.indexOf('__')
  if (at <= 0 || at + 2 >= rest.length) return undefined
  return { server: rest.slice(0, at), name: rest.slice(at + 2) }
}

const words = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[_\-.\s]+/)
    .filter(Boolean)

/**
 * The server's own read-only flag wins; else the worst verb in the name (`get_and_delete`
 * is destructive); else `unknown`, which never draws as read.
 */
export function classify(name: string, isReadOnly: boolean): Cls {
  if (isReadOnly) return 'read'
  const ws = words(name)
  if (ws.some(w => DESTRUCTIVE.has(w))) return 'destructive'
  if (ws.some(w => CRED.has(w))) return 'cred'
  if (ws.some(w => WRITE.has(w))) return 'write'
  if (ws.some(w => READ.has(w))) return 'read'
  return 'unknown'
}

const norm = (key: string) => key.toLowerCase().replace(/[_-]/g, '')

/** Allowlisted identifier args, in the call's order, values redacted; anything multi-line or long is dropped. */
export function pickArgs(args: Readonly<Record<string, unknown>>): [string, string][] {
  const out: [string, string][] = []
  for (const [key, raw] of Object.entries(args)) {
    if (RESERVED.has(key) || !ID_RANK.has(norm(key))) continue
    if (typeof raw !== 'string' && typeof raw !== 'number') continue
    const value = redact(String(raw)).trim()
    if (value === '' || value.includes('\n') || value.length > MAX_VALUE) continue
    out.push([key, value])
  }
  return out
}

export function mcpCall(tool: string, args: Readonly<Record<string, unknown>>, isReadOnly: boolean): McpCall | undefined {
  const split = splitTool(tool)
  if (!split) return undefined
  const kept = pickArgs(args)
  const target = [...kept].sort((a, b) => ID_RANK.get(norm(a[0]))! - ID_RANK.get(norm(b[0]))!)[0]?.[1]
  const display = [split.name, ...kept.map(([k, v]) => `${k}=${v}`)].join(' ').slice(0, MAX_DISPLAY)
  return { ...split, cls: classify(split.name, isReadOnly), ...(target !== undefined ? { target } : {}), display }
}

/**
 * Scope (a): writes and unknowns from every server, reads dropped until a server is
 * marked infra. Dropped here, not hidden at draw time: the history cap would let
 * chatty MCP reads push CLI writes off the map. The desktop app's own `ccd_*`
 * servers are UI bookkeeping (chapters, task chips), not infra.
 */
export const isKept = (call: McpCall) => call.cls !== 'read' && !call.server.startsWith('ccd_')

/** Claude.ai connector servers are UUIDs: first block only. */
export const shortServer = (server: string) => (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(server) ? `${server.slice(0, 8)}…` : server)
