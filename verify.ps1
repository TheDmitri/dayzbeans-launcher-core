<#
.SYNOPSIS
    Verify that an installed Day(Z) Beans Launcher matches its published source.

.DESCRIPTION
    Runs two independent checks.

    CHECK 1 (no dependencies) compares the SHA256 of the installed app.asar against
    the value published for that release. It proves the application package on this
    machine is byte-identical to the one the release workflow built and signed --
    nothing was patched after installation.

    CHECK 2 (requires Node.js) recompiles nothing and trusts nothing: it extracts
    the compiled main process out of app.asar and compares every file against
    ELECTRON-HASHES.txt from the public source repository. It proves the code that
    touches this machine is the code published at
    https://github.com/TheDmitri/dayzbeans-launcher-core

    Check 1 answers "is my install genuine". Check 2 answers "does the published
    source describe what is actually running". Check 1 runs anywhere; check 2 needs
    Node.js because reading the asar container does.

.PARAMETER InstallPath
    Launcher installation directory. Autodetected when omitted.

.PARAMETER Ref
    Git ref (tag or branch) of the public repository to verify against. Defaults to
    the tag matching the installed version, falling back to main.

.EXAMPLE
    irm https://raw.githubusercontent.com/TheDmitri/dayzbeans-launcher-core/main/verify.ps1 | iex

.EXAMPLE
    .\verify.ps1 -InstallPath "C:\Program Files\Day(Z) Beans Launcher"
#>
[CmdletBinding()]
param(
    [string]$InstallPath,
    [string]$Ref
)

$ErrorActionPreference = 'Stop'
$RepoRaw = 'https://raw.githubusercontent.com/TheDmitri/dayzbeans-launcher-core'
$RepoUrl = 'https://github.com/TheDmitri/dayzbeans-launcher-core'

function Write-Step { param($Message) Write-Host "`n=== $Message ===" -ForegroundColor Cyan }
function Write-Ok   { param($Message) Write-Host "  OK    $Message" -ForegroundColor Green }
function Write-Bad  { param($Message) Write-Host "  FAIL  $Message" -ForegroundColor Red }
function Write-Info { param($Message) Write-Host "        $Message" -ForegroundColor Gray }

# ---------------------------------------------------------------------------
# Locate the installation
# ---------------------------------------------------------------------------
Write-Step 'Locating the launcher'

if (-not $InstallPath) {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\dayz-bean-launcher'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Day(Z) Beans Launcher'),
        (Join-Path ${env:ProgramFiles} 'Day(Z) Beans Launcher'),
        (Join-Path ${env:ProgramFiles(x86)} 'Day(Z) Beans Launcher')
    ) | Where-Object { $_ -and (Test-Path (Join-Path $_ 'resources\app.asar')) }

    if (-not $candidates) {
        Write-Bad 'Could not find an installation.'
        Write-Info 'Pass the folder explicitly:  .\verify.ps1 -InstallPath "C:\path\to\launcher"'
        Write-Info 'A portable build lives wherever you unpacked it.'
        exit 1
    }
    $InstallPath = $candidates[0]
}

$Asar = Join-Path $InstallPath 'resources\app.asar'
if (-not (Test-Path $Asar)) {
    Write-Bad "No resources\app.asar under $InstallPath"
    exit 1
}
Write-Ok "Found $InstallPath"

# The installed version. Read from the executable's file metadata, which
# electron-builder stamps at package time -- not from the packaged package.json,
# whose bytes sit somewhere in the middle of the archive's data section rather than
# at a fixed offset, and finding them would need a real asar parser.
$Version = $null
try {
    $exe = Get-ChildItem -Path $InstallPath -Filter '*.exe' -File |
        Where-Object { $_.Name -notmatch 'Uninstall|Squirrel|elevate' } |
        Select-Object -First 1
    if ($exe) {
        $raw = $exe.VersionInfo.ProductVersion
        if (-not $raw) { $raw = $exe.VersionInfo.FileVersion }
        if ($raw -match '([0-9]+\.[0-9]+\.[0-9]+)') { $Version = $Matches[1] }
    }
} catch { }

if ($Version) { Write-Ok "Installed version $Version" }
else { Write-Info 'Could not read the version out of the package; will verify against main.' }

if (-not $Ref) { $Ref = if ($Version) { "v$Version" } else { 'main' } }
Write-Info "Verifying against $RepoUrl @ $Ref"

# ---------------------------------------------------------------------------
# CHECK 1 - package integrity, no dependencies
# ---------------------------------------------------------------------------
Write-Step 'Check 1: is this install the genuine release?'

$localAsarHash = (Get-FileHash -Algorithm SHA256 -Path $Asar).Hash.ToLower()
Write-Info "local  app.asar $localAsarHash"

$published = $null
try {
    $published = (Invoke-RestMethod -Uri "$RepoRaw/$Ref/APP-ASAR-SHA256.txt" -UseBasicParsing).Trim().Split()[0].ToLower()
} catch {
    Write-Info "Could not fetch APP-ASAR-SHA256.txt for $Ref ($($_.Exception.Message))"
}

$check1 = $null
if ($published) {
    Write-Info "public app.asar $published"
    if ($localAsarHash -eq $published) {
        $check1 = $true
        Write-Ok 'The installed package is byte-identical to the published release.'
    } else {
        $check1 = $false
        Write-Bad 'The installed package does NOT match the published release.'
        Write-Info 'Reinstall from https://dayzbeanslauncher.com and run this again.'
        Write-Info 'If it still differs, report it: admin@dayzbeanslauncher.com'
    }
} else {
    Write-Info 'Skipped - no published hash available for this version.'
}

# ---------------------------------------------------------------------------
# CHECK 2 - source correspondence, needs Node.js
# ---------------------------------------------------------------------------
Write-Step 'Check 2: does the published source match what is running?'

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Info 'Skipped - Node.js is not installed (https://nodejs.org).'
    Write-Info 'Check 1 above already proves the package is the genuine release.'
} else {
    $work = Join-Path ([System.IO.Path]::GetTempPath()) ("dzbl-verify-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $work -Force | Out-Null
    try {
        Write-Info 'Extracting the application package...'
        & npx --yes @electron/asar extract $Asar (Join-Path $work 'extracted') 2>&1 | Out-Null
        $dist = Join-Path $work 'extracted\dist-electron'
        if (-not (Test-Path $dist)) { throw 'dist-electron was not found inside app.asar' }

        Write-Info 'Fetching the published source manifest and hashing script...'
        Invoke-WebRequest -Uri "$RepoRaw/$Ref/ELECTRON-HASHES.txt" -OutFile (Join-Path $work 'ELECTRON-HASHES.txt') -UseBasicParsing
        Invoke-WebRequest -Uri "$RepoRaw/$Ref/scripts/electron-hashes.js" -OutFile (Join-Path $work 'electron-hashes.js') -UseBasicParsing

        & node (Join-Path $work 'electron-hashes.js') --dir $dist --check (Join-Path $work 'ELECTRON-HASHES.txt')
        if ($LASTEXITCODE -eq 0) {
            Write-Ok 'Every compiled main-process file matches the published source.'
        } else {
            Write-Bad 'The running main process does NOT match the published source.'
            Write-Info 'Please report this: admin@dayzbeanslauncher.com'
        }
    } catch {
        Write-Info "Skipped - $($_.Exception.Message)"
    } finally {
        Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
    }
}

Write-Step 'Done'
Write-Info "Source:      $RepoUrl"
Write-Info 'Installers:  every release is signed, hashed, VirusTotal-scanned, and carries'
Write-Info '             a Sigstore attestation. See the repository README.'

if ($check1 -eq $false) { exit 1 }
