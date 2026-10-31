import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { AppProvider } from '@/components/AppState'
import { Topbar } from '@/components/Topbar'
import './globals.css'

export const metadata: Metadata = {
	title: 'Writ · court-order-gated stablecoin freezes',
	description: 'Chainlink CRE verifies a court order against the federal docket and freezes exactly the wallets the court named, for exactly as long as the order lasts.',
}

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="en">
			<body>
				<AppProvider>
					<Topbar />
					<main>{children}</main>
					<footer>Demo on Sepolia with test tokens. Not legal advice; issuers keep a human override for sealed or disputed orders.</footer>
				</AppProvider>
			</body>
		</html>
	)
}
