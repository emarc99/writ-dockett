import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The repo root, whether the process runs from web/ (next dev) or from the root itself. */
export const REPO_ROOT = existsSync(join(process.cwd(), 'deployments')) ? process.cwd() : join(process.cwd(), '..')

let dotenv: Record<string, string> | undefined

function readDotenv(): Record<string, string> {
	const vars: Record<string, string> = {}
	try {
		for (const line of readFileSync(join(REPO_ROOT, '.env'), 'utf8').split(/\r?\n/)) {
			const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
			if (m) vars[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2')
		}
	} catch {
		// No repo-level .env (e.g. on Vercel): process.env is the only source.
	}
	return vars
}

/** process.env first (Vercel project settings), then the repo's .env for local runs. */
export function env(name: string): string | undefined {
	const value = process.env[name]?.trim()
	if (value) return value
	dotenv ??= readDotenv()
	return dotenv[name] || undefined
}
