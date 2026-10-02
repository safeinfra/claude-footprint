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
  return clock
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
