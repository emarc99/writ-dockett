/**
 * Fires the deployed workflow's HTTP trigger from the command line with the issuer key in .env.
 *
 *   cd web && bun run sync && bun scripts/trigger.ts ../payloads/forged.json
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { deployment } from '../lib/deployment'
import { serverSignerKey, triggerDeployed } from '../lib/server/gateway'

const file = process.argv[2]
if (!file) throw new Error('usage: bun scripts/trigger.ts <payload.json>')
const key = serverSignerKey()
if (!key) throw new Error('CRE_ETH_PRIVATE_KEY missing from .env')
const input = JSON.parse(readFileSync(resolve(file), 'utf8'))
const result = await triggerDeployed(deployment.workflowId, input, key)
console.log(JSON.stringify({ executionId: result.executionId, status: result.status, error: result.error }, null, 2))
