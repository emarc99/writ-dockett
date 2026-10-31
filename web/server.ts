/**
 * Local demo server for Writ. Serves the UI and turns a submission into a CRE workflow run.
 *
 * Deployed (deployments/sepolia.json has a workflowId): POST /api/verify and POST /api/sweep sign
 * a JSON-RPC request with the HTTP trigger's authorized key, send it to the CRE gateway, wait for
 * the DON execution and stream one node's logs back. The sweep request is `{"action":"sweep"}`;
 * the DON also runs the sweep on its cron schedule. POST /api/execute does the same for a request
 * the browser wallet already signed, forwarding it unchanged.
 *
 * Simulation (no workflowId): both endpoints run `cre workflow simulate --broadcast`.
 *
 *   bun web/server.ts          -> http://localhost:8787
 */
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { privateKeyToAccount } from 'viem/accounts'
import { Reason } from '../workflows/writ/legal'
import { sendSigned, signerKeyFromEnv, triggerDeployed, type GatewayResult } from './gateway'
import { jwtIssuer } from './src/rpc'

const ROOT = resolve(import.meta.dir, '..')
const PUBLIC = join(import.meta.dir, 'public')
const PORT = Number(process.env.PORT ?? 8787)
const deployment = await Bun.file(join(ROOT, 'deployments', 'sepolia.json')).json()
const DEPLOYED = Boolean(deployment.workflowId)

const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, 'src', 'app.js')], target: 'browser', minify: true })
if (!bundle.success) throw new AggregateError(bundle.logs, 'UI bundle failed')
const appJs = await bundle.outputs[0].text()

const FIXTURES: Record<string, string> = {
	'ecf-18-genuine.pdf': 'fixtures/newton-v-ermilov/entry-18.genuine.pdf',
	'ecf-18-forged.pdf': 'fixtures/newton-v-ermilov/entry-18.forged.pdf',
}

const encoder = new TextEncoder()
let busy = false

/** Streams whatever `run` writes, holding the single-run lock until it finishes. */
function streamRun(run: (write: (line: string) => void, raw: (chunk: Uint8Array) => void) => Promise<void>): Response {
	if (busy) return new Response('Another workflow run is in progress, try again in a moment.\n', { status: 409 })
	busy = true
	const stream = new ReadableStream({
		async start(controller) {
			const write = (line: string) => controller.enqueue(encoder.encode(`${line}\n`))
			try {
				await run(write, (chunk) => controller.enqueue(chunk))
			} catch (err) {
				write(`workflow execution failed: ${(err as Error).message ?? err}`)
			} finally {
				busy = false
				controller.close()
			}
		},
	})
	return new Response(stream, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })
}

function simulate(triggerIndex: number, payloadPath?: string): Response {
	return streamRun(async (write, raw) => {
		const args = ['cre', 'workflow', 'simulate', 'workflows/writ', '--target', 'staging-settings', '--non-interactive', '--trigger-index', String(triggerIndex), '--broadcast']
		if (payloadPath) args.push('--http-payload', payloadPath)
		const proc = Bun.spawn(args, { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1' } })
		const pump = async (s: ReadableStream<Uint8Array>) => {
			for await (const chunk of s) raw(chunk)
		}
		await Promise.all([pump(proc.stdout), pump(proc.stderr)])
		write(`\n[writ] cre exited with code ${await proc.exited}`)
	})
}

async function cre(...args: string[]): Promise<string> {
	const proc = Bun.spawn(['cre', ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1' } })
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
	await proc.exited
	return out + err
}

/** Turns the DON's final `[verify]` log line into the same result shape the simulator returns. */
function resultFromLogs(lines: string[]): Record<string, unknown> | undefined {
	const legal = lines.map((l) => /expiresAt=(\S+)/.exec(l)?.[1]).find(Boolean)
	for (const l of lines) {
		let m = /\[verify\] VERIFIED (0x[0-9a-f]{64}): froze (\d+) wallet\(s\) tx=(0x[0-9a-f]+)/i.exec(l)
		if (m) {
			const expiresAt = legal && legal !== 'until' ? Math.floor(Date.parse(legal) / 1000) : 0
			return { decision: 'VERIFIED', orderId: m[1], wallets: Array(Number(m[2])).fill(''), expiresAt, txHash: m[3] }
		}
		m = /\[verify\] REJECTED submission (0x[0-9a-f]{64}): (.+) tx=(0x[0-9a-f]+)/i.exec(l)
		if (m) {
			const labels = m[2].split(', ')
			const reasons = labels.reduce((acc, label) => acc | (Reason[label as keyof typeof Reason] ?? 0), 0)
			return { decision: 'REJECTED', submissionId: m[1], reasons, labels, txHash: m[3] }
		}
		m = /\[verify\] order (0x[0-9a-f]{64}) already recorded with status (\w+)/i.exec(l)
		if (m) return { decision: 'ALREADY_RECORDED', orderId: m[1], status: m[2] }
	}
	return undefined
}

type Kind = 'verify' | 'sweep'

/** Signs with the server's key from .env. */
function runDeployed(input: unknown, kind: Kind): Response {
	return followExecution(kind, async (write) => {
		const key = await signerKeyFromEnv(ROOT)
		write(`[writ] signing workflows.execute for ${deployment.workflowName} (${deployment.workflowId.slice(0, 10)}…) with the server key ${privateKeyToAccount(key).address}`)
		return triggerDeployed(deployment.workflowId, input, key)
	})
}

/** Forwards a request the browser wallet already signed; the gateway checks the signature. */
function runPresigned(body: string, jwt: string, kind: Kind): Response {
	return followExecution(kind, async (write) => {
		write(`[writ] workflows.execute for ${deployment.workflowName} (${deployment.workflowId.slice(0, 10)}…) signed in the browser by ${jwtIssuer(jwt) ?? 'unknown'}`)
		return sendSigned(body, jwt)
	})
}

function followExecution(kind: Kind, send: (write: (line: string) => void) => Promise<GatewayResult>): Response {
	return streamRun(async (write) => {
		const sent = await send(write)
		if (!sent.executionId) throw new Error(`gateway refused the request: ${sent.error ?? JSON.stringify(sent.raw)}`)
		write(`[writ] CRE gateway ${sent.status}: execution ${sent.executionId}`)

		const id = sent.executionId.replace(/^0x/, '')
		let status = 'PENDING'
		for (let i = 0; i < 30 && !/SUCCESS|FAIL|ERROR|TIMEOUT/i.test(status); i++) {
			await Bun.sleep(5000)
			const list = await cre('execution', 'list', deployment.workflowName)
			status = new RegExp(`${id}[\\s\\S]*?Status:\\s+(\\w+)`).exec(list)?.[1] ?? status
			write(`[writ] DON execution status: ${status}`)
		}

		const done = (ls: string[]) => (kind === 'verify' ? Boolean(resultFromLogs(ls)) : ls.some((l) => /\[(sweep|chain)\]/.test(l)))
		let lines: string[] = []
		for (let i = 0; i < 4; i++) {
			lines = (await cre('execution', 'logs', id)).split(/\r?\n/).filter((l) => /^\[\d{4}-/.test(l))
			if (done(lines)) break
			await Bun.sleep(5000)
		}
		const final = lines.find((l) => /\[verify\] (VERIFIED|REJECTED|order )|tx=0x/.test(l)) ?? lines[0]
		const node = final ? /\[(Node \d+)\]/.exec(final)?.[1] : undefined
		const nodes = new Set(lines.map((l) => /\[(Node \d+)\]/.exec(l)?.[1]).filter(Boolean))
		write(`[writ] ${nodes.size} DON node(s) ran the workflow; showing ${node ?? 'all nodes'}`)
		const mine = node ? lines.filter((l) => l.includes(`[${node}]`)) : lines
		for (const l of mine) write(`[USER LOG] ${l.replace(/^\[[^\]]+\] \[Node \d+\] /, '')}`)

		const result = kind === 'verify' ? resultFromLogs(mine) : undefined
		if (result) write(`[writ] result ${JSON.stringify(result)}`)
		else if (kind === 'sweep' && /SUCCESS/i.test(status)) write(`[writ] DON execution ${sent.executionId} finished: ${status}`)
		else write(`workflow execution failed: execution ${sent.executionId} ended with status ${status}`)
	})
}

function validSubmission(b: any): string | undefined {
	if (typeof b !== 'object' || b === null) return 'body must be a JSON object'
	if (!/^[a-z0-9]{2,16}$/i.test(b.court ?? '')) return 'court must be a CourtListener court id, e.g. "cand"'
	if (!/^[\w:.-]{3,64}$/.test(b.docketNumber ?? '')) return 'docketNumber looks invalid'
	if (!Number.isInteger(b.entryNumber) || b.entryNumber < 1) return 'entryNumber must be a positive integer'
	if (!/^(0x)?[0-9a-f]{40}$/i.test(b.documentSha1 ?? '')) return 'documentSha1 must be 40 hex chars'
	if (b.wallets !== undefined && (!Array.isArray(b.wallets) || b.wallets.length > 50)) return 'wallets must be an array'
	return undefined
}

Bun.serve({
	port: PORT,
	hostname: '127.0.0.1',
	idleTimeout: 255,
	async fetch(req) {
		const url = new URL(req.url)

		if (url.pathname === '/api/config') return Response.json(deployment)
		if (url.pathname === '/app.js') return new Response(appJs, { headers: { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' } })

		if (url.pathname.startsWith('/fixtures/')) {
			const rel = FIXTURES[url.pathname.slice('/fixtures/'.length)]
			return rel ? new Response(Bun.file(join(ROOT, rel))) : new Response('not found', { status: 404 })
		}

		if (url.pathname === '/api/verify' && req.method === 'POST') {
			const body = await req.json().catch(() => null)
			const err = validSubmission(body)
			if (err) return new Response(`${err}\n`, { status: 400 })
			const submission = {
				court: body.court.toLowerCase(),
				docketNumber: body.docketNumber,
				entryNumber: body.entryNumber,
				documentSha1: body.documentSha1.toLowerCase().replace(/^0x/, ''),
				wallets: (body.wallets ?? []).map(String),
				...(body.filedDate ? { filedDate: String(body.filedDate) } : {}),
			}
			if (DEPLOYED) return runDeployed(submission, 'verify')
			const path = join(tmpdir(), `writ-submission-${Date.now()}.json`)
			await Bun.write(path, JSON.stringify(submission))
			return simulate(0, path)
		}

		if (url.pathname === '/api/sweep' && req.method === 'POST') {
			return DEPLOYED ? runDeployed({ action: 'sweep' }, 'sweep') : simulate(1)
		}

		if (url.pathname === '/api/execute' && req.method === 'POST') {
			if (!DEPLOYED) return new Response('wallet signing needs a deployed workflow (workflowId in deployments/sepolia.json)\n', { status: 400 })
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
			const kind: Kind = input?.action === 'sweep' ? 'sweep' : 'verify'
			const err = kind === 'sweep' ? (Object.keys(input).length === 1 ? undefined : 'sweep takes no other fields') : validSubmission(input)
			if (err) return new Response(`${err}\n`, { status: 400 })
			return runPresigned(b.body, b.jwt, kind)
		}

		const file = Bun.file(join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '')))
		return (await file.exists()) && !url.pathname.includes('..')
			? new Response(file, { headers: { 'Cache-Control': 'no-store' } })
			: new Response('not found', { status: 404 })
	},
})

console.log(`Writ demo UI on http://localhost:${PORT} (${DEPLOYED ? `deployed workflow ${deployment.workflowName}` : 'local simulation'})`)
