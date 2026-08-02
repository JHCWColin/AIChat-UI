param(
    [switch]$PreviewOnly
)

$ErrorActionPreference = 'Stop'

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

function Normalize-Version {
    param(
        [Parameter(Mandatory = $true)][string]$VersionText
    )

    $parts = @($VersionText.Split('.') | Where-Object { $_ -ne '' })
    if ($parts.Count -eq 0) {
        throw "Failed to parse version: $VersionText"
    }

    while ($parts.Count -lt 3) {
        $parts += '0'
    }

    if ($parts.Count -gt 3) {
        $parts = $parts[0..2]
    }

    return ($parts -join '.')
}

function Prompt-ForValue {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [AllowEmptyString()][string]$CurrentValue
    )

    $displayValue = if ([string]::IsNullOrEmpty($CurrentValue)) { '<empty>' } else { $CurrentValue }
    Write-Host "$Label current value: $displayValue" -ForegroundColor Cyan
    $newValue = Read-Host 'Enter a new value, or press Enter to keep the current value'
    if ([string]::IsNullOrWhiteSpace($newValue)) {
        return $CurrentValue
    }
    return $newValue.Trim()
}

$repoRoot = Split-Path -Parent $PSCommandPath
$indexPath = Join-Path $repoRoot 'index.html'
$packagePath = Join-Path $repoRoot 'package.json'
$packageLockPath = Join-Path $repoRoot 'package-lock.json'

if (-not (Test-Path $indexPath)) {
    throw "index.html not found: $indexPath"
}

if (-not (Test-Path $packagePath)) {
    throw "package.json not found: $packagePath"
}

$indexHtml = Get-Content -Path $indexPath -Raw -Encoding UTF8
$versionNodeMatch = [regex]::Match(
    $indexHtml,
    '<[^>]*id=["'']app-version["''][^>]*>(?<text>[^<]+)<',
    [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
)

if (-not $versionNodeMatch.Success) {
    throw 'Could not find the app-version node in index.html.'
}

$displayVersionText = $versionNodeMatch.Groups['text'].Value.Trim()
$versionMatch = [regex]::Match($displayVersionText, '(?<version>\d+(?:\.\d+){0,2})')
if (-not $versionMatch.Success) {
    throw "Could not parse a semantic version from: $displayVersionText"
}

$normalizedVersion = Normalize-Version $versionMatch.Groups['version'].Value
$package = Get-Content -Path $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json

Write-Host "About page version: $displayVersionText" -ForegroundColor Green
Write-Host "Normalized package version: $normalizedVersion" -ForegroundColor Green

if ($PreviewOnly) {
    Write-Host ''
    Write-Host 'Preview mode only. No files will be changed and no build will run.' -ForegroundColor Yellow
    Write-Host "name: $($package.name)"
    Write-Host "description: $($package.description)"
    Write-Host "author: $($package.author)"
    if ($null -ne $package.build) {
        Write-Host "build.productName: $($package.build.productName)"
        Write-Host "build.appId: $($package.build.appId)"
    }
    exit 0
}

Write-Host ''
Write-Host 'You can update base package fields now. Press Enter to keep the current value.' -ForegroundColor Yellow

$package.version = $normalizedVersion
$package.description = Prompt-ForValue -Label 'description' -CurrentValue ([string]$package.description)
$package.author = Prompt-ForValue -Label 'author' -CurrentValue ([string]$package.author)
$package.name = Prompt-ForValue -Label 'name' -CurrentValue ([string]$package.name)

if ($null -ne $package.build) {
    $package.build.productName = Prompt-ForValue -Label 'build.productName' -CurrentValue ([string]$package.build.productName)
    $package.build.appId = Prompt-ForValue -Label 'build.appId' -CurrentValue ([string]$package.build.appId)
}

Write-Host ''
Write-Host 'The following values will be written before build:' -ForegroundColor Yellow
Write-Host "version: $($package.version)"
Write-Host "description: $($package.description)"
Write-Host "author: $($package.author)"
Write-Host "name: $($package.name)"
if ($null -ne $package.build) {
    Write-Host "build.productName: $($package.build.productName)"
    Write-Host "build.appId: $($package.build.appId)"
}

$confirmation = Read-Host 'Write package files and start npm run build? (Y/N)'
if ($confirmation -notmatch '^(?i:y|yes)$') {
    Write-Host 'Build cancelled.' -ForegroundColor Yellow
    exit 0
}

$packageJson = ($package | ConvertTo-Json -Depth 100) + "`r`n"
Write-Utf8NoBom -Path $packagePath -Content $packageJson

if (Test-Path $packageLockPath) {
    $packageLock = Get-Content -Path $packageLockPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $packageLock.version = $normalizedVersion
    if ($package.PSObject.Properties.Name -contains 'name') {
        $packageLock.name = $package.name
    }
    if ($null -ne $packageLock.packages -and $null -ne $packageLock.packages.'') {
        $packageLock.packages.''.version = $normalizedVersion
        if ($package.PSObject.Properties.Name -contains 'name') {
            $packageLock.packages.''.name = $package.name
        }
    }
    $packageLockJson = ($packageLock | ConvertTo-Json -Depth 100) + "`r`n"
    Write-Utf8NoBom -Path $packageLockPath -Content $packageLockJson
}

Push-Location $repoRoot
try {
    Write-Host ''
    Write-Host 'Running npm run build ...' -ForegroundColor Green
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) {
        throw "npm run build failed with exit code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}

Write-Host ''
Write-Host 'Build completed.' -ForegroundColor Green
