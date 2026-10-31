import { runWithServerKey } from '@/lib/server/run'
import { normalizeSubmission, validSubmission } from '@/lib/server/validate'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(req: Request) {
	const body = await req.json().catch(() => null)
	const err = validSubmission(body)
	if (err) return new Response(`${err}\n`, { status: 400 })
	return runWithServerKey(normalizeSubmission(body), 'verify')
}
