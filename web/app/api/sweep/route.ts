import { runWithServerKey } from '@/lib/server/run'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export function POST() {
	return runWithServerKey({ action: 'sweep' }, 'sweep')
}
