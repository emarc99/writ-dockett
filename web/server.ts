/**
 * Local demo server for Writ. Serves the UI and turns a submission into a CRE workflow run:
 * POST /api/verify fires the HTTP trigger, POST /api/sweep fires the cron trigger, both via
 * `cre workflow simulate --broadcast`, with the CLI output streamed back line by line.
 * Once the workflow is deployed to a DON, /api/verify becomes a signed POST to the CRE gateway.
 *
 *   bun web/server.ts          -> http://localhost:8787
 */
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const PUBLIC = join(import.meta.dir, 'public')
const PORT = Number(process.env.PORT ?? 8787)
const deployment = await Bun.file(join(ROOT, 'deployments', 'sepolia.json')).json()

const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, 'src', 'app.js')], target: 'browser', minify: true })
if (!bundle.success) throw new AggregateError(bundle.logs, 'UI bundle failed')
const appJs = await bundle.outputs[0].text()

const FIXTURES: Record<string, string> = {
	'ecf-18-genuine.pdf': 'fixtures/newton-v-ermilov/entry-18.genuine.pdf',
	'ecf-18-forged.pdf': 'fixtures/newton-v-ermilov/entry-18.forged.pdf',
}

let busy = false

function simulate(triggerIndex: number, payloadPath?: string): Response {
	if (busy) return new Response('Another workflow run is in progress, try again in a moment.\n', { status: 409 })
	busy = true
	const args = ['cre', 'workflow', 'simulate', 'workflows/writ', '--target', 'staging-settings', '--non-interactive', '--trigger-index', String(triggerIndex), '--broadcast']
	if (payloadPath) args.push('--http-payload', payloadPath)
	const proc = Bun.spawn(args, { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1' } })

	const encoder = new TextEncoder()
	const stream = new ReadableStream({
		async start(controller) {
			const pump = async (s: ReadableStream<Uint8Array>) => {
				for await (const chunk of s) controller.enqueue(chunk)
			}
			try {
				await Promise.all([pump(proc.stdout), pump(proc.stderr)])
				const code = await proc.exited
				controller.enqueue(encoder.encode(`\n[writ] cre exited with code ${code}\n`))
			} finally {
				busy = false
				controller.close()
			}
		},
	})
	return new Response(stream, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })
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
		if (url.pathname === '/app.js') return new Response(appJs, { headers: { 'Content-Type': 'text/javascript' } })

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
			const path = join(tmpdir(), `writ-submission-${Date.now()}.json`)
			await Bun.write(path, JSON.stringify(submission))
			return simulate(0, path)
		}

		if (url.pathname === '/api/sweep' && req.method === 'POST') return simulate(1)

		const file = Bun.file(join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '')))
		return (await file.exists()) && !url.pathname.includes('..') ? new Response(file) : new Response('not found', { status: 404 })
	},
})

console.log(`Writ demo UI on http://localhost:${PORT}`)
