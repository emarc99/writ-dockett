/**
 * CRE gateway request format, shared by the server (signs with a local key) and the browser
 * (signs with the connected wallet). The gateway checks an ETH-signed JWT whose `digest` is the
 * SHA-256 of the exact request body, so both sides must serialize identically.
 */

/** JSON with keys sorted at every level; the gateway digests this exact serialization. */
export function stableStringify(v: unknown): string {
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

export function b64url(bytes: Uint8Array): string {
	let s = ''
	for (const b of bytes) s += String.fromCharCode(b)
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const utf8 = (s: string) => new TextEncoder().encode(s)

export function executeBody(workflowId: string, input: unknown): string {
	return stableStringify({
		id: crypto.randomUUID(),
		jsonrpc: '2.0',
		method: 'workflows.execute',
		params: { input, workflow: { workflowID: workflowId.replace(/^0x/, '') } },
	})
}

/** The `header.payload` string the signer must personal_sign (EIP-191). */
export async function jwtSigningInput(body: string, issuer: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(body)))
	const now = Math.floor(Date.now() / 1000)
	const header = b64url(utf8(JSON.stringify({ alg: 'ETH', typ: 'JWT' })))
	const payload = b64url(
		utf8(
			JSON.stringify({
				digest: `0x${[...digest].map((b) => b.toString(16).padStart(2, '0')).join('')}`,
				iss: issuer,
				iat: now,
				exp: now + 300,
				jti: crypto.randomUUID(),
			}),
		),
	)
	return `${header}.${payload}`
}

/** Appends a 65-byte `r || s || v` signature (v as 27/28 or 0/1) in the gateway's r||s||recovery form. */
export function jwtWithSignature(signingInput: string, signatureHex: string): string {
	const hex = signatureHex.replace(/^0x/, '')
	if (hex.length !== 130) throw new Error('expected a 65-byte signature')
	const sig = new Uint8Array(65)
	for (let i = 0; i < 65; i++) sig[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
	if (sig[64] >= 27) sig[64] -= 27
	return `${signingInput}.${b64url(sig)}`
}

/** Reads the `iss` claim back out of a JWT (no verification; the gateway verifies). */
export function jwtIssuer(jwt: string): string | undefined {
	try {
		const part = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
		return JSON.parse(atob(part + '='.repeat((4 - (part.length % 4)) % 4))).iss
	} catch {
		return undefined
	}
}
