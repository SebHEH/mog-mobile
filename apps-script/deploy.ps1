<#
.SYNOPSIS
  Pushes the local apps-script/ folder to one or more bound Apps Script projects.

.DESCRIPTION
  Reads .clasp-targets.json, then for each target writes a temporary .clasp.json
  pointing at that target's scriptId and runs `clasp push -f`. Spreadsheet data
  on each Sheet is untouched - clasp only updates the bound script project.

  Prerequisites:
    - Node.js LTS installed
    - clasp installed globally:  npm install -g @google/clasp
    - Logged in once:            clasp login
    - .clasp-targets.json filled in with real Script IDs (not "FILL_ME_IN")

.PARAMETER Target
  Optional. Slug of a single target to push to. If omitted, pushes to ALL targets.

.PARAMETER DryRun
  If set, prints what would be pushed without actually running `clasp push`.

.EXAMPLE
  .\deploy.ps1
    Pushes to all stores in .clasp-targets.json.

.EXAMPLE
  .\deploy.ps1 -Target rpr
    Pushes only to the Roll Play Rosslyn BOH store.

.EXAMPLE
  .\deploy.ps1 -DryRun
    Lists targets and confirms each Script ID is set, no push.
#>

[CmdletBinding()]
param(
  [string]$Target,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

$targetsFile = Join-Path $here '.clasp-targets.json'
$claspFile   = Join-Path $here '.clasp.json'

if (-not (Test-Path $targetsFile)) {
  Write-Host "ERROR: $targetsFile not found." -ForegroundColor Red
  exit 1
}

$null = Get-Command clasp -ErrorAction SilentlyContinue
if (-not $?) {
  Write-Host "ERROR: 'clasp' not found on PATH. Install with: npm install -g @google/clasp" -ForegroundColor Red
  exit 1
}

$targets = Get-Content $targetsFile -Raw | ConvertFrom-Json

if ($Target) {
  $targets = $targets | Where-Object { $_.slug -eq $Target }
  if (-not $targets) {
    Write-Host "ERROR: no target with slug '$Target' in .clasp-targets.json" -ForegroundColor Red
    exit 1
  }
}

$placeholder = $targets | Where-Object { $_.scriptId -eq 'FILL_ME_IN' -or -not $_.scriptId }
if ($placeholder) {
  Write-Host "ERROR: these targets still have a placeholder Script ID:" -ForegroundColor Red
  $placeholder | ForEach-Object { Write-Host "  - $($_.slug) ($($_.label))" -ForegroundColor Red }
  Write-Host "Edit .clasp-targets.json and replace FILL_ME_IN with each Sheet's real Script ID."
  Write-Host "(In the Sheet: Extensions > Apps Script > Project Settings > Script ID)"
  exit 1
}

$results = @()

foreach ($t in $targets) {
  Write-Host ""
  Write-Host ("=== {0} ({1}) ===" -f $t.slug, $t.label) -ForegroundColor Cyan
  Write-Host "Script ID: $($t.scriptId)"

  if ($DryRun) {
    Write-Host "[dry run] would: clasp push -f" -ForegroundColor Yellow
    $results += [pscustomobject]@{ slug = $t.slug; status = 'dry-run' }
    continue
  }

  @{ scriptId = $t.scriptId; rootDir = '.' } | ConvertTo-Json | Set-Content -Path $claspFile -Encoding utf8

  try {
    clasp push -f
    if ($LASTEXITCODE -eq 0) {
      Write-Host "OK: $($t.slug)" -ForegroundColor Green
      $results += [pscustomobject]@{ slug = $t.slug; status = 'ok' }
    } else {
      Write-Host "FAILED: $($t.slug) (exit $LASTEXITCODE)" -ForegroundColor Red
      $results += [pscustomobject]@{ slug = $t.slug; status = "fail (exit $LASTEXITCODE)" }
    }
  } catch {
    Write-Host "FAILED: $($t.slug) - $_" -ForegroundColor Red
    $results += [pscustomobject]@{ slug = $t.slug; status = "fail ($_)" }
  }
}

if (Test-Path $claspFile) { Remove-Item $claspFile -Force }

Write-Host ""
Write-Host "=== Summary ===" -ForegroundColor Cyan
$results | Format-Table -AutoSize
$failed = @($results | Where-Object { $_.status -notin @('ok','dry-run') })
if ($failed.Count -gt 0) { exit 1 }
