// Sample native workflow script for the console's static parser. It follows
// the sketch in docs/factory/plan.md §10; the real .claude/workflows/ script
// replaces it once M4a lands. `human:merge` is not an agent the engine can
// pause on — it is the hand-off point from the §4 diagram, drawn on the map.
export const meta = {
  name: 'implement-from-spec',
  description: 'spec → gated, reviewed branch',
  phases: [
    { title: 'Implement', detail: 'the implementer works the spec on a branch' },
    { title: 'Gate', detail: 'types → tests → selftest → build, at most 2 tries' },
    { title: 'Review', detail: 'a separate read-only reviewer, then a human merges' },
  ],
}

const spec = args
let gate
for (let i = 0; i < 2; i++) {
  await agent(`/implement ${spec}`, { label: 'implement', phase: 'Implement' })
  gate = await agent('Run `npm run gate`; return {ok, log}', { schema: GATE, label: 'gate', phase: 'Gate' })
  if (gate.ok) break
}
if (!gate.ok) return { status: 'needs-human', gate }

const review = await agent(`Review ${spec} against the diff`, {
  agentType: 'reviewer',
  schema: REVIEW,
  label: 'review',
  phase: 'Review',
})
await agent('Open a draft PR and append the RUNS.md row', { label: 'human:merge', phase: 'Review' })
return { status: review.verdict === 'pass' ? 'ready-for-pr' : 'needs-human', review }
