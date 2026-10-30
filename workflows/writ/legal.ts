/**
 * Deterministic legal rules. Nothing here calls an LLM: Gemini only reads documents, and every
 * value that ends up on-chain (who is frozen, until when) is decided by these functions.
 */

export const DAY = 86_400

/** Mirrors OrderRegistry.OrderType. */
export enum OrderType {
	Other = 0,
	TRO = 1,
	PreliminaryInjunction = 2,
	AssetFreeze = 3,
	Judgment = 4,
}

/** Mirrors OrderRegistry.Status. */
export enum Status {
	None = 0,
	Active = 1,
	Rejected = 2,
	Dissolved = 3,
	Expired = 4,
	Superseded = 5,
}

/** Rejection reason bits, mirrored in OrderRegistry NatSpec. */
export const Reason = {
	DocketNotFound: 1,
	EntryNotFound: 2,
	NotAnOrder: 4,
	HashMismatch: 8,
	WalletNotInOrder: 16,
	NoWallets: 32,
	DateMismatch: 64,
	AlreadyExpired: 128,
} as const

export function reasonLabels(reasons: number): string[] {
	return Object.entries(Reason)
		.filter(([, bit]) => (reasons & bit) !== 0)
		.map(([name]) => name)
}

/** Fed. R. Civ. P. 65(b)(2): an order granted without notice expires within 14 days of entry. */
export const EX_PARTE_TRO_MAX_DAYS = 14

const NON_ORDER_PREFIX =
	/^\s*(\[?proposed\]?|motion|stipulation|application|ex parte application|notice|declaration|brief|memorandum|letter|certificate|opposition|reply|minute entry|clerk'?s notice)\b/i

/**
 * True when a docket text describes an order signed by the court, rather than a filing that merely
 * asks for or attaches one (e.g. "STIPULATION ... with [Proposed] Order").
 */
export function isOrderDescription(description: string): boolean {
	const first = description.split(/\.\s/)[0] ?? ''
	if (NON_ORDER_PREFIX.test(first)) return false
	if (/proposed\s+order/i.test(first)) return false
	return /\b(order|judgment|injunction)\b/i.test(first)
}

/** Order type from the clerk's docket text, when it is explicit. Takes priority over the LLM. */
export function orderTypeFromDescription(description: string): OrderType | undefined {
	const d = description.toUpperCase()
	if (/TEMPORARY RESTRAINING ORDER/.test(d)) return OrderType.TRO
	if (/(GRANTING|ENTERING).*PRELIMINARY INJUNCTION|^PRELIMINARY INJUNCTION/.test(d)) {
		return OrderType.PreliminaryInjunction
	}
	if (/ASSET FREEZE|FREEZING ASSETS/.test(d)) return OrderType.AssetFreeze
	if (/\bJUDGMENT\b/.test(d) && !/MOTION FOR .*JUDGMENT/.test(d)) return OrderType.Judgment
	return undefined
}

export function orderTypeFromLabel(label: string): OrderType {
	switch (label) {
		case 'TRO':
			return OrderType.TRO
		case 'PRELIMINARY_INJUNCTION':
			return OrderType.PreliminaryInjunction
		case 'ASSET_FREEZE':
			return OrderType.AssetFreeze
		case 'JUDGMENT':
			return OrderType.Judgment
		default:
			return OrderType.Other
	}
}

/** A stipulated or consent order was by definition entered with notice to the restrained party. */
export function isConsentOrder(description: string): boolean {
	return /\b(stipulat\w*|consent)\b/i.test(description)
}

const EVM_ADDRESS = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g

/** Every EVM address that appears verbatim in the official text, lowercased and de-duplicated. */
export function walletsInText(text: string): string[] {
	const seen = new Set<string>()
	for (const m of text.matchAll(EVM_ADDRESS)) seen.add(m[0].toLowerCase())
	return [...seen]
}

export function isEvmAddress(s: string): boolean {
	return /^0x[0-9a-fA-F]{40}$/.test(s)
}

/** "YYYY-MM-DD" -> unix seconds at 00:00 UTC, or 0 if unparseable. */
export function dateToUnix(date: string): number {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim())
	if (!m) return 0
	const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
	return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0
}

export interface ExpiryInput {
	orderType: OrderType
	exParte: boolean
	/** Entry date of the order (unix seconds). */
	issuedAt: number
	/** Expiry date stated in the order, unix seconds, or 0. */
	statedExpiry: number
	/** Duration stated in the order in days, or 0. */
	statedDays: number
}

/**
 * When the restraint stops binding, in unix seconds; 0 means "until further order of the court".
 *
 * - Ex parte TRO: whatever the court set, capped at 14 days after entry (Rule 65(b)(2)). An ex parte
 *   TRO that says "until further order" still dies on day 14 unless the court extends it.
 * - Anything else (TRO with notice/consent, preliminary injunction, freeze order, judgment): the
 *   stated date or duration if any, otherwise open-ended until the court says otherwise.
 */
export function computeExpiry(i: ExpiryInput): number {
	const stated = i.statedExpiry > 0 ? i.statedExpiry : i.statedDays > 0 ? i.issuedAt + i.statedDays * DAY : 0
	if (i.orderType === OrderType.TRO && i.exParte) {
		const cap = i.issuedAt + EX_PARTE_TRO_MAX_DAYS * DAY
		return stated > 0 ? Math.min(stated, cap) : cap
	}
	return stated
}

export type FollowupEffect = 'NONE' | 'DISSOLVED' | 'EXTENDED' | 'SUPERSEDED'

export function statusForEffect(effect: FollowupEffect): Status {
	switch (effect) {
		case 'DISSOLVED':
			return Status.Dissolved
		case 'SUPERSEDED':
			return Status.Superseded
		default:
			return Status.Active
	}
}

/**
 * New expiry for an order the court extended. Rule 65(b)(2) allows one extension "for a like
 * period" (another 14 days) for good cause, or longer with consent; a stated date wins if present.
 */
export function extendedExpiry(current: number, statedNewExpiry: number, orderType: OrderType, exParte: boolean): number {
	if (statedNewExpiry > 0) return statedNewExpiry
	if (orderType === OrderType.TRO && exParte && current > 0) return current + EX_PARTE_TRO_MAX_DAYS * DAY
	return current
}
