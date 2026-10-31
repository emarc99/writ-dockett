import { privateKeyToAccount } from 'viem/accounts'
import { deployment } from '../deployment'
import { jwtIssuer } from '../rpc'
import { followExecution, type RunKind } from './cre'
import { sendSigned, serverSignerKey, triggerDeployed } from './gateway'

const label = () => `${deployment.workflowName} (${deployment.workflowId.slice(0, 10)}…)`

/** Signs with the server's issuer key, if this deployment has one. */
export function runWithServerKey(input: unknown, kind: RunKind): Response {
	const key = serverSignerKey()
	if (!key) return new Response('This deployment does not sign for you: connect the issuer wallet to sign the request.\n', { status: 403 })
	return followExecution(kind, async (write) => {
		write(`[writ] signing workflows.execute for ${label()} with the server key ${privateKeyToAccount(key).address}`)
		return triggerDeployed(deployment.workflowId, input, key)
	})
}

/** Forwards a request the browser wallet already signed; the gateway checks the signature. */
export function runPresigned(body: string, jwt: string, kind: RunKind): Response {
	return followExecution(kind, async (write) => {
		write(`[writ] workflows.execute for ${label()} signed in the browser by ${jwtIssuer(jwt) ?? 'unknown'}`)
		return sendSigned(body, jwt)
	})
}
