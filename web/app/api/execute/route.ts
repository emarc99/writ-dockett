import { deployment } from '@/lib/deployment'
import type { RunKind } from '@/lib/server/cre'
import { runPresigned } from '@/lib/server/run'
import { validSubmission } from '@/lib/server/validate'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/** Forwards a gateway request the browser wallet signed, after checking it targets this workflow. */
export async function POST(req: Request) {
	const b = await req.json().catch(() => null)
	let rpc: any
	try {
		rpc = JSON.parse(b?.body)
	} catch {
		return new Response('body must be the signed JSON-RPC request string\n', { status: 400 })
	}
	if (typeof b?.jwt !== 'string' || rpc?.method !== 'workflows.execute' || rpc?.params?.workflow?.workflowID !== deployment.workflowId) {
		return new Response('request must be workflows.execute for this deployment, with a jwt\n', { status: 400 })
	}
	const input = rpc.params.input
	const kind: RunKind = input?.action === 'sweep' ? 'sweep' : 'verify'
	const err = kind === 'sweep' ? (Object.keys(input).length === 1 ? undefined : 'sweep takes no other fields') : validSubmission(input)
	if (err) return new Response(`${err}\n`, { status: 400 })
	return runPresigned(b.body, b.jwt, kind)
}
