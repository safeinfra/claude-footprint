// bun test: the pure view model. Named *.spec.ts so `claude plugin test` skips it.
import { describe, expect, test } from 'bun:test'

import type { Filter, KubeInfo, MapEvent, ProfileInfo } from '../types'

import { analyze, redact } from '../hooks/parse'
import { appendEvents, eventsOf } from '../hooks/record'
import { buildMap, LOOKED_OPEN, mapLines, saysOf, whereOf } from '../hooks/view'

const PROFILES: Record<string, ProfileInfo> = {
  'acct-a': { status: 'ok', account: '123456789012', region: 'ap-northeast-1' },
  'acct-b': { status: 'ok', account: '210987654321', region: 'us-east-1' },
}
const KUBE: KubeInfo = { status: 'ok', current: 'prod-eks', ns: {} }

// 30 mixed commands across 2 accounts and 1 cluster; turn t2 starts at the kubectl block.
const A = 'aws --profile acct-a'
const B = 'aws --profile acct-b'
const K = 'kubectl --context prod-eks -n web'
const SESSION: [turn: string, command: string, ok?: boolean][] = [
  ['t1', `${A} ec2 describe-instances`],
  ['t1', `${A} ec2 describe-vpcs`],
  ['t1', `${A} ec2 describe-subnets`],
  ['t1', `${A} ec2 describe-security-groups`],
  ['t1', `${A} ec2 terminate-instances --instance-ids i-0abc`],
  ['t1', `${A} ecr get-login-password | docker login --password-stdin x`],
  ['t1', `${A} iam list-roles`],
  ['t1', `${A} sts get-caller-identity`],
  ['t1', `${A} s3 ls`],
  ['t1', `${A} lambda list-functions`],
  ['t1', `${A} lambda update-function-configuration --function-name api --timeout 30`, false],
  ['t1', `${A} logs describe-log-groups`],
  ['t1', `${A} rds describe-db-instances`],
  ['t1', `${A} sts assume-role --role-arn arn:aws:iam::210987654321:role/Deploy --role-session-name s`],
  ['t1', `${A} eks update-kubeconfig --name prod-eks`],
  ['t1', `${B} ec2 describe-instances`],
  ['t1', `${B} s3 ls s3://logs-b/`],
  ['t1', `${B} cloudwatch describe-alarms`],
  ['t1', `${B} ec2 describe-vpcs`],
  ['t2', `${K} get pods`],
  ['t2', `${K} get deploy`],
  ['t2', `${K} logs api-1`],
  ['t2', `${K} describe pod api-1`],
  ['t2', `${K} get svc`],
  ['t2', `${K} rollout restart deploy/api`],
  ['t2', `${K} rollout status deploy/api`],
  ['t2', `${K} get events`],
  ['t2', `${K} top pods`],
  ['t2', `${K} get pods -o wide`],
  ['t2', `${K} get hpa`],
]

function session(): MapEvent[] {
  let events: MapEvent[] = []
  SESSION.forEach(([turnId, command, ok = true], i) => {
    const { actions } = analyze(command)
    events = appendEvents(events, eventsOf(actions, { ts: i, turnId, ok, cmd: redact(command), profiles: PROFILES, kube: KUBE }))
  })
  return events
}

const ctx = (filter: Filter = 'all', expanded: Record<string, boolean> = {}) => ({
  profiles: PROFILES,
  kube: KUBE,
  turnId: 't2',
  filter,
  expanded,
})

const view = (filter: Filter = 'all', expanded: Record<string, boolean> = {}) => mapLines(buildMap(session(), ctx(filter, expanded)), expanded)

describe('acceptance: 30 commands, 2 accounts, 1 cluster', () => {
  const lines = view()

  test('30 events recorded', () => expect(session()).toHaveLength(30))

  test('snapshot of the default view: sections by outcome, LOOKED AT folded', () => {
    expect(lines).toEqual([
      'CHANGED (2)',
      '  AWS account 123456789012 · ap-northeast-1',
      '    ec2 i-0abc  terminate-instances, worked',
      '  Kubernetes prod-eks · namespace web',
      '    deployment api  rollout restart, worked',
      'MAY HAVE CHANGED (2)',
      '  AWS account 123456789012 · ap-northeast-1',
      '    ecr  get-login-password, worked',
      '  AWS account 123456789012 · global',
      '    sts Deploy  assume-role, worked',
      '      opens AWS account 210987654321, role Deploy',
      'FAILED, NEVER SUCCEEDED (1)',
      '  AWS account 123456789012 · ap-northeast-1',
      '    lambda api  update-function-configuration (change), failed',
      'LOOKED AT (24) · ec2, lambda, logs, rds, eks, iam, sts, s3, cloudwatch, pods, deployments, services, events, horizontalpodautoscalers',
    ])
  })

  test('every write/destructive/cred action is visible unexpanded', () => {
    const text = lines.join('\n')
    for (const needle of [
      'ec2 i-0abc  terminate-instances, worked',
      'get-login-password, worked',
      'lambda api  update-function-configuration (change), failed',
      'assume-role, worked',
      'deployment api  rollout restart, worked',
    ]) {
      expect(text).toContain(needle)
    }
  })

  test('scope line: full account id and full region, profile left out', () => {
    expect(lines).toContain('  AWS account 123456789012 · ap-northeast-1')
    expect(lines.join('\n')).not.toContain('acct-a')
  })

  test('links show under the row that opened them', () => {
    expect(lines).toContain('      opens AWS account 210987654321, role Deploy')
  })
})

describe('LOOKED AT, filters', () => {
  test('opened LOOKED AT lists rows and says what ok means', () => {
    const lines = view('all', { [LOOKED_OPEN]: true })
    const looked = lines.slice(lines.findIndex(l => l.startsWith('LOOKED AT')))
    expect(looked[0]).toMatch(/^LOOKED AT \(\d+\)$/)
    expect(looked).toContain('  AWS account 210987654321 · us-east-1')
    expect(looked).toContain('  Kubernetes prod-eks · namespace web')
    expect(looked.at(-1)).toBe('  ran without error; results are not recorded')
  })

  test('write filter drops LOOKED AT', () => {
    const lines = view('write')
    expect(lines.some(l => l.startsWith('LOOKED AT'))).toBe(false)
    expect(lines.join('\n')).not.toContain('210987654321 · us-east-1')
  })

  test('turn filter keeps only the current turn; CHANGED always shows', () => {
    const lines = view('turn')
    expect(lines[0]).toBe('CHANGED (1)')
    expect(lines.join('\n')).not.toContain('AWS')
  })

  test('nothing changed is said, not left blank', () => {
    const only = session().filter(e => e.cls === 'read')
    expect(mapLines(buildMap(only, ctx())).slice(0, 2)).toEqual(['CHANGED (0)', '  nothing changed'])
  })
})

test('several operations on one object name it once', () => {
  let events: MapEvent[] = []
  for (const command of [`${A} rds describe-db-instances`, `${A} rds describe-db-clusters`]) {
    events = appendEvents(events, eventsOf(analyze(command).actions, { ts: 0, turnId: 't1', ok: true, cmd: command, profiles: PROFILES, kube: KUBE }))
  }
  expect(mapLines(buildMap(events, ctx()), { [LOOKED_OPEN]: true }).slice(4, 6)).toEqual([
    '    rds  describe-db-instances, worked',
    '         describe-db-clusters, worked',
  ])
})

describe('counting and retries', () => {
  const ev = (cmd: string, ok: boolean) => ({ cmd, ok }) as MapEvent
  test.each([
    [[ev('a', true)], 'worked'],
    [[ev('a', false)], 'failed'],
    [[ev('a', false), ev('a', false)], '2 calls, all failed'],
    [[ev('a', false), ev('a', true)], '2 calls, last worked'],
    [[ev('a', true), ev('b', true), ev('c', true)], '3 calls'],
    [[ev('a', true), ev('a', false)], '2 calls, last failed'],
  ])('%j → %s', (list, says) => expect(saysOf(list)).toBe(says))
})

describe('where it ran: no level invented', () => {
  const aws = (profile: string, region?: string) =>
    eventsOf(analyze(`aws --profile ${profile} ec2 describe-vpcs`).actions, { ts: 0, turnId: null, ok: true, cmd: '', profiles: {}, kube: null }).map(
      e => ({ ...e, id: 1, scope: { ...(e as MapEvent & { tool: 'aws' }).scope, region } }) as MapEvent,
    )[0]!
  const kube = (cmd: string) =>
    ({ ...eventsOf(analyze(cmd).actions, { ts: 0, turnId: null, ok: true, cmd: '', profiles: {}, kube: null })[0]!, id: 1 }) as MapEvent

  test('aws: unknown account and region are written out', () => {
    expect(whereOf(aws('ghost'), { profiles: { ghost: { status: 'error' } }, kube: null }).text).toBe('AWS profile ghost · account unknown · region unknown')
    expect(whereOf(aws('slow', 'us-east-1'), { profiles: { slow: { status: 'pending' } }, kube: null }).text).toBe(
      'AWS profile slow · account not looked up yet · us-east-1',
    )
  })

  test('kubernetes: all namespaces and cluster-wide in words', () => {
    expect(whereOf(kube('kubectl --context c get pods -A'), { profiles: {}, kube: null }).text).toBe('Kubernetes c · all namespaces')
    expect(whereOf(kube('kubectl --context c get nodes'), { profiles: {}, kube: null }).text).toBe('Kubernetes c · cluster-wide')
    expect(whereOf(kube('kubectl get pods'), { profiles: {}, kube: null }).text).toBe('Kubernetes context unknown · namespace default')
  })
})
