# Resets the live demo: deploys a fresh OrderRegistry + WritToken behind the Sepolia
# KeystoneForwarder, points the workflow config at it, redeploys the workflow to CRE (which gives it
# a new workflow ID) and pins the registry to that ID. Afterwards the genuine order can be verified,
# the forged one rejected and the sweep run again, all on the DON.
#
#   ./scripts/fresh-demo.ps1
param(
    # CRE organization's workflow owner (shown by `cre workflow deploy`)
    [string]$WorkflowOwner = ""
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$keystone = "0xF8344CFd5c43616a4366C34E3EEE75af79a74482"
$depPath = Join-Path $root "deployments/sepolia.json"
$cfgPath = Join-Path $root "workflows/writ/config.staging.json"

if (-not $WorkflowOwner) { $WorkflowOwner = (Get-Content $depPath -Raw | ConvertFrom-Json).workflowOwner }
if (-not $WorkflowOwner) { throw "pass -WorkflowOwner (deployments/sepolia.json has none)" }
$workflowOwner = $WorkflowOwner

Get-Content (Join-Path $root ".env") | ForEach-Object {
    if ($_ -match '^\s*([A-Z_]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2].Trim(), "Process") }
}
$rpc = $env:SEPOLIA_RPC_URL
$pk = $env:CRE_ETH_PRIVATE_KEY
$fromBlock = [int64](cast block-number --rpc-url $rpc)

& (Join-Path $PSScriptRoot "deploy.ps1") -Forwarder $keystone
$dep = Get-Content $depPath -Raw | ConvertFrom-Json

$cfg = (Get-Content $cfgPath -Raw) -replace '("registryAddress":\s*")0x[0-9a-fA-F]{40}', ('${1}' + $dep.orderRegistry)
[IO.File]::WriteAllText($cfgPath, $cfg)
Write-Host "workflow config now targets $($dep.orderRegistry)"

Push-Location $root
$ErrorActionPreference = "Continue"   # cre writes progress to stderr
try {
    $out = (cre workflow deploy workflows/writ --target staging-settings --yes --non-interactive 2>&1 | Out-String)
} finally {
    $ErrorActionPreference = "Stop"
    Pop-Location
}
Write-Host $out
$m = [regex]::Match($out, '(?i)workflow\s*id\W*(?:0x)?([0-9a-f]{64})')
if (-not $m.Success) { throw "could not find the workflow ID in the deploy output" }
$workflowId = $m.Groups[1].Value

cast send $dep.orderRegistry "pinWorkflow(address,bytes32)" $workflowOwner "0x$workflowId" --rpc-url $rpc --private-key $pk --json | Out-Null
Write-Host "pinned registry to workflow $workflowId (owner $workflowOwner)"

$deployment = [ordered]@{
    chain               = $dep.chain
    chainId             = $dep.chainId
    orderRegistry       = $dep.orderRegistry
    writToken           = $dep.writToken
    forwarder           = $keystone
    workflowName        = "writ-staging"
    workflowId          = $workflowId
    workflowOwner       = $workflowOwner
    httpAuthorizedKey   = $dep.deployer
    deployer            = $dep.deployer
    deployedAt          = $dep.deployedAt
    fromBlock           = $fromBlock
}
$deployment | ConvertTo-Json | Set-Content $depPath
Write-Host "wrote $depPath; restart the web app (cd web; bun run dev) to pick it up"
