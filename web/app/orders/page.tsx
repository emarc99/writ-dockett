'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { formatUnits, type Address } from 'viem'
import { useApp } from '@/components/AppState'
import { AddrLink, TxLink } from '@/components/Links'
import { day, isFrozen, reasonList, short, tryTransfer, TYPES, type OrderView } from '@/lib/chain'

type TryResult = { ok: boolean; text: string } | 'pending'

function TryTransfer({ wallet }: { wallet: Address }) {
	const [out, setOut] = useState<TryResult>()
	return (
		<>
			<button type="button" onClick={async () => (setOut('pending'), setOut(await tryTransfer(wallet)))}>
				Try transfer
			</button>
			{out && <span className={`try-out ${out === 'pending' ? '' : out.ok ? 'free' : 'frozen'}`}>{out === 'pending' ? '…' : out.text}</span>}
		</>
	)
}

function OrderCard({ order }: { order: OrderView }) {
	const { id, o, inForce, wallets, status } = order
	const [court, docket] = o.docketRef.split('|')
	const now = Date.now() / 1000
	const expiry =
		o.expiresAt === 0n
			? 'Until further order'
			: Number(o.expiresAt) > now
				? `${day(o.expiresAt)} (${Math.ceil((Number(o.expiresAt) - now) / 86400)} days left)`
				: `${day(o.expiresAt)} (lapsed)`
	const frozenCount = wallets.filter((x) => x.frozen).length

	return (
		<div className={`order ${status}`}>
			<div className="order-head">
				<div>
					<strong>
						{court.toUpperCase()} {docket} · ECF {o.entryNumber}
					</strong>
					<div className="order-sub">
						{TYPES[o.orderType]} · {frozenCount} of {wallets.length} wallets frozen
					</div>
				</div>
				<span className={`pill ${status}`}>
					{status}
					{status === 'Active' && !inForce ? ' (lapsed)' : ''}
				</span>
			</div>
			<div className="facts">
				<div className="fact">
					<span>Notice</span>
					<b>{o.exParte ? 'Ex parte (14-day cap)' : 'With notice / consent'}</b>
				</div>
				<div className="fact">
					<span>Entered</span>
					<b>{day(o.issuedAt)}</b>
				</div>
				<div className="fact">
					<span>Freeze ends</span>
					<b>{expiry}</b>
				</div>
				<div className="fact">
					<span>Docket checked through</span>
					<b>ECF {o.lastCheckedEntry}</b>
				</div>
				<div className="fact">
					<span>Evidence</span>
					<b>{o.evidenceEntry ? `ECF ${o.evidenceEntry}` : '—'}</b>
				</div>
				<div className="fact">
					<span>Order id</span>
					<b className="mono">{short(id)}</b>
				</div>
			</div>
			<div className="hashes">
				<span>
					Court PDF SHA-1 <code>{o.docSha1.slice(2)}</code>
				</span>
			</div>
			<table>
				<thead>
					<tr>
						<th>Wallet</th>
						<th>Balance</th>
						<th>Status</th>
						<th />
					</tr>
				</thead>
				<tbody>
					{wallets.map(({ w, frozen, bal }) => (
						<tr key={w}>
							<td>
								<AddrLink address={w} />
							</td>
							<td>{Number(formatUnits(bal, 6)).toLocaleString()} wUSD</td>
							<td>
								<span className={`chip ${frozen ? 'frozen' : 'free'}`}>{frozen ? 'FROZEN' : 'FREE'}</span>
							</td>
							<td>
								<TryTransfer wallet={w} />
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	)
}

function Probe() {
	const [wallet, setWallet] = useState('')
	const [out, setOut] = useState<{ frozen: boolean; text: string } | string>('')

	async function probe() {
		const w = wallet.trim()
		if (!/^0x[0-9a-fA-F]{40}$/.test(w)) return setOut('Enter a 0x address.')
		setOut('…')
		const [frozen, r] = await Promise.all([isFrozen(w as Address), tryTransfer(w as Address)])
		setOut({ frozen, text: r.text })
	}

	return (
		<div className="card">
			<h3 className="card-title">Check any wallet</h3>
			<div className="row">
				<input placeholder="0x…" spellCheck={false} value={wallet} onChange={(e) => setWallet(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && probe()} />
				<button type="button" className="btn-ghost" onClick={probe}>
					Try a wUSD transfer
				</button>
			</div>
			<div className="muted probe-out">
				{typeof out === 'string' ? (
					out
				) : (
					<>
						<span className={`chip ${out.frozen ? 'frozen' : 'free'}`}>{out.frozen ? 'FROZEN' : 'NOT FROZEN'}</span> {out.text}
					</>
				)}
			</div>
		</div>
	)
}

export default function OrdersPage() {
	const { chain, refresh } = useApp()
	const [refreshing, setRefreshing] = useState(false)

	async function reload() {
		setRefreshing(true)
		await refresh()
		setRefreshing(false)
	}

	useEffect(() => {
		refresh()
	}, [refresh])

	return (
		<section>
			<div className="page-head">
				<div>
					<h2>On-chain orders</h2>
					<p className="muted">
						Live from the <code>OrderRegistry</code> on Sepolia. A wallet is frozen only while a verified order naming it is in force.
					</p>
				</div>
				<button type="button" className="btn-ghost" onClick={reload} disabled={refreshing}>
					{refreshing ? 'Refreshing…' : '↻ Refresh'}
				</button>
			</div>
			<div className="two-col orders-layout">
				<div>
					{!chain.loaded ? (
						<div className="card empty-state">Loading from Sepolia…</div>
					) : chain.error ? (
						<div className="card empty-state">Could not read Sepolia: {chain.error}</div>
					) : chain.orders.length === 0 ? (
						<div className="card empty-state">
							<b>No verified orders yet</b>
							Verify the genuine ECF 18 to see its wallets frozen here.
							<br />
							<br />
							<Link className="btn btn-primary" href="/verify">
								Verify an order
							</Link>
						</div>
					) : (
						chain.orders.map((order) => <OrderCard key={order.id} order={order} />)
					)}
				</div>
				<aside>
					<Probe />
					<div className="card">
						<h3 className="card-title">Rejected submissions</h3>
						{chain.rejections.length === 0 ? (
							<span className="muted">{chain.loaded ? 'None yet.' : '—'}</span>
						) : (
							chain.rejections.map((r) => {
								const [court, docket] = r.docketRef.split('|')
								return (
									<div className="reject" key={r.tx}>
										<b>
											{court.toUpperCase()} {docket} · ECF {r.entryNumber}
										</b>
										<div className="reasons">
											{reasonList(r.reasons).map((x) => (
												<span key={x}>{x}</span>
											))}
										</div>
										<div className="muted">
											submitted SHA-1 <code>{r.submittedSha1.slice(2, 14)}…</code> · tx <TxLink hash={r.tx} />
										</div>
									</div>
								)
							})
						)}
					</div>
				</aside>
			</div>
		</section>
	)
}
