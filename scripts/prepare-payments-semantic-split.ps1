[CmdletBinding()]
param(
	[Parameter(Mandatory)] [string]$SourceSql,
	[Parameter(Mandatory)] [string]$TargetSqlite,
	[Parameter(Mandatory)] [string]$EvidenceDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$protectedSecretPath = Join-Path $env:LOCALAPPDATA "GatoPago\phase-2-1\payments-generated-secrets.dpapi"
$dpapiEntropy = [Text.Encoding]::UTF8.GetBytes("gatopago-payments-secrets-v1")

if (-not (Test-Path -LiteralPath $protectedSecretPath)) {
	throw "The existing DPAPI-protected Payments secret file is required for the semantic split"
}
$source = (Resolve-Path -LiteralPath $SourceSql).Path
$target = [IO.Path]::GetFullPath($TargetSqlite)
$evidence = [IO.Path]::GetFullPath($EvidenceDirectory)

$protected = [IO.File]::ReadAllBytes($protectedSecretPath)
$plaintext = [Security.Cryptography.ProtectedData]::Unprotect(
	$protected,
	$dpapiEntropy,
	[Security.Cryptography.DataProtectionScope]::CurrentUser
)
$generated = [Text.Encoding]::UTF8.GetString($plaintext) | ConvertFrom-Json
$plaintext = $null

$previous = [ordered]@{
	WEBHOOK_SECRET_ENCRYPTION_KEY = $env:WEBHOOK_SECRET_ENCRYPTION_KEY
	WEBHOOK_SECRET_ENCRYPTION_KEY_ID = $env:WEBHOOK_SECRET_ENCRYPTION_KEY_ID
	WEBHOOK_SECRET_ENCRYPTION_KEYS_PREVIOUS = $env:WEBHOOK_SECRET_ENCRYPTION_KEYS_PREVIOUS
}

try {
	$env:WEBHOOK_SECRET_ENCRYPTION_KEY = [string]$generated.webhookEncryptionKey
	$env:WEBHOOK_SECRET_ENCRYPTION_KEY_ID = [string]$generated.webhookEncryptionKeyId
	$env:WEBHOOK_SECRET_ENCRYPTION_KEYS_PREVIOUS = "{}"
	& (Get-Command node.exe).Source (Join-Path $repoRoot "scripts\split-payments-d1.mjs") `
		--source-sql $source --target $target --backup-dir $evidence
	if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
	$generated = $null
	foreach ($entry in $previous.GetEnumerator()) {
		if ($null -eq $entry.Value) { Remove-Item -Path "Env:$($entry.Key)" -ErrorAction SilentlyContinue }
		else { Set-Item -Path "Env:$($entry.Key)" -Value $entry.Value }
	}
}
