// Copies repo-level artifacts the app needs into web/ so it builds standalone (e.g. on Vercel with
// root directory "web"): the current Sepolia deployment and the demo case's PDFs.
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const web = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = join(web, '..')

const copies = [
	['deployments/sepolia.json', 'lib/deployment.json'],
	['fixtures/newton-v-ermilov/entry-18.genuine.pdf', 'public/fixtures/ecf-18-genuine.pdf'],
	['fixtures/newton-v-ermilov/entry-18.forged.pdf', 'public/fixtures/ecf-18-forged.pdf'],
]

for (const [from, to] of copies) {
	mkdirSync(dirname(join(web, to)), { recursive: true })
	copyFileSync(join(root, from), join(web, to))
}
console.log(`synced ${copies.length} files from the repo root`)
