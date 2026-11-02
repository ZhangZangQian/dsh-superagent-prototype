/** The `ones` CLI wrapper calls the Source and assessments use, and the ONES thread context reader. */
import { z } from 'zod'
import { validItems, type Commands } from '../infra/commands.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'
import { OnesActivitySchema, OnesCommentSchema, OnesIssueSchema, type OnesIssue } from './ones-trigger.ts'

/** The command workers and this Source call; `worker-bin` shims it onto PATH. */
export const ONES_CLI = 'ones'
/** The runner every wrapper call goes through: `Commands.run` of the host's command context. */
type Runner = Pick<Commands, 'run'>

/** `api user`: the agent's account as the wrapper reports it. */
export async function onesApiUser(commands: Runner, cli: string) {
  const UserSchema = z.looseObject({ uuid: z.string(), name: z.string().optional() })
  return UserSchema.parse(JSON.parse(await commands.run(cli, ['api', 'user'])))
}
/** `list issues --changed-since`: the project's tasks whose edits land after the cursor. */
export async function onesListIssues(commands: Runner, cli: string, project: string, since: string, tally: { skipped: number } = { skipped: 0 }) {
  const PageSchema = z.looseObject({ items: z.array(z.unknown()) })
  const page = PageSchema.parse(JSON.parse(await commands.run(cli, ['list', 'issues', '--project', project, '--changed-since', since])))
  return validItems(OnesIssueSchema, page.items, tally)
}
/** `get issue --id`: one task. */
export async function onesGetIssue(commands: Runner, cli: string, issue: string): Promise<OnesIssue> {
  return OnesIssueSchema.parse(JSON.parse(await commands.run(cli, ['get', 'issue', '--id', issue])))
}
/** `list activities --id`: the task's activity record; owner changes carry who performed the assignment. */
export async function onesListActivities(commands: Runner, cli: string, issue: string, tally: { skipped: number } = { skipped: 0 }) {
  const PageSchema = z.looseObject({ items: z.array(z.unknown()), next: z.string().optional() })
  const items: unknown[] = []
  let cursor: string | undefined
  const seen = new Set<string>()
  do {
    const page = PageSchema.parse(JSON.parse(await commands.run(cli,
      ['list', 'activities', '--id', issue, ...(cursor ? ['--after', cursor] : [])])))
    items.push(...page.items)
    if (page.next && seen.has(page.next)) throw new Error('ONES activity pagination did not advance')
    cursor = page.next
    if (cursor) seen.add(cursor)
  } while (cursor)
  return validItems(OnesActivitySchema, items, tally)
}
/** `list comments --id --page`: one page of a task's comments, oldest first. */
export async function onesListComments(commands: Runner, cli: string, issue: string, page: number, tally: { skipped: number } = { skipped: 0 }) {
  const PageSchema = z.looseObject({ items: z.array(z.unknown()), next_page: z.number().optional() })
  const result = PageSchema.parse(JSON.parse(await commands.run(cli, ['list', 'comments', '--id', issue, '--page', String(page)])))
  const items = validItems(OnesCommentSchema, result.items, tally)
  return { items, ...result.next_page ? { next_page: result.next_page } : {} }
}
/** `add comment --issue --body --marker`: delivery and acknowledgements both go here; the marker makes retries idempotent. */
export async function onesAddComment(commands: Runner, cli: string, issue: string, body: string, marker: string): Promise<void> {
  await commands.run(cli, ['add', 'comment', '--issue', issue, '--body', `${body}\n\n<!-- ${marker} -->`])
}
/** `list members`: the project's members, for the Policy's roster sync. */
export async function onesListMembers(commands: Runner, cli: string) {
  const MemberSchema = z.looseObject({ uuid: z.string(), name: z.string().optional() })
  const PageSchema = z.looseObject({ items: z.array(z.unknown()) })
  const page = PageSchema.parse(JSON.parse(await commands.run(cli, ['list', 'members'])))
  return validItems(MemberSchema, page.items)
}

/** A task as one model-facing message: its title, description, creator and time. */
const taskMessage = (task: OnesIssue): ContextMessage =>
  ({ id: task.uuid, from: task.creator?.name ?? task.creator?.uuid ?? '', at: task.createdAt,
    text: [task.title, task.description ?? ''].filter(Boolean).join('\n\n'), ...(task.url ? { url: task.url } : {}) })
/** A comment as one model-facing message; the writer's name when ONES gives one, else their UUID. */
const commentMessage = (comment: z.infer<typeof OnesCommentSchema>): ContextMessage =>
  ({ id: comment.uuid, from: comment.writer?.name ?? comment.writer?.uuid ?? '', at: comment.createdAt,
    text: comment.content ?? '', ...(comment.url ? { url: comment.url } : {}) })
const issueStatusOf = (task: OnesIssue): string => task.issueStatusName ?? task.issueStatusIdentifier ?? ''

/** The `ones/` resources for orchestrator_read: a task with its description first, and pages of its comments. */
export async function readOnes(commands: Runner, cli: string, resource: string): Promise<unknown> {
  const match = /^ones\/([A-Za-z0-9]{8,64})(?:\/(description|comments)(?:\/([1-9]\d*))?)?$/.exec(resource)
  if (!match) throw new Error('Use ones/<task uuid>, or append /description or /comments/<page>')
  const [, issue, section, page = '1'] = match
  const task = await onesGetIssue(commands, cli, issue!)
  if (!section || section === 'description') return { messages: [taskMessage(task)], status: issueStatusOf(task) }
  const listed = await onesListComments(commands, cli, issue!, Number(page))
  return { messages: listed.items.map(commentMessage),
    ...listed.next_page ? { next_resource: `ones/${issue}/comments/${listed.next_page}` } : {} }
}

/**
 * Context reader for a ONES Trigger: the task's description as its root and parent, and its comment list by page.
 * The description is flat and first, so root and parent read the same description as page 1 of the thread.
 */
export const onesThreadContext: ThreadContext<{ cli: string }> = {
  messageId: trigger => String(trigger.meta.commentId ?? trigger.meta.issue ?? ''),
  read: async (commands, trigger, part, cursor, config) => {
    const issue = String(trigger.meta.issue ?? '')
    if (!issue) throw new Error('A ONES source trigger is required')
    if (part === 'root' || part === 'parent') {
      const task = await onesGetIssue(commands, config.cli, issue)
      return { messages: [taskMessage(task)], body: { status: 'description' }, status: 'description' }
    }
    const page = Number(cursor ?? '1')
    const listed = await onesListComments(commands, config.cli, issue, page)
    return { messages: listed.items.map(commentMessage), next: listed.next_page ? String(listed.next_page) : undefined,
      body: { page }, status: 'comments' }
  },
}
