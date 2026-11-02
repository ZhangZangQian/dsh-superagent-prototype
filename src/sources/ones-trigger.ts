/** ONES task events as domain Triggers: the words are ONES's, the concepts the domain's. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'

export const SOURCE = 'ones'
/** ONES issue (task) UUID; any work-item type counts as a task. */
const uuid = z.string().regex(/^[A-Za-z0-9]{8,64}$/)
/** An ONES user or automation identity as issue records and activities print it. */
export const OnesActorSchema = z.looseObject({ uuid: uuid.optional(), name: z.string().optional() })
/** Parses a timestamp ONES prints as epoch milliseconds, or as an ISO-8601 string. */
export function onesTime(value: string | number): string {
  const time = typeof value === 'number' ? value : /^\d{12,}$/.test(value) ? Number(value) : Date.parse(value)
  if (!Number.isFinite(time)) throw new Error(`Unreadable ONES timestamp: ${String(value)}`)
  return new Date(time).toISOString()
}
/** A timestamp as the wrapper prints it: epoch milliseconds or ISO-8601, normalized to ISO strings. */
export const OnesTime = z.union([z.string(), z.number()]).transform(onesTime)
/** Builds the reply address of a task's comment list; `comment` names the message a reply follows. */
export const onesChannel = (project: string, issue: string, comment?: string): ChannelRef =>
  ({ source: SOURCE, thread: `ones:${project}:${issue}`, address: { project, issue, ...(comment ? { comment } : {}) } })
/** The web URL of a task on the instance; `link()` builds it from the base URL the config holds. */
export const onesPage = (baseUrl: string, project: string, issue: string): string =>
  `${baseUrl.replace(/\/+$/, '')}/project/#/task/${project}/${issue}`

/** A task record as `list issues` and `get issue` print it; any work-item type counts. */
export const OnesIssueSchema = z.looseObject({
  uuid: uuid, title: z.string(), issueStatusName: z.string().optional(), issueStatusIdentifier: z.string().optional(),
  owner: OnesActorSchema.nullish(), creator: OnesActorSchema.nullish(),
  description: z.string().nullish(), createdAt: OnesTime, updatedAt: OnesTime, url: z.string().optional(),
})
export type OnesIssue = z.infer<typeof OnesIssueSchema>

/** A comment as `get issue` and `list activities` print it; plain text only in the first cut. */
export const OnesCommentSchema = z.looseObject({
  uuid: uuid, writer: OnesActorSchema.nullish(), content: z.string().nullish(),
  createdAt: OnesTime, updatedAt: OnesTime.optional(), url: z.string().optional(),
})
export type OnesComment = z.infer<typeof OnesCommentSchema>

/** One activity entry; an owner change is the assignment action, and `comment` a comment added on the task. */
export const OnesActivitySchema = z.looseObject({
  uuid: uuid, action: z.string(), at: OnesTime,
  operator: OnesActorSchema.extend({ automation: z.boolean().optional() }).nullish(), to: OnesActorSchema.nullish(),
  comment: OnesCommentSchema.nullish(), url: z.string().optional(),
})
export type OnesActivity = z.infer<typeof OnesActivitySchema>

/** Case-insensitive ONES identity comparison, as the Policy's allowed list compares. */
export const sameActor = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
/** An issue's current status name, falling back to its identifier. */
export const issueStatus = (issue: OnesIssue): string => issue.issueStatusName ?? issue.issueStatusIdentifier ?? ''

/** Deterministic comment id: an edit changes the event, as GitHub treats comment `updated_at`. */
export const onesCommentId = (id: string, version: string): string => key('ones-comment', id, version)

/** The Trigger of a comment on a task; the agent's own comments produce none. */
export function commentTrigger(comment: OnesComment, project: string, issue: string, agentId: string): Trigger | undefined {
  const writer = comment.writer?.uuid
  if (!writer || sameActor(writer, agentId)) return undefined
  return { id: onesCommentId(comment.uuid, comment.updatedAt ?? comment.createdAt),
    source: SOURCE, threads: [{ source: SOURCE, id: `${project}:${issue}` }],
    actor: { source: SOURCE, id: writer }, human: true, at: comment.createdAt, text: comment.content ?? '',
    channel: onesChannel(project, issue, comment.uuid), ...(comment.url ? { url: comment.url } : {}),
    meta: { project, issue, commentId: comment.uuid, kind: 'comment' } }
}

/** The Trigger of the assignment that made the agent the task's owner; `assigner` is who performed the action. */
export function assignmentTrigger(issue: OnesIssue, activity: { at: string; operator?: { uuid?: string } | null }, project: string): Trigger {
  const assigner = activity.operator?.uuid ?? ''
  return { id: key('ones-assignment', issue.uuid, project), source: SOURCE,
    threads: [{ source: SOURCE, id: `${project}:${issue.uuid}` }],
    actor: { source: SOURCE, id: assigner }, human: true, at: activity.at,
    text: [issue.title, issue.description ?? ''].filter(Boolean).join('\n\n'),
    channel: onesChannel(project, issue.uuid), ...(issue.url ? { url: issue.url } : {}),
    // Assignment is the addressing: explicit however its text reads. When the API cannot name the assigner, the
    // trigger stays human with an empty actor, so the gate reads the admission table rather than guessing a sender.
    addressed: 'mention',
    meta: { project, issue: issue.uuid, kind: 'assignment', assigner, owner: issue.owner?.uuid ?? '', title: issue.title } }
}

/** The Trigger of a task's creation in the project (observed only); its creator is the actor, never addressing the agent. */
export function taskTrigger(issue: OnesIssue, project: string, at: string): Trigger {
  return { id: key('ones-task', issue.uuid, project), source: SOURCE,
    threads: [{ source: SOURCE, id: `${project}:${issue.uuid}` }],
    actor: { source: SOURCE, id: issue.creator?.uuid ?? '' }, human: true, at,
    text: [issue.title, issue.description ?? ''].filter(Boolean).join('\n\n'),
    channel: onesChannel(project, issue.uuid), ...(issue.url ? { url: issue.url } : {}),
    meta: { project, issue: issue.uuid, kind: 'task', title: issue.title } }
}

/** The Trigger of a status change on a task; it reaches subscribed Tickets as context and never addresses the agent. */
export function statusTrigger(issue: OnesIssue, project: string, status: string, at: string, actor = ''): Trigger {
  return { id: key('ones-status', issue.uuid, status, at), source: SOURCE,
    threads: [{ source: SOURCE, id: `${project}:${issue.uuid}` }],
    actor: { source: SOURCE, id: actor }, human: false, at, text: `Status changed to ${status}.`,
    channel: onesChannel(project, issue.uuid), ...(issue.url ? { url: issue.url } : {}),
    meta: { project, issue: issue.uuid, kind: 'status', status } }
}

/** The Trigger of a task's close (done or canceled); the Source also reports the close to the Engine. */
export function closedTrigger(issue: OnesIssue, project: string, status: string, at: string): Trigger {
  return { id: key('ones-closed', issue.uuid, status, at), source: SOURCE,
    threads: [{ source: SOURCE, id: `${project}:${issue.uuid}` }],
    actor: { source: SOURCE, id: '' }, human: false, at, text: `Task closed as ${status}.`,
    channel: onesChannel(project, issue.uuid), ...(issue.url ? { url: issue.url } : {}),
    meta: { project, issue: issue.uuid, kind: 'closed', status } }
}
