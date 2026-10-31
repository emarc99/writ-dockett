import { ETHERSCAN, short } from '@/lib/chain'

export function AddrLink({ address }: { address: string }) {
	return (
		<a className="mono" href={`${ETHERSCAN}/address/${address}`} target="_blank" rel="noreferrer">
			{short(address)}
		</a>
	)
}

export function TxLink({ hash }: { hash: string }) {
	return (
		<a className="mono" href={`${ETHERSCAN}/tx/${hash}`} target="_blank" rel="noreferrer">
			{short(hash)}
		</a>
	)
}
