export interface Submission {
	court: string
	docketNumber: string
	entryNumber: number
	documentSha1: string
	wallets: string[]
	filedDate?: string
}

export function validSubmission(b: any): string | undefined {
	if (typeof b !== 'object' || b === null) return 'body must be a JSON object'
	if (!/^[a-z0-9]{2,16}$/i.test(b.court ?? '')) return 'court must be a CourtListener court id, e.g. "cand"'
	if (!/^[\w:.-]{3,64}$/.test(b.docketNumber ?? '')) return 'docketNumber looks invalid'
	if (!Number.isInteger(b.entryNumber) || b.entryNumber < 1) return 'entryNumber must be a positive integer'
	if (!/^(0x)?[0-9a-f]{40}$/i.test(b.documentSha1 ?? '')) return 'documentSha1 must be 40 hex chars'
	if (b.wallets !== undefined && (!Array.isArray(b.wallets) || b.wallets.length > 50)) return 'wallets must be an array'
	return undefined
}

export function normalizeSubmission(b: any): Submission {
	return {
		court: String(b.court).toLowerCase(),
		docketNumber: String(b.docketNumber),
		entryNumber: b.entryNumber,
		documentSha1: String(b.documentSha1).toLowerCase().replace(/^0x/, ''),
		wallets: (b.wallets ?? []).map(String),
		...(b.filedDate ? { filedDate: String(b.filedDate) } : {}),
	}
}
