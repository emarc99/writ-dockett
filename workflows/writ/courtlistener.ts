import {
	consensusIdenticalAggregation,
	cre,
	ok,
	text,
	type HTTPSendRequester,
	type Runtime,
} from '@chainlink/cre-sdk'
import type { Config } from './config'

/**
 * CourtListener (Free Law Project) REST v4: the public mirror of PACER dockets. Each fetch returns
 * only normalized fields so every DON node reaches identical consensus; responses are cached so
 * one node's fetch serves the others (the API token is rate-limited).
 */

export interface DocketLookup {
	found: boolean
	docketId: number
	caseName: string
}

export interface DocketEntry {
	found: boolean
	entryNumber: number
	dateFiled: string
	description: string
	/** SHA-1 of the court's PDF as stored by RECAP; "" when the PDF has not been purchased yet. */
	sha1: string
	pageCount: number
	filepathLocal: string
	plainText: string
}

export interface EntrySummary {
	entryNumber: number
	dateFiled: string
	description: string
	sha1: string
}

export interface EntriesPage {
	entries: EntrySummary[]
	hasMore: boolean
}

interface RecapDocument {
	sha1?: string
	page_count?: number | null
	filepath_local?: string | null
	plain_text?: string
	attachment_number?: number | null
}

interface RawEntry {
	entry_number?: number | null
	date_filed?: string | null
	description?: string
	recap_documents?: RecapDocument[]
}

const CACHE = { store: true, maxAge: '300s' }

/** One retry on timeout or 5xx; 4xx (bad token, throttled) fails immediately. */
function get(sendRequester: HTTPSendRequester, url: string, token: string): unknown {
	let lastError = ''
	for (let attempt = 0; attempt < 2; attempt++) {
		let resp
		try {
			resp = sendRequester
				.sendRequest({
					url,
					method: 'GET',
					timeout: '10s',
					cacheSettings: CACHE,
					multiHeaders: {
						Authorization: { values: [`Token ${token}`] },
						Accept: { values: ['application/json'] },
					},
				})
				.result()
		} catch (e) {
			lastError = String(e)
			continue
		}
		if (ok(resp)) return JSON.parse(text(resp))
		lastError = `HTTP ${resp.statusCode}`
		if (resp.statusCode < 500) break
	}
	throw new Error(`CourtListener ${lastError} for ${url}`)
}

function mainDocument(entry: RawEntry): RecapDocument | undefined {
	const docs = entry.recap_documents ?? []
	return docs.find((d) => d.attachment_number == null) ?? docs[0]
}

const qs = (params: Record<string, string | number>) =>
	Object.entries(params)
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
		.join('&')

export function lookupDocket(runtime: Runtime<Config>, token: string, court: string, docketNumber: string): DocketLookup {
	const url = `${runtime.config.courtListenerBaseUrl}/dockets/?${qs({
		court,
		docket_number: docketNumber,
		fields: 'id,case_name,docket_number',
	})}`
	return new cre.capabilities.HTTPClient()
		.sendRequest(
			runtime,
			(sr: HTTPSendRequester): DocketLookup => {
				const body = get(sr, url, token) as { results?: { id: number; case_name?: string }[] }
				const hit = body.results?.[0]
				return hit ? { found: true, docketId: hit.id, caseName: hit.case_name ?? '' } : { found: false, docketId: 0, caseName: '' }
			},
			consensusIdenticalAggregation<DocketLookup>(),
		)()
		.result()
}

export function fetchEntry(runtime: Runtime<Config>, token: string, docketId: number, entryNumber: number): DocketEntry {
	const url = `${runtime.config.courtListenerBaseUrl}/docket-entries/?${qs({
		docket: docketId,
		entry_number: entryNumber,
		fields: 'entry_number,date_filed,description,recap_documents',
	})}`
	return new cre.capabilities.HTTPClient()
		.sendRequest(
			runtime,
			(sr: HTTPSendRequester): DocketEntry => {
				const body = get(sr, url, token) as { results?: RawEntry[] }
				const raw = body.results?.[0]
				const doc = raw && mainDocument(raw)
				if (!raw || !doc) {
					return { found: false, entryNumber, dateFiled: '', description: '', sha1: '', pageCount: 0, filepathLocal: '', plainText: '' }
				}
				return {
					found: true,
					entryNumber: raw.entry_number ?? entryNumber,
					dateFiled: raw.date_filed ?? '',
					description: raw.description ?? '',
					sha1: (doc.sha1 ?? '').toLowerCase(),
					pageCount: doc.page_count ?? 0,
					filepathLocal: doc.filepath_local ?? '',
					plainText: doc.plain_text ?? '',
				}
			},
			consensusIdenticalAggregation<DocketEntry>(),
		)()
		.result()
}

/** Docket entries filed after `afterEntry`, oldest first, without document text (one page of 20). */
export function fetchEntriesAfter(runtime: Runtime<Config>, token: string, docketId: number, afterEntry: number): EntriesPage {
	const url = `${runtime.config.courtListenerBaseUrl}/docket-entries/?${qs({
		docket: docketId,
		entry_number__gt: afterEntry,
		order_by: 'entry_number',
		fields: 'entry_number,date_filed,description,recap_documents',
		omit: 'recap_documents__plain_text',
	})}`
	return new cre.capabilities.HTTPClient()
		.sendRequest(
			runtime,
			(sr: HTTPSendRequester): EntriesPage => {
				const body = get(sr, url, token) as { results?: RawEntry[]; next?: string | null }
				const entries = (body.results ?? [])
					.filter((r) => r.entry_number != null)
					.map((r) => ({
						entryNumber: r.entry_number as number,
						dateFiled: r.date_filed ?? '',
						description: (r.description ?? '').replace(/\s+/g, ' ').trim(),
						sha1: (mainDocument(r)?.sha1 ?? '').toLowerCase(),
					}))
				return { entries, hasMore: Boolean(body.next) }
			},
			consensusIdenticalAggregation<EntriesPage>(),
		)()
		.result()
}
