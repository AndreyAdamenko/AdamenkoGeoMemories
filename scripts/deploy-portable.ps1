[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ArchiveRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$archivePath = (Resolve-Path -LiteralPath $ArchiveRoot).Path.TrimEnd('\')
$deployPath = [IO.Path]::GetFullPath((Join-Path $archivePath '_GeoMemories'))
$targetData = Join-Path $deployPath 'data'
$localNode = Join-Path $repoRoot 'node_modules\node\bin\node.exe'
$utf8 = [Text.UTF8Encoding]::new($false)

function Test-Within([string]$Parent, [string]$Child) {
    $parentPath = [IO.Path]::GetFullPath($Parent).TrimEnd('\')
    $childPath = [IO.Path]::GetFullPath($Child).TrimEnd('\')
    return $childPath.Equals($parentPath, [StringComparison]::OrdinalIgnoreCase) -or $childPath.StartsWith($parentPath + '\', [StringComparison]::OrdinalIgnoreCase)
}
function Write-Json([string]$File, $Value) {
    [IO.File]::WriteAllText($File, ($Value | ConvertTo-Json -Depth 10), $utf8)
}
function Copy-Tree([string]$Source, [string]$Target) {
    & robocopy.exe $Source $Target /E /COPY:DAT /DCOPY:T /XJ /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Copy failed: $Source -> $Target (robocopy $LASTEXITCODE)" }
}
function Assert-ServerStopped([int]$Port) {
    $running = $null
    try { $running = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/status" -TimeoutSec 2 } catch {}
    if ($null -ne $running) { throw "Stop the photo server on port $Port before transferring its data." }
}

if (-not (Test-Path -LiteralPath $localNode)) { throw 'Install project dependencies first.' }
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'dist\index.html'))) { throw 'Run npm run build first.' }
if ((Test-Within $deployPath $repoRoot) -or (Test-Within $repoRoot $deployPath)) { throw 'Deployment must be separate from the source checkout.' }
if ((Test-Path -LiteralPath $deployPath) -and -not (Test-Path -LiteralPath (Join-Path $deployPath '.geo-memories-app'))) { throw "Destination exists without an application marker: $deployPath" }

Push-Location -LiteralPath $repoRoot
try {
    $resolvedJson = & $localNode --input-type=module --eval 'import {loadConfig} from "./server/config.ts"; console.log(JSON.stringify(loadConfig()));'
    if ($LASTEXITCODE -ne 0) { throw 'Could not resolve source settings.' }
    $settings = $resolvedJson | ConvertFrom-Json
    $sourceData = [IO.Path]::GetFullPath($settings.dataDir)
    $sameData = $sourceData.Equals([IO.Path]::GetFullPath($targetData), [StringComparison]::OrdinalIgnoreCase)
    Assert-ServerStopped $settings.port
    if (-not $sameData -and (Test-Path -LiteralPath (Join-Path $targetData 'catalog.sqlite'))) { throw 'Both locations contain a catalog. Automatic merge is not supported; both copies are unchanged.' }

    New-Item -ItemType Directory -Path $deployPath -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $deployPath '.geo-memories-app'), "GeoMemories portable application v1`n", $utf8)
    foreach ($folder in @('server', 'src', 'public', 'docs', 'scripts', 'tests', 'dist', 'node_modules')) {
        Write-Host "Copying $folder..."
        Copy-Tree (Join-Path $repoRoot $folder) (Join-Path $deployPath $folder)
    }
    foreach ($file in @('package.json', 'package-lock.json', 'README.md', 'PORTABLE.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'index.html', 'tsconfig.json', 'vite.config.ts', 'config.example.json')) {
        Copy-Item -LiteralPath (Join-Path $repoRoot $file) -Destination (Join-Path $deployPath $file) -Force
    }
    $batch = [IO.File]::ReadAllText((Join-Path $repoRoot 'portable\start-server.bat')) -replace '\r?\n', "`r`n"
    [IO.File]::WriteAllText((Join-Path $deployPath 'start-server.bat'), $batch, $utf8)
    $publicBatch = [IO.File]::ReadAllText((Join-Path $repoRoot 'portable\start-public.bat')) -replace '\r?\n', "`r`n"
    [IO.File]::WriteAllText((Join-Path $deployPath 'start-public.bat'), $publicBatch, $utf8)
    Write-Json (Join-Path $deployPath 'config.local.json') @{ sourceRoot = '..'; dataDir = './data'; portable = $true; port = $settings.port; importConcurrency = $settings.importConcurrency }

    $manifest = @()
    $locks = [Collections.Generic.List[IDisposable]]::new()
    try {
        Assert-ServerStopped $settings.port
        if (-not $sameData -and (Test-Path -LiteralPath $sourceData)) {
            foreach ($name in @('catalog.sqlite', 'catalog.sqlite-wal', 'catalog.sqlite-shm')) {
                $dbFile = Join-Path $sourceData $name
                if (Test-Path -LiteralPath $dbFile) { $locks.Add([IO.File]::Open($dbFile, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)) }
            }
            Write-Host 'Copying catalog and previews...'
            Copy-Tree $sourceData $targetData
            foreach ($file in Get-ChildItem -LiteralPath $sourceData -File -Recurse -Force) {
                if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked files in application data are not supported.' }
                $relative = [IO.Path]::GetRelativePath($sourceData, $file.FullName)
                $targetFile = Join-Path $targetData $relative
                $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
                if (-not (Test-Path -LiteralPath $targetFile) -or (Get-FileHash -LiteralPath $targetFile -Algorithm SHA256).Hash -ne $hash) { throw "Data verification failed: $relative. Source data is retained." }
                $manifest += [PSCustomObject]@{ path = $relative; bytes = $file.Length; sha256 = $hash }
            }
        } else { New-Item -ItemType Directory -Path $targetData -Force | Out-Null }
    } finally { foreach ($handle in $locks) { $handle.Dispose() } }

    $backupDir = Join-Path $repoRoot '.deployment-backups'
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    if ($manifest.Count) {
        Write-Json (Join-Path $backupDir 'transferred-data-manifest.json') $manifest
        $backupFile = Join-Path $backupDir ('catalog-before-portable-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '.sqlite')
        & $localNode --input-type=module --eval 'import {DatabaseSync} from "node:sqlite"; const db=new DatabaseSync(process.argv[1]); try{db.prepare("VACUUM INTO ?").run(process.argv[2]);}finally{db.close();}' (Join-Path $targetData 'catalog.sqlite') $backupFile
        if ($LASTEXITCODE -ne 0) { throw 'Catalog backup failed. Source data is retained.' }
    }

    Write-Host 'Verifying the deployed runtime, catalog, map and photo preview...'
    Push-Location -LiteralPath $deployPath
    try {
        & (Join-Path $deployPath 'node_modules\node\bin\node.exe') (Join-Path $deployPath 'scripts\verify-portable.ts')
        if ($LASTEXITCODE -ne 0) { throw 'Deployed application verification failed. Source data is retained.' }
    } finally { Pop-Location }

    $workspaceConfig = Join-Path $repoRoot 'config.local.json'
    if (Test-Path -LiteralPath $workspaceConfig) { Copy-Item -LiteralPath $workspaceConfig -Destination (Join-Path $backupDir 'config.before-portable.json') -Force }
    Write-Json $workspaceConfig @{ sourceRoot = $archivePath; dataDir = $targetData; portable = $false; port = $settings.port; importConcurrency = $settings.importConcurrency }
    $archivedLocalData = $null
    if (-not $sameData -and $manifest.Count) {
        # Retain all old data in a reversible backup; never recursively delete it.
        $expectedData = [IO.Path]::GetFullPath((Join-Path $repoRoot 'data'))
        if ($sourceData.Equals($expectedData, [StringComparison]::OrdinalIgnoreCase) -and (Test-Within $repoRoot $sourceData) -and -not (Test-Within $sourceData $deployPath)) {
            if ((Get-Item -LiteralPath $sourceData).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing to move a linked source directory.' }
            if (@(Get-ChildItem -LiteralPath $sourceData -File -Recurse -Force).Count -ne $manifest.Count) { throw 'Source data changed during deployment; it has been retained in place.' }
            foreach ($entry in $manifest) {
                $current = Join-Path $sourceData $entry.path
                if ((Get-FileHash -LiteralPath $current -Algorithm SHA256).Hash -ne $entry.sha256) { throw 'Source data changed during deployment; it has been retained.' }
            }
            $archivedLocalData = [IO.Path]::GetFullPath((Join-Path $backupDir ('data-before-portable-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))))
            if (-not (Test-Within $repoRoot $archivedLocalData) -or (Test-Path -LiteralPath $archivedLocalData)) { throw 'Invalid backup destination; source data is retained in place.' }
            Move-Item -LiteralPath $sourceData -Destination $archivedLocalData
        }
    }
    $transferredBytes = if ($manifest.Count) { ($manifest | Measure-Object bytes -Sum).Sum } else { 0 }
    $report = @{ deployedAtUtc = [DateTime]::UtcNow.ToString('o'); app = $deployPath; data = $targetData; verifiedDataFiles = $manifest.Count; transferredDataBytes = $transferredBytes; localDataBackup = $archivedLocalData; launcher = (Join-Path $deployPath 'start-server.bat'); catalogBackupDirectory = $backupDir }
    Write-Json (Join-Path $repoRoot 'portable-deployment-report.json') $report
    Write-Json (Join-Path $deployPath 'deployment-report.json') $report
    Write-Host "Ready: $(Join-Path $deployPath 'start-server.bat')"
} finally { Pop-Location }
