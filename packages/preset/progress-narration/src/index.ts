/**
 * User-facing progress-message policy for one agent scope or a deployment.
 * @module @deepseek-ai/dsh-progress-narration
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Cordis plugin name. */
export const name = 'progress-narration'

/** Prompt registry required by the policy. */
export const inject = ['systemPrompt']

/** Stable section identity for scoped prompt assembly. */
export const PROGRESS_NARRATION_SECTION = 'interaction:progress-narration'

/** Guidance for visible progress in the current Session and one final answer. */
export const PROGRESS_NARRATION_POLICY = `Keep the user informed while you work:
- Before your first tool call, send a short user-facing progress message that states the action you are taking.
- Send another short progress message only when you begin a meaningful new phase, discover an important finding, or encounter a blocker. Do not narrate every routine tool call.
- State observable actions and findings. Never reveal hidden chain-of-thought, private reasoning, or internal deliberation.
- A progress message does not end the turn. Continue working after sending it.
- After the work is complete, send exactly one final answer that summarizes the outcome and any remaining blockers.`

/**
 * Add the static policy to the mounting scope until this plugin unloads.
 * @param ctx - global or Agent-scoped context receiving the section.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.systemPrompt.section({
    name: PROGRESS_NARRATION_SECTION,
    order: ctx.systemPrompt.getSectionOrder('PROGRESS_NARRATION'),
    text: PROGRESS_NARRATION_POLICY,
  }), 'progressNarration.section()')
}
