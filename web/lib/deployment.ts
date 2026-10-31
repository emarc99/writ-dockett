import type { Address } from 'viem'
import raw from './deployment.json'

export interface Deployment {
	chain: string
	chainId: number
	orderRegistry: Address
	writToken: Address
	forwarder: Address
	workflowName: string
	workflowId: string
	workflowOwner?: string
	httpAuthorizedKey: Address
	deployer: Address
	deployedAt: string
	fromBlock: number
}

/** Synced from deployments/sepolia.json by scripts/sync.mjs. */
export const deployment = raw as Deployment
