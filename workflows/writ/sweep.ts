import type { CronPayload, Runtime } from '@chainlink/cre-sdk'
import type { Hex } from 'viem'
import type { Config } from './config'
import { fetchEntriesAfter, lookupDocket } from './courtlistener'
import { classifyFollowups } from './gemini'
import { extendedExpiry, dateToUnix, isOrderDescription, OrderType, Status, statusForEffect } from './legal'
import { encodeStatus, readOrder, readOrderIds, sha1Hex, submitReport, type OnchainOrder, type StatusReport } from './registry'

const ZERO_SHA1 = `0x${'0'.repeat(40)}` as Hex

const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 10)

function describe(o: OnchainOrder): string {
	const term = o.expiresAt === 0 ? 'in force until further order of the court' : `expires ${iso(o.expiresAt)}`
	const notice = o.exParte ? 'granted ex parte (without notice)' : 'entered with notice to / consent of the restrained party'
	return `ECF ${o.entryNumber} on docket ${o.docketRef}: ${OrderType[o.orderType]} issued ${iso(o.issuedAt)}, ${notice}, ${term}. It freezes ${o.wallets.length} wallet(s).`
}

/**
 * Cron trigger: for every Active order, read the docket entries filed since the last check, let
 * Gemini spot a later order that dissolves, supersedes or extends it, and write the new status.
 * Orders whose fixed term has run out are marked Expired (they already stopped freezing on-chain).
 */
export function onSweep(runtime: Runtime<Config>, _trigger: CronPayload): string {
	const cfg = runtime.config
	const ids = readOrderIds(runtime).slice(-cfg.maxOrdersScanned)
	const active: { id: Hex; order: OnchainOrder }[] = []
	for (const id of ids) {
		const order = readOrder(runtime, id)
		if (order.status === Status.Active) active.push({ id, order })
	}
	runtime.log(`[sweep] ${ids.length} order(s) scanned, ${active.length} active`)
	if (active.length === 0) return JSON.stringify({ swept: 0, updates: [] })

	const token = runtime.getSecret({ id: 'COURTLISTENER_TOKEN' }).result().value
	const now = Math.floor(runtime.now().getTime() / 1000)
	const updates: Record<string, unknown>[] = []

	for (const { id, order } of active.slice(0, cfg.maxOrdersSwept)) {
		const [court, docketNumber] = order.docketRef.split('|')
		const docket = lookupDocket(runtime, token, court ?? '', docketNumber ?? '')
		if (!docket.found) {
			runtime.log(`[sweep] ${id}: docket ${order.docketRef} not found, skipping`)
			continue
		}

		const page = fetchEntriesAfter(runtime, token, docket.docketId, order.lastCheckedEntry)
		const lastSeen = page.entries.reduce((m, e) => Math.max(m, e.entryNumber), order.lastCheckedEntry)
		const candidates = page.entries.filter((e) => isOrderDescription(e.description))
		runtime.log(
			`[sweep] ${order.docketRef}: ${page.entries.length} new entr(ies) after ECF ${order.lastCheckedEntry}, ${candidates.length} look like orders${page.hasMore ? ' (more pages pending)' : ''}`,
		)

		let report: StatusReport | undefined
		if (candidates.length > 0) {
			const apiKey = runtime.getSecret({ id: 'GEMINI_API_KEY' }).result().value
			const list = candidates.map((e) => `#${e.entryNumber} (${e.dateFiled}): ${e.description}`).join('\n')
			const c = classifyFollowups(runtime, apiKey, describe(order), list)
			const cited = candidates.find((e) => e.entryNumber === c.entryNumber)
			runtime.log(`[gemini] effect=${c.effect} entry=${c.entryNumber} ${c.rationale}`)

			if (cited && (c.effect === 'DISSOLVED' || c.effect === 'SUPERSEDED')) {
				report = {
					id,
					newStatus: statusForEffect(c.effect),
					newExpiresAt: order.expiresAt,
					evidenceEntry: cited.entryNumber,
					evidenceSha1: sha1Hex(cited.sha1),
					lastCheckedEntry: lastSeen,
				}
			} else if (cited && c.effect === 'EXTENDED') {
				const next = extendedExpiry(order.expiresAt, dateToUnix(c.newExpiryDate), order.orderType, order.exParte)
				if (next !== order.expiresAt && next > now) {
					report = {
						id,
						newStatus: Status.Active,
						newExpiresAt: next,
						evidenceEntry: cited.entryNumber,
						evidenceSha1: sha1Hex(cited.sha1),
						lastCheckedEntry: lastSeen,
					}
				}
			}
		}

		if (!report && order.expiresAt !== 0 && now >= order.expiresAt) {
			report = { id, newStatus: Status.Expired, newExpiresAt: order.expiresAt, evidenceEntry: 0, evidenceSha1: ZERO_SHA1, lastCheckedEntry: lastSeen }
		}
		if (!report && lastSeen > order.lastCheckedEntry) {
			report = { id, newStatus: Status.Active, newExpiresAt: order.expiresAt, evidenceEntry: 0, evidenceSha1: ZERO_SHA1, lastCheckedEntry: lastSeen }
		}
		if (!report) {
			runtime.log(`[sweep] ${id}: no change`)
			continue
		}

		const txHash = submitReport(runtime, encodeStatus(report))
		const label =
			report.newStatus !== Status.Active
				? Status[report.newStatus].toUpperCase()
				: report.newExpiresAt !== order.expiresAt
					? 'EXTENDED'
					: 'CHECKPOINT'
		runtime.log(`[sweep] ${id}: ${label} evidence=ECF ${report.evidenceEntry} lastChecked=${report.lastCheckedEntry} tx=${txHash}`)
		updates.push({ orderId: id, result: label, evidenceEntry: report.evidenceEntry, newExpiresAt: report.newExpiresAt, txHash })
	}

	return JSON.stringify({ swept: Math.min(active.length, cfg.maxOrdersSwept), updates })
}
