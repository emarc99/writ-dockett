import { decodeJson, type HTTPPayload, type Runtime } from '@chainlink/cre-sdk'
import { getAddress, type Address } from 'viem'
import { submissionSchema, type Config } from './config'
import { fetchEntry, lookupDocket } from './courtlistener'
import { extractOrderTerms } from './gemini'
import {
	computeExpiry,
	dateToUnix,
	isConsentOrder,
	isEvmAddress,
	isOrderDescription,
	OrderType,
	orderTypeFromDescription,
	orderTypeFromLabel,
	Reason,
	reasonLabels,
	Status,
	walletsInText,
} from './legal'
import { Action, encodeAttest, orderId, readOrder, sha1Hex, submissionId, submitReport } from './registry'

/**
 * HTTP trigger: verify a submitted court order against the public federal docket and either
 * attest it on-chain (freezing the wallets it names until it expires or is dissolved) or record a
 * rejection with the reasons it failed.
 */
export function onVerify(runtime: Runtime<Config>, payload: HTTPPayload): string {
	const sub = submissionSchema.parse(decodeJson(payload.input))
	const court = sub.court.trim().toLowerCase()
	const docketNumber = sub.docketNumber.trim()
	const docketRef = `${court}|${docketNumber}`
	const id = orderId(court, docketNumber, sub.entryNumber)
	const submittedSha1 = sha1Hex(sub.documentSha1)
	const claimed = sub.wallets.map((w) => w.trim().toLowerCase())

	runtime.log(`[verify] ${docketRef} ECF ${sub.entryNumber} sha1=${submittedSha1} claimed=${claimed.length} wallet(s)`)

	const existing = readOrder(runtime, id)
	if (existing.status !== Status.None && existing.docSha1.toLowerCase() === submittedSha1) {
		runtime.log(`[verify] order ${id} already recorded with status ${Status[existing.status]}; nothing to write`)
		return JSON.stringify({ decision: 'ALREADY_RECORDED', orderId: id, status: Status[existing.status] })
	}

	const token = runtime.getSecret({ id: 'COURTLISTENER_TOKEN' }).result().value
	let reasons = 0
	const check = (name: string, pass: boolean, detail: string, bit: number) => {
		runtime.log(`[check] ${pass ? 'PASS' : 'FAIL'} ${name}: ${detail}`)
		if (!pass) reasons |= bit
	}

	const docket = lookupDocket(runtime, token, court, docketNumber)
	check('docket exists', docket.found, docket.found ? `${docket.caseName} (CourtListener #${docket.docketId})` : 'no such docket', Reason.DocketNotFound)
	if (!docket.found) return reject(runtime, { id, docketRef, sub, submittedSha1, claimed, reasons })

	const entry = fetchEntry(runtime, token, docket.docketId, sub.entryNumber)
	check('entry exists', entry.found, entry.found ? `ECF ${entry.entryNumber} filed ${entry.dateFiled}` : 'no such entry', Reason.EntryNotFound)
	if (!entry.found) return reject(runtime, { id, docketRef, sub, submittedSha1, claimed, reasons })

	const isOrder = isOrderDescription(entry.description)
	check('is a court order', isOrder, entry.description.slice(0, 120), Reason.NotAnOrder)
	check(
		'document hash',
		entry.sha1 !== '' && `0x${entry.sha1}` === submittedSha1,
		`court PDF sha1=0x${entry.sha1 || '(not on RECAP)'} submitted=${submittedSha1}`,
		Reason.HashMismatch,
	)
	if (sub.filedDate) {
		check('filing date', sub.filedDate === entry.dateFiled, `docket=${entry.dateFiled} submitted=${sub.filedDate}`, Reason.DateMismatch)
	}

	const official = walletsInText(entry.plainText)
	let restrained: string[] = []
	let orderType = OrderType.Other
	let exParte = false
	let expiresAt = 0
	const issuedAt = dateToUnix(entry.dateFiled)

	if (isOrder && entry.plainText) {
		const apiKey = runtime.getSecret({ id: 'GEMINI_API_KEY' }).result().value
		const terms = extractOrderTerms(runtime, apiKey, entry.description, entry.plainText)
		runtime.log(
			`[gemini] type=${terms.orderType} withoutNotice=${terms.issuedWithoutNotice} untilFurtherOrder=${terms.untilFurtherOrder} expiry="${terms.statedExpiryDate}" days=${terms.statedDurationDays} wallets=${terms.restrainedWallets.length}`,
		)

		// Only addresses that appear verbatim in the court's own text can be frozen.
		restrained = official.filter((w) => terms.restrainedWallets.includes(w))
		orderType = orderTypeFromDescription(entry.description) ?? orderTypeFromLabel(terms.orderType)
		exParte = terms.issuedWithoutNotice && !isConsentOrder(entry.description)
		expiresAt = computeExpiry({
			orderType,
			exParte,
			issuedAt,
			statedExpiry: dateToUnix(terms.statedExpiryDate),
			statedDays: terms.statedDurationDays,
		})
		runtime.log(
			`[legal] ${OrderType[orderType]} ${exParte ? 'ex parte (Rule 65(b)(2) 14-day cap)' : 'with notice/consent'} -> expiresAt=${expiresAt === 0 ? 'until further order' : new Date(expiresAt * 1000).toISOString()}`,
		)
	}

	check('order names wallets', restrained.length > 0, `${restrained.length} restrained wallet(s) found in the official text`, Reason.NoWallets)
	const notInOrder = claimed.filter((w) => !isEvmAddress(w) || !restrained.includes(w))
	if (claimed.length > 0) {
		check('claimed wallets are in the order', notInOrder.length === 0, notInOrder.length ? `not in order: ${notInOrder.join(', ')}` : `all ${claimed.length} found`, Reason.WalletNotInOrder)
	}

	const now = Math.floor(runtime.now().getTime() / 1000)
	if (expiresAt !== 0) {
		check('still in force', expiresAt > now, `expires ${new Date(expiresAt * 1000).toISOString()}`, Reason.AlreadyExpired)
	}

	if (reasons !== 0) return reject(runtime, { id, docketRef, sub, submittedSha1, claimed, reasons })

	const wallets = (claimed.length > 0 ? claimed : restrained).map((w) => getAddress(w)) as Address[]
	const txHash = submitReport(
		runtime,
		encodeAttest(Action.Attest, {
			id,
			docketRef,
			entryNumber: sub.entryNumber,
			docSha1: submittedSha1,
			orderType,
			exParte,
			issuedAt,
			expiresAt,
			reasons: 0,
			wallets,
		}),
	)
	runtime.log(`[verify] VERIFIED ${id}: froze ${wallets.length} wallet(s) tx=${txHash}`)
	return JSON.stringify({ decision: 'VERIFIED', orderId: id, orderType: OrderType[orderType], exParte, issuedAt, expiresAt, wallets, txHash })
}

interface Rejection {
	id: `0x${string}`
	docketRef: string
	sub: { entryNumber: number }
	submittedSha1: `0x${string}`
	claimed: string[]
	reasons: number
}

function reject(runtime: Runtime<Config>, r: Rejection): string {
	const subId = submissionId(r.id, r.submittedSha1, r.claimed)
	const txHash = submitReport(
		runtime,
		encodeAttest(Action.Reject, {
			id: subId,
			docketRef: r.docketRef,
			entryNumber: r.sub.entryNumber,
			docSha1: r.submittedSha1,
			orderType: OrderType.Other,
			exParte: false,
			issuedAt: 0,
			expiresAt: 0,
			reasons: r.reasons,
			wallets: [],
		}),
	)
	const labels = reasonLabels(r.reasons)
	runtime.log(`[verify] REJECTED submission ${subId}: ${labels.join(', ')} tx=${txHash}`)
	return JSON.stringify({ decision: 'REJECTED', submissionId: subId, reasons: r.reasons, labels, txHash })
}
