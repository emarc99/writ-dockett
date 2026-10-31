'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { AddrLink } from './Links'
import { useApp } from './AppState'

const TABS = [
	{ href: '/', label: 'Overview' },
	{ href: '/verify', label: 'Verify an order', run: 'verify' },
	{ href: '/orders', label: 'On-chain orders' },
	{ href: '/sweep', label: 'Docket sweep', run: 'sweep' },
] as const

export function Topbar() {
	const path = usePathname()
	const app = useApp()

	return (
		<nav className="topbar">
			<Link className="logo" href="/">
				<span className="logo-mark">W</span>
				<span>Writ</span>
			</Link>
			<div className="tabs">
				{TABS.map((t) => {
					const busy = 'run' in t && app[t.run].busy
					return (
						<Link key={t.href} href={t.href} className={`${path === t.href ? 'active' : ''} ${busy ? 'busy' : ''}`}>
							{t.label}
						</Link>
					)
				})}
			</div>
			<div className="header-right">
				<span className="signer">
					{app.account ? (
						<>
							Signer <AddrLink address={app.account} />
							<span className={app.authorized ? 'ok-text' : 'bad-text'}>{app.authorized ? '✓ authorized issuer key' : '✕ not authorized: CRE will refuse'}</span>
						</>
					) : app.server && !app.server.serverSigning ? (
						<span className="bad-text">Connect the issuer wallet to sign</span>
					) : (
						'Signer: server key'
					)}
				</span>
				<button type="button" className="btn-ghost" onClick={app.account ? app.disconnect : app.connect}>
					{app.account ? 'Disconnect' : 'Connect wallet'}
				</button>
				<span className="chain">
					<span className="dot" />
					Sepolia
				</span>
			</div>
		</nav>
	)
}
