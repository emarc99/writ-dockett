import type { NextConfig } from 'next'

const config: NextConfig = {
	turbopack: { root: import.meta.dirname },
	outputFileTracingRoot: import.meta.dirname,
	devIndicators: false,
}

export default config
