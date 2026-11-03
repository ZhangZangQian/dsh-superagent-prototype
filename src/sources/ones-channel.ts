/** ONES outbound channel: posts task comments through the agent's `ones` wrapper. */
import type { OutboundMessage } from '../core/index.ts'
import type { SourceContext } from './host.ts'
import { checkedImText } from '../infra/text.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { onesPage } from './ones-trigger.ts'
import { onesAddComment } from './ones-read.ts'

/** Posts a comment on the task the Channel names; the embedded marker makes an Outbox retry idempotent (the gh-agent pattern). */
export async function sendOnes(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { project, issue } = message.channel.address
  if (!project || !issue) throw new Error('Missing ONES reply target')
  // The registry passes only `commands`; its deployment carries the resolved ONES account (the github-channel pattern).
  const cli = host.commands.deployment.ones?.cli ?? 'ones'
  await onesAddComment(host.commands, cli, issue, checkedImText(message.text), message.id)
  return 'sent'
}
/** Links to the task's page on the instance; empty while setup has not resolved the base URL. */
export function onesLink(address: Record<string, string>, links: ChannelLinks): ChannelLink {
  const base = links.ones?.url ?? ''
  return { url: base ? onesPage(base, address.project ?? '', address.issue ?? '') : '',
    label: { zh: 'ONES 任务', en: 'ONES task' } }
}
