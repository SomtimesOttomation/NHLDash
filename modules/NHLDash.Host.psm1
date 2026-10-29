<#
.SYNOPSIS
    NHL dash backend for DashLauncher contract version 1. Contacts nothing: every number it shows is made up.
.DESCRIPTION
    Windows PowerShell 5.1. A small, complete example of the dash contract (DASH-CONTRACT.md in the DashLauncher repo),
    and a test tool for the launcher: the page can pretend there are live games, an update or a problem, and run a fake
    sync, so every tab badge, the stop button and tab switching can be tried without touching the network.

    There is no worker runspace here, because nothing slow happens. A real dash (NBADash) does its fetching in a worker
    runspace or a child process and only reads results in Receive-DashEvents; this one just works out its fake numbers
    there. Copy this folder as the starting point for a new dash and replace the fake parts.
#>

$script:Ctx = $null
$script:Root = Split-Path $PSScriptRoot
$script:Mutex = $null
$script:Version = '0.0.0'
$script:CacheDir = ''
$script:WebViewDataDir = ''
$script:S = $null
$script:SyncSeconds = 8

function New-DashState {
    return @{
        Visible = $false; Paused = $true; Halted = $false
        Ticks = 0; NextTick = [datetime]::MinValue
        Live = 0; Update = $false; Problem = $false
        SyncStart = $null; LastSyncPct = -1
        Requests = 0; Bytes = 0
    }
}

# ---------------------------------------------------------------- page messages
function Send-Page {
    param([string]$Json)
    try { if ($script:Ctx -and $script:Ctx.Post) { & $script:Ctx.Post $Json } } catch { }
}
function Reply { param($Id, [string]$DataJson = 'null') Send-Page ('{{"id":{0},"ok":true,"data":{1}}}' -f [int]$Id, $DataJson) }
function ReplyError { param($Id, [string]$Message) Send-Page ('{{"id":{0},"ok":false,"error":{1}}}' -f [int]$Id, (ConvertTo-Json -InputObject $Message -Compress)) }
function ConvertTo-PageJson { param($Object) return (ConvertTo-Json -InputObject $Object -Depth 5 -Compress) }

function Get-DashSnapshot {
    $s = $script:S
    return @{
        mode = [string]$script:Ctx.Mode; version = $script:Version; theme = [string]$script:Ctx.Theme
        launcherVersion = [string]$script:Ctx.LauncherVersion
        halted = $s.Halted; paused = $s.Paused; ticks = $s.Ticks
        live = $s.Live; update = $s.Update; problem = $s.Problem
        sync = (Get-SyncProgress)
        traffic = @{ requests = $s.Requests; bytes = $s.Bytes }
    }
}

function Get-SyncProgress {
    $s = $script:S
    if (-not $s.SyncStart) { return @{ running = $false; pct = 0 } }
    $pct = [int][Math]::Min(100, ((Get-Date) - $s.SyncStart).TotalSeconds / $script:SyncSeconds * 100)
    return @{ running = ($pct -lt 100); pct = $pct }
}

function Start-FakeSync {
    if ($script:S.Halted -or $script:S.SyncStart) { return $false }
    $script:S.SyncStart = Get-Date
    $script:S.LastSyncPct = -1
    return $true
}

# ---------------------------------------------------------------- contract functions
function Initialize-Dash {
    <# Takes the host lock and makes its folders. Starts nothing. #>
    param([Parameter(Mandatory)]$Context)
    if ($script:Ctx) { return @{ Ok = $true; Reason = ''; CacheDir = $script:CacheDir; WebViewDataDir = $script:WebViewDataDir } }
    $created = $false
    try { $m = New-Object System.Threading.Mutex($true, 'Local\DashHost-nhldash', [ref]$created) } catch { $m = $null }
    if (-not $m -or -not $created) {
        if ($m) { $m.Dispose() }
        return @{ Ok = $false; Reason = 'locked'; CacheDir = ''; WebViewDataDir = '' }
    }
    $script:Mutex = $m
    $script:Ctx = $Context
    if ($Context.Root) { $script:Root = [string]$Context.Root }
    try { $script:Version = ([IO.File]::ReadAllText((Join-Path $script:Root 'VERSION'))).Trim() } catch { }
    $base = Join-Path $env:LOCALAPPDATA 'NHLDash'
    $script:CacheDir = Join-Path $base 'cache'
    $script:WebViewDataDir = Join-Path $base 'webview2'
    foreach ($d in @($script:CacheDir, $script:WebViewDataDir)) { if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null } }
    $script:S = New-DashState
    return @{ Ok = $true; Reason = ''; CacheDir = $script:CacheDir; WebViewDataDir = $script:WebViewDataDir }
}

function Start-DashWorker {
    <# Visible: the tick counter runs, unless the launcher's stop button halted it. #>
    if (-not $script:S) { return }
    $script:S.Visible = $true
    if ($script:S.Halted) { return }
    $script:S.Paused = $false
    $script:S.NextTick = (Get-Date).AddSeconds(1)
}

function Suspend-DashWorker {
    <# Hidden: no timed work. A fake sync already running keeps going, as a real one would. #>
    if (-not $script:S) { return }
    $script:S.Visible = $false
    $script:S.Paused = $true
}

function Invoke-DashCommand {
    param([Parameter(Mandatory)]$Message)
    $id = $Message.id
    $a = $Message.args
    try {
        switch ([string]$Message.cmd) {
            'init' { Reply $id (ConvertTo-PageJson (Get-DashSnapshot)) }
            'nhldash.set' {
                switch ([string]$a.key) {
                    'live' { $n = 0; try { $n = [int]$a.value } catch { }; $script:S.Live = [Math]::Max(0, [Math]::Min(15, $n)) }
                    'update' { $script:S.Update = [bool]$a.value }
                    'problem' { $script:S.Problem = [bool]$a.value }
                    default { ReplyError $id 'unknown setting'; return }
                }
                Reply $id (ConvertTo-PageJson (Get-DashSnapshot))
            }
            'sync.run' {
                if ($script:S.Halted) { ReplyError $id 'Traffic is stopped. Resume first.'; return }
                Reply $id ((Start-FakeSync).ToString().ToLower())
            }
            'sync.cancel' { $script:S.SyncStart = $null; Reply $id 'true' }
            'traffic.stop' {
                Stop-DashTraffic                  # the same stop as the launcher's button
                Reply $id (ConvertTo-PageJson (Get-DashSnapshot))
            }
            'traffic.resume' {
                $script:S.Halted = $false
                $script:S.Paused = -not $script:S.Visible
                $script:S.NextTick = (Get-Date).AddSeconds(1)
                Send-Page '{"event":"traffic","data":{"stopped":false}}'
                Reply $id (ConvertTo-PageJson (Get-DashSnapshot))
            }
            default { ReplyError $id ('unknown command: ' + [string]$Message.cmd) }
        }
    } catch { ReplyError $id $_.Exception.Message }
}

function Receive-DashEvents {
    <# Every 250 ms. A real dash drains its worker's queue here; this one works out its fake events. #>
    $out = New-Object System.Collections.Generic.List[string]
    $s = $script:S
    if (-not $s) { return @() }
    $now = Get-Date
    if (-not $s.Paused -and -not $s.Halted -and $now -ge $s.NextTick) {
        $s.Ticks++
        $s.Requests++                     # simulated: nothing leaves this computer
        $s.Bytes += 512
        $s.NextTick = $now.AddSeconds(1)
        $out.Add((ConvertTo-PageJson @{ event = 'tick'; data = @{ ticks = $s.Ticks; traffic = @{ requests = $s.Requests; bytes = $s.Bytes } } }))
    }
    if ($s.SyncStart) {
        $p = Get-SyncProgress
        if ($p.pct -ne $s.LastSyncPct) {
            $s.LastSyncPct = $p.pct
            $out.Add((ConvertTo-PageJson @{ event = 'sync'; data = $p }))
        }
        if (-not $p.running) { $s.SyncStart = $null }
    }
    return $out.ToArray()       # unrolled: the caller gets one JSON string per item (wrap in @() for 0 or 1)
}

function Get-DashStatus {
    <# Every 2 seconds: no network, no disk. #>
    $s = $script:S
    if (-not $s) { return @{ Live = 0; Syncing = $false; SyncPct = $null; UpdateAvailable = $null; Error = $null; Traffic = @{ Requests = 0; Bytes = 0; Errors = 0 } } }
    $p = Get-SyncProgress
    return @{
        Live            = $s.Live
        Syncing         = $p.running
        SyncPct         = $(if ($p.running) { $p.pct } else { $null })
        UpdateAvailable = $(if ($s.Update) { '9.9.9' } else { $null })
        Error           = $(if ($s.Problem) { 'Pretend problem from the NHL dash.' } else { $null })
        Traffic         = @{ Requests = $s.Requests; Bytes = $s.Bytes; Errors = 0 }
    }
}

function Stop-DashTraffic {
    <# The launcher's stop button: cancel the fake sync, stop ticking, and wait for the person to resume here. #>
    if (-not $script:S) { return }
    $script:S.Halted = $true
    $script:S.Paused = $true
    $script:S.SyncStart = $null
    Send-Page '{"event":"traffic","data":{"stopped":true}}'
}

function Stop-Dash {
    <# Closing: release the host lock so the dash can open somewhere else. #>
    try { if ($script:Mutex) { $script:Mutex.ReleaseMutex(); $script:Mutex.Dispose() } } catch { }
    $script:Mutex = $null
    $script:Ctx = $null
    $script:S = $null
}

function Invoke-DashSync {
    <# Optional (the launcher's master sync, switched off for now): the fake sync. #>
    param([ValidateSet('quick')][string]$Scope = 'quick')
    if (-not $script:S) { return $false }
    return (Start-FakeSync)
}

Export-ModuleMember -Function Initialize-Dash, Start-DashWorker, Suspend-DashWorker, Invoke-DashCommand, Receive-DashEvents, Get-DashStatus, Stop-DashTraffic, Stop-Dash, Invoke-DashSync
