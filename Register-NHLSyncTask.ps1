<#
.SYNOPSIS
  Registers (or removes) the nightly NHL cache sync as a Windows scheduled task for the
  current user. No administrator rights needed.

.EXAMPLE
  .\Register-NHLSyncTask.ps1                  # daily at 04:00 local time
  .\Register-NHLSyncTask.ps1 -Time 03:30
  .\Register-NHLSyncTask.ps1 -RunNow          # register, then start one run immediately
  .\Register-NHLSyncTask.ps1 -Unregister
#>
[CmdletBinding()]
param(
    [string]$Time = '04:00',
    [string]$ScriptPath = '',
    [string]$TaskName = 'NHLDash Nightly Sync',
    [switch]$Unregister,
    [switch]$RunNow
)

if (-not $ScriptPath) {
    $base = $PSScriptRoot
    if (-not $base) { $base = (Get-Location).Path }
    $ScriptPath = Join-Path $base 'Sync-NHLCache.ps1'
}

try {
    if ($Unregister) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
        Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Green
        return
    }

    if (-not (Test-Path $ScriptPath)) {
        Write-Host "Cannot find $ScriptPath. Keep Sync-NHLCache.ps1 next to this script or pass -ScriptPath." -ForegroundColor Red
        return
    }

    $arg = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $ScriptPath
    $action   = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg
    $trigger  = New-ScheduledTaskTrigger -Daily -At $Time
    # StartWhenAvailable = if the PC was asleep or off at the start time, run as soon as it can
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
                    -DontStopIfGoingOnBatteries -RunOnlyIfNetworkAvailable `
                    -ExecutionTimeLimit (New-TimeSpan -Hours 1)
    $me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited

    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal -Force -ErrorAction Stop | Out-Null

    Write-Host "Registered '$TaskName': daily at $Time as $me (runs while you are signed in)." -ForegroundColor Green
    Write-Host "Missed runs start as soon as the PC is awake and online. Remove with -Unregister."

    if ($RunNow) {
        Start-ScheduledTask -TaskName $TaskName
        Write-Host 'Started one run now. Progress: %LOCALAPPDATA%\NHLDash\cache\logs\' -ForegroundColor Green
    }
}
catch {
    Write-Host ("Could not change the scheduled task: " + $_.Exception.Message) -ForegroundColor Red
    Write-Host 'If access is denied, this machine may block user-level scheduled tasks; Sync-NHLCache.ps1 still runs fine by hand.'
}
