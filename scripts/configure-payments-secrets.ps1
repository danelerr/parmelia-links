[CmdletBinding()]
param(
	[string]$WorkerName = "gatopago-payments-api",
	[string]$KeystoreAccount = "wallet-0x75",
	[string]$ArbitrumSepoliaSecondaryRpcUrl = "https://arbitrum-sepolia-rpc.publicnode.com",
	[string]$BaseSepoliaSecondaryRpcUrl = "https://base-sepolia-rpc.publicnode.com",
	[string]$AvalancheFujiSecondaryRpcUrl = "https://avalanche-fuji-c-chain-rpc.publicnode.com"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$secureRoot = Join-Path $env:LOCALAPPDATA "GatoPago\phase-2-1"
$generatedSecretPath = Join-Path $secureRoot "payments-generated-secrets.dpapi"
$dpapiEntropy = [Text.Encoding]::UTF8.GetBytes("gatopago-payments-secrets-v1")

function Invoke-ChildProcess {
	param(
		[Parameter(Mandatory)] [string]$FileName,
		[Parameter(Mandatory)] [AllowEmptyString()] [string[]]$Arguments,
		[string]$StandardInput = ""
	)
	$startInfo = [Diagnostics.ProcessStartInfo]::new()
	$startInfo.FileName = $FileName
	$startInfo.WorkingDirectory = $repoRoot
	$startInfo.UseShellExecute = $false
	$startInfo.CreateNoWindow = $true
	$startInfo.RedirectStandardInput = $true
	$startInfo.RedirectStandardOutput = $true
	$startInfo.RedirectStandardError = $true
	foreach ($argument in $Arguments) { $null = $startInfo.ArgumentList.Add($argument) }
	$process = [Diagnostics.Process]::new()
	$process.StartInfo = $startInfo
	$null = $process.Start()
	if ($StandardInput) { $process.StandardInput.Write($StandardInput) }
	$process.StandardInput.Close()
	$stdout = $process.StandardOutput.ReadToEnd()
	$stderr = $process.StandardError.ReadToEnd()
	$process.WaitForExit()
	return [pscustomobject]@{ ExitCode = $process.ExitCode; Stdout = $stdout; Stderr = $stderr }
}

function Read-ExampleEnvValue {
	param([Parameter(Mandatory)] [string]$Name)
	$path = Join-Path $repoRoot "contracts\.env.example"
	$match = Get-Content -LiteralPath $path | Select-String -Pattern ("^" + [regex]::Escape($Name) + "=(.+)$") | Select-Object -First 1
	if (-not $match -or [string]::IsNullOrWhiteSpace($match.Matches[0].Groups[1].Value)) {
		throw "Missing $Name in contracts/.env.example"
	}
	return $match.Matches[0].Groups[1].Value.Trim()
}

function Assert-PaymentRpcSet {
	param(
		[Parameter(Mandatory)] [string]$ChainLabel,
		[Parameter(Mandatory)] [string]$ExpectedChainIdHex,
		[Parameter(Mandatory)] [string[]]$Urls
	)
	if ($Urls.Count -lt 2) { throw "$ChainLabel requires at least two RPC endpoints" }
	$hosts = @()
	foreach ($rpcUrl in $Urls) {
		[Uri]$parsed = $null
		if (-not [Uri]::TryCreate($rpcUrl, [UriKind]::Absolute, [ref]$parsed) -or
			$parsed.Scheme -ne "https" -or [string]::IsNullOrWhiteSpace($parsed.Host)) {
			throw "$ChainLabel contains an invalid HTTPS RPC endpoint"
		}
		$hosts += $parsed.Host.ToLowerInvariant()
	}
	if (@($hosts | Select-Object -Unique).Count -lt 2) {
		throw "$ChainLabel requires RPC endpoints from at least two distinct hostnames"
	}

	$body = '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'
	foreach ($rpcUrl in $Urls) {
		try {
			$response = Invoke-RestMethod -Method Post -Uri $rpcUrl -ContentType "application/json" `
				-Body $body -TimeoutSec 15
		} catch {
			throw "$ChainLabel RPC probe failed before secret upload"
		}
		if ([string]$response.result -ne $ExpectedChainIdHex) {
			throw "$ChainLabel RPC returned an unexpected chain ID before secret upload"
		}
	}
}

New-Item -ItemType Directory -Force -Path $secureRoot | Out-Null

if (Test-Path -LiteralPath $generatedSecretPath) {
	$protected = [IO.File]::ReadAllBytes($generatedSecretPath)
	$plaintext = [Security.Cryptography.ProtectedData]::Unprotect(
		$protected,
		$dpapiEntropy,
		[Security.Cryptography.DataProtectionScope]::CurrentUser
	)
	$generated = [Text.Encoding]::UTF8.GetString($plaintext) | ConvertFrom-Json
} else {
	$generated = [ordered]@{
		webhookEncryptionKey = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
		webhookEncryptionKeyId = "2026_08_phase2_1"
		opsHealthToken = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
	}
	$plaintext = [Text.Encoding]::UTF8.GetBytes(($generated | ConvertTo-Json -Compress))
	$protected = [Security.Cryptography.ProtectedData]::Protect(
		$plaintext,
		$dpapiEntropy,
		[Security.Cryptography.DataProtectionScope]::CurrentUser
	)
	[IO.File]::WriteAllBytes($generatedSecretPath, $protected)
}

$cast = Invoke-ChildProcess -FileName (Get-Command cast.exe).Source -Arguments @(
	"wallet", "decrypt-keystore", $KeystoreAccount, "--unsafe-password", ""
)
$privateKeyMatch = [regex]::Match($cast.Stdout, "(?:0x)?[0-9a-fA-F]{64}")
if ($cast.ExitCode -ne 0 -or -not $privateKeyMatch.Success) {
	throw "Could not decrypt the configured Foundry keystore"
}
$privateKey = $privateKeyMatch.Value
if (-not $privateKey.StartsWith("0x")) { $privateKey = "0x$privateKey" }

$derive = Invoke-ChildProcess -FileName (Get-Command pnpm.cmd).Source -Arguments @(
	"--filter", "payments-worker", "exec", "node", "--input-type=module", "-e",
	"import{privateKeyToAccount}from'viem/accounts';let s='';for await(const c of process.stdin)s+=c;console.log(privateKeyToAccount(s.trim()).address)"
) -StandardInput $privateKey
if ($derive.ExitCode -ne 0) { throw "Could not derive the keystore address" }
$derivedAddress = $derive.Stdout.Trim()

$manifestPaths = @(
	"contracts\deployments\421614\payment-router-v2.json",
	"contracts\deployments\84532\cctp-payment-router.json",
	"contracts\deployments\43113\cctp-payment-router.json"
)
$expectedSigners = @($manifestPaths | ForEach-Object {
	(Get-Content -Raw -LiteralPath (Join-Path $repoRoot $_) | ConvertFrom-Json).roles.authorizationSigner.ToLowerInvariant()
} | Select-Object -Unique)
if ($expectedSigners.Count -ne 1 -or $derivedAddress.ToLowerInvariant() -ne $expectedSigners[0]) {
	throw "The keystore does not match every deployed payment-router authorization signer"
}

$rpcSets = [ordered]@{
	"421614" = @(
		(Read-ExampleEnvValue "ARBITRUM_SEPOLIA_RPC_URL"),
		$ArbitrumSepoliaSecondaryRpcUrl
	)
	"84532" = @(
		(Read-ExampleEnvValue "BASE_SEPOLIA_RPC_URL"),
		$BaseSepoliaSecondaryRpcUrl
	)
	"43113" = @(
		(Read-ExampleEnvValue "AVALANCHE_FUJI_RPC_URL"),
		$AvalancheFujiSecondaryRpcUrl
	)
}
Assert-PaymentRpcSet -ChainLabel "Arbitrum Sepolia" -ExpectedChainIdHex "0x66eee" -Urls $rpcSets["421614"]
Assert-PaymentRpcSet -ChainLabel "Base Sepolia" -ExpectedChainIdHex "0x14a34" -Urls $rpcSets["84532"]
Assert-PaymentRpcSet -ChainLabel "Avalanche Fuji" -ExpectedChainIdHex "0xa869" -Urls $rpcSets["43113"]
$rpcUrls = $rpcSets | ConvertTo-Json -Compress

$secrets = [ordered]@{
	PAYMENT_AUTHORIZATION_SIGNER_PRIVATE_KEY = $privateKey
	PAYMENT_RPC_URLS = $rpcUrls
	PAYMENT_RELAYER_PRIVATE_KEY = $privateKey
	WEBHOOK_SECRET_ENCRYPTION_KEY = $generated.webhookEncryptionKey
	WEBHOOK_SECRET_ENCRYPTION_KEY_ID = $generated.webhookEncryptionKeyId
	WEBHOOK_SECRET_ENCRYPTION_KEYS_PREVIOUS = "{}"
	OPS_HEALTH_TOKEN = $generated.opsHealthToken
}
$upload = Invoke-ChildProcess -FileName (Get-Command pnpm.cmd).Source -Arguments @(
	"--filter", "payments-worker", "exec", "wrangler", "secret", "bulk", "--name", $WorkerName
) -StandardInput ($secrets | ConvertTo-Json -Compress)
$privateKey = $null
$secrets = $null
if ($upload.ExitCode -ne 0) {
	throw "Wrangler secret bulk failed with exit code $($upload.ExitCode)"
}

[ordered]@{
	worker = $WorkerName
	keystoreAddress = $derivedAddress
	secretCount = 7
	generatedSecretsProtection = "Windows DPAPI CurrentUser"
	protectedSecretFile = $generatedSecretPath
	plaintextSecretFileCreated = $false
} | ConvertTo-Json
