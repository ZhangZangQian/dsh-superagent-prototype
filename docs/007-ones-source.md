# 007 ONES Source

> Status: design proposal, not yet implemented. This document extends the numbered series for a review audience; a merged implementation updates [006 Deployment](006-deployment.md) alongside.

ONES as a Source kind: assignment authorizes work. This document builds on [001 Domain model](001-domain.md) and [002 Authorization](002-authorization.md).

## Concept mapping

The concepts are the domain's; only the words are ONES's. "Task" below means any ONES work item type (task, issue, requirement, bug…).

| Domain | ONES | Notes |
| --- | --- | --- |
| Source instance | One ONES team + one watched project | Config holds base URL, team UUID, project UUID, agent CLI path |
| Thread | One ONES task | `ones:<projectUUID>:<issueID>` |
| Trigger | A task event: assignment to the agent, comment, description/status change, task close | One immutable event per activity |
| Explicit addressing | The agent account becomes the task's owner (assignee) | Assignment = mention. No comment text needed |
| Channel | `add issue comment` | Delivery and acknowledgements both go there |
| Allowed list | ONES user UUIDs who may assign to the agent | The authorizer is the person who performs the assignment action |
| Bot list | Workflow automation / integration identities | An automation-set assignee is a bot: inferred candidate at most, never explicit |
| Subscription | The agent-owned task | Follow-up comments/status changes fan out without Eval |
| End | Task closed (done/canceled) | `threadClosed` with outcome |

## Authorization semantics: assignment is the mandate

- **Who authorizes**: the user who performed the assignment action, taken from the task's activity record (`get_issue_activities`). If the API cannot name them, the mandate records the task creator as sender with strength honestly downgraded or the trigger observed rather than accepted — never guessed.
- **Explicit request**: a user on the allowed list assigns the task to the agent account. The trigger's `meta.addressed` is set by assignment, not mention text.
- **Unlisted assigner**: the admission table's unlistedAddressed cell decides (default: recorded, not accepted) — same table as [002](002-authorization.md).
- **Automation never authorizes**: assignment performed by workflow automation or an integration counts as a bot trigger. It can become an inferred candidate (when the identity is on the bot list) subject to accept mode and rules; it can never be explicit, and never authorizes new scope on an existing ticket.
- **Stop**: a listed user comments "stop"/"不用做了" on the task (Eval judges), or cancels the assignment, or the task is closed. Cancel/close of the thread ends per the domain's threadClosed rules.
- **Resume**: a person's comment on the agent-owned task resumes an ended ticket under the same mandate, revalidated as usual (allowed list membership of the original authorizer, task still open).

## Triggers and threads

Poll loop over the project's task list (edited-since cursor), analogous to the GitHub notification poll:

1. For each changed task where the agent is owner → activity diff → emit triggers (assignment / comment / status change / close).
2. Tasks not owned by the agent are received only with observe switches on (`observeTasks`, `observeComments`), as admission-table candidates, never explicit.
3. Read position: a persisted cursor of task UUID + activity timestamp; a restart never replays (Source rule).

Channel address: `{ project, issue, comment? }`; `link()` builds the ONES web URL from base URL + project + issue.

## Policy part

`policy.schema`: `{ allowed: [{id: onces user uuid, name?}], bots: [{id}], admission: table }`
`sync` (optional): refresh `allowed` from the project's member list (ones `get_project_members`), mirroring the Feishu chat-member sync.

Admission rows: `tasks` (new tasks in the project), `comments` (comments on non-agent tasks), `assignment` (assignment to the agent by an unlisted user). The `assignment` row's unlistedAddressed cell is the main knob: default `ignore`, `inferred` for a trial period, `explicit` never recommended.

## Environment variables

| Variable | Value |
| --- | --- |
| `DSH_SUPERAGENT_ONES_URL` | Base URL of the ONES instance |
| `DSH_SUPERAGENT_ONES_PROJECT` | Watched project UUID |
| `DSH_SUPERAGENT_ONES_ISSUE` | The task that started the ticket; empty otherwise |
| `DSH_SUPERAGENT_ONES_TASK_URL` | Web URL of that task |

Workers call the CLI as `ones` (shimmed in `worker-bin` like `gh`/`lark-cli`); delivery comments use `add issue comment`.

## CLI wrapper (`ones-agent`)

ONES has no official CLI, so the bundle ships a small wrapper script following the gh-agent pattern:

- Credentials in a separate config dir (`ONES_CONFIG_DIR`), holding base URL, team UUID, API token — never in the panel, never in chat.
- Subcommands emit stable JSON on stdout: `api user` (whoami), `list issues --changed-since`, `get issue --id`, `list activities --id`, `add comment --id --body`, `list members`.
- The Source's poll and channel call it through `Commands`; setup checks `api user` can read the project (and reports a setup problem when it cannot).

## Scope guardrails

- One watched project per instance; more projects = more instances.
- No cross-source identity mapping: an ONES user and a GitHub account are never linked in code; if a team needs "same person" semantics it is prompt text (domain rule).
- No new domain concepts: no "sprint", no "sprint triggered" concept — if needed, sprint sync is prompt text for the worker.
- Health entries: `ones` (poll), `sync:ones` (roster sync when enabled).

## Open questions (for the review)

1. Does the team's ONES edition expose `get_issue_activities` with actor attribution for owner changes? (Determines assigner identification honesty; fallback documented above.)
2. Should `observeTasks` include status-change triggers on non-agent tasks, or new tasks only, at first?
3. Comment delivery: plain text only first (no rich text/attachments), matching the GitHub channel's simplicity?
