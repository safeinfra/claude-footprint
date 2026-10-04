// bun test: MCP call → what the map keeps. Named *.spec.ts so `claude plugin test` skips it.
import { describe, expect, test } from 'bun:test'

import type { Filter, MapEvent } from '../types'

import { classify, isKept, mcpCall, pickArgs, shortServer, splitTool } from '../hooks/mcp'
import { appendEvents, mcpEventOf } from '../hooks/record'
import { buildMap, mapLines } from '../hooks/view'

describe('splitTool', () => {
  test('server and tool on the first __', () => {
    expect(splitTool('mcp__kafka-ui__kafka_ui_get_topic')).toEqual({ server: 'kafka-ui', name: 'kafka_ui_get_topic' })
    expect(splitTool('mcp__plugin_x_terraform__get_module_details')).toEqual({ server: 'plugin_x_terraform', name: 'get_module_details' })
  })
  test('not an MCP tool', () => {
    expect(splitTool('Bash')).toBeUndefined()
    expect(splitTool('mcp__only')).toBeUndefined()
  })
})

describe('classify', () => {
  test("the server's read-only flag wins over the name", () => expect(classify('delete_everything', true)).toBe('read'))
  test('name verbs, snake, kebab and camel', () => {
    expect(classify('kafka_ui_get_topic', false)).toBe('read')
    expect(classify('notion-create-pages', false)).toBe('write')
    expect(classify('runGroovyScript', false)).toBe('write')
    expect(classify('list_task_runs', false)).toBe('read')
  })
  test('worst verb wins', () => {
    expect(classify('get_and_delete', false)).toBe('destructive')
    expect(classify('get_api_token', false)).toBe('cred')
  })
  test('no known verb is unknown, never read', () => expect(classify('hn_comments', false)).toBe('unknown'))
})

describe('pickArgs', () => {
  test('allowlisted identifiers only, reserved keys out', () => {
    const args = { tool: 'mcp__s__t', tool_use_id: 'x', agentId: 'a', name: 'deploy-api', script: 'rm -rf /', text: 'hello' }
    expect(pickArgs(args)).toEqual([['name', 'deploy-api']])
  })
  test('key spelling: snake, kebab, camel', () => {
    expect(pickArgs({ channel_id: 'C1', topicName: 'orders', 'job-name': 'build' })).toEqual([
      ['channel_id', 'C1'],
      ['topicName', 'orders'],
      ['job-name', 'build'],
    ])
  })
  test('multi-line, long and non-scalar values dropped; tokens masked', () => {
    expect(pickArgs({ name: 'a\nb', id: 'x'.repeat(61), path: ['p'], project: 'xoxb-1234567890-abcdef' })).toEqual([['project', '***']])
  })
})

describe('mcpCall', () => {
  test('target by preference, display keeps call order', () => {
    const call = mcpCall('mcp__jenkins__build_item', { id: 7, fullName: 'deploy/api', parameters: { ENV: 'prod' } }, false)
    expect(call).toEqual({ server: 'jenkins', name: 'build_item', cls: 'unknown', target: 'deploy/api', display: 'build_item id=7 fullName=deploy/api' })
  })
  test('scope (a): reads and ccd_* dropped, writes and unknowns kept', () => {
    const kept = (tool: string, ro = false) => isKept(mcpCall(tool, {}, ro)!)
    expect(kept('mcp__jenkins__get_build_console_output')).toBe(false)
    expect(kept('mcp__jenkins__build_item', true)).toBe(false)
    expect(kept('mcp__ccd_session__spawn_task')).toBe(false)
    expect(kept('mcp__jenkins__stop_build')).toBe(true)
    expect(kept('mcp__hn__hn_comments')).toBe(true)
  })
})

test('shortServer: connector UUIDs cut, names kept', () => {
  expect(shortServer('1a59c906-04da-521d-bda7-7f71b9f9e01c')).toBe('1a59c906…')
  expect(shortServer('kafka-ui')).toBe('kafka-ui')
})

describe('view', () => {
  const ctx = (filter: Filter = 'all') => ({ profiles: {}, kube: null, turnId: 't1', filter, expanded: {} })
  let events: MapEvent[] = []
  const add = (tool: string, args: Record<string, unknown>, ok = true) => {
    events = appendEvents(events, [mcpEventOf(mcpCall(tool, args, false)!, { ts: 0, turnId: 't1', ok })])
  }
  add('mcp__jenkins__build_item', { fullName: 'deploy-api' })
  add('mcp__jenkins__stop_build', { fullName: 'deploy-api', number: 12 }, false)
  add('mcp__hn__hn_comments', {})
  add('mcp__hn__hn_vote', {}, false)

  test('server is the scope, target is the object; unknowns may have changed; a failed write says change', () => {
    expect(mapLines(buildMap(events, ctx()))).toEqual([
      'CHANGED (0)',
      '  nothing changed',
      'MAY HAVE CHANGED (2)',
      '  jenkins',
      '    deploy-api  build_item, worked',
      '  hn',
      '    hn_comments  worked',
      'FAILED, NEVER SUCCEEDED (2)',
      '  jenkins',
      '    deploy-api  stop_build (change), failed',
      '  hn',
      '    hn_vote  (may have changed), failed',
    ])
  })
  test('write filter keeps unknowns', () => {
    expect(buildMap(events, ctx('write')).find(s => s.outcome === 'maybe')?.rows).toBe(2)
  })
})
