[CmdletBinding()]
param(
	[string]$Url = "https://gatopago-payments-api.parmelia.workers.dev/health/ops"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$secretPath = Join-Path $env:LOCALAPPDATA "GatoPago\phase-2-1\payments-generated-secrets.dpapi"
if (-not (Test-Path -LiteralPath $secretPath)) {
	throw "Protected Payments operations token is missing"
}
$entropy = [Text.Encoding]::UTF8.GetBytes("gatopago-payments-secrets-v1")
$protected = [IO.File]::ReadAllBytes($secretPath)
$plaintext = [Security.Cryptography.ProtectedData]::Unprotect(
	$protected,
	$entropy,
	[Security.Cryptography.DataProtectionScope]::CurrentUser
)
$generated = [Text.Encoding]::UTF8.GetString($plaintext) | ConvertFrom-Json
$response = Invoke-WebRequest -Uri $Url -Headers @{ "X-Ops-Token" = $generated.opsHealthToken } -SkipHttpErrorCheck
[ordered]@{
	statusCode = $response.StatusCode
	body = $response.Content | ConvertFrom-Json
} | ConvertTo-Json -Depth 12
