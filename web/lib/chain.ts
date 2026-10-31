import { createPublicClient, http, parseAbi, parseAbiItem, type Address, type Hex } from 'viem'
import { sepolia } from 'viem/chains'
import { deployment } from './deployment'

const RPC = 'https://ethereum-sepolia-rpc.publicnode.com'
export const ETHERSCAN = 'https://sepolia.etherscan.io'
// Matches sweepSchedule "0 0 */6 * * *" in workflows/writ/config.staging.json.
export const SWEEP_EVERY_HOURS = 6

export const STATUS = ['None', 'Active', 'Rejected', 'Dissolved', 'Expired', 'Superseded'] as const
export const TYPES = ['Other', 'TRO', 'Preliminary injunction', 'Asset freeze', 'Judgment'] as const
/** Rejection reason bits, mirroring Reason in workflows/writ/legal.ts. */
export const REASONS: [number, string][] = [
	[1, 'docket not found'], [2, 'entry not found'], [4, 'not a court order'], [8, 'PDF hash does not match the court copy'],
	[16, 'wallet not named in the order'], [32, 'order names no wallets'], [64, 'filing date mismatch'], [128, 'order already expired'],
]
export const reasonList = (bits: number) => REASONS.filter(([b]) => bits & b).map(([, l]) => l)

export const PRESET_WALLETS = [
	'0xf7Fcc767dE537953b3519D4b3097a24A6dFE1c84',
	'0x898137400867603E6D713CBD40881dd0c79E47cB',
	'0xf02d9f19060eE2dd50047dC6E1E9eBAC9bA436FE',
	'0x784Cf4b62655486B405Eb76731885CC9ed56f42f',
	'0xe497285e466227F4E8648209E34B465dAA1F90a0',
	'0x9030D5C596d636eEFC8f0ad7b2788AE7E9ef3D46',
]
export const ATTACKER = '0x4c1f0B2d9e8a7f6C3B5a49d8e7f60a1B2C3D4e5f'

const registryAbi = parseAbi([
	'struct Order { string docketRef; uint32 entryNumber; bytes20 docSha1; uint8 orderType; uint8 status; bool exParte; uint64 issuedAt; uint64 expiresAt; uint32 lastCheckedEntry; uint32 evidenceEntry; bytes20 evidenceSha1; address[] wallets; }',
	'function getOrder(bytes32 id) view returns (Order)',
	'function getOrderIds() view returns (bytes32[])',
	'function isFrozen(address wallet) view returns (bool)',
	'function isInForce(bytes32 id) view returns (bool)',
])
const tokenAbi = parseAbi([
	'function balanceOf(address) view returns (uint256)',
	'function transfer(address to, uint256 amount) returns (bool)',
	'error WalletFrozen(address wallet)',
	'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
])
const rejectedEvent = parseAbiItem('event OrderRejected(bytes32 indexed submissionId, string docketRef, uint32 entryNumber, bytes20 submittedSha1, uint32 reasons)')

const client = createPublicClient({ chain: sepolia, transport: http(RPC) })
const registry = { address: deployment.orderRegistry, abi: registryAbi } as const

export const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`
export const day = (t: bigint | number) => new Date(Number(t) * 1000).toISOString().slice(0, 10)

export function nextSweep(now: number): string {
	const step = SWEEP_EVERY_HOURS * 3600_000
	const next = new Date(Math.ceil((now + 1) / step) * step)
	const mins = Math.round((next.getTime() - now) / 60_000)
	const time = next.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
	return `${time} (in ${mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`})`
}

export const isFrozen = (wallet: Address) => client.readContract({ ...registry, functionName: 'isFrozen', args: [wallet] })

async function loadOrder(id: Hex) {
	const [o, inForce] = await Promise.all([
		client.readContract({ ...registry, functionName: 'getOrder', args: [id] }),
		client.readContract({ ...registry, functionName: 'isInForce', args: [id] }),
	])
	const wallets = await Promise.all(
		o.wallets.map(async (w) => {
			const [frozen, bal] = await Promise.all([
				isFrozen(w),
				client.readContract({ address: deployment.writToken, abi: tokenAbi, functionName: 'balanceOf', args: [w] }),
			])
			return { w, frozen, bal }
		}),
	)
	return { id, o, inForce, wallets, status: STATUS[o.status] ?? 'None' }
}
export type OrderView = Awaited<ReturnType<typeof loadOrder>>

export interface Rejection {
	docketRef: string
	entryNumber: number
	submittedSha1: Hex
	reasons: number
	tx: Hex
}

export async function loadChainState(): Promise<{ orders: OrderView[]; rejections: Rejection[] }> {
	const [ids, logs] = await Promise.all([
		client.readContract({ ...registry, functionName: 'getOrderIds' }),
		client.getLogs({ address: deployment.orderRegistry, event: rejectedEvent, fromBlock: BigInt(deployment.fromBlock), toBlock: 'latest' }),
	])
	const orders = await Promise.all([...ids].reverse().map(loadOrder))
	const rejections = logs
		.map((l) => ({
			docketRef: l.args.docketRef ?? '',
			entryNumber: l.args.entryNumber ?? 0,
			submittedSha1: l.args.submittedSha1 ?? '0x',
			reasons: l.args.reasons ?? 0,
			tx: l.transactionHash,
		}))
		.reverse()
	return { orders, rejections }
}

/** Simulates a 1 wUSD transfer from `from`, which the token blocks while a court order freezes it. */
export async function tryTransfer(from: Address): Promise<{ ok: boolean; text: string }> {
	try {
		await client.simulateContract({ address: deployment.writToken, abi: tokenAbi, functionName: 'transfer', args: [deployment.deployer, 1_000_000n], account: from })
		return { ok: true, text: '✓ transfer would succeed' }
	} catch (e) {
		const err = e as { shortMessage?: string; walk?: (fn: (x: unknown) => boolean) => unknown }
		const found = err.walk?.((x) => Boolean((x as { data?: { errorName?: string } })?.data?.errorName)) as { data?: { errorName?: string } } | undefined
		const name = found?.data?.errorName
		if (name === 'WalletFrozen') return { ok: false, text: '✕ blocked: WalletFrozen (court order in force)' }
		if (name === 'ERC20InsufficientBalance') return { ok: true, text: 'not frozen (no wUSD balance to move)' }
		return { ok: false, text: err.shortMessage ?? String(e) }
	}
}
