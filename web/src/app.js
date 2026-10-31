import { createPublicClient, formatUnits, getAddress, http, parseAbi, parseAbiItem, toHex } from 'viem'
import { sepolia } from 'viem/chains'
import { executeBody, jwtSigningInput, jwtWithSignature } from './rpc'

const RPC = 'https://ethereum-sepolia-rpc.publicnode.com'
const ETHERSCAN = 'https://sepolia.etherscan.io'
const SWEEP_EVERY_HOURS = 6 // sweepSchedule "0 0 */6 * * *" in workflows/writ/config.staging.json
const STATUS = ['None', 'Active', 'Rejected', 'Dissolved', 'Expired', 'Superseded']
const TYPES = ['Other', 'TRO', 'Preliminary injunction', 'Asset freeze', 'Judgment']
const REASONS = [
	[1, 'docket not found'], [2, 'entry not found'], [4, 'not a court order'], [8, 'PDF hash does not match the court copy'],
	[16, 'wallet not named in the order'], [32, 'order names no wallets'], [64, 'filing date mismatch'], [128, 'order already expired'],
]
const KIND_LABELS = { chain: 'Chain read', gemini: 'Gemini', legal: 'Rule 65', identity: 'Identity', report: 'Signed report', sweep: 'Sweep' }

const PRESET_WALLETS = [
	'0xf7Fcc767dE537953b3519D4b3097a24A6dFE1c84',
	'0x898137400867603E6D713CBD40881dd0c79E47cB',
	'0xf02d9f19060eE2dd50047dC6E1E9eBAC9bA436FE',
	'0x784Cf4b62655486B405Eb76731885CC9ed56f42f',
	'0xe497285e466227F4E8648209E34B465dAA1F90a0',
	'0x9030D5C596d636eEFC8f0ad7b2788AE7E9ef3D46',
]
const ATTACKER = '0x4c1f0B2d9e8a7f6C3B5a49d8e7f60a1B2C3D4e5f'

const registryAbi = parseAbi([
	'struct Order { string docketRef; uint32 entryNumber; bytes20 docSha1; uint8 orderType; uint8 status; bool exParte; uint64 issuedAt; uint64 expiresAt; uint32 lastCheckedEntry; uint32 evidenceEntry; bytes20 evidenceSha1; address[] wallets; }',
	'function getOrder(bytes32 id) view returns (Order)',
	'function getOrderIds() view returns (bytes32[])',
	'function isFrozen(address wallet) view returns (bool)',
	'function isInForce(bytes32 id) view returns (bool)',
])
const tokenAbi = parseAbi([
	'function balanceOf(address) view returns (uint256)',
	'function transfer(address to, uint256 amount) returns (bool)',
	'error WalletFrozen(address wallet)',
	'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
])
const rejectedEvent = parseAbiItem('event OrderRejected(bytes32 indexed submissionId, string docketRef, uint32 entryNumber, bytes20 submittedSha1, uint32 reasons)')

const client = createPublicClient({ chain: sepolia, transport: http(RPC) })
const cfg = await (await fetch('/api/config')).json()
const $ = (id) => document.getElementById(id)
const short = (a) => `${a.slice(0, 8)}…${a.slice(-6)}`
const addrLink = (a) => `<a class="mono" href="${ETHERSCAN}/address/${a}" target="_blank" rel="noreferrer">${short(a)}</a>`
const txLink = (h) => `<a class="mono" href="${ETHERSCAN}/tx/${h}" target="_blank" rel="noreferrer">${short(h)}</a>`
const day = (t) => new Date(Number(t) * 1000).toISOString().slice(0, 10)
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const reasonList = (bits) => REASONS.filter(([b]) => bits & b).map(([, l]) => l)

$('contracts').innerHTML = `Contracts: OrderRegistry ${addrLink(cfg.orderRegistry)} · Writ USD ${addrLink(cfg.writToken)} · CRE forwarder ${addrLink(cfg.forwarder)}${cfg.workflowId ? ` · CRE workflow <code>${esc(cfg.workflowName)}</code> <code>${cfg.workflowId.slice(0, 10)}…</code>` : ''}`

// ---------------------------------------------------------------- pages

const PAGES = ['overview', 'verify', 'orders', 'sweep']

function route() {
	const want = location.hash.replace(/^#\/?/, '')
	const page = PAGES.includes(want) ? want : 'overview'
	document.querySelectorAll('[data-page]').forEach((s) => (s.hidden = s.dataset.page !== page))
	document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.nav === page))
	if (page === 'orders') refresh()
	window.scrollTo({ top: 0 })
}
addEventListener('hashchange', route)

function nextSweep() {
	const step = SWEEP_EVERY_HOURS * 3600_000
	const next = new Date(Math.ceil((Date.now() + 1) / step) * step)
	const mins = Math.round((next - Date.now()) / 60_000)
	const time = next.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
	return `${time} (in ${mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`})`
}
function renderSchedule() {
	$('stat-cron').textContent = nextSweep()
	$('sweep-next').textContent = nextSweep()
}
setInterval(renderSchedule, 30_000)

// ---------------------------------------------------------------- issuer wallet

let account = null

function renderWallet() {
	const btn = $('connect-btn')
	if (!cfg.workflowId) {
		btn.hidden = true
		return
	}
	if (!account) {
		btn.textContent = 'Connect wallet'
		$('signer').textContent = 'Signer: server key'
		return
	}
	const ok = account.toLowerCase() === cfg.httpAuthorizedKey?.toLowerCase()
	btn.textContent = 'Disconnect'
	$('signer').innerHTML = `Signer ${addrLink(account)}<span class="${ok ? 'ok-text' : 'bad-text'}">${ok ? '✓ authorized issuer key' : '✕ not authorized: CRE will refuse'}</span>`
}

$('connect-btn').addEventListener('click', async () => {
	if (account) {
		account = null
		return renderWallet()
	}
	if (!window.ethereum) return alert('No browser wallet found. Install MetaMask, or stay disconnected to sign with the server key.')
	try {
		const [a] = await window.ethereum.request({ method: 'eth_requestAccounts' })
		account = a ? getAddress(a) : null
	} catch (err) {
		alert(err.message ?? err)
	}
	renderWallet()
})

window.ethereum?.on?.('accountsChanged', (accounts) => {
	if (!account) return
	account = accounts[0] ? getAddress(accounts[0]) : null
	renderWallet()
})

/** Builds the gateway request in the browser and has the connected wallet sign it (EIP-191). */
async function walletSigned(input) {
	const body = executeBody(cfg.workflowId, input)
	const message = await jwtSigningInput(body, account)
	const signature = await window.ethereum.request({ method: 'personal_sign', params: [toHex(message), account] })
	return { body, jwt: jwtWithSignature(message, signature) }
}

// ---------------------------------------------------------------- run progress

/** Drives a 4-step progress list (sign → gateway → DON → chain) with an elapsed timer. */
function stepper(el) {
	const items = Object.fromEntries([...el.querySelectorAll('li')].map((li) => [li.dataset.step, li]))
	const order = ['sign', 'gateway', 'don', 'chain']
	let timer
	const set = (step, state) => {
		const li = items[step]
		li.classList.remove('active', 'done', 'fail')
		if (state) li.classList.add(state)
	}
	return {
		reset() {
			clearInterval(timer)
			order.forEach((s) => set(s))
			el.querySelectorAll('.elapsed').forEach((e) => e.remove())
		},
		start(step) {
			const i = order.indexOf(step)
			order.forEach((s, j) => j < i && !items[s].classList.contains('done') && set(s, 'done'))
			set(step, 'active')
			if (step === 'don') {
				const t0 = Date.now()
				const span = document.createElement('span')
				span.className = 'elapsed'
				items.don.appendChild(span)
				clearInterval(timer)
				timer = setInterval(() => {
					const s = Math.floor((Date.now() - t0) / 1000)
					span.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
				}, 500)
			}
		},
		done(step) {
			if (step === 'don') clearInterval(timer)
			set(step, 'done')
		},
		fail() {
			clearInterval(timer)
			const current = order.find((s) => items[s].classList.contains('active')) ?? 'sign'
			set(current, 'fail')
		},
		finish() {
			clearInterval(timer)
			order.forEach((s) => set(s, 'done'))
		},
	}
}
const verifySteps = stepper($('verify-steps'))
const sweepSteps = stepper($('sweep-steps'))

// ---------------------------------------------------------------- submission

const form = $('form')
let sha1 = ''

async function hashFile(blob) {
	const digest = await crypto.subtle.digest('SHA-1', await blob.arrayBuffer())
	sha1 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
	$('sha').innerHTML = `SHA-1 computed in your browser: <code>${sha1}</code>`
}

form.pdf.addEventListener('change', () => form.pdf.files[0] && hashFile(form.pdf.files[0]))

document.querySelectorAll('[data-preset]').forEach((btn) =>
	btn.addEventListener('click', async () => {
		const forged = btn.dataset.preset === 'forged'
		const pdf = await (await fetch(`/fixtures/ecf-18-${forged ? 'forged' : 'genuine'}.pdf`)).blob()
		const dt = new DataTransfer()
		dt.items.add(new File([pdf], `ecf-18-${forged ? 'forged' : 'genuine'}.pdf`, { type: 'application/pdf' }))
		form.pdf.files = dt.files
		await hashFile(pdf)
		form.court.value = 'cand'
		form.docketNumber.value = '5:26-cv-05055'
		form.entryNumber.value = '18'
		form.filedDate.value = '2026-06-05'
		const wallets = [...PRESET_WALLETS]
		if (forged) wallets[4] = ATTACKER
		form.wallets.value = wallets.join('\n')
	}),
)

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '')

/** Streams a CRE run, advancing the stepper and turning USER LOG lines into a checklist. */
async function runWorkflow(url, body, { log, checks, steps, onResult }) {
	log.textContent = ''
	checks.innerHTML = ''
	const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
	if (!res.ok) throw new Error(await res.text())
	const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
	let buf = ''
	let nextIsResult = false
	for (;;) {
		const { value, done } = await reader.read()
		if (done) break
		buf += value
		const lines = buf.split(/\r?\n/)
		buf = lines.pop()
		for (const raw of lines) {
			const line = stripAnsi(raw)
			log.textContent += line + '\n'
			log.scrollTop = log.scrollHeight
			if (/CRE gateway ACCEPTED/.test(line)) steps.start('don')
			else if (/^\[writ\] (signing|workflows\.execute)/.test(line)) steps.start('gateway')
			else if (/DON execution status: SUCCESS|finished: SUCCESS|\d+ DON node\(s\) ran/.test(line)) steps.start('chain')
			else if (/Workflow Simulation Result/.test(line)) steps.start('chain')
			if (nextIsResult && line.trim()) {
				nextIsResult = false
				try { onResult(JSON.parse(JSON.parse(line.trim()))) } catch { /* not JSON */ }
			}
			if (line.includes('Workflow Simulation Result')) nextIsResult = true
			if (line.startsWith('[writ] result ')) onResult(JSON.parse(line.slice('[writ] result '.length)))
			if (/workflow execution failed/i.test(line)) onResult({ decision: 'ERROR', error: line.replace(/^.*workflow execution failed:\s*/i, '') })
			const m = /\[USER LOG\] \[(check|gemini|legal|sweep|chain|identity|report)\] (?:(PASS|FAIL) )?(.+?)(?:: (.*))?$/.exec(line)
			if (m) {
				const [, kind, verdict, name, detail] = m
				if (kind === 'report') steps.start('chain')
				const li = document.createElement('li')
				li.className = verdict ? verdict.toLowerCase() : 'info'
				const badge = kind === 'check' ? '' : `<span class="kind ${kind}">${KIND_LABELS[kind]}</span>`
				li.innerHTML = `<span class="icon">${verdict === 'PASS' ? '✓' : verdict === 'FAIL' ? '✕' : '•'}</span><div>${badge}${esc(name)}${detail ? `<small>${esc(detail)}</small>` : ''}</div>`
				checks.appendChild(li)
			}
		}
	}
}

function setBusy(nav, busy) {
	document.querySelector(`.tabs a[data-nav="${nav}"]`)?.classList.toggle('busy', busy)
}

form.addEventListener('submit', async (e) => {
	e.preventDefault()
	if (!sha1) return alert('Choose the order PDF first (or load the demo case).')
	const result = $('result')
	const btn = $('verify-btn')
	btn.disabled = true
	btn.textContent = 'Verifying…'
	setBusy('verify', true)
	verifySteps.reset()
	verifySteps.start('sign')
	result.className = 'result run'
	const submission = {
		court: form.court.value.trim().toLowerCase(),
		docketNumber: form.docketNumber.value.trim(),
		entryNumber: Number(form.entryNumber.value),
		documentSha1: sha1,
		wallets: form.wallets.value.split(/\s+/).map((w) => w.trim()).filter(Boolean),
		...(form.filedDate.value ? { filedDate: form.filedDate.value } : {}),
	}
	let outcome
	try {
		let url = '/api/verify'
		let body = submission
		if (account) {
			result.textContent = 'Sign the request in your wallet…'
			url = '/api/execute'
			body = await walletSigned(submission)
		}
		result.textContent = 'Ten Chainlink nodes are checking the order against the federal docket and reading it with Gemini. This takes about a minute.'
		await runWorkflow(url, body, {
			log: $('log'),
			checks: $('checks'),
			steps: verifySteps,
			onResult: (r) => (outcome = r),
		})
	} catch (err) {
		outcome = { decision: 'ERROR', error: String(err.message ?? err) }
	} finally {
		btn.disabled = false
		btn.textContent = 'Verify with Chainlink CRE'
		setBusy('verify', false)
		showVerifyResult(outcome ?? { decision: 'ERROR', error: 'The run ended without a result; see the raw log.' })
		refresh()
	}
})

function showVerifyResult(r) {
	const result = $('result')
	const cta = '<a class="cta" href="#/orders">View on-chain orders →</a>'
	if (r.decision === 'VERIFIED') {
		verifySteps.finish()
		result.className = 'result ok'
		result.innerHTML = `✓ Verified: ${r.wallets.length} wallet(s) frozen ${r.expiresAt ? `until ${day(r.expiresAt)}` : 'until further order of the court'}. Tx ${txLink(r.txHash)}<br>${cta}`
	} else if (r.decision === 'REJECTED') {
		verifySteps.finish()
		result.className = 'result bad'
		result.innerHTML = `✕ Rejected: ${(r.labels && !r.reasons ? r.labels : reasonList(r.reasons)).join('; ')}. The rejection is recorded on-chain: tx ${txLink(r.txHash)}<br>${cta}`
	} else if (r.decision === 'ALREADY_RECORDED') {
		verifySteps.finish()
		result.className = 'result ok'
		result.innerHTML = `This order is already on-chain with status ${esc(r.status)}.<br>${cta}`
	} else {
		verifySteps.fail()
		result.className = 'result bad'
		result.textContent = `✕ ${r.error ?? 'Workflow failed; see the raw log.'}`
	}
}

// ---------------------------------------------------------------- on-chain state

async function tryTransfer(from) {
	try {
		await client.simulateContract({ address: cfg.writToken, abi: tokenAbi, functionName: 'transfer', args: [cfg.deployer, 1_000_000n], account: from })
		return { ok: true, text: '✓ transfer would succeed' }
	} catch (e) {
		const name = e?.cause?.data?.errorName ?? e?.walk?.((x) => x?.data?.errorName)?.data?.errorName
		if (name === 'WalletFrozen') return { ok: false, text: '✕ blocked: WalletFrozen (court order in force)' }
		if (name === 'ERC20InsufficientBalance') return { ok: true, text: 'not frozen (no wUSD balance to move)' }
		return { ok: false, text: e.shortMessage ?? String(e) }
	}
}

async function loadOrder(id) {
	const [o, inForce] = await Promise.all([
		client.readContract({ address: cfg.orderRegistry, abi: registryAbi, functionName: 'getOrder', args: [id] }),
		client.readContract({ address: cfg.orderRegistry, abi: registryAbi, functionName: 'isInForce', args: [id] }),
	])
	const wallets = await Promise.all(
		o.wallets.map(async (w) => {
			const [frozen, bal] = await Promise.all([
				client.readContract({ address: cfg.orderRegistry, abi: registryAbi, functionName: 'isFrozen', args: [w] }),
				client.readContract({ address: cfg.writToken, abi: tokenAbi, functionName: 'balanceOf', args: [w] }),
			])
			return { w, frozen, bal }
		}),
	)
	return { id, o, inForce, wallets }
}

function orderCard({ id, o, inForce, wallets }) {
	const [court, docket] = o.docketRef.split('|')
	const now = Date.now() / 1000
	const expiry = o.expiresAt === 0n
		? 'Until further order'
		: Number(o.expiresAt) > now
			? `${day(o.expiresAt)} (${Math.ceil((Number(o.expiresAt) - now) / 86400)} days left)`
			: `${day(o.expiresAt)} (lapsed)`
	const status = STATUS[o.status]
	const frozenCount = wallets.filter((x) => x.frozen).length
	const rows = wallets
		.map(({ w, frozen, bal }) => `<tr><td>${addrLink(w)}</td><td>${Number(formatUnits(bal, 6)).toLocaleString()} wUSD</td>
			<td><span class="chip ${frozen ? 'frozen' : 'free'}">${frozen ? 'FROZEN' : 'FREE'}</span></td>
			<td><button type="button" data-try="${w}">Try transfer</button><span class="try-out" data-out="${w}"></span></td></tr>`)
		.join('')
	return `<div class="order ${status}">
		<div class="order-head">
			<div><strong>${esc(court.toUpperCase())} ${esc(docket)} · ECF ${o.entryNumber}</strong>
				<div class="order-sub">${TYPES[o.orderType]} · ${frozenCount} of ${wallets.length} wallets frozen</div></div>
			<span class="pill ${status}">${status}${status === 'Active' && !inForce ? ' (lapsed)' : ''}</span>
		</div>
		<div class="facts">
			<div class="fact"><span>Notice</span><b>${o.exParte ? 'Ex parte (14-day cap)' : 'With notice / consent'}</b></div>
			<div class="fact"><span>Entered</span><b>${day(o.issuedAt)}</b></div>
			<div class="fact"><span>Freeze ends</span><b>${expiry}</b></div>
			<div class="fact"><span>Docket checked through</span><b>ECF ${o.lastCheckedEntry}</b></div>
			<div class="fact"><span>Evidence</span><b>${o.evidenceEntry ? `ECF ${o.evidenceEntry}` : '—'}</b></div>
			<div class="fact"><span>Order id</span><b class="mono">${short(id)}</b></div>
		</div>
		<div class="hashes"><span>Court PDF SHA-1 <code>${o.docSha1.slice(2)}</code></span></div>
		<table><tr><th>Wallet</th><th>Balance</th><th>Status</th><th></th></tr>${rows}</table>
	</div>`
}

function rejectionsHtml(logs) {
	if (!logs.length) return '<span class="muted">None yet.</span>'
	return [...logs]
		.reverse()
		.map(({ args, transactionHash }) => {
			const [court, docket] = args.docketRef.split('|')
			return `<div class="reject"><b>${esc(court.toUpperCase())} ${esc(docket)} · ECF ${args.entryNumber}</b>
				<div class="reasons">${reasonList(args.reasons).map((r) => `<span>${esc(r)}</span>`).join('')}</div>
				<div class="muted">submitted SHA-1 <code>${args.submittedSha1.slice(2, 14)}…</code> · tx ${txLink(transactionHash)}</div></div>`
		})
		.join('')
}

let refreshing
async function refresh() {
	if (refreshing) return refreshing
	refreshing = (async () => {
		if (!$('orders').children.length) $('orders').innerHTML = '<div class="card empty-state">Loading from Sepolia…</div>'
		try {
			const [ids, logs] = await Promise.all([
				client.readContract({ address: cfg.orderRegistry, abi: registryAbi, functionName: 'getOrderIds' }),
				client.getLogs({ address: cfg.orderRegistry, event: rejectedEvent, fromBlock: BigInt(cfg.fromBlock), toBlock: 'latest' }),
			])
			const orders = await Promise.all([...ids].reverse().map(loadOrder))
			$('orders').innerHTML = orders.length
				? orders.map(orderCard).join('')
				: '<div class="card empty-state"><b>No verified orders yet</b>Verify the genuine ECF 18 to see its wallets frozen here.<br><br><a class="btn btn-primary" href="#/verify">Verify an order</a></div>'
			$('rejections').innerHTML = rejectionsHtml(logs)
			$('stat-active').textContent = orders.filter((x) => STATUS[x.o.status] === 'Active' && x.inForce).length
			$('stat-frozen').textContent = orders.reduce((n, x) => n + x.wallets.filter((w) => w.frozen).length, 0)
			$('stat-rejected').textContent = logs.length
		} catch (e) {
			$('orders').innerHTML = `<div class="card empty-state">Could not read Sepolia: ${esc(e.shortMessage ?? e.message)}</div>`
		} finally {
			refreshing = undefined
		}
	})()
	return refreshing
}

document.addEventListener('click', async (e) => {
	const w = e.target?.dataset?.try
	if (!w) return
	const out = document.querySelector(`[data-out="${w}"]`)
	out.textContent = '…'
	const r = await tryTransfer(w)
	out.textContent = r.text
	out.className = `try-out ${r.ok ? 'free' : 'frozen'}`
})

$('probe-btn').addEventListener('click', async () => {
	const w = $('probe').value.trim()
	if (!/^0x[0-9a-fA-F]{40}$/.test(w)) return ($('probe-out').textContent = 'Enter a 0x address.')
	$('probe-out').textContent = '…'
	const frozen = await client.readContract({ address: cfg.orderRegistry, abi: registryAbi, functionName: 'isFrozen', args: [w] })
	const r = await tryTransfer(w)
	$('probe-out').innerHTML = `<span class="chip ${frozen ? 'frozen' : 'free'}">${frozen ? 'FROZEN' : 'NOT FROZEN'}</span> ${esc(r.text)}`
})

$('refresh').addEventListener('click', refresh)

// ---------------------------------------------------------------- sweep

$('sweep-btn').addEventListener('click', async () => {
	const btn = $('sweep-btn')
	btn.disabled = true
	btn.textContent = 'Sweeping…'
	setBusy('sweep', true)
	sweepSteps.reset()
	sweepSteps.start('sign')
	let failed = false
	try {
		const opts = {
			log: $('sweep-log'),
			checks: $('sweep-checks'),
			steps: sweepSteps,
			onResult: (r) => (failed = r.decision === 'ERROR'),
		}
		if (account) await runWorkflow('/api/execute', await walletSigned({ action: 'sweep' }), opts)
		else await runWorkflow('/api/sweep', null, opts)
	} catch (err) {
		failed = true
		$('sweep-log').textContent += String(err.message ?? err)
		$('sweep-checks').innerHTML = `<li class="fail"><span class="icon">✕</span><div>${esc(err.message ?? err)}</div></li>`
	} finally {
		if (failed) sweepSteps.fail()
		else sweepSteps.finish()
		btn.disabled = false
		btn.textContent = 'Run sweep now'
		setBusy('sweep', false)
		refresh()
	}
})

renderWallet()
renderSchedule()
route()
refresh()
