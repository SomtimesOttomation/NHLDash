<#
.SYNOPSIS
    NHLDash season sync with no window: saves the season's weeks, standings, rookies and every finished game's
    box score to %LOCALAPPDATA%\NHLDash\cache, exactly as the "Sync season" button does.
.DESCRIPTION
    Run by the nightly scheduled task (Register-NHLSyncTask.ps1), or by hand. Skips itself when NHLDash is open.
    Already-saved finished games are not downloaded again. Log: %LOCALAPPDATA%\NHLDash\cache\logs\sync.log
#>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$logDir = Join-Path $env:LOCALAPPDATA 'NHLDash\cache\logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$log = Join-Path $logDir 'sync.log'
function Write-Log([string]$Text) { Add-Content -LiteralPath $log -Value ('{0}  {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $Text) }
try {
    Write-Log 'Nightly sync started.'
    $m = Import-Module (Join-Path $root 'modules\NHLDash.Host.psm1') -Force -PassThru
    $result = & $m { param($r) Invoke-NhlHeadlessSync -Root $r } $root
    Write-Log $result
} catch {
    Write-Log ('Failed: ' + $_.Exception.Message)
}
# keep the log short
try { $lines = Get-Content -LiteralPath $log; if ($lines.Count -gt 400) { $lines[-300..-1] | Set-Content -LiteralPath $log } } catch { }
