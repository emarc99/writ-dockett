/**
 * Fires the deployed Writ workflow's HTTP trigger through the CRE gateway, signing the request
 * with a key listed in the trigger's authorizedKeys (same scheme as @chainlink/cre-http-trigger).
 */
import type { Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { executeBody, jwtSigningInput, jwtWithSignature } from '../rpc'
import { env } from './env'

export const GATEWAY = 'https://01.gateway.zone-a.cre.chain.link'

export interface GatewayResult {
	executionId?: string
	status?: string
	error?: string
	raw: unknown
}

/** POSTs an already-signed request; `body` must be the exact string the JWT digest covers. */
export async function sendSigned(body: string, jwt: string): Promise<GatewayResult> {
	const post = () => fetch(GATEWAY, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` }, body })
	let res: Response | undefined
	for (let attempt = 1; !res; attempt++) {
		try {
			res = await post()
		} catch (err) {
			// Network-level failure (DNS, reset): the request never reached the gateway, so resending is safe.
			if (attempt >= 3) throw new Error(`could not reach the CRE gateway: ${(err as Error).message}`)
			await new Promise((r) => setTimeout(r, 2000 * attempt))
		}
	}
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

/** The issuer key the server signs with, if this deployment allows server-side signing. */
export function serverSignerKey(): Hex | undefined {
	const key = env('CRE_ETH_PRIVATE_KEY')
	if (!key) return undefined
	return (key.startsWith('0x') ? key : `0x${key}`) as Hex
}
