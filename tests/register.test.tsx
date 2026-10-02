// claude plugin test: the mod as the engine loads it, the world beneath stubbed per test.
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const SESSION = { surface: 'terminal' as const, isInteractive: true, cwd: '/work' }
const SURFACES = ['terminal', 'desktop'] as const

type World = {
  fails?: (command: string) => boolean
  denies?: (command: string) => boolean
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
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('tool.call', ($, e) => {
    const command = String(e.command ?? '')
    if (w.denies?.(command)) return { deny: 'no' }
    if (w.fails?.(command)) return { isError: true as const, result: 'boom', text: 'boom' }
    return { result: { stdout: 'SECRET-OUTPUT', stderr: '', interrupted: false } }
  })
  on('process.run', ($, e) => ({ value: { stderr: '', ...(w.run?.(e.argv) ?? { exitCode: 1, stdout: '' }) } }))
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
  return { clock, panes, opened }
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

async function twoAccountsOneCluster($: Engine) {
  await $.session.start(SESSION)
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
}

const band = (bodyColumns = 120, hasSurvey = false) => ({
  plugin: 'footprint',
  component: 'AbovePrompt' as const,
  props: { hasSurvey, isWorking: false, maxRows: 10, bodyColumns, scroll: { offset: 0, bodyRows: 10 }, view: {} },
})

type Engine = import('claude-code/testing').Engine

async function bandText($: Engine, columns = 120, hasSurvey = false, surface: (typeof SURFACES)[number] = 'terminal') {
  const ui = await $.ui.mount({ ...band(columns, hasSurvey), surface })
  const found = await ui.find({ key: 'footprint-band' })
  const engine = await ui.find({ type: 'Text', text: 'engine band' })
  await ui.unmount()
  return found?.text ?? (engine ? 'engine band' : '')
}

test('no infra calls: the engine band shows', async ($, on) => {
  world(on)
  await $.session.start(SESSION)
  await $.tool.call({ tool: 'Bash', command: 'ls -la && git status' })
  expect(await bandText($)).toBe('engine band')
})

test('band: notable scopes first, read-only last, failures marked', async ($, on) => {
  world(on, { fails: c => c.includes('update-function'), env: { AWS_PROFILE: 'acct-a' } })
  await $.session.start(SESSION)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'aws ec2 terminate-instances --instance-ids i-1' })
  await $.tool.call({ tool: 'Bash', command: 'aws lambda update-function-configuration --function-name api' })
  await $.tool.call({ tool: 'Bash', command: 'aws --profile acct-b s3 ls s3://b' })
  await $.tool.call({ tool: 'Bash', command: 'kubectl --context prod-eks -n web scale deploy api --replicas 2' })
  for (const surface of SURFACES) {
    expect(await bandText($, 120, false, surface)).toBe('aws acct-a w1 d1 ✗1 │ k8s prod-eks w1 │ acct-b r1')
  }
})

test('band yields to a survey and truncates read-only scopes first', async ($, on) => {
  world(on)
  await $.session.start(SESSION)
  await $.tool.call({ tool: 'Bash', command: 'aws --profile a ec2 delete-vpc --vpc-id v' })
  await $.tool.call({ tool: 'Bash', command: 'aws --profile b ec2 describe-vpcs' })
  expect(await bandText($, 120, true)).toBe('engine band')
  expect(await bandText($, 12)).toBe('aws a d1 +1')
})

test('denied calls are not recorded', async ($, on) => {
  world(on, { denies: c => c.includes('delete') })
  await $.session.start(SESSION)
  await $.tool.call({ tool: 'Bash', command: 'aws --profile a ec2 delete-vpc --vpc-id v' })
  expect(await bandText($)).toBe('engine band')
})

test('pane: tree with collapsed read-only group, notable rows visible', async ($, on) => {
  world(on)
  await twoAccountsOneCluster($)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...pane(), surface })
    expect((await ui.find({ key: 'group-1' }))?.text).toBe('▾ aws › acct-a')
    expect((await ui.find({ key: 'group-2' }))?.text).toBe('▸ aws › acct-b › ?')
    expect((await ui.find({ key: 'group-3' }))?.text).toBe('▾ k8s › prod-eks › web')
    const all = (await texts(ui)).join('\n')
    expect(all).toContain('terminate-instances i-0abc')
    expect(all).toContain('create db')
    expect(all).toContain('pods · read-only (1)')
    expect(await ui.find({ type: 'Button', text: /acct-b/ })).toMatchObject({ props: { hotkey: '2', plain: true } })
    await ui.unmount()
  }
})

test('pane: a group header toggles expanded', async ($, on) => {
  world(on)
  await twoAccountsOneCluster($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await ui.press({ key: 'group-2' })
  expect((await ui.find({ key: 'group-2' }))?.text).toBe('▾ aws › acct-b › ?')
  expect((await texts(ui)).join('\n')).toContain('describe-vpcs')
  await ui.press({ key: 'group-2' })
  expect((await ui.find({ key: 'group-2' }))?.text).toBe('▸ aws › acct-b › ?')
  await ui.unmount()
})

test('pane: write and turn filters', async ($, on) => {
  world(on)
  await twoAccountsOneCluster($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await ui.press({ key: 'filter-write' })
  expect((await texts(ui)).join('\n')).not.toContain('acct-b')
  expect((await texts(ui)).join('\n')).not.toContain('read-only')
  await ui.press({ key: 'filter-turn' })
  expect((await ui.find({ key: 'group-1' }))?.text).toBe('▾ k8s › prod-eks › web')
  await ui.press({ key: 'filter-all' })
  expect(await ui.find({ key: 'group-3' })).toBeDefined()
  await ui.unmount()
})

test('pane: selecting a row shows its redacted command, never the output', async ($, on) => {
  world(on)
  await twoAccountsOneCluster($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  const row = await ui.find({ type: 'Button', text: /secrets/ })
  expect(row).toBeDefined()
  await ui.press({ key: row!.key! })
  const detail = await ui.find({ key: 'detail-cmd' })
  expect(detail?.text).toBe('$ kubectl --context prod-eks -n web create secret generic db --from-literal=password=***')
  const all = (await texts(ui)).join('\n')
  expect(all).not.toContain('hunter2')
  expect(all).not.toContain('SECRET-OUTPUT')
  expect(all).toContain('this turn')
  await ui.unmount()
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

test('/map on a narrow terminal falls back to the band', async ($, on) => {
  const w = world(on, { narrow: true })
  await $.session.start(SESSION)
  await $.tool.call({ tool: 'Bash', command: 'aws --profile a ec2 describe-vpcs' })
  expect((await $.command.run(map())).text).toContain('too narrow')
  expect(w.panes.has('footprint')).toBe(false)
  expect(await bandText($)).toBe('aws a r1')
})

test('/map clear empties the map; /map collapse folds groups', async ($, on) => {
  world(on)
  await twoAccountsOneCluster($)
  const ui = await $.ui.mount({ ...pane(), surface: 'terminal' })
  await ui.press({ key: 'group-2' })
  await $.command.run(map('collapse'))
  expect((await ui.find({ key: 'group-2' }))?.text).toBe('▸ aws › acct-b › ?')
  await $.command.run(map('clear'))
  expect((await texts(ui)).join('\n')).toContain('No aws or kubectl calls yet.')
  expect(await bandText($)).toBe('engine band')
  await ui.unmount()
})
