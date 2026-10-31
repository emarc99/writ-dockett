import { logSource } from '@/lib/server/cre'
import { serverSignerKey } from '@/lib/server/gateway'

export const dynamic = 'force-dynamic'

/** What this deployment can do: sign for the issuer, and where it reads DON logs from. */
export function GET() {
	return Response.json({ serverSigning: Boolean(serverSignerKey()), logs: logSource() })
}
