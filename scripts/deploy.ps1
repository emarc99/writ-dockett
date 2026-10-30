# Deploys OrderRegistry + WritToken to Sepolia and seeds wUSD balances in the wallets named by
# Newton AC/DC Fund v. Ermilov (N.D. Cal. 5:26-cv-05055) ECF 18.
#
# Uses `forge create` / `cast send`, which ask the Sepolia node for gas estimates. `forge script`
# simulates in a local EVM that under-prices contract creation on Sepolia's current fork.
#
#   ./scripts/deploy.ps1                 # MockKeystoneForwarder (cre workflow simulate --broadcast)
#   ./scripts/deploy.ps1 -Forwarder 0xF8344CFd5c43616a4366C34E3EEE75af79a74482   # deployed DON workflow
param(
    [string]$Forwarder = "0x15fC6ae953E024d975e77382eEeC56A9101f9F88"
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

Get-Content (Join-Path $root ".env") | ForEach-Object {
    if ($_ -match '^\s*([A-Z_]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2].Trim(), "Process") }
}
$rpc = $env:SEPOLIA_RPC_URL
$pk = $env:CRE_ETH_PRIVATE_KEY
$deployer = cast wallet address --private-key $pk

function Deploy-Contract([string]$id, [string[]]$ctorArgs) {
    $out = forge create $id --root (Join-Path $root "contracts") --rpc-url $rpc --private-key $pk --broadcast --json --constructor-args @ctorArgs
    $json = ($out -join "`n")
    ($json.Substring($json.LastIndexOf("{")) | ConvertFrom-Json).deployedTo
}

$registry = Deploy-Contract "src/OrderRegistry.sol:OrderRegistry" @($Forwarder)
Write-Host "OrderRegistry $registry"
$token = Deploy-Contract "src/WritToken.sol:WritToken" @($registry)
Write-Host "WritToken     $token"

$named = @(
    "0xf7Fcc767dE537953b3519D4b3097A24A6dFE1c84",
    "0x898137400867603E6D713CBD40881dd0c79E47cB",
    "0xf02d9f19060eE2dd50047dC6E1E9eBAC9bA436FE",
    "0x784Cf4b62655486B405Eb76731885CC9ed56f42f",
    "0xe497285e466227F4E8648209E34B465dAA1F90a0",
    "0x9030D5C596d636eEFC8f0ad7b2788AE7E9ef3D46"
)
foreach ($w in $named + @($deployer)) {
    cast send $token "mint(address,uint256)" $w 250000000000 --rpc-url $rpc --private-key $pk --json | Out-Null
    Write-Host "minted 250,000 wUSD to $w"
}

$deployment = [ordered]@{
    chain         = "ethereum-testnet-sepolia"
    chainId       = 11155111
    orderRegistry = $registry
    writToken     = $token
    forwarder     = $Forwarder
    deployer      = $deployer
    deployedAt    = (Get-Date).ToUniversalTime().ToString("o")
}
$path = Join-Path $root "deployments/sepolia.json"
New-Item -ItemType Directory -Force (Split-Path $path) | Out-Null
$deployment | ConvertTo-Json | Set-Content $path
Write-Host "wrote $path"
