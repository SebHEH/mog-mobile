<#
.SYNOPSIS
  Pushes the local apps-script/ folder to one or more bound Apps Script projects,
  optionally bumping each Sheet's web-app deployment so the /exec URL the PWA
  hits serves the new code.

.DESCRIPTION
  Reads .clasp-targets.json, then for each target writes a temporary .clasp.json
  pointing at that target's scriptId and runs `clasp push -f`. Spreadsheet data
  on each Sheet is untouched - clasp only updates the bound script project.

  If -Redeploy is passed, ALSO runs `clasp deploy --deploymentId <id>` per target
  to publish a new version under each Sheet's existing /exec URL. This is
  REQUIRED when MOGApi.gs changes — the PWA hits a versioned snapshot, not HEAD,
  so a push alone won't reach the live URL.

  When -Redeploy IS NOT needed:
    Bound-sidebar-only changes (ManageVendors.html, ManageItems.html,
    OrderHistory.html, etc., and the .gs functions those sidebars call directly)
    run against HEAD inside the Sheet — a push is enough.

  When -Redeploy IS needed:
    Any change to MOGApi.gs or to .gs functions the PWA calls via the /exec URL.
    If unsure, run with -Redeploy. The redeploy phase adds ~3s per target.

  Prerequisites:
    - Node.js LTS installed
    - clasp installed globally:  npm install -g @google/clasp
    - Logged in once:            clasp login
    - .clasp-targets.json filled in with real Script IDs (not "FILL_ME_IN")
    - For -Redeploy: deploymentIds populated too. If not, run discover-deployments.ps1
      once to find them, then paste into .clasp-targets.json.

.PARAMETER Target
  Optional. Slug of a single target to push to. If omitted, pushes to ALL targets.

.PARAMETER DryRun
  If set, prints what would be pushed (and redeployed if -Redeploy is also set)
  without actually running clasp.

.PARAMETER Redeploy
  After pushing, also bump each target's web-app deployment so the /exec URL
  serves the new code. Skips targets with null/missing deploymentId (e.g.
  _template, which isn't published as a web app).

.PARAMETER Description
  Optional description string passed to `clasp deploy --description`. Only used
  when -Redeploy is set. Useful for tagging deployment history.

.EXAMPLE
  .\deploy.ps1
    Pushes to all stores. Bound sidebars in each Sheet pick up changes
    immediately on reload. /exec URLs are NOT bumped — use -Redeploy for that.

.EXAMPLE
  .\deploy.ps1 -Redeploy
    Pushes to all stores AND bumps each Sheet's web-app deployment. Use after
    any MOGApi.gs change.

.EXAMPLE
  .\deploy.ps1 -Target rpr -Redeploy -Description "Order history bootstrap"
    Single-store push + redeploy with a tag.

.EXAMPLE
  .\deploy.ps1 -DryRun -Redeploy
    Lists targets, shows what would push and what would redeploy.
#>

[CmdletBinding()]
param(
  [string]$Target,
  [switch]$DryRun,
  [switch]$Redeploy,
  [string]$Description
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

if ($Redeploy) {
  $missingDeploy = $targets | Where-Object {
    -not $_.isTemplate -and ($_.deploymentId -eq 'FILL_ME_IN' -or -not $_.deploymentId)
  }
  if ($missingDeploy) {
    Write-Host "ERROR: -Redeploy requested but these targets are missing a deploymentId:" -ForegroundColor Red
    $missingDeploy | ForEach-Object { Write-Host "  - $($_.slug) ($($_.label))" -ForegroundColor Red }
    Write-Host "Run .\discover-deployments.ps1 to find them, then paste into .clasp-targets.json."
    exit 1
  }
}

$results = @()

foreach ($t in $targets) {
  Write-Host ""
  Write-Host ("=== {0} ({1}) ===" -f $t.slug, $t.label) -ForegroundColor Cyan
  Write-Host "Script ID: $($t.scriptId)"
  if ($Redeploy -and $t.deploymentId) { Write-Host "Deployment ID: $($t.deploymentId)" }

  if ($DryRun) {
    Write-Host "[dry run] would: clasp push -f" -ForegroundColor Yellow
    $dryRedeployStatus = 'n/a'
    if ($Redeploy) {
      if ($t.deploymentId) {
        $descArg = ''
        if ($Description) { $descArg = " --description `"$Description`"" }
        Write-Host ("[dry run] would: clasp deploy --deploymentId {0}{1}" -f $t.deploymentId, $descArg) -ForegroundColor Yellow
        $dryRedeployStatus = 'dry-run'
      } else {
        Write-Host "[dry run] would: SKIP redeploy (no deploymentId, e.g. template)" -ForegroundColor Yellow
        $dryRedeployStatus = 'skipped'
      }
    }
    $results += [pscustomobject]@{ slug = $t.slug; push = 'dry-run'; redeploy = $dryRedeployStatus }
    continue
  }

  @{ scriptId = $t.scriptId; rootDir = '.' } | ConvertTo-Json | Set-Content -Path $claspFile -Encoding utf8

  $pushStatus = 'fail'
  $deployStatus = 'n/a'

  try {
    clasp push -f
    if ($LASTEXITCODE -eq 0) {
      Write-Host "PUSH OK: $($t.slug)" -ForegroundColor Green
      $pushStatus = 'ok'
    } else {
      Write-Host "PUSH FAILED: $($t.slug) (exit $LASTEXITCODE)" -ForegroundColor Red
      $pushStatus = "fail (exit $LASTEXITCODE)"
    }
  } catch {
    Write-Host "PUSH FAILED: $($t.slug) - $_" -ForegroundColor Red
    $pushStatus = "fail ($_)"
  }

  if ($Redeploy -and $pushStatus -eq 'ok') {
    if ($t.deploymentId) {
      try {
        if ($Description) {
          clasp deploy --deploymentId $t.deploymentId --description $Description
        } else {
          clasp deploy --deploymentId $t.deploymentId
        }
        if ($LASTEXITCODE -eq 0) {
          Write-Host "DEPLOY OK: $($t.slug)" -ForegroundColor Green
          $deployStatus = 'ok'
        } else {
          Write-Host "DEPLOY FAILED: $($t.slug) (exit $LASTEXITCODE)" -ForegroundColor Red
          $deployStatus = "fail (exit $LASTEXITCODE)"
        }
      } catch {
        Write-Host "DEPLOY FAILED: $($t.slug) - $_" -ForegroundColor Red
        $deployStatus = "fail ($_)"
      }
    } else {
      Write-Host "DEPLOY SKIPPED: $($t.slug) (no deploymentId)" -ForegroundColor Yellow
      $deployStatus = 'skipped'
    }
  }

  $results += [pscustomobject]@{ slug = $t.slug; push = $pushStatus; redeploy = $deployStatus }
}

if (Test-Path $claspFile) { Remove-Item $claspFile -Force }

Write-Host ""
Write-Host "=== Summary ===" -ForegroundColor Cyan
$results | Format-Table -AutoSize
$failed = @($results | Where-Object {
  ($_.push -notin @('ok','dry-run')) -or ($_.redeploy -notin @('ok','dry-run','skipped','n/a'))
})
if ($failed.Count -gt 0) { exit 1 }
