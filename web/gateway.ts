/**
 * Fires the deployed Writ workflow's HTTP trigger through the CRE gateway, signing the request
 * with a key listed in the trigger's authorizedKeys (same scheme as @chainlink/cre-http-trigger).
 *
 *   bun web/gateway.ts payloads/forged.json
 */
import { join, resolve } from 'node:path'
import type { Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { executeBody, jwtSigningInput, jwtWithSignature } from './src/rpc'

export const GATEWAY = 'https://01.gateway.zone-a.cre.chain.link'

export interface GatewayResult {
	executionId?: string
	status?: string
	error?: string
	raw: unknown
}

/** POSTs an already-signed request; `body` must be the exact string the JWT digest covers. */
export async function sendSigned(body: string, jwt: string): Promise<GatewayResult> {
	const res = await fetch(GATEWAY, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
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

export async function triggerDeployed(workflowId: string, input: unknown, privateKey: Hex): Promise<GatewayResult> {
	const account = privateKeyToAccount(privateKey)
	const body = executeBody(workflowId, input)
	const message = await jwtSigningInput(body, account.address)
	return sendSigned(body, jwtWithSignature(message, await account.signMessage({ message })))
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
