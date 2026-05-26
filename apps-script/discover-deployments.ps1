<#
.SYNOPSIS
  Discovers the live web-app deployment ID for each store in .clasp-targets.json.

.DESCRIPTION
  For each non-template target, writes a temporary .clasp.json pointing at that
  target's scriptId, runs `clasp deployments`, and parses out the highest-versioned
  non-@HEAD deployment ID. Prints a JSON snippet you can paste into the
  `deploymentId` fields in .clasp-targets.json.

  Why this exists:
    Apps Script has two distinct concepts that the deploy workflow has to handle.
      - Script ID: identifies the script project. Stable. Used by `clasp push`.
      - Deployment ID: identifies a specific web-app /exec URL. Stable per Sheet
        once created. Used by `clasp deploy --deploymentId <id>` to publish a
        new version of the code under the SAME URL.
    `clasp push` updates the bound script (which bound sidebars read directly
    from HEAD), but the /exec URL the PWA hits is a versioned snapshot and does
    NOT auto-pick up pushes. So MOGApi changes need a redeploy. This script is
    the one-time-per-machine bootstrap that fills in the deployment IDs so
    `deploy.ps1 -Redeploy` knows what to bump.

  Once .clasp-targets.json has real deploymentIds committed to git, future
  machines don't need to run this — they just need `clasp login`.

  Prerequisites:
    - clasp installed globally and logged in to the right Google account
    - .clasp-targets.json has real scriptIds

.PARAMETER Target
  Optional. Slug of a single target to discover for. If omitted, runs all
  non-template targets.

.EXAMPLE
  .\discover-deployments.ps1
    Discovers deployment IDs for every non-template target and prints a JSON
    snippet to paste into .clasp-targets.json.

.EXAMPLE
  .\discover-deployments.ps1 -Target rpfrf
    Discovers the deployment ID for a single store (e.g. a newly-onboarded one).
#>

[CmdletBinding()]
param(
  [string]$Target
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
$targets = $targets | Where-Object { -not $_.isTemplate }

if ($Target) {
  $targets = $targets | Where-Object { $_.slug -eq $Target }
  if (-not $targets) {
    Write-Host "ERROR: no non-template target with slug '$Target' in .clasp-targets.json" -ForegroundColor Red
    exit 1
  }
}

$discovered = [ordered]@{}

foreach ($t in $targets) {
  Write-Host ""
  Write-Host ("=== {0} ({1}) ===" -f $t.slug, $t.label) -ForegroundColor Cyan

  @{ scriptId = $t.scriptId; rootDir = '.' } | ConvertTo-Json | Set-Content -Path $claspFile -Encoding utf8

  try {
    $output = clasp deployments 2>&1
    if ($LASTEXITCODE -ne 0) {
      Write-Host "FAILED: clasp deployments exit $LASTEXITCODE" -ForegroundColor Red
      Write-Host $output
      $discovered[$t.slug] = $null
      continue
    }

    # Parse lines like:
    #   - AKfycby...   @HEAD
    #   - AKfycbz...   @1 - mog-mobile-api-v1
    # We want the highest-versioned non-HEAD entry. @HEAD is the test
    # deployment and isn't the URL the PWA calls.
    $best = $null
    $bestVersion = -1
    foreach ($line in $output) {
      if ($line -match '^\s*-\s+(\S+)\s+@(\d+)') {
        $id = $matches[1]
        $version = [int]$matches[2]
        if ($version -gt $bestVersion) {
          $bestVersion = $version
          $best = $id
        }
      }
    }

    if ($best) {
      Write-Host ("Found deployment @{0}: {1}" -f $bestVersion, $best) -ForegroundColor Green
      $discovered[$t.slug] = $best
    } else {
      Write-Host "No versioned web-app deployment found for this Sheet." -ForegroundColor Yellow
      Write-Host "Output was:"
      Write-Host $output
      $discovered[$t.slug] = $null
    }
  } catch {
    Write-Host "FAILED: $_" -ForegroundColor Red
    $discovered[$t.slug] = $null
  }
}

if (Test-Path $claspFile) { Remove-Item $claspFile -Force }

Write-Host ""
Write-Host "=== Discovered deployment IDs ===" -ForegroundColor Cyan
Write-Host "Paste these into the matching entries in .clasp-targets.json:"
Write-Host ""
foreach ($slug in $discovered.Keys) {
  $id = $discovered[$slug]
  if ($id) {
    Write-Host ('  "{0}": "deploymentId": "{1}"' -f $slug, $id)
  } else {
    Write-Host ('  "{0}": (not found - check the Sheet has a published web-app deployment)' -f $slug) -ForegroundColor Yellow
  }
}
