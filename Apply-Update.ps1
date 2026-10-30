<#
.SYNOPSIS
    Swaps in a staged NHLDash update after the app has closed, relaunches it, and rolls back if the new version does not start.
.DESCRIPTION
    Windows PowerShell 5.1. Started hidden by the dashboard from a copy in the update work folder, so replacing the app files
    cannot disturb this script. Never touches: lib\ (WebView2 DLLs), the cache, settings, logs, or the update folder.
    Steps: wait for the app to exit -> back up the current files -> copy the staged files over -> relaunch ->
    wait for the new app to write the "ok" marker (it does that once its window has loaded) -> otherwise restore the backup.
#>
param(
    [Parameter(Mandatory)][string]$AppDir,
    [Parameter(Mandatory)][string]$StageDir,
    [Parameter(Mandatory)][string]$WorkDir,
    [Parameter(Mandatory)][int]$ParentPid,
    [string]$Relaunch = '',            # what to start afterwards (Context.Relaunch): the dash's own .bat, or a DashLauncher command line
    [string]$RelaunchB64 = '',         # the same, base64 (UTF-8), so quotes and arguments survive the trip unchanged
    [Parameter(Mandatory)][string]$OldVersion,
    [Parameter(Mandatory)][string]$NewVersion,
    [int]$OkWaitSeconds = 60
)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$AppDir = [IO.Path]::GetFullPath($AppDir).TrimEnd('\', '/')
if ($RelaunchB64) { try { $Relaunch = $utf8.GetString([Convert]::FromBase64String($RelaunchB64)) } catch { $Relaunch = '' } }
if (-not $Relaunch) { $Relaunch = '"' + (Join-Path $AppDir 'Start-NHLDash.bat') + '"' }
# Context.Relaunch is run exactly as given and may carry arguments, e.g.  "C:\Apps\DashLauncher\Start-DashLauncher.bat" -Open nhldash
# Split it only to find the .bat (for the working folder and for spotting a stuck copy during rollback).
$Relaunch = $Relaunch.Trim()
if ($Relaunch -match '^"([^"]+)"\s*(.*)$') { $relaunchFile = $Matches[1]; $relaunchArgs = $Matches[2] }
elseif ($Relaunch -match '^(.+?\.(?:bat|cmd))(?:\s+(.*))?$') { $relaunchFile = $Matches[1]; $relaunchArgs = [string]$Matches[2] }
else { $relaunchFile = $Relaunch; $relaunchArgs = '' }
$relaunchFile = [IO.Path]::GetFullPath($relaunchFile)
$relaunchDir = Split-Path $relaunchFile
$relaunchScript = [IO.Path]::GetFileNameWithoutExtension($relaunchFile) + '.ps1'
$StageDir = [IO.Path]::GetFullPath($StageDir).TrimEnd('\', '/')
$logFile = Join-Path $WorkDir 'apply.log'
$backupRoot = Join-Path $WorkDir 'backup'
$backupDir = Join-Path $backupRoot ("v{0}" -f $OldVersion)
$pendingFile = Join-Path $WorkDir 'update-pending.json'
$okFile = Join-Path $WorkDir 'update-ok.json'
$failFile = Join-Path $WorkDir 'update-failed.json'
$skip = 'lib', 'update', '.git'          # top-level folders that are never backed up, overwritten or deleted

function Write-Log {
    param([string]$Text)
    try { [IO.File]::AppendAllText($logFile, ("{0}  {1}`r`n" -f (Get-Date).ToString('s'), $Text), $utf8) } catch { }
}

function Get-RelFiles {
    param([string]$Root)
    $r = $Root.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    foreach ($f in Get-ChildItem $Root -Recurse -File -Force) {
        $rel = $f.FullName.Substring($r.Length)
        if ($skip -contains ($rel -split '[\\/]')[0].ToLowerInvariant()) { continue }
        $rel
    }
}

function Copy-Rel {
    param([string]$From, [string]$To, [string]$Rel)
    $src = Join-Path $From $Rel
    $dst = Join-Path $To $Rel
    $dir = Split-Path $dst
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    Copy-Item -Path $src -Destination $dst -Force
}

function Restore-Backup {
    param([string[]]$NewFiles)
    Write-Log 'Rolling back to the previous version'
    $old = @(Get-RelFiles $backupDir)
    foreach ($rel in $NewFiles) { if ($old -notcontains $rel) { Remove-Item (Join-Path $AppDir $rel) -Force -ErrorAction SilentlyContinue } }
    foreach ($rel in $old) { Copy-Rel $backupDir $AppDir $rel }
}

function Start-App {
    # Same entry point the person double-clicks (the dash's .bat, or DashLauncher's): it re-checks lib\ and starts the hidden host.
    $extra = @{}
    if ($PSVersionTable.PSEdition -ne 'Core' -or $IsWindows) { $extra.WindowStyle = 'Hidden' }     # (PowerShell 7 on Linux has no such switch: test runs only)
    # cmd /c ""file.bat" args": the outer quotes keep cmd from stripping the inner ones when the path has spaces
    $line = ('"{0}"' -f $relaunchFile) + $(if ($relaunchArgs) { ' ' + $relaunchArgs } else { '' })
    Start-Process -FilePath $env:ComSpec -ArgumentList '/c', ('"{0}"' -f $line) -WorkingDirectory $relaunchDir @extra
}

function Stop-App {
    # Anything still running the (new) app from this folder, found by its command line.
    try {
        $mine = $PID
        Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object {
            $_.ProcessId -ne $mine -and $_.CommandLine -and ($_.CommandLine -like "*$AppDir*Start-NHLDash.ps1*" -or $_.CommandLine -like "*$relaunchDir*$relaunchScript*")
        } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    } catch { }
}

$newFiles = @()
$swapped = $false
$parentGone = $false
try {
    Write-Log "Update $OldVersion -> $NewVersion starting"
    Remove-Item $okFile, $failFile -Force -ErrorAction SilentlyContinue

    # 1. wait for the app to close
    $deadline = (Get-Date).AddSeconds(45)
    while ((Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
    if (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) { throw 'The dashboard did not close in time, so nothing was changed.' }
    $parentGone = $true
    Start-Sleep -Milliseconds 500

    # 2. sanity: the staged package must still be there
    if (-not (Test-Path (Join-Path $StageDir 'Start-NHLDash.ps1'))) { throw 'The downloaded update is no longer available.' }
    $newFiles = @(Get-RelFiles $StageDir)
    $oldFiles = @(Get-RelFiles $AppDir)

    # 3. back up the current files (replaces any earlier backup of the same version)
    if (Test-Path $backupRoot) { Remove-Item $backupRoot -Recurse -Force }
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    foreach ($rel in $oldFiles) { Copy-Rel $AppDir $backupDir $rel }
    Write-Log ("Backed up {0} files" -f $oldFiles.Count)

    # 4. swap: copy new files in, then delete files the new version no longer has
    $swapped = $true
    foreach ($rel in $newFiles) { Copy-Rel $StageDir $AppDir $rel }
    # only app-owned folders are cleaned of leftovers; files the user keeps next to the scripts are left alone
    foreach ($rel in $oldFiles) {
        if ($newFiles -notcontains $rel -and $rel -match '^(ui|modules)[\\/]') { Remove-Item (Join-Path $AppDir $rel) -Force -ErrorAction SilentlyContinue }
    }
    Write-Log ("Copied {0} files" -f $newFiles.Count)

    # 5. relaunch and wait for the new app to say it loaded
    [IO.File]::WriteAllText($pendingFile, (@{ from = $OldVersion; to = $NewVersion; at = (Get-Date).ToString('o') } | ConvertTo-Json), $utf8)
    Start-App
    Write-Log 'Relaunched; waiting for the new version to confirm'
    $deadline = (Get-Date).AddSeconds($OkWaitSeconds)
    while (-not (Test-Path $okFile) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
    if (-not (Test-Path $okFile)) { throw 'The new version did not start.' }

    Write-Log 'New version confirmed'
    Remove-Item $StageDir -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $WorkDir 'staged.json') -Force -ErrorAction SilentlyContinue
    exit 0
} catch {
    $why = $_.Exception.Message
    Write-Log "FAILED: $why"
    try {
        if ($swapped) {
            Stop-App
            Start-Sleep -Milliseconds 800
            Restore-Backup $newFiles
            Remove-Item $pendingFile -Force -ErrorAction SilentlyContinue
            [IO.File]::WriteAllText($failFile, (@{ from = $OldVersion; to = $NewVersion; reason = $why; at = (Get-Date).ToString('o') } | ConvertTo-Json), $utf8)
            Start-App
        } elseif ($parentGone) {
            [IO.File]::WriteAllText($failFile, (@{ from = $OldVersion; to = $NewVersion; reason = $why; at = (Get-Date).ToString('o') } | ConvertTo-Json), $utf8)
            Start-App
        }
    } catch { Write-Log "Rollback problem: $($_.Exception.Message)" }
    exit 1
}
