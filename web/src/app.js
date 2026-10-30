import { createPublicClient, formatUnits, http, parseAbi, parseAbiItem } from 'viem'
import { sepolia } from 'viem/chains'

const RPC = 'https://ethereum-sepolia-rpc.publicnode.com'
const ETHERSCAN = 'https://sepolia.etherscan.io'
const STATUS = ['None', 'Active', 'Rejected', 'Dissolved', 'Expired', 'Superseded']
const TYPES = ['Other', 'TRO', 'Preliminary injunction', 'Asset freeze', 'Judgment']
const REASONS = [
	[1, 'docket not found'], [2, 'entry not found'], [4, 'not a court order'], [8, 'PDF hash does not match the court copy'],
	[16, 'wallet not named in the order'], [32, 'order names no wallets'], [64, 'filing date mismatch'], [128, 'order already expired'],
]

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

$('contracts').innerHTML = `OrderRegistry ${addrLink(cfg.orderRegistry)} · Writ USD ${addrLink(cfg.writToken)} · CRE forwarder ${addrLink(cfg.forwarder)}`

// ---------------------------------------------------------------- submission

const form = $('form')
let sha1 = ''

async function hashFile(blob) {
	const digest = await crypto.subtle.digest('SHA-1', await blob.arrayBuffer())
	sha1 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
	$('sha').innerHTML = `SHA-1: <code>${sha1}</code>`
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

/** Streams a CRE run and turns its USER LOG lines into a checklist. */
async function runWorkflow(url, body, { log, checks, onResult }) {
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
			if (nextIsResult && line.trim()) {
				nextIsResult = false
				try { onResult(JSON.parse(JSON.parse(line.trim()))) } catch { /* not JSON */ }
			}
			if (line.includes('Workflow Simulation Result')) nextIsResult = true
			if (/workflow execution failed/i.test(line)) onResult({ decision: 'ERROR', error: line })
			const m = /\[USER LOG\] \[(check|gemini|legal|sweep)\] (?:(PASS|FAIL) )?([^:]+?)(?:: (.*))?$/.exec(line)
			if (m) {
				const [, kind, verdict, name, detail] = m
				const li = document.createElement('li')
				li.className = verdict ? verdict.toLowerCase() : 'info'
				li.innerHTML = `<span class="icon">${verdict === 'PASS' ? '✓' : verdict === 'FAIL' ? '✗' : '›'}</span><div>${kind === 'check' ? esc(name) : `<b>${kind}</b> ${esc(name)}`}${detail ? `<small>${esc(detail)}</small>` : ''}</div>`
				checks.appendChild(li)
			}
		}
	}
}

form.addEventListener('submit', async (e) => {
	e.preventDefault()
	if (!sha1) return alert('Choose the order PDF first (or load a preset).')
	const result = $('result')
	const btn = $('verify-btn')
	btn.disabled = true
	result.className = 'result run'
	result.textContent = 'Running the CRE workflow: CourtListener → Gemini → signed report → Sepolia…'
	const body = {
		court: form.court.value.trim(),
		docketNumber: form.docketNumber.value.trim(),
		entryNumber: Number(form.entryNumber.value),
		documentSha1: sha1,
		filedDate: form.filedDate.value || undefined,
		wallets: form.wallets.value.split(/\s+/).map((w) => w.trim()).filter(Boolean),
	}
	try {
		await runWorkflow('/api/verify', body, {
			log: $('log'),
			checks: $('checks'),
			onResult: (r) => {
				if (r.decision === 'VERIFIED') {
					result.className = 'result ok'
					result.innerHTML = `Verified: ${r.wallets.length} wallet(s) frozen ${r.expiresAt ? `until ${day(r.expiresAt)}` : 'until further order of the court'} · tx ${txLink(r.txHash)}`
				} else if (r.decision === 'REJECTED') {
					result.className = 'result bad'
					result.innerHTML = `Rejected: ${REASONS.filter(([b]) => r.reasons & b).map(([, l]) => l).join('; ')} · tx ${txLink(r.txHash)}`
				} else if (r.decision === 'ALREADY_RECORDED') {
					result.className = 'result ok'
					result.textContent = `Already on-chain with status ${r.status}.`
				} else {
					result.className = 'result bad'
					result.textContent = r.error ?? 'Workflow failed; see the log.'
				}
			},
		})
	} catch (err) {
		result.className = 'result bad'
		result.textContent = String(err.message ?? err)
	} finally {
		btn.disabled = false
		refresh()
	}
})

// ---------------------------------------------------------------- on-chain state

async function tryTransfer(from) {
	try {
		await client.simulateContract({ address: cfg.writToken, abi: tokenAbi, functionName: 'transfer', args: [cfg.deployer, 1_000_000n], account: from })
		return { ok: true, text: 'transfer would succeed' }
	} catch (e) {
		const name = e?.cause?.data?.errorName ?? e?.walk?.((x) => x?.data?.errorName)?.data?.errorName
		if (name === 'WalletFrozen') return { ok: false, text: 'blocked: WalletFrozen (court order in force)' }
		if (name === 'ERC20InsufficientBalance') return { ok: true, text: 'not frozen (no wUSD balance to move)' }
		return { ok: false, text: e.shortMessage ?? String(e) }
	}
}

async function renderOrder(id) {
	const [o, inForce] = await Promise.all([
		client.readContract({ address: cfg.orderRegistry, abi: registryAbi, functionName: 'getOrder', args: [id] }),
		client.readContract({ address: cfg.orderRegistry, abi: registryAbi, functionName: 'isInForce', args: [id] }),
	])
	const [court, docket] = o.docketRef.split('|')
	const now = Date.now() / 1000
	const expiry = o.expiresAt === 0n
		? 'until further order'
		: Number(o.expiresAt) > now
			? `${day(o.expiresAt)} (${Math.ceil((Number(o.expiresAt) - now) / 86400)} days left)`
			: `${day(o.expiresAt)} (lapsed)`
	const rows = await Promise.all(
		o.wallets.map(async (w) => {
			const [frozen, bal] = await Promise.all([
				client.readContract({ address: cfg.orderRegistry, abi: registryAbi, functionName: 'isFrozen', args: [w] }),
				client.readContract({ address: cfg.writToken, abi: tokenAbi, functionName: 'balanceOf', args: [w] }),
			])
			return `<tr><td>${addrLink(w)}</td><td>${Number(formatUnits(bal, 6)).toLocaleString()} wUSD</td>
				<td class="${frozen ? 'frozen' : 'free'}">${frozen ? 'FROZEN' : 'free'}</td>
				<td><button type="button" data-try="${w}">Try transfer</button> <span class="muted" data-out="${w}"></span></td></tr>`
		}),
	)
	const status = STATUS[o.status]
	const evidence = o.evidenceEntry ? `<span>Evidence <b>ECF ${o.evidenceEntry}</b></span>` : ''
	return `<div class="order">
		<div class="order-head"><strong>${esc(court.toUpperCase())} ${esc(docket)} · ECF ${o.entryNumber}</strong>
			<span class="pill ${status}">${status}${status === 'Active' && !inForce ? ' (lapsed)' : ''}</span></div>
		<div class="facts">
			<span>${TYPES[o.orderType]}</span>
			<span>${o.exParte ? 'Ex parte: 14-day cap applies' : 'Entered with notice / consent'}</span>
			<span>Entered <b>${day(o.issuedAt)}</b></span>
			<span>Freeze ends <b>${expiry}</b></span>
			<span>Docket checked through <b>ECF ${o.lastCheckedEntry}</b></span>
			${evidence}
		</div>
		<div class="facts"><span>Court PDF SHA-1 <code>${o.docSha1.slice(2)}</code></span><span>Order id <code>${short(id)}</code></span></div>
		<table><tr><th>Wallet</th><th>Balance</th><th>Status</th><th></th></tr>${rows.join('')}</table>
	</div>`
}

async function renderRejections() {
	const logs = await client.getLogs({ address: cfg.orderRegistry, event: rejectedEvent, fromBlock: BigInt(cfg.fromBlock), toBlock: 'latest' })
	if (!logs.length) return '<span class="muted">None yet.</span>'
	return logs
		.reverse()
		.map(({ args, transactionHash }) => {
			const why = REASONS.filter(([b]) => args.reasons & b).map(([, l]) => l).join('; ')
			const [court, docket] = args.docketRef.split('|')
			return `<div class="reject"><b>${esc(court.toUpperCase())} ${esc(docket)} · ECF ${args.entryNumber}</b>: ${esc(why)}
				<div class="muted">submitted SHA-1 <code>${args.submittedSha1.slice(2)}</code> · tx ${txLink(transactionHash)}</div></div>`
		})
		.join('')
}

async function refresh() {
	$('orders').innerHTML = '<p class="muted">Loading…</p>'
	try {
		const ids = await client.readContract({ address: cfg.orderRegistry, abi: registryAbi, functionName: 'getOrderIds' })
		$('orders').innerHTML = ids.length ? (await Promise.all([...ids].reverse().map(renderOrder))).join('') : '<p class="muted">No verified orders yet.</p>'
		$('rejections').innerHTML = await renderRejections()
	} catch (e) {
		$('orders').innerHTML = `<p class="muted">Could not read Sepolia: ${esc(e.shortMessage ?? e.message)}</p>`
	}
}

document.addEventListener('click', async (e) => {
	const w = e.target?.dataset?.try
	if (!w) return
	const out = document.querySelector(`[data-out="${w}"]`)
	out.textContent = '…'
	const r = await tryTransfer(w)
	out.textContent = r.text
	out.className = r.ok ? 'free' : 'frozen'
})

$('probe-btn').addEventListener('click', async () => {
	const w = $('probe').value.trim()
	if (!/^0x[0-9a-fA-F]{40}$/.test(w)) return ($('probe-out').textContent = 'Enter a 0x address.')
	$('probe-out').textContent = '…'
	const frozen = await client.readContract({ address: cfg.orderRegistry, abi: registryAbi, functionName: 'isFrozen', args: [w] })
	const r = await tryTransfer(w)
	$('probe-out').innerHTML = `<span class="${frozen ? 'frozen' : 'free'}">${frozen ? 'FROZEN' : 'not frozen'}</span> · ${esc(r.text)}`
})

$('refresh').addEventListener('click', refresh)

$('sweep-btn').addEventListener('click', async () => {
	const btn = $('sweep-btn')
	btn.disabled = true
	try {
		await runWorkflow('/api/sweep', null, { log: $('sweep-log'), checks: $('sweep-checks'), onResult: () => {} })
	} catch (err) {
		$('sweep-log').textContent += String(err.message ?? err)
	} finally {
		btn.disabled = false
		refresh()
	}
})

refresh()
