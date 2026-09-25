import { Context } from '@deepseek-ai/cordis'
import { createScope, type ScopeKey } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { afterEach, describe, expect, it } from 'vitest'
import * as ProgressNarration from '../src/index.ts'

const EXPECTED_POLICY = `Keep the user informed while you work:
- Before your first tool call, send a short user-facing progress message that states the action you are taking.
- Send another short progress message only when you begin a meaningful new phase, discover an important finding, or encounter a blocker. Do not narrate every routine tool call.
- State observable actions and findings. Never reveal hidden chain-of-thought, private reasoning, or internal deliberation.
- A progress message does not end the turn. Continue working after sending it.
- After the work is complete, send exactly one final answer that summarizes the outcome and any remaining blockers.`

let context: Context | undefined
afterEach(async () => { await context?.fiber.dispose() })

async function harness(): Promise<Context> {
  const ctx = new Context()
  context = ctx
  await ctx.plugin(SystemPrompt)
  return ctx
}

describe('the progress narration row', () => {
  it('registers the exact progress policy at the first-party placement', async () => {
    const ctx = await harness()
    await ctx.plugin(ProgressNarration)

    const section = (await ctx.systemPrompt.assemble()).sections
      .find(candidate => candidate.name === ProgressNarration.PROGRESS_NARRATION_SECTION)

    expect(ctx.systemPrompt.getSectionOrder('PROGRESS_NARRATION')).toBe(400)
    expect(section).toEqual({
      name: 'interaction:progress-narration',
      text: EXPECTED_POLICY,
    })
  })

  it('limits a scoped mount to that agent and removes it when the fiber unloads', async () => {
    const ctx = await harness()
    const key: ScopeKey = { agent: 'a1' }
    const other: ScopeKey = { agent: 'a2' }
    const fiber = await createScope(ctx, key).ctx.plugin(ProgressNarration)

    const sectionNames = async (scope?: ScopeKey): Promise<string[]> =>
      (await ctx.systemPrompt.assemble(scope === undefined ? {} : { scope }))
        .sections.map(section => section.name)

    expect(await sectionNames(key)).toContain('interaction:progress-narration')
    expect(await sectionNames(other)).not.toContain('interaction:progress-narration')
    expect(await sectionNames()).not.toContain('interaction:progress-narration')

    await fiber.dispose()

    expect(await sectionNames(key)).not.toContain('interaction:progress-narration')
  })
})
