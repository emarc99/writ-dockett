import {
	bytesToHex,
	cre,
	encodeCallMsg,
	getNetwork,
	LAST_FINALIZED_BLOCK_NUMBER,
	prepareReportRequest,
	TxStatus,
	type Runtime,
} from '@chainlink/cre-sdk'
import {
	decodeFunctionResult,
	encodeAbiParameters,
	encodeFunctionData,
	keccak256,
	parseAbi,
	parseAbiParameters,
	zeroAddress,
	type Address,
	type Hex,
} from 'viem'
import type { Config } from './config'
import type { OrderType, Status } from './legal'

/** EVM capability ReceiverContractExecutionStatus.REVERTED. */
const RECEIVER_REVERTED = 1

/** Mirrors OrderRegistry.Action. */
export enum Action {
	Attest = 1,
	Reject = 2,
	UpdateStatus = 3,
}

export const registryAbi = parseAbi([
	'struct Order { string docketRef; uint32 entryNumber; bytes20 docSha1; uint8 orderType; uint8 status; bool exParte; uint64 issuedAt; uint64 expiresAt; uint32 lastCheckedEntry; uint32 evidenceEntry; bytes20 evidenceSha1; address[] wallets; }',
	'function getOrder(bytes32 id) view returns (Order)',
	'function getOrderIds() view returns (bytes32[])',
])

const ATTEST_REPORT = parseAbiParameters(
	'(bytes32 id, string docketRef, uint32 entryNumber, bytes20 docSha1, uint8 orderType, bool exParte, uint64 issuedAt, uint64 expiresAt, uint32 reasons, address[] wallets)',
)
const STATUS_REPORT = parseAbiParameters(
	'(bytes32 id, uint8 newStatus, uint64 newExpiresAt, uint32 evidenceEntry, bytes20 evidenceSha1, uint32 lastCheckedEntry)',
)
const ENVELOPE = parseAbiParameters('uint8 action, bytes data')

export interface AttestReport {
	id: Hex
	docketRef: string
	entryNumber: number
	docSha1: Hex
	orderType: OrderType
	exParte: boolean
	issuedAt: number
	expiresAt: number
	reasons: number
	wallets: Address[]
}

export interface StatusReport {
	id: Hex
	newStatus: Status
	newExpiresAt: number
	evidenceEntry: number
	evidenceSha1: Hex
	lastCheckedEntry: number
}

export interface OnchainOrder {
	docketRef: string
	entryNumber: number
	docSha1: Hex
	orderType: number
	status: number
	exParte: boolean
	issuedAt: number
	expiresAt: number
	lastCheckedEntry: number
	evidenceEntry: number
	evidenceSha1: Hex
	wallets: readonly Address[]
}

/** Same derivation as the contract tests: keccak256(abi.encode(court, docketNumber, entry)). */
export function orderId(court: string, docketNumber: string, entryNumber: number): Hex {
	return keccak256(encodeAbiParameters(parseAbiParameters('string, string, uint32'), [court, docketNumber, entryNumber]))
}

/** Rejections are keyed by what was submitted, so a forged copy never collides with the real order. */
export function submissionId(orderKey: Hex, submittedSha1: Hex, wallets: string[]): Hex {
	return keccak256(
		encodeAbiParameters(parseAbiParameters('bytes32, bytes20, string[]'), [orderKey, submittedSha1, wallets]),
	)
}

export function sha1Hex(s: string): Hex {
	const h = s.toLowerCase().replace(/^0x/, '')
	return (/^[0-9a-f]{40}$/.test(h) ? `0x${h}` : `0x${'0'.repeat(40)}`) as Hex
}

export function encodeAttest(action: Action.Attest | Action.Reject, r: AttestReport): Hex {
	const data = encodeAbiParameters(ATTEST_REPORT, [
		{
			id: r.id,
			docketRef: r.docketRef,
			entryNumber: r.entryNumber,
			docSha1: r.docSha1,
			orderType: r.orderType,
			exParte: r.exParte,
			issuedAt: BigInt(r.issuedAt),
			expiresAt: BigInt(r.expiresAt),
			reasons: r.reasons,
			wallets: r.wallets,
		},
	])
	return encodeAbiParameters(ENVELOPE, [action, data])
}

export function encodeStatus(r: StatusReport): Hex {
	const data = encodeAbiParameters(STATUS_REPORT, [
		{
			id: r.id,
			newStatus: r.newStatus,
			newExpiresAt: BigInt(r.newExpiresAt),
			evidenceEntry: r.evidenceEntry,
			evidenceSha1: r.evidenceSha1,
			lastCheckedEntry: r.lastCheckedEntry,
		},
	])
	return encodeAbiParameters(ENVELOPE, [Action.UpdateStatus, data])
}

export function evmClient(config: Config) {
	const network = getNetwork({ chainFamily: 'evm', chainSelectorName: config.chainSelectorName, isTestnet: true })
	if (!network) throw new Error(`Unknown chain: ${config.chainSelectorName}`)
	return new cre.capabilities.EVMClient(network.chainSelector.selector)
}

function read<T>(runtime: Runtime<Config>, data: Hex, fn: 'getOrder' | 'getOrderIds'): T {
	const reply = evmClient(runtime.config)
		.callContract(runtime, {
			call: encodeCallMsg({ from: zeroAddress, to: runtime.config.registryAddress as Address, data }),
			blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
		})
		.result()
	return decodeFunctionResult({ abi: registryAbi, functionName: fn, data: bytesToHex(reply.data) }) as T
}

export function readOrderIds(runtime: Runtime<Config>): readonly Hex[] {
	return read<readonly Hex[]>(runtime, encodeFunctionData({ abi: registryAbi, functionName: 'getOrderIds' }), 'getOrderIds')
}

export function readOrder(runtime: Runtime<Config>, id: Hex): OnchainOrder {
	const o = read<{
		docketRef: string
		entryNumber: number
		docSha1: Hex
		orderType: number
		status: number
		exParte: boolean
		issuedAt: bigint
		expiresAt: bigint
		lastCheckedEntry: number
		evidenceEntry: number
		evidenceSha1: Hex
		wallets: readonly Address[]
	}>(runtime, encodeFunctionData({ abi: registryAbi, functionName: 'getOrder', args: [id] }), 'getOrder')
	return { ...o, issuedAt: Number(o.issuedAt), expiresAt: Number(o.expiresAt) }
}

/** Signs `payload` with the DON and delivers it to OrderRegistry.onReport via the forwarder. */
export function submitReport(runtime: Runtime<Config>, payload: Hex): Hex {
	const report = runtime.report(prepareReportRequest(payload)).result()
	runtime.log(`[report] DON-signed report (ecdsa, keccak256) over ${(payload.length - 2) / 2} bytes -> writeReport to ${runtime.config.registryAddress}`)
	const res = evmClient(runtime.config)
		.writeReport(runtime, {
			receiver: runtime.config.registryAddress,
			report,
			gasConfig: { gasLimit: runtime.config.gasLimit },
		})
		.result()
	const txHash = bytesToHex(res.txHash ?? new Uint8Array(32))
	if (res.txStatus !== TxStatus.SUCCESS) {
		throw new Error(`writeReport failed (${res.txStatus}): ${res.errorMessage ?? 'no message'} tx=${txHash}`)
	}
	// The forwarder catches receiver reverts, so a mined tx can still mean OrderRegistry refused it.
	if (res.receiverContractExecutionStatus === RECEIVER_REVERTED) {
		throw new Error(`OrderRegistry reverted the report: ${res.errorMessage ?? 'no message'} tx=${txHash}`)
	}
	return txHash
}
