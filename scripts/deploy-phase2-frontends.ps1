[CmdletBinding()]
param(
  [switch] $ConfigureOnly,

  [switch] $PlanOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$ClientDirectory = Join-Path $Root 'client'
$DashboardDirectory = Join-Path $Root 'dashboard'
$TeamId = 'team_jyOTOwbyBPWRg4U8FfGOwkg3'
$Scope = 'danelerrs-projects'
$DashboardProject = 'gatopago-dashboard'
$PaymentsUrl = 'https://gatopago-payments-api.parmelia.workers.dev'
$AppUrl = 'https://server.parmelia.workers.dev'
$SiteUrl = 'https://parmelia.me'
$DashboardAlias = 'dashboard.parmelia.me'
$VercelScript = Join-Path $env:APPDATA 'npm\node_modules\vercel\dist\vc.js'

if (-not (Test-Path -LiteralPath $VercelScript -PathType Leaf)) {
  throw 'Vercel CLI 59.5.0+ must be installed globally before this script runs.'
}

$Node = (Get-Command node.exe -ErrorAction Stop).Source
$env:NO_COLOR = '1'
$env:VERCEL_TELEMETRY_DISABLED = '1'
$env:CI = '1'

function Invoke-Vercel {
  param(
    [Parameter(Mandatory = $true)] [string[]] $Arguments,
    [Parameter(Mandatory = $true)] [string] $WorkingDirectory,
    [AllowNull()] [string] $InputValue = $null
  )

  $hasInputValue = $PSBoundParameters.ContainsKey('InputValue')

  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $Node
  $info.WorkingDirectory = $WorkingDirectory
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.RedirectStandardInput = $hasInputValue
  [void] $info.ArgumentList.Add($VercelScript)
  foreach ($argument in $Arguments) { [void] $info.ArgumentList.Add($argument) }

  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $info
  if (-not $process.Start()) { throw 'Could not start Vercel CLI.' }
  if ($hasInputValue) {
    $process.StandardInput.WriteLine($InputValue)
    $process.StandardInput.Close()
  }
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $process.WaitForExit()
  $stdout = $stdoutTask.GetAwaiter().GetResult().Trim()
  $stderr = $stderrTask.GetAwaiter().GetResult().Trim()
  if ($hasInputValue -and -not [string]::IsNullOrEmpty($InputValue)) {
    $stdout = $stdout.Replace($InputValue, '[redacted]')
    $stderr = $stderr.Replace($InputValue, '[redacted]')
  }
  if ($process.ExitCode -ne 0) {
    throw (($stderr, $stdout | Where-Object { $_ }) -join [Environment]::NewLine)
  }
  return $stdout
}

function Read-DotEnv {
  param([Parameter(Mandatory = $true)] [string] $Path)
  $values = @{}
  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') { continue }
    $value = $Matches[2].Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
        ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $values[$Matches[1]] = $value
  }
  return $values
}

function Require-Value {
  param([hashtable] $Values, [string] $Name, [string] $Source)
  $value = [string] $Values[$Name]
  if ([string]::IsNullOrWhiteSpace($value)) { throw "$Name is missing from $Source." }
  return $value
}

function Set-ProductionVariable {
  param([string] $Directory, [string] $Name, [string] $Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { throw "$Name cannot be empty." }
  [void] (Invoke-Vercel -WorkingDirectory $Directory -InputValue $Value -Arguments @(
    'env', 'add', $Name, 'production', '--force', '--no-sensitive', '--scope', $Scope, '--no-color'
  ))
  Write-Output "Configured Production variable: $Name"
}

function Deployment-Url {
  param([string] $Json)
  $parsed = $Json | ConvertFrom-Json
  $url = ''
  if ($parsed.PSObject.Properties.Name -contains 'url') {
    $url = [string] $parsed.url
  } elseif (($parsed.PSObject.Properties.Name -contains 'deployment') -and
    $null -ne $parsed.deployment -and
    $parsed.deployment.PSObject.Properties.Name -contains 'url') {
    $url = [string] $parsed.deployment.url
  }
  if ([string]::IsNullOrWhiteSpace($url)) { throw 'Vercel deploy did not return a URL.' }
  if ($url -notmatch '^https://') { $url = "https://$url" }
  return $url
}

$clientEnv = Read-DotEnv -Path (Join-Path $ClientDirectory '.env')
$dashboardEnv = Read-DotEnv -Path (Join-Path $DashboardDirectory '.env')
$requiredDashboardFirebase = @(
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_STORAGE_BUCKET',
  'VITE_FIREBASE_MESSAGING_SENDER_ID',
  'VITE_FIREBASE_APP_ID'
)
foreach ($name in $requiredDashboardFirebase) {
  [void] (Require-Value $dashboardEnv $name 'dashboard/.env')
}
[void] (Require-Value $clientEnv 'VITE_TURNSTILE_SITE_KEY' 'client/.env')

if ($PlanOnly) {
  [pscustomobject]@{
    team = $TeamId
    scope = $Scope
    existingClientProject = 'parmelia'
    dashboardProject = $DashboardProject
    clientProductionVariables = @('VITE_PAYMENTS_API_URL')
    dashboardProductionVariables = @($requiredDashboardFirebase) + @(
      'VITE_APP_API_URL', 'VITE_PAYMENTS_API_URL', 'VITE_SITE_URL', 'VITE_TURNSTILE_SITE_KEY'
    )
    productionDeployments = -not $ConfigureOnly
    aliases = @('app.parmelia.me', $DashboardAlias)
  } | ConvertTo-Json -Depth 4
  exit 0
}

$identity = Invoke-Vercel -WorkingDirectory $Root -Arguments @('whoami', '--no-color')
Write-Output "Authenticated Vercel principal: $identity"

if (-not $ConfigureOnly) {
  & $Node (Join-Path $Root 'scripts\assert-reproducible-deploy-source.mjs') client dashboard
  if ($LASTEXITCODE -ne 0) { throw 'Frontend deployment source is not reproducible.' }
}

$clientLink = Get-Content -LiteralPath (Join-Path $ClientDirectory '.vercel\project.json') -Raw |
  ConvertFrom-Json
if ($clientLink.projectName -ne 'parmelia' -or $clientLink.orgId -ne $TeamId) {
  throw 'client/ is not linked to the expected parmelia project and team.'
}

$projects = Invoke-Vercel -WorkingDirectory $Root -Arguments @(
  'project', 'ls', '--json', '--scope', $Scope, '--no-color'
) | ConvertFrom-Json
if ($DashboardProject -notin @($projects.projects | ForEach-Object name)) {
  [void] (Invoke-Vercel -WorkingDirectory $Root -Arguments @(
    'project', 'add', $DashboardProject, '--scope', $Scope, '--no-color'
  ))
  Write-Output "Created Vercel project: $DashboardProject"
}

[void] (Invoke-Vercel -WorkingDirectory $DashboardDirectory -Arguments @(
  'link', '--yes', '--project', $DashboardProject, '--scope', $Scope, '--no-color'
))
$dashboardLink = Get-Content -LiteralPath (Join-Path $DashboardDirectory '.vercel\project.json') -Raw |
  ConvertFrom-Json
if ($dashboardLink.projectName -ne $DashboardProject -or $dashboardLink.orgId -ne $TeamId) {
  throw 'dashboard/ was not linked to the expected Vercel project and team.'
}

Set-ProductionVariable $ClientDirectory 'VITE_PAYMENTS_API_URL' $PaymentsUrl

foreach ($name in $requiredDashboardFirebase) {
  Set-ProductionVariable $DashboardDirectory $name (Require-Value $dashboardEnv $name 'dashboard/.env')
}
Set-ProductionVariable $DashboardDirectory 'VITE_APP_API_URL' $AppUrl
Set-ProductionVariable $DashboardDirectory 'VITE_PAYMENTS_API_URL' $PaymentsUrl
Set-ProductionVariable $DashboardDirectory 'VITE_SITE_URL' $SiteUrl
Set-ProductionVariable $DashboardDirectory 'VITE_TURNSTILE_SITE_KEY' (
  Require-Value $clientEnv 'VITE_TURNSTILE_SITE_KEY' 'client/.env'
)

if ($ConfigureOnly) {
  Write-Output 'Vercel projects and Production variables are configured; deployment was skipped.'
  exit 0
}

$clientDeploy = Invoke-Vercel -WorkingDirectory $ClientDirectory -Arguments @(
  'deploy', '--prod', '--yes', '--no-wait', '--json', '--scope', $Scope, '--no-color'
)
$clientUrl = Deployment-Url $clientDeploy
[void] (Invoke-Vercel -WorkingDirectory $ClientDirectory -Arguments @(
  'inspect', $clientUrl, '--wait', '--timeout', '10m', '--json', '--scope', $Scope, '--no-color'
))

$dashboardDeploy = Invoke-Vercel -WorkingDirectory $DashboardDirectory -Arguments @(
  'deploy', '--prod', '--yes', '--no-wait', '--json', '--scope', $Scope, '--no-color'
)
$dashboardUrl = Deployment-Url $dashboardDeploy
[void] (Invoke-Vercel -WorkingDirectory $DashboardDirectory -Arguments @(
  'inspect', $dashboardUrl, '--wait', '--timeout', '10m', '--json', '--scope', $Scope, '--no-color'
))
[void] (Invoke-Vercel -WorkingDirectory $DashboardDirectory -Arguments @(
  'alias', 'set', $dashboardUrl, $DashboardAlias, '--scope', $Scope, '--no-color'
))

[pscustomobject]@{
  clientDeployment = $clientUrl
  clientProduction = 'https://app.parmelia.me'
  dashboardDeployment = $dashboardUrl
  dashboardProduction = "https://$DashboardAlias"
} | ConvertTo-Json -Depth 3
