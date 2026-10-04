// claude plugin test: the mod as the engine loads it, the world beneath stubbed per test.
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const SESSION = { surface: 'terminal' as const, isInteractive: true, cwd: '/work' }
const SURFACES = ['terminal', 'desktop'] as const

type World = {
  /** Sees the Bash command, or the tool name for any other tool. */
  fails?: (command: string) => boolean
  denies?: (command: string) => boolean
  /** Tools whose server declares them read-only. */
  readOnly?: (tool: string) => boolean
  run?: (argv: readonly string[]) => { exitCode: number; stdout: string }
  files?: Record<string, string>
  env?: Record<string, string>
  narrow?: boolean
}

function world(on: On, w: World = {}) {
  mock.env(on, w.env ?? {})
  const clock = mock.clock(on, { now: 1_000 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.id', () => ({ value: 'sess-1' }))
  const written: Record<string, string> = {}
  on('fs.write', ($, e) => {
    written[e.path] = e.text
    return { value: undefined }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('tool.call', ($, e) => {
    const command = e.tool === 'Bash' ? e.command : e.tool
    if (w.denies?.(command)) return { deny: 'no' }
    if (w.fails?.(command)) return { isError: true as const, result: 'boom', text: 'boom' }
    const ro = w.readOnly?.(e.tool) ? { isReadOnly: true as const } : {}
    return { result: { stdout: 'SECRET-OUTPUT', stderr: '', interrupted: false }, ...ro }
  })
  on('process.run', ($, e) => ({ value: { stderr: '', isStdoutTruncated: false, isStderrTruncated: false, ...(w.run?.(e.argv) ?? { exitCode: 1, stdout: '' }) } }))
  on('fs.read', ($, e) => {
    const text = w.files?.[e.path]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Text } = await $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  const panes = new Set<string>()
  const opened: string[] = []
  on('ui.open', ($, e) => {
    opened.push(e.id)
    if (w.narrow) return { value: { isPlaced: false as const, reason: 'narrow' } }
    panes.add(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', ($, e) => {
    panes.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: [...panes].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })),
  }))
  return { clock, panes, opened, written }
}

const pane = (bodyColumns = 80) => ({
  plugin: 'footprint',
  component: 'Pane' as const,
  requestId: 'footprint',
  viewport: { columns: 160, rows: 40 },
  props: { title: 'Footprint', isFocused: false, bodyColumns, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} },
})

const map = (args = '') => ({
  command: 'map',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 160 },
})

const texts = async (ui: { findAll: (q: { type?: string }) => Promise<{ text: string }[]> }) =>
  (await ui.findAll({ type: 'Box' })).map(b => b.text)

const ACCOUNTS: Record<string, string> = { 'acct-a': '123456789012', 'acct-a-admin': '123456789012', 'acct-b': '210987654321' }
const REGIONS: Record<string, string> = { 'acct-a': 'ap-northeast-1', 'acct-a-admin': 'ap-northeast-1', 'acct-b': 'us-east-1' }

/** The host's aws and kubectl answering the mod's lookups. */
function hostRun(argv: readonly string[]): { exitCode: number; stdout: string } {
  const [bin, a, b, , profile] = argv
  if (bin === 'aws' && a === 'sts' && b === 'get-caller-identity') {
    const account = ACCOUNTS[profile ?? '']
    return account
      ? { exitCode: 0, stdout: JSON.stringify({ UserId: 'AID:me', Account: account, Arn: `arn:aws:sts::${account}:assumed-role/Admin/me` }) }
      : { exitCode: 255, stdout: '' }
  }
  if (bin === 'aws' && a === 'configure') {
    const region = REGIONS[argv[5] ?? '']
    return region ? { exitCode: 0, stdout: `${region}\n` } : { exitCode: 1, stdout: '' }
  }
  if (bin === 'kubectl' && b === 'current-context') return { exitCode: 0, stdout: 'prod-eks\n' }
  if (bin === 'kubectl' && b === 'view') return { exitCode: 0, stdout: 'prod-eks\tweb\nstaging\t\n' }
  return { exitCode: 1, stdout: '' }
}

async function twoAccountsOneCluster($: Engine, on: On) {
  const w = world(on, { run: hostRun })
  await $.session.start(SESSION)
  await w.clock.settle()
  await $.turn.start({ text: 'one', turnId: 't1' })
  for (const command of [
    'aws --profile acct-a ec2 describe-instances',
    'aws --profile acct-a ec2 terminate-instances --instance-ids i-0abc',
    'aws --profile acct-a iam list-roles',
    'aws --profile acct-b ec2 describe-vpcs',
    'aws --profile acct-b s3 ls s3://logs',
  ]) {
    await $.tool.call({ tool: 'Bash', command })
  }
  await $.turn.start({ text: 'two', turnId: 't2' })
  await $.tool.call({ tool: 'Bash', command: 'kubectl --context prod-eks -n web get pods' })
  await $.tool.call({ tool: 'Bash', command: 'kubectl --context prod-eks -n web create secret generic db --from-literal=password=hunter2' })
  await w.clock.settle()
  return w
}

type Engine = import('claude-code/testing').Engine

test('the mod never draws above the prompt', async ($, on) => {
  world(on)
  await $.session.start(SESSION)
  await $.tool.call({ tool: 'Bash', command: 'aws --profile a ec2 delete-vpc --vpc-id v' })
  const ui = await $.ui.mount({
    plugin: 'footprint',
    component: 'AbovePrompt' as const,
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
    surface: 'terminal',
  })
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toEqual(['engine band'])
  await ui.unmount()
})

test('no infra calls and denied calls are not recorded', async ($, on) => {
  world(on, { denies: c => c.includes('delete') })
  await $.session.start(SESSION)
  await $.tool.call({ tool: 'Bash', command: 'ls -la && git status' })
  await $.tool.call({ tool: 'Bash', command: 'aws --profile a ec2 delete-vpc --vpc-id v' })
  expect(await paneText($)).toContain('No aws, kubectl or MCP calls yet.')
})


test('pane: sections by outcome, LOOKED AT folded to one line', async ($, on) => {
  await twoAccountsOneCluster($, on)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...pane(), surface })
    const all = (await texts(ui)).join('\n')
    expect(all).toContain('CHANGED (2)')
    expect(all).toContain('AWS account 123456789012 · ap-northeast-1')
    expect(all).toContain('ec2 i-0abc  terminate-instances, worked')
    expect(all).toContain('secret db  create, worked')
    expect(all).toContain('LOOKED AT (5) · ec2, iam, s3, pods')
    expect(all).not.toContain('210987654321')
    expect(await ui.find({ type: 'Button', text: /^LOOKED AT/ })).toMatchObject({ props: { hotkey: 'l', plain: true } })
    await ui.unmount()
  }
})

test('pane: LOOKED AT opens and folds', async ($, on) => {
  await twoAccountsOneCluster($, on)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await ui.press({ key: 'section-looked' })
  const all = (await texts(ui)).join('\n')
  expect(all).toContain('AWS account 210987654321 · us-east-1')
  expect(all).toContain('describe-vpcs, worked')
  expect(all).toContain('ran without error; results are not recorded')
  await ui.press({ key: 'section-looked' })
  expect((await texts(ui)).join('\n')).not.toContain('describe-vpcs')
  await ui.unmount()
})

test('pane: write and turn filters', async ($, on) => {
  await twoAccountsOneCluster($, on)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await ui.press({ key: 'filter-write' })
  expect((await texts(ui)).join('\n')).not.toContain('LOOKED AT')
  await ui.press({ key: 'filter-turn' })
  const turn = (await texts(ui)).join('\n')
  expect(turn).toContain('Kubernetes prod-eks · namespace web')
  expect(turn).not.toContain('AWS account')
  await ui.press({ key: 'filter-all' })
  expect((await texts(ui)).join('\n')).toContain('AWS account')
  await ui.unmount()
})

test('pane: selecting a row lists every call behind it, redacted, never the output', async ($, on) => {
  await twoAccountsOneCluster($, on)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  const row = await ui.find({ type: 'Button', text: /secret db/ })
  expect(row).toBeDefined()
  await ui.press({ key: row!.key! })
  const all = (await texts(ui)).join('\n')
  expect(all).toContain('secret db · create · 1 call')
  expect((await ui.find({ key: 'detail-call-0' }))?.text).toMatch(/^ {2}\d\d:\d\d {2}worked$/)
  expect((await ui.find({ key: 'detail-cmd-0' }))?.text).toBe('    kubectl --context prod-eks -n web create secret generic db --from-literal=password=***')
  expect(all).not.toContain('hunter2')
  expect(all).not.toContain('SECRET-OUTPUT')
  await ui.unmount()
})

test('pane: detail adds the aws profile only when the command does not name it', async ($, on) => {
  const w = world(on, { run: hostRun, fails: c => c.includes('acct-a-admin'), env: { AWS_PROFILE: 'acct-a' } })
  await $.session.start(SESSION)
  await $.tool.call({ tool: 'Bash', command: 'aws --profile acct-a-admin ec2 describe-vpcs' })
  await $.tool.call({ tool: 'Bash', command: 'aws ec2 describe-vpcs' })
  await w.clock.settle()
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await ui.press({ key: 'section-looked' })
  const row = await ui.find({ type: 'Button', text: /ec2/ })
  await ui.press({ key: row!.key! })
  const all = (await texts(ui)).join('\n')
  expect(all).toContain('ec2  describe-vpcs, 2 calls, last worked')
  expect(all).toContain('ec2 · describe-vpcs · 2 calls, 2 different commands')
  expect((await ui.find({ key: 'detail-call-0' }))?.text).toMatch(/^ {2}\d\d:\d\d {2}failed$/)
  expect((await ui.find({ key: 'detail-call-1' }))?.text).toMatch(/^ {2}\d\d:\d\d {2}worked {2}profile acct-a$/)
  await ui.unmount()
})

test('pane: detail shows the Bash description beside each call', async ($, on) => {
  world(on)
  await $.session.start(SESSION)
  await $.tool.call({ tool: 'Bash', command: 'aws --profile a rds describe-db-instances', description: 'List RDS instances ghp_abcdefghijklmnopqrstuvwxyz0123456789' })
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await ui.press({ key: 'section-looked' })
  await ui.press({ key: (await ui.find({ type: 'Button', text: /rds/ }))!.key! })
  expect((await ui.find({ key: 'detail-call-0' }))?.text).toMatch(/^ {2}\d\d:\d\d {2}worked {2}List RDS instances \*\*\*$/)
  await ui.unmount()
})

test('/map export writes every call as JSON lines outside the repo', async ($, on) => {
  const w = world(on, { env: { HOME: '/home/me' }, fails: c => c.includes('delete') })
  const clipboard: string[] = []
  let isRefused = false
  on('ui.copy', ($, e) => {
    if (isRefused) return { value: { isCopied: false as const, reason: 'no-clipboard' as const } }
    clipboard.push(e.text)
    return { value: { isCopied: true as const } }
  })
  await $.session.start(SESSION)
  expect((await $.command.run(map('export'))).text).toBe('Footprint: nothing to export yet.')
  await $.tool.call({ tool: 'Bash', command: 'aws --profile a ec2 describe-vpcs', description: 'List VPCs' })
  await $.tool.call({ tool: 'Bash', command: 'aws --profile a ec2 delete-vpc --vpc-id v-1' })
  expect((await $.command.run(map('export'))).text).toBe(
    'Footprint: 2 calls written to /home/me/.claude/footprint/trace-sess-1.jsonl. Path copied.',
  )
  expect(clipboard).toEqual(['/home/me/.claude/footprint/trace-sess-1.jsonl'])
  isRefused = true
  expect((await $.command.run(map('export'))).text).toEndWith('.jsonl. Path not copied (no-clipboard).')
  const lines = w.written['/home/me/.claude/footprint/trace-sess-1.jsonl']!.trim().split('\n').map(l => JSON.parse(l))
  expect(lines).toHaveLength(2)
  expect(lines[0]).toMatchObject({ outcome: 'worked', class: 'read', tool: 'aws', profile: 'a', object: 'ec2', operation: 'describe-vpcs', description: 'List VPCs' })
  expect(lines[1]).toMatchObject({ outcome: 'failed', class: 'destructive', object: 'ec2 v-1', command: 'aws --profile a ec2 delete-vpc --vpc-id v-1' })
  expect(JSON.stringify(lines)).not.toContain('SECRET-OUTPUT')
})

test('/map toggles the pane; filters open it', async ($, on) => {
  const w = world(on)
  await $.session.start(SESSION)
  expect((await $.command.run(map())).text).toBe('Footprint pane opened.')
  expect(w.panes.has('footprint')).toBe(true)
  expect((await $.command.run(map())).text).toBe('Footprint pane closed.')
  expect(w.panes.has('footprint')).toBe(false)
  expect((await $.command.run(map('write'))).text).toBe('Footprint: showing write.')
  expect(w.panes.has('footprint')).toBe(true)
  expect((await $.command.run(map('nope'))).text).toContain('/map toggles the pane')
})

test('/map on a narrow terminal says so and keeps recording', async ($, on) => {
  const w = world(on, { narrow: true })
  await $.session.start(SESSION)
  await $.tool.call({ tool: 'Bash', command: 'aws --profile a ec2 describe-vpcs' })
  expect((await $.command.run(map())).text).toContain('too narrow')
  expect(w.panes.has('footprint')).toBe(false)
  expect(await paneText($)).toContain('ec2  describe-vpcs, worked')
})

test('/map clear empties the map; /map collapse folds LOOKED AT', async ($, on) => {
  await twoAccountsOneCluster($, on)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await ui.press({ key: 'section-looked' })
  expect((await $.command.run(map('collapse'))).text).toBe('Footprint: LOOKED AT folded.')
  expect((await ui.find({ key: 'section-looked' }))?.text).toBe('LOOKED AT (5) · ec2, iam, s3, pods')
  await $.command.run(map('clear'))
  expect((await texts(ui)).join('\n')).toContain('No aws, kubectl or MCP calls yet.')
  await ui.unmount()
})

test('history cap: the pane says older calls were dropped', async ($, on) => {
  world(on)
  await $.session.start(SESSION)
  for (let i = 0; i < 501; i++) await $.tool.call({ tool: 'Bash', command: `aws --profile a ec2 describe-vpcs --vpc-ids v-${i}` })
  expect(await paneText($)).toContain('older calls dropped')
  await $.command.run(map('clear'))
  expect(await paneText($)).not.toContain('older calls dropped')
})

/** Pane text below the filter bar, LOOKED AT opened. */
async function paneText($: Engine): Promise<string> {
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  if ((await ui.find({ key: 'section-looked' }))?.text.includes(' · ')) await ui.press({ key: 'section-looked' })
  const all = (await texts(ui)).slice(1).join('\n')
  await ui.unmount()
  return all
}

test('scope: two profiles on one account merge; the caller ARN is never kept', async ($, on) => {
  const w = world(on, { run: hostRun })
  await $.session.start(SESSION)
  await $.tool.call({ tool: 'Bash', command: 'aws --profile acct-a ec2 describe-vpcs' })
  await $.tool.call({ tool: 'Bash', command: 'aws --profile acct-a-admin ec2 delete-vpc --vpc-id vpc-1' })
  await w.clock.settle()
  const all = await paneText($)
  expect(all.split('\n').filter(l => l.includes('AWS account 123456789012 · ap-northeast-1'))).toHaveLength(2)
  expect(all).not.toContain('acct-a')
  expect(all).not.toContain('assumed-role')
})

test('scope: process AWS_PROFILE/AWS_REGION apply when the command names none', async ($, on) => {
  const w = world(on, { run: hostRun, env: { AWS_PROFILE: 'acct-b', AWS_REGION: 'eu-west-1' } })
  await $.session.start(SESSION)
  await $.tool.call({ tool: 'Bash', command: 'aws ec2 describe-vpcs' })
  await w.clock.settle()
  expect(await paneText($)).toContain('AWS account 210987654321 · eu-west-1')
})

test('scope: an unresolvable profile says account unknown and region unknown', async ($, on) => {
  const w = world(on, { run: hostRun })
  await $.session.start(SESSION)
  await $.tool.call({ tool: 'Bash', command: 'aws --profile ghost ec2 describe-vpcs' })
  await w.clock.settle()
  expect(await paneText($)).toContain('AWS profile ghost · account unknown · region unknown')
})

test('kubectl: default namespace from the kubeconfig; use-context pins earlier rows', async ($, on) => {
  const w = world(on, { run: hostRun })
  await $.session.start(SESSION)
  await $.tool.call({ tool: 'Bash', command: 'kubectl delete pod web-1' })
  await w.clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'kubectl config use-context staging' })
  await $.tool.call({ tool: 'Bash', command: 'kubectl scale deploy api --replicas 0' })
  await w.clock.settle()
  const all = await paneText($)
  expect(all).toMatch(/Kubernetes prod-eks · namespace web\n\s+pod web-1 {2}delete, worked/)
  expect(all).toMatch(/Kubernetes staging · namespace default\n\s+deployment api {2}scale, worked/)
})

test('kubectl -f: kind and name come from the manifest file', async ($, on) => {
  const w = world(on, {
    run: hostRun,
    files: {
      '/work/deploy/api.yaml': 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\n  namespace: edge\n---\nkind: ClusterRole\nmetadata:\n  name: reader\n',
    },
  })
  await $.session.start(SESSION)
  await $.tool.call({ tool: 'Bash', command: 'cd deploy && kubectl --context prod-eks apply -f api.yaml' })
  await $.tool.call({ tool: 'Bash', command: 'kubectl --context prod-eks apply -f missing.yaml' })
  await w.clock.settle()
  const all = await paneText($)
  expect(all).toMatch(/namespace edge\n\s+deployment api {2}apply, worked/)
  expect(all).toMatch(/cluster-wide\n\s+clusterrole reader {2}apply, worked/)
  expect(all).toContain('manifest missing.yaml  apply, worked')
})

test('edges: assume-role and update-kubeconfig say what they open, under their row', async ($, on) => {
  const w = world(on, { run: hostRun })
  await $.session.start(SESSION)
  await $.tool.call({ tool: 'Bash', command: 'aws --profile acct-b sts get-caller-identity' })
  await $.tool.call({ tool: 'Bash', command: 'aws --profile acct-a sts assume-role --role-arn arn:aws:iam::210987654321:role/Deploy --role-session-name s' })
  await $.tool.call({ tool: 'Bash', command: 'aws --profile acct-a eks update-kubeconfig --name prod-eks' })
  await w.clock.settle()
  const all = await paneText($)
  expect(all).toMatch(/sts Deploy {2}assume-role, worked\n\s+opens AWS account 210987654321, role Deploy/)
  expect(all).toMatch(/eks prod-eks {2}update-kubeconfig, worked\n\s+opens Kubernetes prod-eks/)
})

test('a failed change sits under FAILED and says it was a change; colour stays the class', async ($, on) => {
  const w = world(on, { run: hostRun, fails: c => c.includes('s3://b') })
  await $.session.start(SESSION)
  await $.tool.call({ tool: 'Bash', command: 'aws --profile acct-a s3 rm s3://b/k' })
  await $.tool.call({ tool: 'Bash', command: 'aws --profile acct-a s3 ls s3://b' })
  await w.clock.settle()
  const all = await paneText($)
  expect(all).toMatch(/FAILED, NEVER SUCCEEDED \(2\)\n\s+AWS account 123456789012 · ap-northeast-1\n\s+s3 s3:\/\/b\/k {2}rm \(change\), failed/)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: 'rm (change), failed' }))?.props.color).toBe('red')
  expect((await ui.find({ type: 'Text', text: 'ls, failed' }))?.props.color).toBeUndefined()
  await ui.unmount()
})

test('mcp: writes and unknowns drawn, reads and denied calls dropped', async ($, on) => {
  world(on, { readOnly: t => t.endsWith('__describe_job'), denies: t => t.endsWith('__delete_job') })
  await $.session.start(SESSION)
  await $.tool.call({ tool: 'mcp__jenkins__get_build_log', name: 'deploy-api' })
  await $.tool.call({ tool: 'mcp__jenkins__describe_job', name: 'deploy-api' })
  await $.tool.call({ tool: 'mcp__jenkins__delete_job', name: 'deploy-api' })
  await $.tool.call({ tool: 'mcp__ccd_session__spawn_task', title: 't' })
  expect(await paneText($)).toContain('No aws, kubectl or MCP calls yet.')
  await $.tool.call({ tool: 'mcp__jenkins__stop_build', name: 'deploy-api' })
  await $.tool.call({ tool: 'mcp__hn__hn_comments', id: 1 })
  const all = await paneText($)
  expect(all).toMatch(/CHANGED \(1\)\n\s+jenkins\n\s+deploy-api {2}stop_build, worked/)
  expect(all).toMatch(/MAY HAVE CHANGED \(1\)\n\s+hn\n\s+1 {2}hn_comments, worked/)
  expect(all).not.toContain('get_build_log')
  expect(all).not.toContain('describe_job')
  expect(all).not.toContain('delete_job')
})

test('mcp: a server read-only flag beats a write-looking name', async ($, on) => {
  world(on, { readOnly: t => t.endsWith('__send_report') })
  await $.session.start(SESSION)
  await $.tool.call({ tool: 'mcp__mail__send_report', name: 'weekly' })
  expect(await paneText($)).toContain('No aws, kubectl or MCP calls yet.')
})

test('mcp: server is the scope line; detail shows allowlisted args, never bodies or output', async ($, on) => {
  world(on)
  await $.session.start(SESSION)
  await $.tool.call({ tool: 'mcp__slack__slack_send_message', channel_id: 'C123', text: 'hunter2 is the password' })
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  const row = await ui.find({ type: 'Button', text: /C123/ })
  expect(row).toBeDefined()
  await ui.press({ key: row!.key! })
  expect((await ui.find({ key: 'detail-cmd-0' }))?.text).toBe('    slack_send_message channel_id=C123')
  const all = (await texts(ui)).join('\n')
  expect(all).toMatch(/CHANGED \(1\)\n\s+slack\n\s+C123 {2}slack_send_message, worked/)
  expect(all).not.toContain('hunter2')
  expect(all).not.toContain('SECRET-OUTPUT')
  await ui.unmount()
})
