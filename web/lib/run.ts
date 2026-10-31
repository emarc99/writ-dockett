/** Turns the server's streamed workflow log into run state: progress steps, checks, result. */

export type Step = 'sign' | 'gateway' | 'don' | 'chain'
export const STEPS: Step[] = ['sign', 'gateway', 'don', 'chain']
export type StepState = 'active' | 'done' | 'fail'

export const KIND_LABELS: Record<string, string> = {
	chain: 'Chain read',
	gemini: 'Gemini',
	legal: 'Rule 65',
	identity: 'Identity',
	report: 'Signed report',
	sweep: 'Sweep',
}

export interface Check {
	verdict: 'pass' | 'fail' | 'info'
	kind: string
	name: string
	detail?: string
}

export type RunResult =
	| { decision: 'VERIFIED'; orderId: string; wallets: number; expiresAt: number; txHash: string }
	| { decision: 'REJECTED'; reasons: number; labels: string[]; txHash: string }
	| { decision: 'ALREADY_RECORDED'; orderId: string; status: string }
	| { decision: 'ACCEPTED'; executionId: string }
	| { decision: 'DONE' }
	| { decision: 'ERROR'; error: string }

export interface Run {
	busy: boolean
	steps: Partial<Record<Step, StepState>>
	donStart?: number
	donEnd?: number
	checks: Check[]
	log: string
	note?: string
	result?: RunResult
}

export const idleRun: Run = { busy: false, steps: {}, checks: [], log: '' }

export function startRun(note?: string): Run {
	return { busy: true, steps: { sign: 'active' }, checks: [], log: '', note }
}

function startStep(r: Run, step: Step): Run {
	const i = STEPS.indexOf(step)
	const steps = { ...r.steps }
	STEPS.forEach((s, j) => {
		if (j < i) steps[s] = 'done'
	})
	steps[step] = 'active'
	return {
		...r,
		steps,
		donStart: step === 'don' ? Date.now() : r.donStart,
		donEnd: i > STEPS.indexOf('don') && r.donStart && !r.donEnd ? Date.now() : r.donEnd,
	}
}

const CHECK = /\[USER LOG\] \[(check|gemini|legal|sweep|chain|identity|report)\] (?:(PASS|FAIL) )?(.+?)(?:: (.*))?$/

export function applyLine(r: Run, raw: string): Run {
	const line = raw.replace(/\x1b\[[0-9;]*m/g, '')
	let next: Run = { ...r, log: `${r.log}${line}\n` }
	if (/CRE gateway ACCEPTED/.test(line)) next = startStep(next, 'don')
	else if (/^\[writ\] (signing|workflows\.execute)/.test(line)) next = startStep(next, 'gateway')
	else if (/DON execution status: SUCCESS|finished: SUCCESS|\d+ DON node\(s\) ran/.test(line)) next = startStep(next, 'chain')

	if (line.startsWith('[writ] result ')) next.result = JSON.parse(line.slice('[writ] result '.length))
	else if (/finished: SUCCESS/.test(line)) next.result = { decision: 'DONE' }
	else if (/workflow execution failed/i.test(line)) next.result = { decision: 'ERROR', error: line.replace(/^.*workflow execution failed:\s*/i, '') }

	const m = CHECK.exec(line)
	if (m) {
		const [, kind, verdict, name, detail] = m
		if (kind === 'report') next = startStep(next, 'chain')
		next.checks = [...next.checks, { kind, verdict: verdict ? (verdict.toLowerCase() as 'pass' | 'fail') : 'info', name, detail }]
	}
	return next
}

/** Closes a run: every step done on success, the current step failed otherwise. */
export function finishRun(r: Run, missing: string): Run {
	const result: RunResult = r.result ?? { decision: 'ERROR', error: missing }
	const failed = result.decision === 'ERROR'
	const steps = { ...r.steps }
	if (failed) {
		const current = STEPS.find((s) => steps[s] === 'active') ?? 'sign'
		steps[current] = 'fail'
	} else {
		STEPS.forEach((s) => (steps[s] = 'done'))
	}
	return { ...r, busy: false, steps, result, note: undefined, donEnd: r.donEnd ?? (r.donStart ? Date.now() : undefined) }
}

/** POSTs to a streaming endpoint and calls `onLine` for each line as it arrives. */
export async function streamLines(url: string, body: unknown, onLine: (line: string) => void): Promise<void> {
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
	})
	if (!res.ok || !res.body) throw new Error((await res.text()).trim() || `HTTP ${res.status}`)
	const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
	let buf = ''
	for (;;) {
		const { value, done } = await reader.read()
		if (done) break
		buf += value
		const lines = buf.split(/\r?\n/)
		buf = lines.pop() ?? ''
		lines.forEach(onLine)
	}
	if (buf) onLine(buf)
}
