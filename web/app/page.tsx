'use client'

import Link from 'next/link'
import { useApp, useNow } from '@/components/AppState'
import { AddrLink } from '@/components/Links'
import { nextSweep } from '@/lib/chain'
import { deployment } from '@/lib/deployment'

const STEPS = [
	['Submit', "The issuer uploads the order. Only the PDF's SHA-1 leaves the browser, in a request signed by the issuer's key."],
	['Verify on the docket', "Ten Chainlink nodes each fetch the docket from CourtListener: the case, the entry, that it is an order, and the court's own PDF hash."],
	['Read, then decide in code', "Gemini reads the order's terms. Code freezes only wallets that appear verbatim in the court's text, and applies Rule 65(b)'s 14-day limit."],
	['Signed on-chain, lifted on time', 'The nodes sign one report for the registry. A docket sweep lifts the freeze when the court dissolves the order or it expires.'],
]

const TRUST = [
	['The AI reads; it does not decide.', "A hallucinated wallet cannot be frozen: it is not in the court's text."],
	['Fails safe.', 'Anything missing or mismatched is rejected with machine-readable reasons, never partly applied.'],
	['Only the issuer can ask.', "CRE's gateway refuses requests not signed by the authorized key."],
	['Humans stay in the loop.', 'Overrides are possible and every one is logged on-chain with a note.'],
]

export default function Overview() {
	const { chain } = useApp()
	const now = useNow(30_000)
	const stat = (n: number) => (chain.loaded ? n : '–')

	return (
		<section>
			<div className="hero">
				<div className="hero-text">
					<span className="eyebrow">Chainlink CRE · Legal tech</span>
					<h1>Freeze a wallet only when a real court order says so, and only for as long as it says so.</h1>
					<p>
						Writ checks a court order against the federal docket, reads it with Gemini, and has a Chainlink network write a signed attestation that freezes exactly the
						wallets the court named. When the order ends, the freeze ends.
					</p>
					<div className="hero-cta">
						<Link className="btn btn-primary" href="/verify">
							Verify an order
						</Link>
						<Link className="btn btn-light" href="/orders">
							See on-chain orders
						</Link>
					</div>
				</div>
				<div className="hero-case">
					<span className="eyebrow">Live demo case</span>
					<strong>
						<em>Newton AC/DC Fund, L.P. v. Ermilov</em>
					</strong>
					<span>N.D. Cal. No. 5:26-cv-05055 · Circle named as relief defendant</span>
					<span>ECF 18: stipulated consent TRO restraining 6 wallets</span>
					<span>ECF 38: order denying the preliminary injunction</span>
				</div>
			</div>

			<div className="stats">
				<div className="stat">
					<span className="stat-label">Orders in force</span>
					<span className="stat-value">{stat(chain.orders.filter((x) => x.status === 'Active' && x.inForce).length)}</span>
				</div>
				<div className="stat">
					<span className="stat-label">Wallets frozen</span>
					<span className="stat-value frozen-text">{stat(chain.orders.reduce((n, x) => n + x.wallets.filter((w) => w.frozen).length, 0))}</span>
				</div>
				<div className="stat">
					<span className="stat-label">Submissions rejected</span>
					<span className="stat-value bad-text">{stat(chain.rejections.length)}</span>
				</div>
				<div className="stat">
					<span className="stat-label">Next scheduled sweep</span>
					<span className="stat-value small">{now === null ? '–' : nextSweep(now)}</span>
				</div>
			</div>

			<h2 className="section-title">How it works</h2>
			<div className="steps">
				{STEPS.map(([title, text], i) => (
					<div className="step" key={title}>
						<span className="step-num">{i + 1}</span>
						<h3>{title}</h3>
						<p>{text}</p>
					</div>
				))}
			</div>

			<h2 className="section-title">Built to be trusted</h2>
			<div className="trust">
				{TRUST.map(([title, text]) => (
					<div key={title}>
						<b>{title}</b> {text}
					</div>
				))}
			</div>
			<p className="contracts">
				Contracts: OrderRegistry <AddrLink address={deployment.orderRegistry} /> · Writ USD <AddrLink address={deployment.writToken} /> · CRE forwarder{' '}
				<AddrLink address={deployment.forwarder} /> · CRE workflow <code>{deployment.workflowName}</code> <code>{deployment.workflowId.slice(0, 10)}…</code>
			</p>
		</section>
	)
}
