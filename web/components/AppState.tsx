'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { getAddress, toHex, type Address } from 'viem'
import { loadChainState, type OrderView, type Rejection } from '@/lib/chain'
import { deployment } from '@/lib/deployment'
import { executeBody, jwtSigningInput, jwtWithSignature } from '@/lib/rpc'
import { applyLine, finishRun, idleRun, startRun, streamLines, type Run } from '@/lib/run'

interface Eip1193 {
	request(args: { method: string; params?: unknown[] }): Promise<any>
	on?(event: string, fn: (...args: any[]) => void): void
	removeListener?(event: string, fn: (...args: any[]) => void): void
}
const ethereum = () => (typeof window === 'undefined' ? undefined : (window as unknown as { ethereum?: Eip1193 }).ethereum)

export interface VerifyForm {
	court: string
	docketNumber: string
	entryNumber: string
	filedDate: string
	wallets: string
	sha1: string
	fileName: string
}

const defaultForm: VerifyForm = { court: 'cand', docketNumber: '5:26-cv-05055', entryNumber: '18', filedDate: '', wallets: '', sha1: '', fileName: '' }

interface ChainView {
	orders: OrderView[]
	rejections: Rejection[]
	loaded: boolean
	error?: string
}

interface ServerStatus {
	serverSigning: boolean
	logs: 'api' | 'cli' | 'none'
}

interface AppState {
	account: Address | null
	authorized: boolean
	connect(): Promise<void>
	disconnect(): void
	server?: ServerStatus
	chain: ChainView
	refresh(): Promise<void>
	form: VerifyForm
	setForm: Dispatch<SetStateAction<VerifyForm>>
	verify: Run
	sweep: Run
	startVerify(): Promise<void>
	startSweep(): Promise<void>
}

const Ctx = createContext<AppState | null>(null)

export function useApp(): AppState {
	const ctx = useContext(Ctx)
	if (!ctx) throw new Error('useApp outside AppProvider')
	return ctx
}

/** Ticks every `ms` after mount; null during server render so times never mismatch on hydration. */
export function useNow(ms = 1000): number | null {
	const [now, setNow] = useState<number | null>(null)
	useEffect(() => {
		setNow(Date.now())
		const t = setInterval(() => setNow(Date.now()), ms)
		return () => clearInterval(t)
	}, [ms])
	return now
}

export function AppProvider({ children }: { children: ReactNode }) {
	const [account, setAccount] = useState<Address | null>(null)
	const [server, setServer] = useState<ServerStatus>()
	const [chain, setChain] = useState<ChainView>({ orders: [], rejections: [], loaded: false })
	const [form, setForm] = useState<VerifyForm>(defaultForm)
	const [verify, setVerify] = useState<Run>(idleRun)
	const [sweep, setSweep] = useState<Run>(idleRun)
	const refreshing = useRef<Promise<void> | null>(null)

	const refresh = useCallback(() => {
		refreshing.current ??= loadChainState()
			.then(({ orders, rejections }) => setChain({ orders, rejections, loaded: true }))
			.catch((e) => setChain((c) => ({ ...c, loaded: true, error: e?.shortMessage ?? e?.message ?? String(e) })))
			.finally(() => (refreshing.current = null))
		return refreshing.current
	}, [])

	useEffect(() => {
		refresh()
		fetch('/api/status')
			.then((r) => r.json())
			.then(setServer)
			.catch(() => undefined)
	}, [refresh])

	useEffect(() => {
		const eth = ethereum()
		const onAccounts = (accounts: string[]) => setAccount((cur) => (cur && accounts[0] ? getAddress(accounts[0]) : null))
		eth?.on?.('accountsChanged', onAccounts)
		return () => eth?.removeListener?.('accountsChanged', onAccounts)
	}, [])

	const connect = useCallback(async () => {
		const eth = ethereum()
		if (!eth) {
			alert('No browser wallet found. Install MetaMask, or stay disconnected to sign with the server key.')
			return
		}
		try {
			const [a] = await eth.request({ method: 'eth_requestAccounts' })
			setAccount(a ? getAddress(a) : null)
		} catch (err) {
			alert((err as Error).message ?? err)
		}
	}, [])

	/** Builds the gateway request here and has the connected wallet sign it (EIP-191). */
	const walletSigned = useCallback(
		async (input: unknown) => {
			if (!account) throw new Error('no wallet connected')
			const body = executeBody(deployment.workflowId, input)
			const message = await jwtSigningInput(body, account)
			const signature = await ethereum()!.request({ method: 'personal_sign', params: [toHex(message), account] })
			return { body, jwt: jwtWithSignature(message, signature) }
		},
		[account],
	)

	const run = useCallback(
		async (set: Dispatch<SetStateAction<Run>>, input: unknown, serverUrl: string, missing: string, note: string) => {
			set(startRun(account ? 'Sign the request in your wallet…' : note))
			try {
				const [url, body] = account ? ['/api/execute', await walletSigned(input)] : [serverUrl, serverUrl === '/api/sweep' ? undefined : input]
				set((r) => ({ ...r, note }))
				await streamLines(url, body, (line) => set((r) => applyLine(r, line)))
			} catch (err) {
				set((r) => ({ ...r, result: { decision: 'ERROR', error: (err as Error).message ?? String(err) } }))
			} finally {
				set((r) => finishRun(r, missing))
				refresh()
			}
		},
		[account, walletSigned, refresh],
	)

	const startVerify = useCallback(async () => {
		const submission = {
			court: form.court.trim().toLowerCase(),
			docketNumber: form.docketNumber.trim(),
			entryNumber: Number(form.entryNumber),
			documentSha1: form.sha1,
			wallets: form.wallets.split(/\s+/).map((w) => w.trim()).filter(Boolean),
			...(form.filedDate ? { filedDate: form.filedDate } : {}),
		}
		await run(setVerify, submission, '/api/verify', 'The run ended without a result; see the raw log.', 'Ten Chainlink nodes are checking the order against the federal docket and reading it with Gemini. This takes about a minute.')
	}, [form, run])

	const startSweep = useCallback(
		() => run(setSweep, { action: 'sweep' }, '/api/sweep', 'The sweep ended without a result; see the raw log.', 'The nodes are re-reading the docket of every active order.'),
		[run],
	)

	const value: AppState = {
		account,
		authorized: Boolean(account && account.toLowerCase() === deployment.httpAuthorizedKey.toLowerCase()),
		connect,
		disconnect: () => setAccount(null),
		server,
		chain,
		refresh,
		form,
		setForm,
		verify,
		sweep,
		startVerify,
		startSweep,
	}
	return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
