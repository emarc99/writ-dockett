'use client'

import type { ReactNode } from 'react'
import { KIND_LABELS, STEPS, type Run, type Step } from '@/lib/run'
import { useNow } from './AppState'

function Elapsed({ start, end }: { start: number; end?: number }) {
	const now = useNow(500)
	if (now === null) return null
	const s = Math.max(0, Math.floor(((end ?? now) - start) / 1000))
	return <span className="elapsed">{`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`}</span>
}

export function RunPanel({ title, labels, run, banner, empty }: { title: string; labels: Record<Step, string>; run: Run; banner?: ReactNode; empty: ReactNode }) {
	return (
		<div className="card run-card">
			<h3 className="card-title">{title}</h3>
			<ol className="stepper">
				{STEPS.map((s) => (
					<li key={s} className={run.steps[s] ?? ''}>
						{labels[s]}
						{s === 'don' && run.donStart ? <Elapsed start={run.donStart} end={run.donEnd} /> : null}
					</li>
				))}
			</ol>
			{run.busy && run.note ? <div className="result run">{run.note}</div> : banner}
			<ol className="checks">
				{run.checks.length === 0 ? (
					<li className="empty">{empty}</li>
				) : (
					run.checks.map((c, i) => (
						<li key={i} className={c.verdict}>
							<span className="icon">{c.verdict === 'pass' ? '✓' : c.verdict === 'fail' ? '✕' : '•'}</span>
							<div>
								{c.kind !== 'check' && <span className={`kind ${c.kind}`}>{KIND_LABELS[c.kind]}</span>}
								{c.name}
								{c.detail && <small>{c.detail}</small>}
							</div>
						</li>
					))
				)}
			</ol>
			<details>
				<summary>Raw workflow log</summary>
				<pre>{run.log || 'Nothing yet.'}</pre>
			</details>
		</div>
	)
}
