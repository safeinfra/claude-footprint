// Pure parsing: no `$`, so the same code runs in hooks and in tests.
import type { Cls, Link } from '../types'

export type AwsAction = {
  tool: 'aws'
  profile?: string
  region?: string
  service: string
  verb: string
  resource?: string
  cls: Cls
  isGlobal: boolean
  link?: Link
}

export type KubeAction = {
  tool: 'kubectl'
  context?: string
  namespace?: string
  kind: string
  verb: string
  resource?: string
  cls: Cls
  /** Manifest files still to read (`-f path`); register.tsx expands them. */
  file?: string
  cwd?: string | null
  useContext?: string
  link?: Link
}

export type Action = AwsAction | KubeAction

export type Analysis = { actions: Action[]; unparsed: number }

type Command = { words: string[]; piped: boolean; stdin?: string }
type Lexed = { ok: true; commands: Command[]; nested: string[] } | { ok: false }

type Invocation = {
  tool: 'aws' | 'kubectl'
  args: string[]
  env: Record<string, string>
  cwd: string | null
  stdin?: string
}

export const ALL_NS = '*'
export const CLUSTER_NS = '(cluster)'

const MENTIONS = /\b(?:safe-)?(?:aws|kubectl)\b/
const TOOLS: Record<string, 'aws' | 'kubectl'> = {
  aws: 'aws',
  'safe-aws': 'aws',
  kubectl: 'kubectl',
  'safe-kubectl': 'kubectl',
}
const KEYWORDS = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'while', 'until', 'do'])

// ---------------------------------------------------------------- shell lexer

function matchParen(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === '\\') {
      i++
    } else if (c === "'") {
      const j = src.indexOf("'", i + 1)
      if (j < 0) return -1
      i = j
    } else if (c === '"') {
      let j = i + 1
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1
      if (j >= src.length) return -1
      i = j
    } else if (c === '(') {
      depth++
    } else if (c === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * Splits a shell command into simple commands on `&& || ; | & newline ( )`,
 * removing quotes and redirections. `$(...)` and backtick bodies are handed
 * back in `nested` so they are parsed as commands of their own. Heredoc
 * bodies become the declaring command's `stdin`.
 */
export function lex(src: string): Lexed {
  const commands: Command[] = []
  const nested: string[] = []
  let cur: Command = { words: [], piped: false }
  let word = ''
  let inWord = false
  let skipNext = false
  let heredocs: { delim: string; strip: boolean; cmd: Command }[] = []
  let i = 0
  const n = src.length

  const endWord = () => {
    if (inWord) {
      if (skipNext) skipNext = false
      else cur.words.push(word)
    }
    word = ''
    inWord = false
  }
  const endCmd = (piped = false) => {
    endWord()
    if (cur.words.length > 0) commands.push(cur)
    cur = { words: [], piped }
  }
  const sub = (start: number, end: number) => {
    nested.push(src.slice(start, end))
  }

  while (i < n) {
    const c = src[i]!
    if (c === '\\') {
      if (src[i + 1] === '\n') {
        i += 2
        continue
      }
      if (i + 1 < n) word += src[i + 1]
      inWord = true
      i += 2
      continue
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1)
      if (j < 0) return { ok: false }
      word += src.slice(i + 1, j)
      inWord = true
      i = j + 1
      continue
    }
    if (c === '"') {
      i++
      inWord = true
      for (;;) {
        if (i >= n) return { ok: false }
        const d = src[i]!
        if (d === '"') {
          i++
          break
        }
        if (d === '\\' && i + 1 < n && '"\\$`\n'.includes(src[i + 1]!)) {
          word += src[i + 1]
          i += 2
        } else if (d === '$' && src[i + 1] === '(') {
          const end = matchParen(src, i + 1)
          if (end < 0) return { ok: false }
          sub(i + 2, end)
          word += src.slice(i, end + 1)
          i = end + 1
        } else if (d === '`') {
          const j = src.indexOf('`', i + 1)
          if (j < 0) return { ok: false }
          sub(i + 1, j)
          word += src.slice(i, j + 1)
          i = j + 1
        } else {
          word += d
          i++
        }
      }
      continue
    }
    if (c === '$' && src[i + 1] === '(') {
      const end = matchParen(src, i + 1)
      if (end < 0) return { ok: false }
      sub(i + 2, end)
      word += src.slice(i, end + 1)
      inWord = true
      i = end + 1
      continue
    }
    if (c === '$' && src[i + 1] === '{') {
      const j = src.indexOf('}', i)
      if (j < 0) return { ok: false }
      word += src.slice(i, j + 1)
      inWord = true
      i = j + 1
      continue
    }
    if (c === '`') {
      const j = src.indexOf('`', i + 1)
      if (j < 0) return { ok: false }
      sub(i + 1, j)
      word += src.slice(i, j + 1)
      inWord = true
      i = j + 1
      continue
    }
    if (c === '#' && !inWord) {
      const j = src.indexOf('\n', i)
      i = j < 0 ? n : j
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord()
      i++
      continue
    }
    if (c === '\n') {
      endCmd()
      i++
      if (heredocs.length > 0) {
        i = readHeredocs(src, i, heredocs)
        heredocs = []
      }
      continue
    }
    if (c === ';' || c === '(' || c === ')') {
      endCmd()
      i++
      continue
    }
    if (c === '&') {
      if (src[i + 1] === '>') {
        endWord()
        i += src[i + 2] === '>' ? 3 : 2
        skipNext = true
        continue
      }
      endCmd()
      i += src[i + 1] === '&' ? 2 : 1
      continue
    }
    if (c === '|') {
      const isOr = src[i + 1] === '|'
      endCmd(!isOr)
      i += isOr || src[i + 1] === '&' ? 2 : 1
      continue
    }
    if (c === '>' || c === '<') {
      if (inWord && /^\d+$/.test(word)) {
        word = ''
        inWord = false
      } else {
        endWord()
      }
      if (c === '<' && src[i + 1] === '<') {
        if (src[i + 2] === '<') {
          i += 3
          skipNext = true
          continue
        }
        i += 2
        const strip = src[i] === '-'
        if (strip) i++
        while (src[i] === ' ' || src[i] === '\t') i++
        const m = /^(['"]?)([A-Za-z0-9_.-]+)\1/.exec(src.slice(i))
        if (!m) return { ok: false }
        heredocs.push({ delim: m[2]!, strip, cmd: cur })
        i += m[0].length
        continue
      }
      if (c === '<' && src[i + 1] === '(') {
        const end = matchParen(src, i + 1)
        if (end < 0) return { ok: false }
        sub(i + 2, end)
        i = end + 1
        continue
      }
      i++
      if (src[i] === '>' || src[i] === '|') i++
      if (src[i] === '&') {
        i++
        const m = /^(\d+|-)/.exec(src.slice(i))
        if (m) {
          i += m[0].length
          continue
        }
      }
      skipNext = true
      continue
    }
    word += c
    inWord = true
    i++
  }
  endCmd()
  return { ok: true, commands, nested }
}

function readHeredocs(
  src: string,
  start: number,
  docs: { delim: string; strip: boolean; cmd: Command }[],
): number {
  let i = start
  for (const doc of docs) {
    const body: string[] = []
    while (i < src.length) {
      const j = src.indexOf('\n', i)
      const end = j < 0 ? src.length : j
      let line = src.slice(i, end)
      if (doc.strip) line = line.replace(/^\t+/, '')
      i = end + 1
      if (line === doc.delim) break
      body.push(line)
    }
    doc.cmd.stdin = body.join('\n')
  }
  return Math.min(i, src.length)
}

// ---------------------------------------------------------------- invocations

const baseName = (w: string) => w.slice(w.lastIndexOf('/') + 1)
const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/

function joinPath(cwd: string | null, p: string): string {
  if (p.startsWith('/') || p.startsWith('~') || cwd === null) return p
  return `${cwd.replace(/\/$/, '')}/${p}`
}

/** Strips env assignments and wrappers (`sudo`, `env`, `timeout 30`, `aws-vault exec p --`). */
function unwrap(words: string[], local: Record<string, string>): string[] {
  const w = [...words]
  for (;;) {
    const h = w[0]
    if (h === undefined) return w
    if (KEYWORDS.has(h)) {
      w.shift()
      continue
    }
    const m = ASSIGN.exec(h)
    if (m) {
      local[m[1]!] = m[2]!
      w.shift()
      continue
    }
    switch (baseName(h)) {
      case 'env':
        w.shift()
        while (w[0]?.startsWith('-')) if (w.shift() === '-u') w.shift()
        continue
      case 'sudo':
        w.shift()
        while (w[0]?.startsWith('-')) if (/^-[ugpCDhrt]$/.test(w.shift()!)) w.shift()
        continue
      case 'time':
      case 'nohup':
      case 'command':
      case 'exec':
      case 'builtin':
        w.shift()
        while (w[0]?.startsWith('-')) w.shift()
        continue
      case 'timeout':
        w.shift()
        while (w[0]?.startsWith('-')) if (/^-[sk]$/.test(w.shift()!)) w.shift()
        w.shift()
        continue
      case 'nice':
        w.shift()
        if (w[0] === '-n') w.splice(0, 2)
        else if (/^-\d+$/.test(w[0] ?? '')) w.shift()
        continue
      case 'aws-vault':
        if (w[1] !== 'exec') return w
        w.splice(0, 2)
        while (w[0]?.startsWith('-')) w.shift()
        if (w[0] !== undefined) local.AWS_PROFILE = w.shift()!
        if (w[0] === '--') w.shift()
        continue
    }
    return w
  }
}

function invocations(
  src: string,
  depth: number,
  out: { list: Invocation[]; unparsed: number },
): void {
  if (depth > 4) return
  const lx = lex(src)
  if (!lx.ok) {
    if (MENTIONS.test(src)) out.unparsed++
    return
  }
  const env: Record<string, string> = {}
  let cwd: string | null = null
  lx.commands.forEach((cmd, index) => {
    const local: Record<string, string> = {}
    const w = unwrap(cmd.words, local)
    const head = w[0] === undefined ? '' : baseName(w[0])
    if (head === 'export') {
      for (const a of w.slice(1)) {
        const m = ASSIGN.exec(a)
        if (m) env[m[1]!] = m[2]!
      }
      return
    }
    if (head === 'unset') {
      for (const a of w.slice(1)) delete env[a]
      return
    }
    if (head === 'cd') {
      cwd = joinPath(cwd, w[1] ?? '~')
      return
    }
    if (head === 'bash' || head === 'sh' || head === 'zsh') {
      const k = w.findIndex(a => /^-[a-z]*c$/.test(a))
      const script = k > 0 ? w[k + 1] : undefined
      if (script !== undefined) invocations(script, depth + 1, out)
      return
    }
    const tool = TOOLS[head]
    if (!tool) return
    let stdin = cmd.stdin
    const prev = lx.commands[index - 1]
    if (stdin === undefined && cmd.piped && prev?.stdin !== undefined && baseName(prev.words[0] ?? '') === 'cat') {
      stdin = prev.stdin
    }
    out.list.push({ tool, args: w.slice(1), env: { ...env, ...local }, cwd, stdin })
  })
  for (const s of lx.nested) invocations(s, depth + 1, out)
}

// ---------------------------------------------------------------- option scan

type Opt = [string, string | true]
type Scan = { pos: string[]; opts: Opt[] }

function scan(args: string[], isBool: (flag: string) => boolean, shortValue: Set<string>): Scan {
  const pos: string[] = []
  const opts: Opt[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--') break
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=')
      if (eq > 0) {
        opts.push([a.slice(0, eq), a.slice(eq + 1)])
        continue
      }
      const nx = args[i + 1]
      if (!isBool(a) && nx !== undefined && (nx === '-' || !nx.startsWith('-'))) {
        opts.push([a, nx])
        i++
      } else {
        opts.push([a, true])
      }
      continue
    }
    if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
      const f = a.slice(0, 2)
      if (shortValue.has(f)) {
        if (a.length > 2) opts.push([f, a.slice(2).replace(/^=/, '')])
        else if (args[i + 1] !== undefined) opts.push([f, args[++i]!])
        else opts.push([f, true])
      } else {
        for (const ch of a.slice(1)) opts.push([`-${ch}`, true])
      }
      continue
    }
    pos.push(a)
  }
  return { pos, opts }
}

const optOf = (opts: Opt[], ...names: string[]): string | undefined => {
  let v: string | undefined
  for (const [k, val] of opts) if (names.includes(k) && typeof val === 'string') v = val
  return v
}
const hasOpt = (opts: Opt[], ...names: string[]) => opts.some(([k]) => names.includes(k))

// ---------------------------------------------------------------- aws

const AWS_BOOL = new Set([
  '--dry-run', '--dryrun', '--debug', '--recursive', '--delete', '--with-decryption', '--force',
  '--quiet', '--only-show-errors', '--exact-timestamps', '--follow', '--size-only',
  '--human-readable', '--summarize', '--cli-auto-prompt', '--generate-cli-skeleton',
  '--skip-final-snapshot', '--apply-immediately', '--force-delete-without-recovery',
  '--include-email', '--version', '--all-regions',
])
const awsBool = (f: string) => AWS_BOOL.has(f) || f.startsWith('--no-')

export const GLOBAL_SERVICES = new Set([
  'iam', 'sts', 'organizations', 'cloudfront', 'route53', 'route53domains', 'account', 'ce',
  'budgets', 'globalaccelerator', 'shield', 'waf', 'artifact', 'sso-admin', 'identitystore',
])

const CRED_OPS: Record<string, RegExp> = {
  ecr: /^(get-login-password|get-authorization-token)$/,
  'ecr-public': /^(get-login-password|get-authorization-token)$/,
  sts: /^(assume-role.*|get-session-token|get-federation-token)$/,
  secretsmanager: /^get-secret-value$/,
  eks: /^get-token$/,
  codeartifact: /^get-authorization-token$/,
  rds: /^generate-db-auth-token$/,
  iam: /^create-access-key$/,
  sso: /^(get-role-credentials|login)$/,
}

const READ_OP = /^(describe|list|get|head|lookup|search|scan|query|batch-get|filter|validate|estimate|simulate|wait|tail|select|check|preview|test)(-|$)/
const DESTRUCTIVE_OP = /^(delete|terminate|deregister|remove|detach|purge|batch-delete|revoke|disassociate)(-|$)/

/** aws verb class from the spec's prefix tables; unknown mutating verbs count as write. */
export function classifyAws(service: string, op: string, opts: Opt[] = []): Cls {
  if (CRED_OPS[service]?.test(op)) return 'cred'
  if (service === 'ssm' && /^get-parameters?(-by-path)?$/.test(op) && hasOpt(opts, '--with-decryption')) {
    return 'cred'
  }
  if (DESTRUCTIVE_OP.test(op)) return 'destructive'
  if (READ_OP.test(op)) return 'read'
  return 'write'
}

const AWS_RESOURCE_OPTS = [
  '--nodegroup-name', '--function-name', '--stack-name', '--table-name', '--queue-url', '--topic-arn',
  '--secret-id', '--role-name', '--user-name', '--policy-arn', '--role-arn', '--repository-name',
  '--db-instance-identifier', '--db-cluster-identifier', '--log-group-name', '--instance-ids',
  '--instance-id', '--load-balancer-arn', '--target-group-arn', '--hosted-zone-id', '--distribution-id',
  '--key-id', '--auto-scaling-group-name', '--state-machine-arn', '--stream-name', '--bucket',
  '--cluster', '--cluster-name', '--service', '--services', '--names', '--name', '--resource-arn',
  '--vpc-id', '--subnet-id', '--group-id', '--group-ids', '--id', '--arn',
]
const AWS_RESOURCE_LIKE = /-(name|names|id|ids|arn|identifier|url)$/

function awsResource(opts: Opt[]): string | undefined {
  for (const name of AWS_RESOURCE_OPTS) {
    const v = optOf(opts, name)
    if (v !== undefined) return v
  }
  for (const [k, v] of opts) {
    if (typeof v === 'string' && AWS_RESOURCE_LIKE.test(k) && k !== '--profile' && k !== '--region') return v
  }
  return undefined
}

const S3_HIGH = new Set(['ls', 'cp', 'mv', 'rm', 'sync', 'mb', 'rb', 'presign', 'website'])
const isS3Url = (s: string | undefined) => s?.startsWith('s3://') === true

function s3High(op: string, rest: string[], opts: Opt[]): { cls: Cls; resource?: string; isGlobal: boolean } {
  const [src, dst] = rest
  switch (op) {
    case 'ls':
      return src === undefined ? { cls: 'read', isGlobal: true } : { cls: 'read', resource: src, isGlobal: false }
    case 'rm':
    case 'rb':
      return { cls: 'destructive', resource: src, isGlobal: false }
    case 'mb':
    case 'website':
      return { cls: 'write', resource: src, isGlobal: false }
    case 'presign':
      return { cls: 'cred', resource: src, isGlobal: false }
  }
  // cp / mv / sync
  if (op === 'sync' && hasOpt(opts, '--delete')) return { cls: 'destructive', resource: dst, isGlobal: false }
  if (op === 'mv' && isS3Url(src)) return { cls: 'destructive', resource: src, isGlobal: false }
  if (isS3Url(src) && !isS3Url(dst)) return { cls: 'read', resource: src, isGlobal: false }
  return { cls: 'write', resource: dst ?? src, isGlobal: false }
}

const ROLE_ARN = /^arn:aws[\w-]*:iam::(\d{12}):role\/(.+)$/

export function parseAws(inv: Pick<Invocation, 'args' | 'env'>): AwsAction | 'skip' | null {
  const { pos, opts } = scan(inv.args, awsBool, new Set())
  const [service, op, ...rest] = pos
  if (service === undefined) return hasOpt(opts, '--version', '--help') ? 'skip' : null
  if (service === 'help' || op === 'help' || service === 'configure' || service === 'history') return 'skip'
  if (op === undefined) return null
  const profile = optOf(opts, '--profile') ?? inv.env.AWS_PROFILE
  const region = optOf(opts, '--region') ?? inv.env.AWS_REGION ?? inv.env.AWS_DEFAULT_REGION
  const base = { tool: 'aws' as const, profile, region, service, verb: op }

  if (service === 's3' && S3_HIGH.has(op)) return { ...base, ...s3High(op, rest, opts) }

  const action: AwsAction = {
    ...base,
    resource: awsResource(opts),
    cls: classifyAws(service, op, opts),
    isGlobal: GLOBAL_SERVICES.has(service) || (service === 's3api' && op === 'list-buckets'),
  }
  if (service === 'sts' && op.startsWith('assume-role')) {
    const arn = ROLE_ARN.exec(optOf(opts, '--role-arn') ?? '')
    if (arn) {
      action.link = { to: 'aws', account: arn[1]!, role: arn[2]! }
      action.resource = arn[2]
    }
  }
  if (service === 'eks' && op === 'update-kubeconfig') {
    // Only rewrites the local kubeconfig, so it is no write to the account.
    action.cls = 'read'
    const cluster = optOf(opts, '--name')
    if (cluster !== undefined) action.link = { to: 'k8s', cluster, context: optOf(opts, '--alias') }
  }
  return action
}

// ---------------------------------------------------------------- kubectl

const KUBE_BOOL = new Set([
  '--all', '--all-namespaces', '--force', '--watch', '--watch-only', '--follow', '--previous',
  '--overwrite', '--record', '--ignore-daemonsets', '--delete-emptydir-data', '--delete-local-data',
  '--show-labels', '--recursive', '--insecure-skip-tls-verify', '--stdin', '--tty', '--rm',
  '--quiet', '--now', '--local', '--server-side', '--force-conflicts', '--prune', '--timestamps',
  '--ignore-not-found', '--disable-eviction', '--list', '--current', '--minify', '--raw', '--flatten',
  '--version', '--help',
])
const kubeBool = (f: string) => KUBE_BOOL.has(f) || f.startsWith('--no-')
const KUBE_SHORT_VALUE = new Set(['-n', '-f', '-l', '-o', '-c', '-p', '-k', '-s'])
const KUBE_SHORT_VALUE_NO_P = new Set(['-n', '-f', '-l', '-o', '-c', '-k', '-s'])

const KUBE_CLS: Record<string, Cls> = {}
for (const v of ['get', 'describe', 'logs', 'top', 'explain', 'api-resources', 'api-versions', 'version',
  'cluster-info', 'wait', 'diff', 'kustomize', 'auth', 'config', 'events', 'options', 'completion']) KUBE_CLS[v] = 'read'
for (const v of ['apply', 'create', 'patch', 'scale', 'edit', 'label', 'annotate', 'rollout', 'set',
  'replace', 'autoscale', 'expose', 'run', 'taint', 'uncordon', 'certificate']) KUBE_CLS[v] = 'write'
for (const v of ['delete', 'drain', 'cordon']) KUBE_CLS[v] = 'destructive'
for (const v of ['exec', 'port-forward', 'cp', 'attach', 'debug', 'proxy']) KUBE_CLS[v] = 'interactive'

const SUB_VERBS = new Set(['rollout', 'config', 'set', 'auth', 'certificate', 'top'])

const KIND_ALIASES: Record<string, string> = {
  po: 'pods', pod: 'pods', svc: 'services', service: 'services', deploy: 'deployments',
  deployment: 'deployments', rs: 'replicasets', replicaset: 'replicasets', sts: 'statefulsets',
  statefulset: 'statefulsets', ds: 'daemonsets', daemonset: 'daemonsets', cm: 'configmaps',
  configmap: 'configmaps', secret: 'secrets', ns: 'namespaces', namespace: 'namespaces',
  no: 'nodes', node: 'nodes', ing: 'ingresses', ingress: 'ingresses', job: 'jobs', cj: 'cronjobs',
  cronjob: 'cronjobs', pv: 'persistentvolumes', pvc: 'persistentvolumeclaims', sa: 'serviceaccounts',
  serviceaccount: 'serviceaccounts', ep: 'endpoints', ev: 'events', event: 'events',
  hpa: 'horizontalpodautoscalers', crd: 'customresourcedefinitions', crds: 'customresourcedefinitions',
  sc: 'storageclasses', netpol: 'networkpolicies', pdb: 'poddisruptionbudgets', role: 'roles',
  rolebinding: 'rolebindings', clusterrole: 'clusterroles', clusterrolebinding: 'clusterrolebindings',
  quota: 'resourcequotas', limits: 'limitranges', csr: 'certificatesigningrequests',
}

export const CLUSTER_KINDS = new Set([
  'nodes', 'namespaces', 'persistentvolumes', 'clusterroles', 'clusterrolebindings',
  'customresourcedefinitions', 'storageclasses', 'apiservices', 'mutatingwebhookconfigurations',
  'validatingwebhookconfigurations', 'priorityclasses', 'ingressclasses', 'csidrivers',
  'runtimeclasses', 'certificatesigningrequests', 'cluster',
])

/** `po`, `Pod`, `pods.v1.` and `Deployment` to the plural lowercase name kubectl lists. */
export function normalizeKind(raw: string): string {
  const k = raw.toLowerCase().split('.')[0]!
  const alias = KIND_ALIASES[k]
  if (alias) return alias
  if (k === 'all' || k.endsWith('s') && !k.endsWith('ss')) return k
  if (/[^aeiou]y$/.test(k)) return `${k.slice(0, -1)}ies`
  if (/(ss|sh|ch|x)$/.test(k)) return `${k}es`
  return `${k}s`
}

export type ManifestDoc = { kind: string; name?: string; namespace?: string }

/** kind/name/namespace of each document in a YAML or JSON manifest; values only, nothing else kept. */
export function parseManifest(text: string): ManifestDoc[] {
  const out: ManifestDoc[] = []
  const t = text.trim()
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t) as { kind?: string; items?: unknown[]; metadata?: { name?: string; namespace?: string } }
      const items = (j.kind === 'List' ? j.items ?? [] : [j]) as typeof j[]
      for (const it of items) {
        if (typeof it?.kind === 'string') {
          out.push({ kind: it.kind, name: it.metadata?.name, namespace: it.metadata?.namespace })
        }
      }
    } catch {
      // Not JSON after all; nothing to show.
    }
    return out.slice(0, 50)
  }
  for (const doc of text.split(/^---.*$/m)) {
    const kind = /^kind:[ \t]*["']?([A-Za-z0-9]+)/m.exec(doc)?.[1]
    if (kind === undefined || kind === 'List') continue
    const meta = /^metadata:[ \t]*\n((?:[ \t]+.*(?:\n|$))*)/m.exec(doc)?.[1] ?? ''
    const indent = /^([ \t]+)/.exec(meta)?.[1] ?? '  '
    const field = (f: string) =>
      new RegExp(`^${indent}${f}:[ \\t]*["']?([^"'\\s#]+)`, 'm').exec(meta)?.[1]
    out.push({ kind, name: field('name'), namespace: field('namespace') })
  }
  return out.slice(0, 50)
}

type Target = { kind: string; name?: string; ns?: string }

function targets(rest: string[], fallbackKind?: string): Target[] {
  const first = rest[0]
  if (first === undefined) return fallbackKind ? [{ kind: fallbackKind }] : []
  if (first.includes('/')) {
    // Only the leading kind/name run: later args (`c=repo/img:tag`) are not targets.
    const out: Target[] = []
    for (const r of rest) {
      if (!r.includes('/') || r.includes('=') || r.includes(':')) break
      const [k, ...name] = r.split('/')
      out.push({ kind: normalizeKind(k!), name: name.join('/') })
    }
    return out
  }
  if (fallbackKind) return [{ kind: fallbackKind, name: first }]
  const kinds = first.split(',').filter(Boolean)
  return kinds.map(k => ({ kind: normalizeKind(k), name: kinds.length === 1 ? rest[1] : undefined }))
}

const SECRET_OUTPUT = /^(yaml|json|jsonpath|go-template|template)/

export function parseKubectl(inv: Pick<Invocation, 'args' | 'cwd' | 'stdin'>): KubeAction[] | 'skip' | null {
  const guess = inv.args.find(a => KUBE_CLS[a] !== undefined)
  const isLogs = guess === 'logs' || guess === 'exec' || guess === 'attach'
  const { pos, opts } = scan(inv.args, kubeBool, isLogs ? KUBE_SHORT_VALUE_NO_P : KUBE_SHORT_VALUE)
  const verb0 = pos[0]
  if (verb0 === undefined) return hasOpt(opts, '--version', '--help', '-h') ? 'skip' : null
  const base = KUBE_CLS[verb0]
  if (base === undefined) return verb0 === 'help' || verb0 === 'plugin' ? 'skip' : null

  const rest = pos.slice(1)
  const sub = SUB_VERBS.has(verb0) ? rest.shift() : undefined
  const verb = sub === undefined ? verb0 : `${verb0} ${sub}`
  const context = optOf(opts, '--context')
  const nsFlag = optOf(opts, '-n', '--namespace')
  const isAll = hasOpt(opts, '-A', '--all-namespaces')
  const files = opts.filter(([k, v]) => (k === '-f' || k === '--filename') && typeof v === 'string').map(([, v]) => v as string)
  const kustomize = optOf(opts, '-k', '--kustomize')

  let cls: Cls = base
  if (verb0 === 'rollout' && (sub === 'status' || sub === 'history')) cls = 'read'
  if (verb0 === 'run' && hasOpt(opts, '-i', '-t', '--stdin', '--tty')) cls = 'interactive'

  const nsOf = (kind: string, own?: string) =>
    CLUSTER_KINDS.has(kind) ? CLUSTER_NS : own ?? (isAll ? ALL_NS : nsFlag)
  const make = (t: Target, c: Cls = cls): KubeAction => ({
    tool: 'kubectl', context, namespace: nsOf(t.kind, t.ns), kind: t.kind, verb, resource: t.name, cls: c,
  })

  if (verb0 === 'config') {
    return [{
      tool: 'kubectl', context, namespace: CLUSTER_NS, kind: 'config', verb, resource: rest[0], cls: 'read',
      useContext: sub === 'use-context' ? rest[0] : undefined,
    }]
  }
  if (['auth', 'version', 'cluster-info', 'api-resources', 'api-versions', 'options', 'completion'].includes(verb0)) {
    return [make({ kind: 'cluster', name: sub === 'can-i' ? rest.join(' ') || undefined : undefined }, 'read')]
  }

  if (files.length > 0 || kustomize !== undefined) {
    const out: KubeAction[] = []
    for (const f of files) {
      if (f === '-' && inv.stdin !== undefined) {
        for (const d of parseManifest(inv.stdin)) {
          const kind = normalizeKind(d.kind)
          out.push(make({ kind, name: d.name, ns: d.namespace }))
        }
      } else if (f === '-' || /^https?:\/\//.test(f)) {
        out.push(make({ kind: 'manifest', name: f === '-' ? 'stdin' : f }))
      } else {
        out.push({ ...make({ kind: 'manifest', name: baseName(f.replace(/\/$/, '')) || f }), file: f, cwd: inv.cwd })
      }
    }
    if (kustomize !== undefined) out.push(make({ kind: 'kustomization', name: kustomize }))
    return out.length > 0 ? out : [make({ kind: 'manifest', name: 'stdin' })]
  }

  let list: Target[]
  switch (verb0) {
    case 'logs':
    case 'exec':
    case 'attach':
    case 'port-forward':
    case 'debug':
      list = targets(rest.slice(0, 1), 'pods')
      if (rest[0]?.includes('/')) list = targets(rest.slice(0, 1))
      break
    case 'cp': {
      const spec = rest.find(r => /^[^/.][^:]*:/.test(r))
      const podPart = spec?.slice(0, spec.indexOf(':'))
      const [a, b] = podPart?.split('/') ?? []
      list = [b === undefined ? { kind: 'pods', name: a } : { kind: 'pods', name: b, ns: a }]
      break
    }
    case 'drain':
    case 'cordon':
    case 'uncordon':
      list = [{ kind: 'nodes', name: rest[0] }]
      break
    case 'top':
      list = [{ kind: normalizeKind(sub ?? 'pods'), name: rest[0] }]
      break
    case 'run':
      list = [{ kind: 'pods', name: rest[0] }]
      break
    case 'create': {
      const t = rest[0]
      if (t === undefined) return null
      const kind = normalizeKind(t)
      const hasSubtype = kind === 'secrets' || kind === 'services'
      const name = hasSubtype ? rest[2] : rest[1]
      if (t === 'token') return [make({ kind: 'serviceaccounts', name: rest[1] }, 'cred')]
      list = [{ kind, name }]
      break
    }
    case 'explain':
      list = [{ kind: normalizeKind(rest[0] ?? 'unknown') }]
      break
    default:
      list = targets(rest)
  }
  if (list.length === 0) return null
  return list.map(t => {
    const output = optOf(opts, '-o', '--output') ?? ''
    const isSecretDump = verb0 === 'get' && t.kind === 'secrets' && SECRET_OUTPUT.test(output)
    return make(t, isSecretDump ? 'cred' : cls)
  })
}

// ---------------------------------------------------------------- entry

/** Every aws/kubectl action in one Bash command, and how many mentions could not be parsed. */
export function analyze(command: string): Analysis {
  const found = { list: [] as Invocation[], unparsed: 0 }
  invocations(command, 0, found)
  const actions: Action[] = []
  let unparsed = found.unparsed
  for (const inv of found.list) {
    const parsed = inv.tool === 'aws' ? parseAws(inv) : parseKubectl(inv)
    if (parsed === 'skip') continue
    if (parsed === null) unparsed++
    else if (Array.isArray(parsed)) actions.push(...parsed)
    else actions.push(parsed)
  }
  for (const a of actions) if (a.resource !== undefined) a.resource = redact(a.resource)
  return { actions, unparsed }
}

// ---------------------------------------------------------------- redaction

const QUOTED = `'[^']*'|"(?:\\\\.|[^"\\\\])*"`
const SECRET_OPT = new RegExp(
  `(--(?:[a-z0-9]+-)*(?:password|passwd|token|secret-string|secret-binary|private-key|client-secret|session-token|secret-access-key|access-key-id|auth-token|api-key|cli-input-json|cli-input-yaml)(?:=|\\s+))(${QUOTED}|[^\\s;&|]+)`,
  'gi',
)
const MULTI_SECRET_OPT = new RegExp(
  `(--parameter-overrides(?:=|\\s+))((?:${QUOTED}|[^\\s;&|]+)(?:\\s+(?![-;&|])(?:${QUOTED}|[^\\s;&|]+))*)`,
  'gi',
)
const FROM_LITERAL = new RegExp(`(--from-literal(?:=|\\s+))(${QUOTED}|[^\\s=]+=(?:${QUOTED}|\\S*)|\\S+)`, 'g')
const ENV_SECRET = new RegExp(
  `(?<![\\w-])([A-Za-z_][A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*)=(${QUOTED}|[^\\s;&|]*)`,
  'gi',
)
const SSM_VALUE = new RegExp(`(\\bput-parameter\\b[^;&|]*?--value(?:=|\\s+))(${QUOTED}|[^\\s;&|]+)`, 'g')
const BEARER = /(Authorization:\s*(?:Bearer|Basic|token)\s+)[^\s'"]+/gi
const ACCESS_KEY = /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g

/** The command with secret values masked, safe to keep in state and show. */
export function redact(command: string): string {
  return command
    .replace(SECRET_OPT, '$1***')
    .replace(MULTI_SECRET_OPT, '$1***')
    .replace(FROM_LITERAL, (_m, pre: string, value: string) => {
      const q = value[0] === "'" || value[0] === '"' ? value[0] : ''
      const inner = q ? value.slice(1, -1) : value
      const eq = inner.indexOf('=')
      return eq < 0 ? `${pre}***` : `${pre}${q}${inner.slice(0, eq)}=***${q}`
    })
    .replace(SSM_VALUE, '$1***')
    .replace(ENV_SECRET, '$1=***')
    .replace(BEARER, '$1***')
    .replace(ACCESS_KEY, '$1****************')
}
