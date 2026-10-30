/**
 * Fires the deployed Writ workflow's HTTP trigger through the CRE gateway, signing the request
 * with a key listed in the trigger's authorizedKeys (same scheme as @chainlink/cre-http-trigger).
 *
 *   bun web/gateway.ts payloads/forged.json
 */
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { parseSignature, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

export const GATEWAY = 'https://01.gateway.zone-a.cre.chain.link'

/** JSON with keys sorted at every level; the gateway digests this exact serialization. */
function stableStringify(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
	if (v && typeof v === 'object') {
		const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined)
		return `{${entries
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([k, x]) => `${JSON.stringify(k)}:${stableStringify(x)}`)
			.join(',')}}`
	}
	return JSON.stringify(v)
}

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export interface GatewayResult {
	executionId?: string
	status?: string
	error?: string
	raw: unknown
}

export async function triggerDeployed(workflowId: string, input: unknown, privateKey: Hex): Promise<GatewayResult> {
	const account = privateKeyToAccount(privateKey)
	const body = stableStringify({
		id: randomUUID(),
		jsonrpc: '2.0',
		method: 'workflows.execute',
		params: { input, workflow: { workflowID: workflowId.replace(/^0x/, '') } },
	})
	const now = Math.floor(Date.now() / 1000)
	const header = b64url(Buffer.from(JSON.stringify({ alg: 'ETH', typ: 'JWT' })))
	const payload = b64url(
		Buffer.from(
			JSON.stringify({
				digest: `0x${createHash('sha256').update(body).digest('hex')}`,
				iss: account.address,
				iat: now,
				exp: now + 300,
				jti: randomUUID(),
			}),
		),
	)
	const message = `${header}.${payload}`
	const { r, s, v, yParity } = parseSignature(await account.signMessage({ message }))
	const recovery = v !== undefined ? Number(v >= 27n ? v - 27n : v) : (yParity ?? 0)
	const sig = Buffer.concat([
		Buffer.from(r.slice(2).padStart(64, '0'), 'hex'),
		Buffer.from(s.slice(2).padStart(64, '0'), 'hex'),
		Buffer.from([recovery]),
	])

	const res = await fetch(GATEWAY, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${message}.${b64url(sig)}` },
		body,
	})
	const raw = (await res.json().catch(() => ({ httpStatus: res.status }))) as {
		result?: { workflow_execution_id?: string; status?: string }
		error?: { message?: string }
	}
	return {
		executionId: raw.result?.workflow_execution_id,
		status: raw.result?.status,
		error: raw.error?.message,
		raw,
	}
}

export async function signerKeyFromEnv(root: string): Promise<Hex> {
	const env = await Bun.file(join(root, '.env')).text()
	const key = /^CRE_ETH_PRIVATE_KEY=(.*)$/m.exec(env)?.[1]?.trim()
	if (!key) throw new Error('CRE_ETH_PRIVATE_KEY missing from .env')
	return (key.startsWith('0x') ? key : `0x${key}`) as Hex
}

if (import.meta.main) {
	const root = resolve(import.meta.dir, '..')
	const file = process.argv[2]
	if (!file) throw new Error('usage: bun web/gateway.ts <payload.json>')
	const deployment = await Bun.file(join(root, 'deployments', 'sepolia.json')).json()
	const input = await Bun.file(resolve(file)).json()
	const result = await triggerDeployed(deployment.workflowId, input, await signerKeyFromEnv(root))
	console.log(JSON.stringify({ executionId: result.executionId, status: result.status, error: result.error }, null, 2))
}
