import type { Ledger, RunManifest } from '../types'
import { fmtDate, fmtDuration, fmtTokens, fmtUsd, projectTag, dash } from './format'

export function RunList({ runs, ledger, selectedId, onSelect }: { runs: RunManifest[]; ledger: Ledger; selectedId?: string; onSelect: (id: string) => void }) {
  return (
    <aside className="rail">
      <h2>Runs</h2>
      {runs.length === 0 && <p className="muted">No runs on disk for this repo.</p>}
      <ul className="runs">
        {runs.map((r) => (
          <li key={r.runId}>
            <button className="run" data-selected={r.runId === selectedId || undefined} onClick={() => r.runId && onSelect(r.runId)}>
              <span className="dot" data-status={r.status ?? 'unknown'} aria-label={r.status} />
              <span className="run-main">
                <span className="run-name">{r.workflowName ?? dash}{r.fixture && <span className="badge">fixture</span>}{r.live && <span className="badge" data-live>live</span>}{projectTag(r.projectSlug) && <span className="badge" title={r.projectSlug}>{projectTag(r.projectSlug)}</span>}</span>
                <span className="run-meta">{fmtDate(r.startTime, r.timestamp)} · {fmtDuration(r.durationMs)} · {fmtTokens(r.totalTokens)} tok{r.runId && ledger[r.runId]?.cost != null && <> · <span className="chip">{fmtUsd(ledger[r.runId].cost)}</span></>}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  )
}
