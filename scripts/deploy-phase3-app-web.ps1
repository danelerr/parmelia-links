[CmdletBinding()]
param(
  [switch] $PlanOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$ClientDirectory = Join-Path $Root 'client'
$TeamId = 'team_jyOTOwbyBPWRg4U8FfGOwkg3'
$Scope = 'danelerrs-projects'
$Project = 'parmelia'
$ProductionAlias = 'app.parmelia.me'

if ($PlanOnly) {
  [pscustomobject]@{
    scope = $Scope
    project = $Project
    source = 'client'
    productionAlias = $ProductionAlias
    remoteMutationPerformed = $false
    deploysAppWeb = $true
    deploysDashboard = $false
    deploysPayments = $false
    configuresEnvironment = $false
  } | ConvertTo-Json -Depth 3
  exit 0
}

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
    [Parameter(Mandatory = $true)] [string] $WorkingDirectory
  )

  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $Node
  $info.WorkingDirectory = $WorkingDirectory
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  [void] $info.ArgumentList.Add($VercelScript)
  foreach ($argument in $Arguments) { [void] $info.ArgumentList.Add($argument) }

  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $info
  if (-not $process.Start()) { throw 'Could not start Vercel CLI.' }
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $process.WaitForExit()
  $stdout = $stdoutTask.GetAwaiter().GetResult().Trim()
  $stderr = $stderrTask.GetAwaiter().GetResult().Trim()
  if ($process.ExitCode -ne 0) {
    throw (($stderr, $stdout | Where-Object { $_ }) -join [Environment]::NewLine)
  }
  return $stdout
}

function Deployment-Url {
  param([Parameter(Mandatory = $true)] [string] $Json)
  $parsed = $Json | ConvertFrom-Json
  $url = ''
  if ($parsed.PSObject.Properties.Name -contains 'url') {
    $url = [string] $parsed.url
  } elseif (($parsed.PSObject.Properties.Name -contains 'deployment') -and
    $null -ne $parsed.deployment -and
    $parsed.deployment.PSObject.Properties.Name -contains 'url') {
    $url = [string] $parsed.deployment.url
  }
  if ([string]::IsNullOrWhiteSpace($url)) { throw 'Vercel did not return a deployment URL.' }
  if ($url -notmatch '^https://') { $url = "https://$url" }
  return $url.TrimEnd('/')
}

& $Node (Join-Path $Root 'scripts\assert-reproducible-deploy-source.mjs') client
if ($LASTEXITCODE -ne 0) { throw 'App Web deployment source is not reproducible.' }

$clientLink = Get-Content -LiteralPath (Join-Path $ClientDirectory '.vercel\project.json') -Raw |
  ConvertFrom-Json
if ($clientLink.projectName -ne $Project -or $clientLink.orgId -ne $TeamId) {
  throw 'client/ is not linked to the expected parmelia project and team.'
}

$identity = Invoke-Vercel -WorkingDirectory $Root -Arguments @('whoami', '--no-color')
Write-Output "Authenticated Vercel principal: $identity"

$previousInspect = Invoke-Vercel -WorkingDirectory $ClientDirectory -Arguments @(
  'inspect', $ProductionAlias, '--json', '--scope', $Scope, '--no-color'
)
$previousDeployment = Deployment-Url -Json $previousInspect

$deployResult = Invoke-Vercel -WorkingDirectory $ClientDirectory -Arguments @(
  'deploy', '--prod', '--yes', '--no-wait', '--json', '--scope', $Scope, '--no-color'
)
$currentDeployment = Deployment-Url -Json $deployResult
[void] (Invoke-Vercel -WorkingDirectory $ClientDirectory -Arguments @(
  'inspect', $currentDeployment, '--wait', '--timeout', '10m', '--json', '--scope', $Scope, '--no-color'
))

$aliasInspect = Invoke-Vercel -WorkingDirectory $ClientDirectory -Arguments @(
  'inspect', $ProductionAlias, '--json', '--scope', $Scope, '--no-color'
)
$aliasDeployment = Deployment-Url -Json $aliasInspect
if ($aliasDeployment -ne $currentDeployment) {
  throw "Production alias does not point to the new deployment. Expected $currentDeployment, got $aliasDeployment."
}

[pscustomobject]@{
  previousDeployment = $previousDeployment
  currentDeployment = $currentDeployment
  productionAlias = "https://$ProductionAlias"
  deploysDashboard = $false
  deploysPayments = $false
  configuresEnvironment = $false
} | ConvertTo-Json -Depth 3
