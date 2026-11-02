/** ONES Source kind definition, poll loop, and Cordis plugin entry; assignment authorizes work. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { threadKey, type Thread, type Trigger } from '../core/index.ts'
import { validItems, type Tally } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import { cursorAt, pause, pollThreads as pollEach } from './poll.ts'
import { health, sourceContext, type Health, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
import { sendOnes, onesLink } from './ones-channel.ts'
import { onesThreadContext, onesListIssues, onesGetIssue, onesListActivities, onesListMembers } from './ones-read.ts'
import {
  assignmentTrigger, closedTrigger, commentTrigger, issueStatus, onesPage, sameActor, statusTrigger, taskTrigger,
  SOURCE, type OnesActivity, type OnesIssue,
} from './ones-trigger.ts'

/** The Source's configuration: one instance, one team, one watched project. */
export const OnesModuleConfigSchema = z.object({
  /** Command name or absolute path of the agent's `ones` wrapper; credentials live in ONES_CONFIG_DIR, never here. */
  cli: z.string().trim().default(''),
  /** Base URL of the ONES instance, such as https://ones.example.com; used for task links. */
  url: z.string().trim().regex(/^https?:\/\//, 'http(s) base URL').default(''),
  /** The watched project's UUID. */
  project: z.string().regex(/^[A-Za-z0-9]{8,64}$/).default(''),
  pollSeconds: z.number().int().min(60).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  /** Receive tasks not owned by the agent (their creation and status changes) as admission-table candidates. */
  observeTasks: z.boolean().default(false),
  /** Receive comments on tasks not owned by the agent as admission-table candidates. */
  observeComments: z.boolean().default(false),
}).strict()
export type OnesModuleConfig = z.infer<typeof OnesModuleConfigSchema>

/** Rows the meta of a trigger names: `assignment` addresses the agent by the act itself. */
function rowOf(meta: Record<string, unknown>): string | undefined {
  const kind = String(meta.kind ?? '')
  if (kind === 'assignment') return 'assignment'
  if (kind === 'comment') return meta.mine === true ? 'mine' : 'comments'
  if (kind === 'status' || kind === 'closed') return meta.mine === true ? 'mine' : 'tasks'
  return undefined
}

export const onesKind: SourceKind<OnesModuleConfig> = {
  kind: SOURCE,
  title: { zh: 'ONES', en: 'ONES' },
  description: {
    zh: '智能体的 ONES 账号；接收项目里指派给它的任务（任务指派即授权），以及它名下任务的评论与状态变化。',
    en: 'The agent\'s ONES account; receives tasks assigned to it in the project (assignment authorizes work), and comments and status changes on its tasks.',
  },
  schema: OnesModuleConfigSchema,
  fields: [
    { key: 'cli', type: 'text', label: { zh: '智能体的 ONES CLI', en: 'Agent ONES CLI' },
      hint: { zh: '命令名或绝对路径，指向仓库 scripts/ones-agent 包装脚本（凭据放在 ONES_CONFIG_DIR 指向的目录里）。保存时检查它能否读取项目，然后重启 dsh-superagent。', en: 'A command name or absolute path of the repository\'s scripts/ones-agent wrapper (credentials live in the directory ONES_CONFIG_DIR points to). Saving checks it can read the project, then restarts dsh-superagent.' } },
    { key: 'url', type: 'text', pattern: 'https?://[^/]+.*', label: { zh: 'ONES 实例地址', en: 'ONES instance URL' },
      hint: { zh: '形如 https://ones.example.com 的基础地址；用于任务链接。', en: 'The base address, such as https://ones.example.com; used for task links.' } },
    { key: 'project', type: 'text', pattern: '[A-Za-z0-9]{8,64}', label: { zh: '监听的项目', en: 'Watched project' },
      hint: { zh: '项目的 UUID，一个实例只监听一个项目；更多项目需要更多实例。保存时检查智能体账号能否读取它。', en: 'The project\'s UUID; one watched project per instance, more projects need more instances. Saving checks the agent account can read it.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' },
      hint: { zh: '单次网络中断会在下一次轮询时自动重试，不必报告。', en: 'A single network interruption is retried on the next poll and need not be reported.' } },
    { key: 'observeTasks', type: 'switch', label: { zh: '接收项目里的任务动态', en: 'Receive project task events' },
      hint: { zh: '打开后，没有指派给智能体的任务的新建和状态变化也会收到，由策略的接收表决定是否成为候选；永远不会成为明确的请求。', en: 'Creation and status changes of tasks not assigned to the agent are received too, and the Policy\'s admission table decides whether they become candidates; they are never explicit.' } },
    { key: 'observeComments', type: 'switch', label: { zh: '接收项目里的评论', en: 'Receive comments in the project' },
      hint: { zh: '打开后，不是智能体名下任务上的评论也会收到，由策略的接收表决定是否成为候选。', en: 'Comments on tasks that are not the agent\'s are received too, and the Policy\'s admission table decides whether they become candidates.' } },
  ],
  // The agent's own tasks are always listened to; everything else needs its observe switch and never addresses the agent.
  scope: ({ meta }, config) => {
    const row = rowOf(meta)
    if (row === 'assignment' || row === 'mine') return { listened: true as const, observed: false, row }
    const observed = (row === 'tasks' && config.observeTasks) || (row === 'comments' && config.observeComments)
    if (!observed) return { listened: false as const, reason: 'observe_off' }
    return { listened: true as const, observed: true, row: row! }
  },
  health: ['ones'],
  channel: { send: sendOnes, link: onesLink },
  threadContext: onesThreadContext,
  // A task's web URL names its Thread; bare UUIDs read as ordinary words, so only the URL identifies one.
  find: query => {
    const task = /\/task\/([A-Za-z0-9]+)\/([A-Za-z0-9]{8,64})(?![A-Za-z0-9])/.exec(query)
    return { threads: task ? [`ones:${task[1]}:${task[2]}`] : [], terms: [] }
  },
  policy: {
    unnamed: { person: { zh: 'ONES 用户', en: 'ONES user' }, bot: { zh: 'ONES 自动化', en: 'ONES automation' } },
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9]{8,64}$/), name: z.string().trim().max(100).optional() }).strict())
        .refine(users => new Set(users.map(user => user.id)).size === users.length, 'Duplicate user UUIDs').default([]),
      syncProject: z.boolean().default(false),
      bots: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9]{8,64}$/), name: z.string().trim().max(100).optional() }).strict())
        .refine(bots => new Set(bots.map(bot => bot.id)).size === bots.length, 'Duplicate bot UUIDs').optional(),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的 ONES 用户', en: 'ONES users who may originate work' },
        hint: { zh: '指派任务给智能体的人必须在这里；名单按 ONES 用户 UUID 填写。', en: 'Whoever assigns a task to the agent must be here; the list holds ONES user UUIDs.' },
        columns: [{ key: 'id', type: 'text', label: { zh: '用户 UUID', en: 'User UUID' }, pattern: '[A-Za-z0-9]{8,64}' },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
      { key: 'syncProject', type: 'switch', label: { zh: '从项目成员同步', en: 'Sync from project members' },
        hint: { zh: '同步时，名单变成这个项目的成员：新成员加入，离开的人移除，名字取项目里的名字。启动时和点同步时进行。', en: 'Syncing makes the list the project\'s members: new members join, people who left are removed, and names follow the project. It runs at startup and on Sync.' } },
      { key: 'bots', type: 'rows', label: { zh: '操作可以成为候选的自动化身份', en: 'Automations whose actions may become candidates' },
        hint: { zh: '名单里的自动化身份（工作流、集成）把任务指派给智能体时，来源记为机器人触发，最多成为推断的候选，交给接收表和接受模式；永远不会成为明确的请求。', en: 'When an identity on this list, such as a workflow or integration, assigns a task to the agent, the Source records a bot trigger: an inferred candidate at most under the admission table and accept mode; never explicit.' },
        columns: [{ key: 'id', type: 'text', label: { zh: '身份 UUID', en: 'Identity UUID' }, pattern: '[A-Za-z0-9]{8,64}' },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
    ],
    explicit: { zh: '名单里的用户把任务指派给智能体的账号；指派即 @，无需评论。', en: 'A user on the list assigns a task to the agent\'s account; the assignment is the mention, no comment needed.' },
    rows() {
      return [
        { id: 'mine', label: { zh: '智能体名下任务的评论与动态', en: 'Comments and events on the agent\'s tasks' }, note: { zh: '接收', en: 'Received' },
          cells: { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: false } },
        { id: 'assignment', label: { zh: '指派给智能体', en: 'Assignment to the agent' }, note: { zh: '未列入者默认不接单', en: 'Unlisted assigners are not accepted by default' },
          cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } },
        { id: 'tasks', label: { zh: '项目里的任务动态', en: 'Project task events' }, note: { zh: '默认不接收', en: 'Not received by default' },
          cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: true } },
        { id: 'comments', label: { zh: '项目里的评论', en: 'Comments in the project' }, note: { zh: '默认不接收', en: 'Not received by default' },
          cells: { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true } },
      ]
    },
    sync: {
      label: { zh: '立即同步', en: 'Sync now' },
      ready: part => part.syncProject === true,
      async run(host, part, signal) {
        const ctx = sourceContext(host, onesKind)
        const config = ctx.config<OnesModuleConfig>(SOURCE)
        if (!config) throw new Error('The ONES Source is off')
        const members = await onesListMembers(ctx.commands.withSignal(signal), config.cli)
        const users = new Map(members.map(user => [user.uuid, user.name]))
        const known = new Set(part.allowed.map(entry => entry.id))
        return { ...part, allowed: [...part.allowed.filter(entry => users.has(entry.id)).map(entry => ({ ...entry, name: users.get(entry.id) ?? entry.name })),
          ...members.filter(user => !known.has(user.uuid)).map(user => ({ id: user.uuid, ...(user.name ? { name: user.name } : {}) }))] }
      },
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_ONES_URL', description: { zh: 'ONES 实例的基础地址', en: 'Base URL of the ONES instance' } },
      { key: 'DSH_SUPERAGENT_ONES_PROJECT', description: { zh: '这个来源监听的项目 UUID', en: 'The project UUID this Source watches' } },
      { key: 'DSH_SUPERAGENT_ONES_ISSUE', description: { zh: '接下工单的 ONES 任务 UUID；工单不是从 ONES 来的时为空', en: 'The ONES task UUID that started the ticket; empty when the ticket did not start on ONES' } },
      { key: 'DSH_SUPERAGENT_ONES_TASK_URL', description: { zh: '那个任务的网页地址', en: 'Web URL of that task' } },
    ],
    values: ({ config, trigger }) => {
      const mine = trigger?.source === SOURCE && typeof trigger.meta.issue === 'string'
      const project = mine ? String(trigger.meta.project ?? config.project) : config.project
      const issue = mine ? String(trigger.meta.issue) : ''
      return { DSH_SUPERAGENT_ONES_URL: config.url, DSH_SUPERAGENT_ONES_PROJECT: project,
        DSH_SUPERAGENT_ONES_ISSUE: issue, DSH_SUPERAGENT_ONES_TASK_URL: issue ? onesPage(config.url, project, issue) : '' }
    },
  },
}

export const name = 'dsh-superagent-ones'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(onesKind), 'ones: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, onesKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the polling loop becomes the Source's health.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('ones', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}

/** Poll loop over the project's task list with an edited-since cursor; trigger ids deduplicate the restart overlap. */
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let interval = 60
  let failures = 0
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the accounts; until then nothing is polled.
  if (!ctx.configured()) { ctx.report('ones', health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<OnesModuleConfig>(SOURCE)
    if (!ctx.deployment.ones) {
      const waiting = config?.cli ? health('paused', 'onesAccountMissing') : health('paused', 'onesCliUnset')
      ctx.report('ones', ctx.problem ? { state: 'paused', detail: ctx.problem.detail } : waiting)
      await pause(60_000, signal)
      continue
    }
    try {
      if (config) interval = await pollRound(ctx, signal)
      else ctx.report('ones', health('paused', 'sourceOff'))
      failures = 0
    } catch (error) {
      failures += 1
      const failed = failures >= (config?.failuresBeforeError ?? 1) ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
      if (!signal.aborted && failed) ctx.report('ones', failed)
    }
    await pause(Math.max(interval, ctx.config<OnesModuleConfig>(SOURCE)?.pollSeconds ?? 60) * 1000, signal)
  }
}

interface Round { started: string; signal?: AbortSignal | undefined; tally: Tally; failures: string[]; read: Set<string> }
const newRound = (signal?: AbortSignal): Round => ({ started: new Date().toISOString(), signal, tally: { skipped: 0 }, failures: [], read: new Set() })
const stopped = (ctx: SourceContext, round: Round): boolean => !!round.signal?.aborted || !ctx.config(SOURCE)

/**
 * One polling round: the project's changed tasks with their activity diff, then subscribed Threads not already read.
 * Each task fails independently so one unreadable task does not hold back the others.
 * @returns the polling interval, in seconds.
 */
export async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<number> {
  const round = newRound(signal)
  const config = ctx.config<OnesModuleConfig>(SOURCE)!
  const commands = ctx.commands.withSignal(signal)
  const { project, cli } = config
  const agent = (ctx.deployment.ones?.user ?? '').toLowerCase()
  if (!agent) throw new Error('The ONES Source has no resolved account')
  const since = ctx.state.get(KV.ones.since) ?? cursorAt(round.started)
  const changed = await onesListIssues(commands, cli, project, since, round.tally)
  for (const issue of changed) {
    if (stopped(ctx, round)) throw new Error('The ONES Source stopped during the poll')
    try { await readTask(ctx, round, issue, agent) }
    catch (error) { if (!stopped(ctx, round)) round.failures.push(`${issue.title}: ${String(error)}`) }
    round.read.add(issue.uuid)
  }
  await pollThreads(ctx, signal, round)
  if (round.failures.length) throw new Error(`${round.failures.length} ONES reads failed: ${round.failures.slice(0, 3).join('; ')}`)
  const newest = changed.map(issue => Date.parse(issue.updatedAt)).filter(Number.isFinite).sort((a, b) => a - b).at(-1)
  const next = newest !== undefined ? cursorAt(new Date(newest).toISOString()) : since
  ctx.state.set(KV.ones.since, Date.parse(next) > Date.parse(since) ? next : since)
  const skipped = round.tally.skipped ? `; ${round.tally.skipped} unreadable items skipped` : ''
  ctx.report('ones', { state: 'ready', detail: `${changed.length} changed tasks${skipped}`, at: round.started })
  return config.pollSeconds
}

/** Reads one changed task: the agent-owned task through its activity diff; others only with observe switches on. */
async function readTask(ctx: SourceContext, round: Round, issue: OnesIssue, agent: string): Promise<void> {
  const config = ctx.config<OnesModuleConfig>(SOURCE)!
  const mine = !!issue.owner?.uuid && sameActor(issue.owner.uuid, agent)
  nameThread(ctx, config, issue)
  if (mine) {
    const activities = await onesListActivities(ctx.commands.withSignal(round.signal), config.cli, issue.uuid, round.tally)
    await intakeTask(ctx, round, issue, activities, agent)
    return
  }
  // Tasks not owned by the agent are received only with observe switches on, as admission-table candidates, never explicit.
  if (!config.observeTasks && !config.observeComments) return
  const activities = await onesListActivities(ctx.commands.withSignal(round.signal), config.cli, issue.uuid, round.tally)
  await intakeTask(ctx, round, issue, activities, agent)
}

/** Turns a task's activity diff into triggers: on the agent's task, the assignment (the mandate), comments and close; on observed tasks, creation and status changes as facts. */
async function intakeTask(ctx: SourceContext, round: Round, issue: OnesIssue, activities: OnesActivity[], agent: string): Promise<void> {
  const config = ctx.config<OnesModuleConfig>(SOURCE)!
  const mine = !!issue.owner?.uuid && sameActor(issue.owner.uuid, agent)
  const status = issueStatus(issue)
  const checkpoint = KV.ones.cursor(issue.uuid)
  const since = ctx.state.get(checkpoint) ?? cursorAt(round.started)
  const fresh = activities.filter(activity => Date.parse(activity.at) >= Date.parse(since)).sort((a, b) => a.at.localeCompare(b.at))
  if (!mine) {
    // Observed tasks never address the agent: creation and status changes are facts for the admission table.
    const created = fresh.find(activity => /create/i.test(activity.action))
    if (created && config.observeTasks) {
      await ctx.receive({ ...taskTrigger(issue, config.project, created.at), meta: { ...taskTrigger(issue, config.project, created.at).meta } })
    }
    const changed = fresh.filter(activity => isStatusChange(activity)).at(-1)
    if (changed && config.observeTasks) {
      await ctx.receive(statusTrigger(issue, config.project, status, changed.at, changed.operator?.uuid ?? ''))
    }
    for (const activity of fresh) {
      if (!activity.comment || !config.observeComments) continue
      const comment = commentTrigger(activity.comment, config.project, issue.uuid, agent)
      if (comment) await ctx.receive(comment)
    }
    ctx.state.set(checkpoint, cursorAt(round.started))
    return
  }
  for (const activity of fresh) {
    if (stopped(ctx, round)) throw new Error('The ONES Source stopped during the poll')
    if (isAssignment(activity, agent)) {
      const trigger = assignmentTrigger(issue, activity, config.project)
      // An automation identity performing the assignment (workflow, integration) is a bot trigger: an inferred candidate
      // at most under the gate's bot list, never an explicit request and never new scope.
      if (activity.operator?.automation) {
        await ctx.receive({ ...trigger, human: false, addressed: undefined, meta: { ...trigger.meta, bot: true } })
        continue
      }
      await ctx.receive(trigger)
      continue
    }
    if (activity.comment) {
      const comment = commentTrigger(activity.comment, config.project, issue.uuid, agent)
      if (comment) await ctx.receive(comment)
    }
    if (isStatusChange(activity) && isClosed(status)) {
      // The close is the thread's end; report it after the round's other reads so its ticket takes the facts first.
      await ctx.receive(closedTrigger(issue, config.project, status, activity.at))
      ctx.tickets.threadClosed({ source: SOURCE, id: `${config.project}:${issue.uuid}` }, 'closed', activity.at)
    }
  }
  ctx.state.set(checkpoint, cursorAt(round.started))
}

/** True when the activity made `agent` the task's owner; ONES editions name the action differently, owner is the stable word. */
function isAssignment(activity: OnesActivity, agent: string): boolean {
  if (!/owner|assign/i.test(activity.action)) return false
  const target = activity.to?.uuid ?? activity.operator?.uuid
  return !!target && sameActor(target, agent)
}
const isStatusChange = (activity: OnesActivity): boolean => /status/i.test(activity.action)
/** True when a status name marks a task done or canceled on this instance. */
export const isClosed = (status: string): boolean => /done|complete|cancel|clos|已完成|已取消|已关闭/i.test(status)

/** Polls subscribed ONES Threads not already read in this round, so follow-ups reach their Tickets in a quiet project. */
export async function pollThreads(ctx: SourceContext, signal?: AbortSignal, round = newRound(signal)): Promise<void> {
  await pollEach(ctx, SOURCE, () => !!signal?.aborted || !ctx.config(SOURCE), async thread => {
    await pollThread(ctx, round, thread)
  }, thread => round.read.has(taskOf(thread)))
}
function taskOf(thread: Thread): string {
  const id = thread.ref.id.slice(thread.ref.id.indexOf(':') + 1)
  if (!id) throw new Error('Subscribed thread has no ONES task UUID')
  return id
}
async function pollThread(ctx: SourceContext, round: Round, thread: Thread): Promise<void> {
  const config = ctx.config<OnesModuleConfig>(SOURCE)
  // The Source was turned off; the next round polls again.
  if (!config) return
  const [, project, issue] = thread.ref.id.split(':')
  if (!project || !issue) throw new Error('Subscribed thread has no ONES project and task')
  const agent = ctx.deployment.ones?.user ?? ''
  const task = await onesGetIssue(ctx.commands.withSignal(round.signal), config.cli, issue)
  nameThread(ctx, config, task)
  if (!task.owner?.uuid || !sameActor(task.owner.uuid, agent)) return
  const activities = await onesListActivities(ctx.commands.withSignal(round.signal), config.cli, issue, round.tally)
  await intakeTask(ctx, round, task, activities, agent)
  round.read.add(issue)
}

/** Names a Thread for the panel with its task title, status fact and page URL. */
function nameThread(ctx: SourceContext, config: OnesModuleConfig, issue: OnesIssue): void {
  ctx.threads.describe(threadKey({ source: SOURCE, id: `${config.project}:${issue.uuid}` }), {
    label: issue.title, url: issue.url ?? onesPage(config.url, config.project, issue.uuid),
    facts: { status: { label: { zh: '状态', en: 'Status' }, value: issueStatus(issue) || '—' } } })
}

/** Kept for the read layer's tests and the resources table. */
export { readOnes } from './ones-read.ts'
