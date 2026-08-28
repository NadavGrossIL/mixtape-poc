export { parseScript, parseSkill, kindOf, nodeId } from './parseScript'
export { parseYaml } from './parseYaml'
export { overlayRun, agentsOf, agentEnd, runBounds, stateAt } from './overlayRun'
export { layout, nodeSize, NODE_W, NODE_H, GATE_H } from './layout'
export type { Layout, Lane, LaidOutNode } from './layout'
import type { Graph, RunManifest, WorkflowFile } from '../types'
import { parseScript, parseSkill } from './parseScript'
import { parseYaml } from './parseYaml'

/** One graph from whichever source we have: a workflow file, else a run's own script. */
export function graphFor(wf: WorkflowFile | undefined, run: RunManifest | undefined): Graph {
  if (wf?.kind === 'yaml') return parseYaml(wf.source)
  if (wf?.kind === 'skill') return parseSkill(wf.name)
  if (wf?.kind === 'script') return parseScript(wf.source)
  if (run?.script) return parseScript(run.script)
  return { name: run?.workflowName, phases: (run?.phases ?? []).map((p) => p.title ?? ''), nodes: [], edges: [] }
}
