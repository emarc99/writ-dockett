/**
 * Follows a DON execution after the gateway accepts it and streams one node's logs to the browser.
 *
 * Execution status and node logs come from the CRE platform API (api.cre.chain.link/graphql) when
 * CRE_API_KEY is set, which is how a Vercel deployment works. Locally, without a key, they come
 * from the logged-in `cre` CLI instead.
 */
import { spawn } from 'node:child_process'
import { deployment } from '../deployment'
import { reasonLabelsToBits } from './reasons'
import { env, REPO_ROOT } from './env'
import type { GatewayResult } from './gateway'

const API = 'https://api.cre.chain.link/graphql'

const LIST_WORKFLOWS = `query ListWorkflows($input: WorkflowsInput!) {
  workflows(input: $input) { data { uuid name workflowId } }
}`
const LIST_EXECUTIONS = `query ListExecutions($input: WorkflowExecutionsInput!) {
  workflowExecutions(input: $input) { data { uuid id status } }
}`
const LIST_EXECUTION_LOGS = `query ListExecutionLogs($input: WorkflowExecutionLogsInput!) {
  workflowExecutionLogs(input: $input) { data { nodeID message timestamp } }
}`

export type LogSource = 'api' | 'cli' | 'none'

export function logSource(): LogSource {
	if (env('CRE_API_KEY')) return 'api'
	return process.env.VERCEL ? 'none' : 'cli'
}

async function gql<T>(query: string, variables: object): Promise<T> {
	const res = await fetch(API, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Apikey ${env('CRE_API_KEY')}` },
		body: JSON.stringify({ query, variables }),
	})
	const json = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message: string }[] }
	if (!res.ok || json.errors?.length || !json.data) {
		throw new Error(`CRE API: ${json.errors?.map((e) => e.message).join('; ') ?? `HTTP ${res.status}`}`)
	}
	return json.data
}

function cli(...args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const proc = spawn('cre', args, { cwd: REPO_ROOT, env: { ...process.env, NO_COLOR: '1' } })
		let out = ''
		proc.stdout.on('data', (d) => (out += d))
		proc.stderr.on('data', (d) => (out += d))
		proc.on('error', reject)
		proc.on('close', () => resolve(out))
	})
}

const hex = (id: string) => id.replace(/^0x/, '').toLowerCase()

let workflowUuid: string | undefined

async function getWorkflowUuid(): Promise<string> {
	if (workflowUuid) return workflowUuid
	const d = await gql<{ workflows: { data: { uuid: string; workflowId: string }[] } }>(LIST_WORKFLOWS, { input: { page: { number: 0, size: 100 } } })
	workflowUuid = d.workflows.data.find((w) => hex(w.workflowId ?? '') === hex(deployment.workflowId))?.uuid
	if (!workflowUuid) throw new Error(`workflow ${deployment.workflowName} is not in the CRE organization that owns CRE_API_KEY`)
	return workflowUuid
}

interface Execution {
	status: string
	uuid?: string
}

async function getExecution(id: string): Promise<Execution | undefined> {
	if (logSource() === 'api') {
		const d = await gql<{ workflowExecutions: { data: { uuid: string; id: string; status: string }[] } }>(LIST_EXECUTIONS, {
			input: { workflowUuid: await getWorkflowUuid(), page: { number: 0, size: 20 } },
		})
		const e = d.workflowExecutions.data.find((x) => hex(x.id) === id)
		return e && { status: e.status, uuid: e.uuid }
	}
	const status = new RegExp(`${id}[\\s\\S]*?Status:\\s+(\\w+)`).exec(await cli('execution', 'list', deployment.workflowName))?.[1]
	return status ? { status } : undefined
}

interface NodeLog {
	node: string
	message: string
}

async function getLogs(id: string, exec: Execution | undefined): Promise<NodeLog[]> {
	if (logSource() === 'api') {
		if (!exec?.uuid) return []
		const d = await gql<{ workflowExecutionLogs: { data: { nodeID: string; message: string; timestamp: string }[] } }>(LIST_EXECUTION_LOGS, {
			input: { workflowExecutionUUID: exec.uuid },
		})
		return [...d.workflowExecutionLogs.data]
			.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
			.map((l) => ({ node: l.nodeID, message: l.message.trim() }))
	}
	return (await cli('execution', 'logs', id))
		.split(/\r?\n/)
		.flatMap((l) => {
			const m = /^\[[^\]]+\] \[(Node \d+)\] (.*)$/.exec(l)
			return m ? [{ node: m[1], message: m[2] }] : []
		})
}

/** Turns the DON's final `[verify]` log line into the result the UI shows. */
function resultFromLogs(messages: string[]): Record<string, unknown> | undefined {
	const legal = messages.map((l) => /expiresAt=(\S+)/.exec(l)?.[1]).find(Boolean)
	for (const l of messages) {
		let m = /\[verify\] VERIFIED (0x[0-9a-f]{64}): froze (\d+) wallet\(s\) tx=(0x[0-9a-f]+)/i.exec(l)
		if (m) {
			const expiresAt = legal && legal !== 'until' ? Math.floor(Date.parse(legal) / 1000) : 0
			return { decision: 'VERIFIED', orderId: m[1], wallets: Number(m[2]), expiresAt, txHash: m[3] }
		}
		m = /\[verify\] REJECTED submission (0x[0-9a-f]{64}): (.+) tx=(0x[0-9a-f]+)/i.exec(l)
		if (m) {
			const labels = m[2].split(', ')
			return { decision: 'REJECTED', submissionId: m[1], reasons: reasonLabelsToBits(labels), labels, txHash: m[3] }
		}
		m = /\[verify\] order (0x[0-9a-f]{64}) already recorded with status (\w+)/i.exec(l)
		if (m) return { decision: 'ALREADY_RECORDED', orderId: m[1], status: m[2] }
	}
	return undefined
}

const encoder = new TextEncoder()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let busy = false

/** Streams whatever `run` writes as plain-text lines, one run per server instance at a time. */
function streamRun(run: (write: (line: string) => void) => Promise<void>): Response {
	if (busy) return new Response('Another workflow run is in progress, try again in a moment.\n', { status: 409 })
	busy = true
	const stream = new ReadableStream({
		async start(controller) {
			const write = (line: string) => controller.enqueue(encoder.encode(`${line}\n`))
			try {
				await run(write)
			} catch (err) {
				write(`workflow execution failed: ${(err as Error).message ?? err}`)
			} finally {
				busy = false
				controller.close()
			}
		},
	})
	return new Response(stream, {
		headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' },
	})
}

export type RunKind = 'verify' | 'sweep'

export function followExecution(kind: RunKind, send: (write: (line: string) => void) => Promise<GatewayResult>): Response {
	return streamRun(async (write) => {
		const source = logSource()
		const sent = await send(write)
		if (!sent.executionId) throw new Error(`gateway refused the request: ${sent.error ?? JSON.stringify(sent.raw)}`)
		write(`[writ] CRE gateway ${sent.status}: execution ${sent.executionId}`)
		if (source === 'none') {
			write('[writ] CRE_API_KEY is not set, so this server cannot read DON logs')
			write(`[writ] result ${JSON.stringify({ decision: 'ACCEPTED', executionId: sent.executionId })}`)
			return
		}

		const id = hex(sent.executionId)
		let exec: Execution | undefined
		for (let i = 0; i < 30 && !/SUCCESS|FAIL|ERROR|TIMEOUT/i.test(exec?.status ?? ''); i++) {
			await sleep(5000)
			exec = (await getExecution(id)) ?? exec
			write(`[writ] DON execution status: ${exec?.status ?? 'PENDING'}`)
		}

		const messages = (ls: NodeLog[]) => ls.map((l) => l.message)
		const done = (ls: NodeLog[]) => (kind === 'verify' ? Boolean(resultFromLogs(messages(ls))) : ls.some((l) => /\[(sweep|chain)\]/.test(l.message)))
		let logs: NodeLog[] = []
		for (let i = 0; i < 4; i++) {
			logs = await getLogs(id, exec)
			if (done(logs)) break
			await sleep(5000)
		}
		const final = logs.find((l) => /\[verify\] (VERIFIED|REJECTED|order )|tx=0x/.test(l.message)) ?? logs[0]
		const nodes = new Set(logs.map((l) => l.node))
		write(`[writ] ${nodes.size} DON node(s) ran the workflow; showing ${final?.node ?? 'all nodes'}`)
		const mine = final ? logs.filter((l) => l.node === final.node) : logs
		for (const l of mine) write(`[USER LOG] ${l.message}`)

		const status = exec?.status ?? 'UNKNOWN'
		const result = kind === 'verify' ? resultFromLogs(messages(mine)) : undefined
		if (result) write(`[writ] result ${JSON.stringify(result)}`)
		else if (kind === 'sweep' && /SUCCESS/i.test(status)) write(`[writ] DON execution ${sent.executionId} finished: ${status}`)
		else write(`workflow execution failed: execution ${sent.executionId} ended with status ${status}`)
	})
}
