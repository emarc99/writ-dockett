import { cre, decodeJson, Runner, type HTTPPayload, type Runtime } from '@chainlink/cre-sdk'
import { configSchema, type Config } from './config'
import { onSweep } from './sweep'
import { onVerify } from './verify'

/**
 * Writ: court-order-gated freezes for a stablecoin.
 *   trigger 0 (HTTP) - verify a submitted order against the federal docket and attest or reject it;
 *                      `{"action":"sweep"}` runs the docket sweep on demand instead
 *   trigger 1 (cron) - watch each active order's docket and unfreeze when it expires or is dissolved
 */
const onHttp = (runtime: Runtime<Config>, payload: HTTPPayload): string => {
	const input = decodeJson(payload.input) as { action?: unknown } | null
	if (input?.action !== 'sweep') return onVerify(runtime, payload)
	runtime.log(`[identity] on-demand sweep requested by ${payload.key?.publicKey || 'none (local simulation)'}`)
	return onSweep(runtime)
}

const initWorkflow = (config: Config) => {
	const http = new cre.capabilities.HTTPCapability()
	const cron = new cre.capabilities.CronCapability()
	const authorizedKeys = config.httpAuthorizedKey
		? [{ type: 'KEY_TYPE_ECDSA_EVM' as const, publicKey: config.httpAuthorizedKey }]
		: []

	return [
		cre.handler(http.trigger({ authorizedKeys }), onHttp),
		cre.handler(cron.trigger({ schedule: config.sweepSchedule }), (runtime: Runtime<Config>) => onSweep(runtime)),
	]
}

export async function main() {
	const runner = await Runner.newRunner({ configSchema })
	await runner.run(initWorkflow)
}

main()
