'use client'

import Link from 'next/link'
import type { FormEvent } from 'react'
import { useApp, type VerifyForm } from '@/components/AppState'
import { TxLink } from '@/components/Links'
import { RunPanel } from '@/components/RunPanel'
import { ATTACKER, day, PRESET_WALLETS, reasonList } from '@/lib/chain'
import type { RunResult } from '@/lib/run'

async function sha1Hex(blob: Blob): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-1', await blob.arrayBuffer())
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const LABELS = {
	sign: 'Signed by the issuer',
	gateway: 'Accepted by the CRE gateway',
	don: 'Chainlink nodes checking the docket',
	chain: 'Signed report written on Sepolia',
}

function Banner({ result }: { result?: RunResult }) {
	if (!result) return null
	const cta = (
		<Link className="cta" href="/orders">
			View on-chain orders →
		</Link>
	)
	switch (result.decision) {
		case 'VERIFIED':
			return (
				<div className="result ok">
					✓ Verified: {result.wallets} wallet(s) frozen {result.expiresAt ? `until ${day(result.expiresAt)}` : 'until further order of the court'}. Tx{' '}
					<TxLink hash={result.txHash} />
					<br />
					{cta}
				</div>
			)
		case 'REJECTED':
			return (
				<div className="result bad">
					✕ Rejected: {(result.reasons ? reasonList(result.reasons) : result.labels).join('; ')}. The rejection is recorded on-chain: tx <TxLink hash={result.txHash} />
					<br />
					{cta}
				</div>
			)
		case 'ALREADY_RECORDED':
			return (
				<div className="result ok">
					This order is already on-chain with status {result.status}.<br />
					{cta}
				</div>
			)
		case 'ACCEPTED':
			return (
				<div className="result ok">
					The DON accepted execution <code>{result.executionId.slice(0, 12)}…</code>; its result appears on-chain in about a minute.
					<br />
					{cta}
				</div>
			)
		case 'ERROR':
			return <div className="result bad">✕ {result.error}</div>
		default:
			return null
	}
}

export default function VerifyPage() {
	const { form, setForm, verify, startVerify } = useApp()
	const set = (patch: Partial<VerifyForm>) => setForm((f) => ({ ...f, ...patch }))

	async function choose(file: Blob, fileName: string) {
		set({ sha1: await sha1Hex(file), fileName })
	}

	async function preset(forged: boolean) {
		const name = `ecf-18-${forged ? 'forged' : 'genuine'}.pdf`
		const pdf = await (await fetch(`/fixtures/${name}`)).blob()
		const wallets = [...PRESET_WALLETS]
		if (forged) wallets[4] = ATTACKER
		setForm({ court: 'cand', docketNumber: '5:26-cv-05055', entryNumber: '18', filedDate: '2026-06-05', wallets: wallets.join('\n'), sha1: await sha1Hex(pdf), fileName: name })
	}

	function submit(e: FormEvent) {
		e.preventDefault()
		if (!form.sha1) return alert('Choose the order PDF first (or load the demo case).')
		startVerify()
	}

	return (
		<section>
			<div className="page-head">
				<div>
					<h2>Verify a court order</h2>
					<p className="muted">
						The PDF never leaves your browser: only its SHA-1 is sent. Chainlink CRE checks it against the court&apos;s copy on the federal docket (CourtListener / RECAP).
					</p>
				</div>
			</div>
			<div className="two-col">
				<div className="card">
					<div className="presets">
						<span className="muted">Try the demo case:</span>
						<button type="button" className="btn-chip ok" onClick={() => preset(false)}>
							Load genuine ECF 18
						</button>
						<button type="button" className="btn-chip bad" onClick={() => preset(true)}>
							Load forged ECF 18
						</button>
					</div>
					<form onSubmit={submit}>
						<div className="grid-3">
							<label>
								Court <input value={form.court} onChange={(e) => set({ court: e.target.value })} required />
							</label>
							<label>
								Docket number <input value={form.docketNumber} onChange={(e) => set({ docketNumber: e.target.value })} required />
							</label>
							<label>
								ECF entry <input type="number" min={1} value={form.entryNumber} onChange={(e) => set({ entryNumber: e.target.value })} required />
							</label>
						</div>
						<label>
							Filed <input type="date" value={form.filedDate} onChange={(e) => set({ filedDate: e.target.value })} />
						</label>
						<label className="dropzone">
							Order PDF
							<input type="file" accept="application/pdf" onChange={(e) => e.target.files?.[0] && choose(e.target.files[0], e.target.files[0].name)} />
							<span className={`drop-box ${form.fileName ? 'has-file' : ''}`}>{form.fileName ? `📄 ${form.fileName}` : 'Choose the order PDF, or load the demo case above'}</span>
						</label>
						<div className="sha">
							{form.sha1 ? (
								<>
									SHA-1 computed in your browser: <code>{form.sha1}</code>
								</>
							) : (
								<>
									SHA-1: <code>—</code>
								</>
							)}
						</div>
						<label>
							Wallets the order freezes <span className="hint">one per line; leave empty to freeze every wallet the order names</span>
							<textarea rows={6} spellCheck={false} value={form.wallets} onChange={(e) => set({ wallets: e.target.value })} />
						</label>
						<button type="submit" className="btn btn-primary wide" disabled={verify.busy}>
							{verify.busy ? 'Verifying…' : 'Verify with Chainlink CRE'}
						</button>
					</form>
				</div>

				<RunPanel
					title="Workflow run"
					labels={LABELS}
					run={verify}
					banner={<Banner result={verify.result} />}
					empty={
						<>
							Load the genuine or forged order and press <b>Verify</b>. Each check the nodes run appears here.
						</>
					}
				/>
			</div>
		</section>
	)
}
