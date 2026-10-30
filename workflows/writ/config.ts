import { z } from 'zod'

export const configSchema = z.object({
	chainSelectorName: z.string(),
	registryAddress: z.string(),
	/** Attesting a 6-wallet order costs ~2.8M gas on Sepolia; CRE caps a write at 10M. */
	gasLimit: z.string().default('5000000'),
	courtListenerBaseUrl: z.string().default('https://www.courtlistener.com/api/rest/v4'),
	/** Tried in order; the next model is used only when one is overloaded (429/5xx) or times out. */
	geminiModels: z.array(z.string()).min(1).max(3).default(['gemini-3.5-flash', 'gemini-3.1-flash-lite']),
	/** Cron for the docket sweep (6-field, with seconds). */
	sweepSchedule: z.string().default('0 0 */6 * * *'),
	/** EVM reads are capped at 15 per execution: 1 for getOrderIds + one getOrder per order. */
	maxOrdersScanned: z.number().int().min(1).max(14).default(10),
	/** HTTP calls are capped at 15 per execution: up to 3 per swept order. */
	maxOrdersSwept: z.number().int().min(1).max(4).default(3),
	/** EVM address allowed to fire the HTTP trigger once deployed; empty while simulating. */
	httpAuthorizedKey: z.string().default(''),
})

export type Config = z.infer<typeof configSchema>

/** Body of the HTTP trigger: what a litigant or issuer submits for verification. */
export const submissionSchema = z.object({
	court: z.string().min(2).max(16),
	docketNumber: z.string().min(3).max(64),
	entryNumber: z.number().int().positive(),
	/** SHA-1 of the PDF the submitter holds; computed client-side by the UI. */
	documentSha1: z.string().regex(/^(0x)?[0-9a-fA-F]{40}$/),
	/** Wallets the submitter claims the order freezes. Empty = freeze everything the order names. */
	wallets: z.array(z.string()).max(50).default([]),
	/** Filing date the submitter claims, YYYY-MM-DD; checked against the docket if present. */
	filedDate: z.string().optional(),
})

export type Submission = z.infer<typeof submissionSchema>
