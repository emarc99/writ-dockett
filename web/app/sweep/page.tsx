'use client'

import Link from 'next/link'
import { useApp, useNow } from '@/components/AppState'
import { RunPanel } from '@/components/RunPanel'
import { nextSweep, SWEEP_EVERY_HOURS } from '@/lib/chain'

const LABELS = {
	sign: 'Signed by the issuer',
	gateway: 'Accepted by the CRE gateway',
	don: 'Chainlink nodes reading dockets',
	chain: 'Result recorded',
}

export default function SweepPage() {
	const { sweep, startSweep } = useApp()
	const now = useNow(30_000)
	const result = sweep.result

	return (
		<section>
			<div className="page-head">
				<div>
					<h2>Docket sweep</h2>
					<p className="muted">Freezes have to end too. The sweep re-reads every active order&apos;s docket and lifts the freeze when the law says it ends.</p>
				</div>
			</div>
			<div className="two-col">
				<div className="card">
					<h3 className="card-title">What ends a freeze</h3>
					<ul className="triggers">
						<li>
							<span className="tag bad">Dissolved</span>A later order ends it, e.g. denying the preliminary injunction.
						</li>
						<li>
							<span className="tag warn">Superseded</span>A later order replaces it, e.g. a preliminary injunction.
						</li>
						<li>
							<span className="tag ok">Extended</span>The court extends it; the new end date is recorded.
						</li>
						<li>
							<span className="tag muted-tag">Expired</span>An ex parte TRO reaches 14 days (Fed. R. Civ. P. 65(b)(2)).
						</li>
					</ul>
					<div className="schedule">
						<div>
							<span className="stat-label">Runs on the DON</span>
							<b>every {SWEEP_EVERY_HOURS} hours</b>
						</div>
						<div>
							<span className="stat-label">Next scheduled run</span>
							<b>{now === null ? '–' : nextSweep(now)}</b>
						</div>
					</div>
					<p className="hint">
						The sweep reads finalized blocks only, so an order verified in the last ~15 minutes is not visible to it yet. A freeze is never lifted on a block that could
						still be reorganised.
					</p>
					<button type="button" className="btn btn-primary wide" disabled={sweep.busy} onClick={startSweep}>
						{sweep.busy ? 'Sweeping…' : 'Run sweep now'}
					</button>
				</div>

				<RunPanel
					title="Sweep run"
					labels={LABELS}
					run={sweep}
					banner={
						result?.decision === 'ERROR' ? (
							<div className="result bad">✕ {result.error}</div>
						) : result ? (
							<div className="result ok">
								✓ Sweep finished on the DON.{' '}
								<Link className="cta" href="/orders">
									View on-chain orders →
								</Link>
							</div>
						) : null
					}
					empty={
						<>
							Press <b>Run sweep now</b> to ask the DON to sweep immediately.
						</>
					}
				/>
			</div>
		</section>
	)
}
