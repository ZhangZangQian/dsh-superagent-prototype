/** The ONES Source on a SourceContext: assignment authorization, translation, polls and read positions, health. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine, key, type Assessor, type Executor, type Thread, type Ticket, type Trigger } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { apply as applyOnesModule, isClosed, onesKind, pollRound } from '../src/sources/ones.ts'
import { assignmentTrigger, closedTrigger, commentTrigger, onesChannel, onesCommentId, onesPage, statusTrigger, SOURCE } from '../src/sources/ones-trigger.ts'
import { onesThreadContext, readOnes } from '../src/sources/ones-read.ts'
import { sendOnes } from '../src/sources/ones-channel.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { Store } from '../src/app/store.ts'
import { Commands, commandError } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'

const PROJECT = 'p1r2o3j4e5c6t7u8'
const AGENT = 'a1g2e3n4t5u6s7e8'
const ALICE = 'u1s2e3r4a5l6i7c8'
const BOB = 'u1s2e3r4b5o6b7u8d9'
const TASK = 't1a2s3k4u5u6i7d8'
const EARLY = '2026-01-01T00:00:00.000Z'
const AT = '2026-11-02T10:00:00.000Z'
const LATER = '2026-11-02T11:00:00.000Z'

/** A task record as the wrapper prints it. */
const task = (fields: Record<string, unknown> = {}) => ({ uuid: TASK, title: 'Fix the login margin', issueStatusName: '进行中',
  owner: { uuid: AGENT, name: 'Agent' }, creator: { uuid: ALICE, name: 'Alice' }, description: 'The button overlaps the field.',
  createdAt: AT, updatedAt: AT, ...fields })
/** An activity as the wrapper prints it. */
const activity = (fields: Record<string, unknown> = {}) => ({ uuid: key('a', String(Math.random())), action: 'update_issue_owner',
  at: AT, operator: { uuid: ALICE, name: 'Alice' }, to: { uuid: AGENT }, ...fields })
const agent = () => ({ uuid: AGENT, name: 'Agent' })
const commentOn = (uuid: string, fields: Record<string, unknown> = {}) =>
  ({ uuid, writer: { uuid: BOB, name: 'Bob' }, content: `note ${uuid}`, createdAt: LATER, ...fields })

function host(overrides: Partial<SourceContextDeps> = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'ones-')), 'db.sqlite'))
  const settings = SettingsSchema.parse({
    policy: { sources: { ones: { allowed: [{ id: ALICE, name: 'Alice' }] } } }, eval: { mode: 'auto' },
    sources: { ones: { enabled: true, config: { cli: '/bin/ones-agent', url: 'https://ones.example.com', project: PROJECT } } } })
  store.saveSettings(settings)
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(onesKind)
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox })
  const deployment = testDeployment({ ones: { cli: '/bin/ones-agent', url: 'https://ones.example.com', project: PROJECT, user: AGENT, name: 'Agent' } })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const parts: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  // Both cursors start in the past so the round reads the fixture's fixed timestamps.
  store.set(KV.ones.since, EARLY)
  store.set(KV.ones.cursor(TASK), EARLY)
  const context = sourceContextOf(parts, { kind: 'ones', health: ['ones'] })
  return { ...parts, ...context, health: board.all, store, engine, commands, receive, executor }
}

/** Stubs the ones wrapper: answers by subcommand and records the calls. */
function ones(h: ReturnType<typeof host>, answer: (args: string[]) => unknown) {
  const calls: string[][] = []
  vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
  vi.spyOn(h.commands, 'run').mockImplementation(async (_program, args) => {
    calls.push(args)
    const value = answer(args)
    if (value instanceof Error) throw value
    return JSON.stringify(value)
  })
  return calls
}
const tasksOf = (...items: unknown[]) => ({ items })

describe('ones source', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('translates an assignment into an addressed trigger whose actor is the assigner', () => {
    const trigger = assignmentTrigger(task(), activity(), PROJECT)
    expect(trigger).toMatchObject({ id: key('ones-assignment', TASK, PROJECT), source: SOURCE,
      threads: [{ source: SOURCE, id: `${PROJECT}:${TASK}` }], actor: { source: SOURCE, id: ALICE }, human: true,
      addressed: 'mention', at: AT, channel: { source: SOURCE, address: { project: PROJECT, issue: TASK } },
      meta: { kind: 'assignment', assigner: ALICE, owner: AGENT } })
    expect(trigger.text).toContain('Fix the login margin')
    // The record cannot name the assigner: the trigger keeps an empty actor, so the gate reads the admission table.
    const unnamed = assignmentTrigger(task(), { at: LATER }, PROJECT)
    expect(unnamed.actor).toEqual({ source: SOURCE, id: '' })
    expect(unnamed).toMatchObject({ human: true, addressed: 'mention' })
  })
  it('translates comments with stable per-edit ids and drops the agent\'s own', () => {
    const comment = commentOn('c1o2m3m4e5n6t7i8d', { content: 'please also check the header' })
    const trigger = commentTrigger(comment, PROJECT, TASK, AGENT)!
    expect(trigger).toMatchObject({ id: onesCommentId(comment.uuid, LATER), actor: { id: BOB }, human: true,
      text: 'please also check the header',
      channel: { address: { project: PROJECT, issue: TASK, comment: comment.uuid } }, meta: { kind: 'comment' } })
    expect(trigger).not.toHaveProperty('addressed')
    expect(commentTrigger({ ...comment, writer: { uuid: AGENT } }, PROJECT, TASK, AGENT)).toBeUndefined()
    const edited = commentTrigger({ ...comment, updatedAt: '2026-11-02T12:00:00.000Z' }, PROJECT, TASK, AGENT)!
    expect(edited.id).not.toBe(trigger.id)
  })
  it('names status changes and closes as facts, never addressed', () => {
    expect(statusTrigger(task(), PROJECT, '已完成', LATER, BOB)).toMatchObject({ human: false, actor: { id: BOB }, meta: { kind: 'status', status: '已完成' } })
    expect(statusTrigger(task(), PROJECT, '进行中', LATER, BOB)).not.toHaveProperty('addressed')
    expect(closedTrigger(task(), PROJECT, '已取消', LATER)).toMatchObject({ human: false, meta: { kind: 'closed', status: '已取消' } })
    expect(isClosed('已完成')).toBe(true)
    expect(isClosed('已取消')).toBe(true)
    expect(isClosed('进行中')).toBe(false)
  })
  it('accepts an allowed assigner\'s assignment as an explicit candidate; an unlisted one is stored but not accepted', async () => {
    const h = host()
    try {
      const calls = ones(h, args => args[0] === 'api' ? agent() : args[1] === 'issues' ? tasksOf(task()) : tasksOf(activity()))
      await pollRound(h)
      // Alice is on the allowed list and the assignment addresses the agent: explicit, no admission cell needed.
      expect(h.engine.candidate(key('ones-assignment', TASK, PROJECT))?.strength).toBe('explicit')
      expect(h.receive).toHaveBeenCalledTimes(1)
      expect(calls.filter(args => args[0] === 'list' && args[1] === 'activities')).toHaveLength(1)
      // An unlisted assigner: stored and evaluated, but the admission cell (default ignore) admits nothing.
      const other = task({ uuid: 'o1t2h3e4r5t6a7s8k', owner: { uuid: BOB }, creator: { uuid: BOB } })
      h.store.saveSettings(SettingsSchema.parse({ ...h.store.settings(), policy: { sources: { ones: { allowed: [] } } } }))
      h.store.delete(KV.ones.since)
      h.store.delete(KV.ones.cursor('o1t2h3e4r5t6a7s8k'))
      const unlisted = assignmentTrigger(other, activity({ operator: { uuid: BOB } }), PROJECT)
      const result = await h.receive(unlisted)
      expect(result).toBe('stored')
      expect(h.engine.candidate(unlisted.id)).toBeUndefined()
    } finally { h.store.close() }
  })
  it('marks an automation-performed assignment as a bot trigger, inferred at most', async () => {
    const h = host()
    try {
      const automated = activity({ operator: { uuid: BOB, name: 'Workflow', automation: true } })
      ones(h, args => args[0] === 'api' ? agent() : args[1] === 'issues' ? tasksOf(task()) : tasksOf(automated))
      await pollRound(h)
      const trigger = h.store.triggers.get(key('ones-assignment', TASK, PROJECT))!
      expect(trigger).toMatchObject({ human: false, actor: { id: BOB } })
      expect(trigger).not.toHaveProperty('addressed')
    } finally { h.store.close() }
  })
  it('emits comments after the cursor and closes the thread when the task closes', async () => {
    const h = host()
    try {
      ones(h, args => args[0] === 'api' ? agent() : args[1] === 'issues' ? tasksOf(task()) : tasksOf(activity()))
      await pollRound(h)
      expect(h.receive).toHaveBeenCalledTimes(1)
      h.receive.mockClear()
      h.store.tickets.save(ticket('t1'))
      h.store.threads.save(thread())
      // A later round: a comment and a close arrive; the read position moved past the assignment (cursorAt's overlap
      // keeps late remote writes, so a same-timestamp replay would deduplicate by id).
      h.store.set(KV.ones.cursor(TASK), new Date(Date.parse(AT) + 1).toISOString())
      const comment = activity({ action: 'create_comment', at: LATER, comment: commentOn('c1o2m3m4e5n6t7i8d', { writer: { uuid: ALICE }, content: 'thanks' }) })
      const close = activity({ action: 'update_issue_status', at: LATER })
      const calls = ones(h, args => {
        if (args[0] === 'api') return agent()
        if (args[1] === 'issues') return tasksOf(task({ issueStatusName: '已完成', updatedAt: LATER }))
        return tasksOf(comment, close)
      })
      await pollRound(h)
      expect(h.receive.mock.calls.map(([trigger]) => [trigger.meta.kind, trigger.id])).toEqual([
        ['comment', onesCommentId('c1o2m3m4e5n6t7i8d', LATER)],
        ['closed', key('ones-closed', TASK, '已完成', LATER)],
      ])
      // The close reached the Engine as a threadClosed: the ticket following the task ended.
      expect(h.store.tickets.get('t1')).toMatchObject({ ended: { outcome: 'closed' } })
      expect(h.store.get(KV.ones.cursor(TASK))).toBeDefined()
      expect(calls.filter(args => args[0] === 'list' && args[1] === 'activities')).toHaveLength(1)
    } finally { h.store.close() }
  })
  it('receives unowned task events only with the observe switch, as candidates never explicit', async () => {
    const h = host()
    try {
      const other = task({ uuid: 'o1t2h3e4r5t6a7s8k', owner: { uuid: BOB } })
      const created = activity({ action: 'create_issue', at: AT })
      ones(h, args => args[0] === 'api' ? agent() : args[1] === 'issues' ? tasksOf(other) : tasksOf(created))
      await pollRound(h)
      expect(h.receive).toHaveBeenCalledTimes(0)
      h.store.saveSettings(SettingsSchema.parse({ ...h.store.settings(), sources: { ones: { enabled: true,
        config: { cli: '/bin/ones-agent', url: 'https://ones.example.com', project: PROJECT, observeTasks: true } } } }))
      h.store.set(KV.ones.cursor('o1t2h3e4r5t6a7s8k'), EARLY)
      const calls = ones(h, args => args[0] === 'api' ? agent() : args[1] === 'issues' ? tasksOf(other) : tasksOf(created))
      await pollRound(h)
      expect(h.receive).toHaveBeenCalledTimes(1)
      // An observed task's creation is a fact from its creator; it never addresses the agent.
      expect(h.receive.mock.calls[0]![0]).toMatchObject({ human: true, actor: { id: ALICE }, meta: { kind: 'task' } })
      expect(h.receive.mock.calls[0]![0]).not.toHaveProperty('addressed')
      h.receive.mockClear()
      h.store.set(KV.ones.cursor('o1t2h3e4r5t6a7s8k'), AT)
      const changed = activity({ action: 'update_issue_status', at: LATER })
      ones(h, args => args[0] === 'api' ? agent() : args[1] === 'issues'
        ? tasksOf({ ...other, issueStatusName: '已完成', updatedAt: LATER }) : tasksOf(created, changed))
      await pollRound(h)
      // The creation replays as a duplicate (its stable id stores once); only the newer status change is new.
      const stored = await Promise.all(h.receive.mock.results.map(result => result.value))
      expect(stored).toEqual(['duplicate', 'stored'])
      expect(h.receive.mock.calls[1]![0]).toMatchObject({ human: false, meta: { kind: 'status', status: '已完成' } })
      expect(calls.filter(args => args[0] === 'list' && args[1] === 'activities')).toHaveLength(1)
    } finally { h.store.close() }
  })
  it('sends a delivery comment through the wrapper with an idempotency marker', async () => {
    const h = host()
    try {
      const calls = ones(h, () => ({}))
      const message = { id: 'reply-1', channel: onesChannel(PROJECT, TASK), text: 'Fixed in this task.', kind: 'reply' as const }
      expect(await sendOnes(h, message)).toBe('sent')
      expect(calls.at(-1)).toEqual(['add', 'comment', '--issue', TASK, '--body', 'Fixed in this task.\n\n<!-- reply-1 -->'])
    } finally { h.store.close() }
  })
  it('reads a task, its description and pages of comments for assessments', async () => {
    const h = host()
    try {
      const first = commentOn('c1o2m3m4e5n6t7i8d'), second = commentOn('c2o2m3m4e5n6t7i8d')
      ones(h, args => args[0] === 'get' ? task() : { items: [first, second], next_page: 2 })
      const read = await readOnes(h.commands, '/bin/ones-agent', `ones/${TASK}`) as { messages: { id: string; from: string }[] }
      expect(read.messages).toEqual([expect.objectContaining({ id: TASK, from: 'Alice', text: expect.stringContaining('Fix the login margin') })])
      const page = await readOnes(h.commands, '/bin/ones-agent', `ones/${TASK}/comments`) as { messages: { id: string }[]; next_resource: string }
      expect(page.messages.map(message => message.id)).toEqual([first.uuid, second.uuid])
      expect(page.next_resource).toBe(`ones/${TASK}/comments/2`)
      const trigger = commentTrigger(first, PROJECT, TASK, AGENT)!
      const root = await onesThreadContext.read(h.commands, trigger, 'root', undefined, { cli: '/bin/ones-agent' })
      expect(root.messages[0]!.text).toContain('Fix the login margin')
      const thread = await onesThreadContext.read(h.commands, trigger, 'thread', undefined, { cli: '/bin/ones-agent' })
      expect(thread.messages.map(message => message.id)).toEqual([first.uuid, second.uuid])
      expect(onesThreadContext.messageId(trigger)).toBe(first.uuid)
      await expect(readOnes(h.commands, '/bin/ones-agent', 'ones/short')).rejects.toThrow('Use ones/')
    } finally { h.store.close() }
  })
  it('links a task page from the configured base URL', () => {
    expect(onesPage('https://ones.example.com/', PROJECT, TASK)).toBe(`https://ones.example.com/project/#/task/${PROJECT}/${TASK}`)
    const account = { cli: '', url: 'https://ones.example.com', project: PROJECT, user: AGENT, name: '' }
    expect(onesKind.channel!.link({ project: PROJECT, issue: TASK }, { ones: account }).url)
      .toBe(`https://ones.example.com/project/#/task/${PROJECT}/${TASK}`)
    expect(onesKind.channel!.link({ project: PROJECT, issue: TASK }, {}).url).toBe('')
    expect(onesChannel(PROJECT, TASK, 'c1o2m3m4e5n6t7i8d').address).toEqual({ project: PROJECT, issue: TASK, comment: 'c1o2m3m4e5n6t7i8d' })
    // A task's web URL names its Thread; bare words name nothing.
    expect(onesKind.find!(`see https://ones.example.com/project/#/task/${PROJECT}/${TASK} please`).threads).toEqual([`ones:${PROJECT}:${TASK}`])
    expect(onesKind.find!('authentication is not a uuid').threads).toEqual([])
  })
  it('registers its kind without an account and reports what setup still needs', async () => {
    const board = new HealthBoard()
    const sources = new SourceRegistry(() => SettingsSchema.parse({}), board)
    const store = new Store(join(mkdtempSync(join(tmpdir(), 'ones-plugin-')), 'db.sqlite'))
    const deployment = testDeployment({ ones: undefined })
    const parts: SourceContextDeps = { store, engine: {} as never, outbox: { send: () => {} }, commands: new Commands(() => deployment, {}, new AbortController().signal),
      sources, deployment, ready: Promise.resolve(), configured: () => false, receive: () => 'stored' as never }
    const host = { ...parts, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(parts, kind) }
    const disposers: (() => unknown)[] = []
    try {
      applyOnesModule({ orchestrator: host, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
      await vi.waitFor(() => expect(board.all.ones).toMatchObject({ state: 'paused', code: 'setupPending' }))
      expect(sources.kind('ones')).toBe(onesKind)
      for (const dispose of disposers) await dispose()
      expect(sources.kind('ones')).toBeUndefined()
    } finally { store.close() }
  })
  it('syncs its allowed list from the project members', async () => {
    const h = host()
    try {
      const sync = onesKind.policy!.sync!
      expect(sync.ready({ allowed: [], syncProject: false })).toBe(false)
      const members = [{ uuid: ALICE, name: 'Alice Li' }, { uuid: BOB, name: 'Bob' }]
      const calls = ones(h, args => args[0] === 'list' && args[1] === 'members' ? { items: members } : {})
      const signal = new AbortController().signal
      const host = { ...h, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(h, kind) }
      expect(await sync.run(host, { allowed: [{ id: ALICE, name: 'Alice' }, { id: 'g1o2n3e4u5s6e7r8d' }], syncProject: true }, signal))
        .toEqual({ allowed: [{ id: ALICE, name: 'Alice Li' }, { id: BOB, name: 'Bob' }], syncProject: true })
      expect(calls.at(-1)).toEqual(['list', 'members'])
    } finally { h.store.close() }
  })
  it('keeps its read position on a failed round and steps it after a full one', async () => {
    const h = host()
    try {
      h.store.set(KV.ones.since, '2026-11-02T09:00:00.000Z')
      const failure = commandError({ stderr: 'ones-agent: project unreadable', code: 1 })
      ones(h, () => { throw failure })
      await expect(pollRound(h)).rejects.toThrow('unreadable')
      expect(h.store.get(KV.ones.since)).toBe('2026-11-02T09:00:00.000Z')
      const calls = ones(h, args => args[0] === 'api' ? agent() : args[1] === 'issues'
        ? tasksOf(task({ updatedAt: LATER })) : tasksOf(activity()))
      await pollRound(h)
      const moved = h.store.get(KV.ones.since)!
      expect(Date.parse(moved)).toBeGreaterThan(Date.parse('2026-11-02T09:00:00.000Z'))
      expect(Date.parse(moved)).toBeLessThanOrEqual(Date.parse(LATER))
      expect(calls.filter(args => args[0] === 'list' && args[1] === 'issues')).toHaveLength(1)
    } finally { h.store.close() }
  })
})

/** A thread the test subscribes a ticket to. */
function thread(): Thread {
  return { key: `ones:${PROJECT}:${TASK}`, ref: { source: SOURCE, id: `${PROJECT}:${TASK}` }, createdAt: AT,
    subscriptions: ['t1'], correlated: [], pending: [], meta: {} }
}
function ticket(id: string): Ticket {
  return { id, title: id, decisionId: `d-${id}`, mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' },
    actor: { source: SOURCE, id: ALICE }, scope: '' }, channels: [onesChannel(PROJECT, TASK)],
    assignments: [{ id: 'a', state: 'running', createdAt: '' }], inputs: [], undelivered: [], createdAt: '', updatedAt: '',
    origin: { triggerId: key('ones-assignment', TASK, PROJECT), triggerIds: [] },
    follows: [{ thread: `ones:${PROJECT}:${TASK}`, own: false }] }
}
