// bun test: the pure view model. Named *.spec.ts so `claude plugin test` skips it.
import { describe, expect, test } from 'bun:test'

import type { Filter, KubeInfo, MapEvent, ProfileInfo } from '../types'

import { analyze, redact } from '../hooks/parse'
import { appendEvents, eventsOf } from '../hooks/record'
import { bandTokens, buildGroups, shortRegion, treeLines } from '../hooks/view'

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

describe('acceptance: 30 commands, 2 accounts, 1 cluster', () => {
  const events = session()
  const lines = treeLines(buildGroups(events, ctx()))

  test('30 events recorded', () => expect(events).toHaveLength(30))

  test('default view fits in about 12 lines', () => {
    expect(lines.length).toBeLessThanOrEqual(12)
  })

  test('every write/destructive/cred action is visible unexpanded', () => {
    const text = lines.join('\n')
    for (const needle of [
      'terminate-instances i-0abc',
      'get-login-password',
      '✗ update-function-configuration api',
      'assume-role Deploy',
      'rollout restart api',
    ]) {
      expect(text).toContain(needle)
    }
  })

  test('the read-only account collapses to one line; notable ones stay open', () => {
    expect(lines.filter(l => l.includes('acct-b (2109…4321) › us-e-1'))).toEqual([
      '2: ▸ aws › acct-b (2109…4321) › us-e-1  r4 · ec2, s3, cloudwatch',
    ])
    expect(lines[0]).toStartWith('1: ▾ aws › acct-a (1234…9012)')
  })

  test('single-child chains collapse into the header', () => {
    expect(lines).toContain('3: ▾ k8s › prod-eks › web  w1')
  })

  test('links show as rows', () => {
    expect(lines.join('\n')).toContain('→ link: aws acct-b (2109…4321) (role Deploy) · k8s prod-eks')
  })

  test('snapshot of the default view', () => {
    expect(lines).toEqual([
      '1: ▾ aws › acct-a (1234…9012)  w1 d1 cred2 ✗1',
      '  ap-ne-1 ec2  r4 d1 · terminate-instances i-0abc',
      '          ecr  cred1 · get-login-password',
      '          lambda  r1 w1 ✗1 · ✗ update-function-configuration api',
      '          logs, rds, eks · read-only (3)',
      '  global  sts  r1 cred1 · assume-role Deploy',
      '          iam, s3 · read-only (2)',
      '  → link: aws acct-b (2109…4321) (role Deploy) · k8s prod-eks',
      '2: ▸ aws › acct-b (2109…4321) › us-e-1  r4 · ec2, s3, cloudwatch',
      '3: ▾ k8s › prod-eks › web  w1',
      '  deployments  r2 w1 · rollout restart api',
      '  pods, services, events, horizontalpodautoscalers · read-only (8)',
    ])
  })
})

describe('expand, filters', () => {
  const events = session()

  test('expanding a group lists every service with top-3 resources and +N more', () => {
    const lines = treeLines(buildGroups(events, ctx('all', { 'k8s:prod-eks': true })))
    const k8s = lines.slice(lines.findIndex(l => l.includes('k8s ›')))
    expect(k8s).toContain('  pods  r5')
    expect(k8s).toContain('    get')
    expect(k8s.some(l => /^\s+\+\d+ more$/.test(l))).toBe(true)
  })

  test('expanding a read-only group opens it', () => {
    const lines = treeLines(buildGroups(events, ctx('all', { 'aws:210987654321': true })))
    expect(lines).toContain('2: ▾ aws › acct-b (2109…4321) › us-e-1  r4')
  })

  test('write filter keeps only non-read actions', () => {
    const lines = treeLines(buildGroups(events, ctx('write')))
    expect(lines.join('\n')).not.toContain('read-only')
    expect(lines.some(l => l.includes('aws › acct-b'))).toBe(false)
  })

  test('turn filter keeps only the current turn', () => {
    const lines = treeLines(buildGroups(events, ctx('turn')))
    expect(lines[0]).toStartWith('1: ▾ k8s › prod-eks › web')
    expect(lines.some(l => l.includes('aws'))).toBe(false)
  })
})

describe('band', () => {
  const groups = buildGroups(session(), ctx())
  const text = (columns: number) => {
    const { tokens, dropped } = bandTokens(groups, columns)
    const body = tokens
      .map(t => [t.prefix, t.label, ...t.badges.map(([b]) => b)].filter(Boolean).join(' '))
      .join(' │ ')
    return dropped > 0 ? `${body} +${dropped}` : body
  }

  test('notable first, tool named once, reads only for read-only scopes', () => {
    expect(text(200)).toBe('aws acct-a w1 d1 cred2 ✗1 │ k8s prod-eks w1 │ acct-b r4')
  })

  test('narrow drops read-only scopes first', () => {
    expect(text(46)).toBe('aws acct-a w1 d1 cred2 ✗1 │ k8s prod-eks w1 +1')
  })
})

test('shortRegion', () => {
  expect(['ap-northeast-1', 'us-east-1', 'eu-central-1', 'ap-southeast-2'].map(shortRegion)).toEqual([
    'ap-ne-1', 'us-e-1', 'eu-c-1', 'ap-se-2',
  ])
})
