import { describe, expect, test } from 'bun:test'
import {
	computeExpiry,
	DAY,
	dateToUnix,
	extendedExpiry,
	isConsentOrder,
	isOrderDescription,
	OrderType,
	orderTypeFromDescription,
	Reason,
	reasonLabels,
	walletsInText,
} from './legal'
import { normalizeClassification, normalizeTerms } from './gemini'
import { encodeAttest, Action, orderId, sha1Hex, submissionId } from './registry'

const ECF18_TEXT = await Bun.file(new URL('../../fixtures/newton-v-ermilov/entry-18.txt', import.meta.url)).text()

const ECF18 = 'STIPULATED CONSENT TEMPORARY RESTRAINING ORDER, AS MODIFIED. Signed by Judge P. Casey Pitts.(lrt, COURT STAFF) (Filed on 6/5/2026) (Entered: 06/05/2026)'
const JUNE_5_2026 = 1780617600

describe('docket descriptions', () => {
	test('recognizes signed orders and rejects filings that only ask for one', () => {
		expect(isOrderDescription(ECF18)).toBe(true)
		expect(isOrderDescription('ORDER Denying 19 Motion for Preliminary Injunction. Signed by Judge P. Casey Pitts on 8/3/2026.')).toBe(true)
		expect(isOrderDescription('ORDER GRANTING 24 Application for Admission of Attorney Mark Wilding Pro Hac Vice')).toBe(true)
		expect(isOrderDescription('MOTION for Preliminary Injunction filed by Newton AC/DC Fund, L.P.')).toBe(false)
		expect(isOrderDescription('STIPULATION re Temporary Restraining Order with [Proposed] Order filed by Newton')).toBe(false)
		expect(isOrderDescription('Proposed Order re 19 MOTION for Preliminary Injunction')).toBe(false)
		expect(isOrderDescription("CLERK'S NOTICE SETTING ZOOM HEARING.")).toBe(false)
	})

	test('types the order from the clerk text and spots consent', () => {
		expect(orderTypeFromDescription(ECF18)).toBe(OrderType.TRO)
		expect(orderTypeFromDescription('ORDER GRANTING 12 Motion for Preliminary Injunction')).toBe(OrderType.PreliminaryInjunction)
		expect(orderTypeFromDescription('ORDER Denying 19 Motion for Preliminary Injunction')).toBeUndefined()
		expect(isConsentOrder(ECF18)).toBe(true)
		expect(isConsentOrder('ORDER GRANTING EX PARTE APPLICATION FOR TEMPORARY RESTRAINING ORDER')).toBe(false)
	})
})

describe('wallets', () => {
	test('extracts the six wallets named in ECF 18, once each', () => {
		const wallets = walletsInText(ECF18_TEXT)
		expect(wallets).toHaveLength(6)
		expect(wallets).toContain('0x9030d5c596d636eefc8f0ad7b2788ae7e9ef3d46')
		expect(wallets).not.toContain('0x4c1f0b2d9e8a7f6c3b5a49d8e7f60a1b2c3d4e5f')
	})

	test('ignores longer hex strings that are not addresses', () => {
		expect(walletsInText(`tx 0x${'a'.repeat(64)} and 0x${'b'.repeat(40)}`)).toEqual([`0x${'b'.repeat(40)}`])
	})

	test('normalizes LLM output and drops anything that is not an address', () => {
		const t = normalizeTerms({
			orderType: 'TRO',
			issuedWithoutNotice: false,
			restrainedWallets: ['0xF7FCC767DE537953B3519D4B3097A24A6DFE1C84', 'not-a-wallet', '0xf7fcc767de537953b3519d4b3097a24a6dfe1c84'],
		})
		expect(t.restrainedWallets).toEqual(['0xf7fcc767de537953b3519d4b3097a24a6dfe1c84'])
		expect(t.statedExpiryDate).toBe('')
		expect(normalizeClassification({ effect: 'OVERRULED' }).effect).toBe('NONE')
	})
})

describe('Rule 65(b) expiry', () => {
	const base = { issuedAt: JUNE_5_2026, statedExpiry: 0, statedDays: 0 }

	test('dates parse to midnight UTC', () => {
		expect(dateToUnix('2026-06-05')).toBe(JUNE_5_2026)
		expect(dateToUnix('June 5')).toBe(0)
	})

	test('consent TRO "until further order" has no automatic expiry', () => {
		expect(computeExpiry({ ...base, orderType: OrderType.TRO, exParte: false })).toBe(0)
	})

	test('ex parte TRO dies 14 days after entry, even if it says "until further order"', () => {
		expect(computeExpiry({ ...base, orderType: OrderType.TRO, exParte: true })).toBe(JUNE_5_2026 + 14 * DAY)
	})

	test('ex parte TRO keeps a shorter stated term but cannot exceed 14 days', () => {
		expect(computeExpiry({ ...base, orderType: OrderType.TRO, exParte: true, statedDays: 7 })).toBe(JUNE_5_2026 + 7 * DAY)
		expect(computeExpiry({ ...base, orderType: OrderType.TRO, exParte: true, statedDays: 30 })).toBe(JUNE_5_2026 + 14 * DAY)
	})

	test('preliminary injunction runs until a stated date or further order', () => {
		expect(computeExpiry({ ...base, orderType: OrderType.PreliminaryInjunction, exParte: false })).toBe(0)
		const end = dateToUnix('2026-12-31')
		expect(computeExpiry({ ...base, orderType: OrderType.PreliminaryInjunction, exParte: false, statedExpiry: end })).toBe(end)
	})

	test('extension for good cause adds a like period of 14 days unless a date is stated', () => {
		const first = JUNE_5_2026 + 14 * DAY
		expect(extendedExpiry(first, 0, OrderType.TRO, true)).toBe(first + 14 * DAY)
		expect(extendedExpiry(first, dateToUnix('2026-07-01'), OrderType.TRO, true)).toBe(dateToUnix('2026-07-01'))
		expect(extendedExpiry(0, 0, OrderType.TRO, false)).toBe(0)
	})
})

describe('report encoding', () => {
	test('order ids match the contract tests derivation', () => {
		expect(orderId('cand', '5:26-cv-05055', 18)).toMatch(/^0x[0-9a-f]{64}$/)
		expect(orderId('cand', '5:26-cv-05055', 18)).not.toBe(orderId('cand', '5:26-cv-05055', 38))
	})

	test('a forged copy gets its own submission id', () => {
		const id = orderId('cand', '5:26-cv-05055', 18)
		expect(submissionId(id, sha1Hex('a40c167938d56e15f8959675bb5c7e46dda1bdea'), [])).not.toBe(
			submissionId(id, sha1Hex('ec485c6c5b714a2f1f7c3c365a2835a0e5d7b8bd'), []),
		)
	})

	test('rejection reasons for the forged demo are hash mismatch + wallet not in order', () => {
		expect(reasonLabels(Reason.HashMismatch | Reason.WalletNotInOrder)).toEqual(['HashMismatch', 'WalletNotInOrder'])
		const hex = encodeAttest(Action.Reject, {
			id: orderId('cand', '5:26-cv-05055', 18),
			docketRef: 'cand|5:26-cv-05055',
			entryNumber: 18,
			docSha1: sha1Hex('a40c167938d56e15f8959675bb5c7e46dda1bdea'),
			orderType: OrderType.Other,
			exParte: false,
			issuedAt: 0,
			expiresAt: 0,
			reasons: 24,
			wallets: [],
		})
		expect(hex.slice(0, 66)).toBe(`0x${'2'.padStart(64, '0')}`)
	})
})
