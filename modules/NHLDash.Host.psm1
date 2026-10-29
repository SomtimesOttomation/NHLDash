<#
.SYNOPSIS
    NHL dash backend for DashLauncher contract version 1.
.DESCRIPTION
    Windows PowerShell 5.1. The page asks for data by key ("score:2026-10-29", "box:2026020190", ...). Keys are checked
    against a fixed list and turned into URLs here, never by the page. A worker runspace downloads them one at a time,
    saves a copy in the cache folder and queues the raw text for the page; Receive-DashEvents hands it over.

    Sources (listed in dash.json):
      - NHL web API, api-web.nhle.com: scores, game centre (box score, play-by-play), standings, leaders.
        Team logos come from assets.nhle.com and are cached on disk.
      - MoneyPuck season summary CSVs (optional, off by default): only the published files on moneypuck.com/data.htm,
        at most once every 12 hours, credited on screen. Non-commercial use only.

    Fetching rules: nothing is fetched until the page asks (the person opened a view or pressed Refresh). Automatic
    refresh is opt-in, interval clamped to 20-600 seconds, and only runs while the tab is visible and not paused.
#>

$script:Ctx = $null
$script:Root = Split-Path $PSScriptRoot
$script:Mutex = $null
$script:Version = '0.0.0'
$script:CacheDir = ''
$script:WebViewDataDir = ''
$script:SettingsFile = ''
$script:Settings = $null
$script:Visible = $false
$script:Watch = @()
$script:NextAuto = [datetime]::MaxValue
$script:SyncKeys = $null
$script:Shared = $null
$script:Queue = $null
$script:Out = $null
$script:Worker = $null
$script:WorkerHandle = $null

$script:NhlApi = 'https://api-web.nhle.com/v1/'
$script:LogoBase = 'https://assets.nhle.com/logos/nhl/svg/'
$script:MoneyPuck = 'https://moneypuck.com/moneypuck/playerData/seasonSummary/'

function New-DefaultSettings {
    return [ordered]@{ autoRefresh = $false; autoAck = $false; refreshSeconds = 60; moneypuck = $false; mpAck = $false; favTeam = '' }
}

# ---------------------------------------------------------------- page messages
function Send-Page {
    param([string]$Json)
    try { if ($script:Ctx -and $script:Ctx.Post) { & $script:Ctx.Post $Json } } catch { }
}
function Reply { param($Id, [string]$DataJson = 'null') Send-Page ('{{"id":{0},"ok":true,"data":{1}}}' -f [int]$Id, $DataJson) }
function ReplyError { param($Id, [string]$Message) Send-Page ('{{"id":{0},"ok":false,"error":{1}}}' -f [int]$Id, (ConvertTo-Json -InputObject $Message -Compress)) }
function ConvertTo-PageJson { param($Object) return (ConvertTo-Json -InputObject $Object -Depth 5 -Compress) }

# ---------------------------------------------------------------- settings
function Read-Settings {
    $s = New-DefaultSettings
    try {
        if (Test-Path $script:SettingsFile) {
            $j = [IO.File]::ReadAllText($script:SettingsFile) | ConvertFrom-Json
            foreach ($k in @($s.Keys)) { if ($null -ne $j.$k) { $s[$k] = $j.$k } }
        }
    } catch { }
    $s.autoRefresh = [bool]$s.autoRefresh; $s.autoAck = [bool]$s.autoAck
    $s.moneypuck = [bool]$s.moneypuck; $s.mpAck = [bool]$s.mpAck
    $s.refreshSeconds = Limit-Seconds $s.refreshSeconds
    if ([string]$s.favTeam -notmatch '^[A-Z]{3}$') { $s.favTeam = '' }
    return $s
}
function Save-Settings {
    try { [IO.File]::WriteAllText($script:SettingsFile, (ConvertTo-Json -InputObject $script:Settings -Compress)) } catch { }
}
function Limit-Seconds { param($Value) $n = 60; try { $n = [int]$Value } catch { }; return [Math]::Max(20, [Math]::Min(600, $n)) }

# ---------------------------------------------------------------- data keys
function Get-SeasonStartYear {
    $d = Get-Date
    if ($d.Month -ge 9) { return $d.Year } else { return $d.Year - 1 }
}

function Resolve-DataKey {
    <# Turns a page key into a download spec, or $null if the key is not allowed. The page never supplies a URL. #>
    param([string]$Key)
    $k = [string]$Key
    if ($k -match '^score:(\d{4}-\d{2}-\d{2})$') {
        $today = (Get-Date).ToString('yyyy-MM-dd')
        $ttl = if ($Matches[1] -lt $today) { 3600 } else { 15 }
        return @{ Key = $k; Url = $script:NhlApi + 'score/' + $Matches[1]; File = "score-$($Matches[1]).json"; Kind = 'json'; Ttl = $ttl }
    }
    if ($k -eq 'standings') { return @{ Key = $k; Url = $script:NhlApi + 'standings/now'; File = 'standings.json'; Kind = 'json'; Ttl = 600 } }
    if ($k -eq 'leaders') {
        return @{ Key = $k; Url = $script:NhlApi + 'skater-stats-leaders/current?categories=points,goals,assists,plusMinus&limit=10'; File = 'leaders.json'; Kind = 'json'; Ttl = 1800 }
    }
    if ($k -eq 'goalies') {
        return @{ Key = $k; Url = $script:NhlApi + 'goalie-stats-leaders/current?categories=wins,savePctg,goalsAgainstAverage,shutouts&limit=10'; File = 'goalies.json'; Kind = 'json'; Ttl = 1800 }
    }
    if ($k -match '^box:(\d{10})$') { return @{ Key = $k; Url = $script:NhlApi + "gamecenter/$($Matches[1])/boxscore"; File = "box-$($Matches[1]).json"; Kind = 'json'; Ttl = 15 } }
    if ($k -match '^pbp:(\d{10})$') { return @{ Key = $k; Url = $script:NhlApi + "gamecenter/$($Matches[1])/play-by-play"; File = "pbp-$($Matches[1]).json"; Kind = 'json'; Ttl = 15 } }
    if ($k -match '^logo:([A-Z]{3})(:dark)?$') {
        $v = if ($Matches[2]) { 'dark' } else { 'light' }
        $f = "logos/$($Matches[1])_$v.svg"
        return @{ Key = $k; Url = $script:LogoBase + "$($Matches[1])_$v.svg"; File = $f; Kind = 'svg'; Ttl = 2592000 }
    }
    if ($k -match '^mp:(teams|skaters|goalies)$') {
        $y = Get-SeasonStartYear
        return @{ Key = $k; Url = $script:MoneyPuck + "$y/regular/$($Matches[1]).csv"; File = "mp-$($Matches[1])-$y.csv"; Kind = 'csv'; Ttl = 43200; MoneyPuck = $true }
    }
    return $null
}

function Get-CacheAge {
    param([string]$File)
    $p = Join-Path $script:CacheDir $File
    if (-not (Test-Path -LiteralPath $p)) { return $null }
    return ((Get-Date) - (Get-Item -LiteralPath $p).LastWriteTime).TotalSeconds
}

function New-DataEvent {
    <# Builds the page event from a cached file. JSON bodies are passed through as they are, CSV as a string. #>
    param($Spec, [bool]$FromCache)
    $p = Join-Path $script:CacheDir $Spec.File
    $at = (Get-Item -LiteralPath $p).LastWriteTimeUtc.ToString('o')
    $head = '{{"event":"data","data":{{"key":{0},"ok":true,"cached":{1},"at":"{2}","file":{3},"body":' -f (ConvertTo-Json $Spec.Key), $FromCache.ToString().ToLower(), $at, (ConvertTo-Json ($Spec.File))
    switch ($Spec.Kind) {
        'json' { return $head + [IO.File]::ReadAllText($p) + '}}' }
        'csv' { return $head + (ConvertTo-Json -InputObject ([IO.File]::ReadAllText($p)) -Compress) + '}}' }
        default { return $head + 'null}}' }
    }
}

function Request-Data {
    <# Answers from the cache when it is fresh enough, otherwise queues a download. Returns 'cached', 'queued' or 'busy'. #>
    param($Spec, [bool]$Force)
    $age = Get-CacheAge $Spec.File
    if (-not $Force -and $null -ne $age -and $age -lt $Spec.Ttl) {
        try { $script:Out.Enqueue((New-DataEvent $Spec $true)); return 'cached' } catch { }
    }
    if ($Spec.MoneyPuck -and $null -ne $age -and $age -lt 1800) {
        # Never more than one MoneyPuck download per file every 30 minutes, even when forced.
        try { $script:Out.Enqueue((New-DataEvent $Spec $true)); return 'cached' } catch { }
    }
    if ($script:Shared.Pending.ContainsKey($Spec.Key)) { return 'busy' }
    $script:Shared.Pending[$Spec.Key] = $true
    $item = @{} + $Spec
    $item.Gen = $script:Shared.Gen
    $script:Queue.Add($item)
    return 'queued'
}

# ---------------------------------------------------------------- worker runspace
$script:WorkerScript = {
    param($Shared, $Queue, $Out, $CacheDir, $UserAgent)
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
    $utf8 = New-Object Text.UTF8Encoding($false)

    function Get-Bytes([string]$Url) {
        $req = [Net.HttpWebRequest]::Create($Url)
        $req.UserAgent = $UserAgent
        $req.Timeout = 20000
        $req.ReadWriteTimeout = 20000
        $req.AutomaticDecompression = [Net.DecompressionMethods]::GZip -bor [Net.DecompressionMethods]::Deflate
        $resp = $req.GetResponse()
        try {
            $ms = New-Object IO.MemoryStream
            $resp.GetResponseStream().CopyTo($ms)
            return , $ms.ToArray()
        } finally { $resp.Close() }
    }

    function Select-MoneyPuck([string]$Text, [string]$Key) {
        # Keep only the columns and situations the page shows, so the page gets ~100 KB instead of 2.5 MB.
        $cols = switch ($Key) {
            'mp:teams' { 'team,situation,games_played,xGoalsPercentage,corsiPercentage,fenwickPercentage,xGoalsFor,xGoalsAgainst,goalsFor,goalsAgainst,highDangerShotsFor,highDangerShotsAgainst,highDangerxGoalsFor,highDangerxGoalsAgainst' }
            'mp:skaters' { 'playerId,name,team,position,situation,games_played,icetime,gameScore,onIce_xGoalsPercentage,onIce_corsiPercentage,I_F_xGoals,I_F_goals,I_F_points,I_F_shotsOnGoal,I_F_highDangerShots' }
            default { 'playerId,name,team,situation,games_played,icetime,xGoals,goals,ongoal,highDangerShots,highDangerxGoals,highDangerGoals' }
        }
        $want = $cols -split ','
        $lines = $Text -split "`r?`n"
        $head = $lines[0] -split ','
        $idx = foreach ($c in $want) { [Array]::IndexOf($head, $c) }
        $sit = [Array]::IndexOf($head, 'situation')
        $sb = New-Object Text.StringBuilder
        [void]$sb.AppendLine($cols)
        for ($i = 1; $i -lt $lines.Length; $i++) {
            if (-not $lines[$i]) { continue }
            $f = $lines[$i] -split ','
            if ($sit -ge 0 -and $f[$sit] -ne 'all' -and $f[$sit] -ne '5on5') { continue }
            $row = foreach ($j in $idx) { if ($j -ge 0 -and $j -lt $f.Length) { $f[$j] } else { '' } }
            [void]$sb.AppendLine(($row -join ','))
        }
        return $sb.ToString()
    }

    while (-not $Shared.Quit) {
        $item = $null
        if (-not $Queue.TryTake([ref]$item, 500)) { continue }
        try {
            if ($Shared.Halted -or $item.Gen -ne $Shared.Gen) { continue }
            $Shared.Requests++
            $bytes = Get-Bytes $item.Url
            $Shared.Bytes += $bytes.Length
            if ($Shared.Halted -or $item.Gen -ne $Shared.Gen) { continue }
            $path = Join-Path $CacheDir $item.File
            $dir = Split-Path $path
            if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
            $at = [datetime]::UtcNow.ToString('o')
            $head = '{{"event":"data","data":{{"key":"{0}","ok":true,"cached":false,"at":"{1}","file":"{2}","body":' -f $item.Key, $at, $item.File
            switch ($item.Kind) {
                'json' {
                    $text = $utf8.GetString($bytes).Trim()
                    if (-not ($text.StartsWith('{') -or $text.StartsWith('['))) { throw 'The NHL API sent something that is not JSON.' }
                    [IO.File]::WriteAllText($path, $text, $utf8)
                    if ($item.Key -eq $Shared.TodayKey) {
                        $Shared.Live = ([regex]::Matches($text, '"gameState"\s*:\s*"(LIVE|CRIT)"')).Count
                    }
                    $Out.Enqueue($head + $text + '}}')
                }
                'csv' {
                    $text = Select-MoneyPuck ($utf8.GetString($bytes)) $item.Key
                    [IO.File]::WriteAllText($path, $text, $utf8)
                    $Out.Enqueue($head + (ConvertTo-Json -InputObject $text -Compress) + '}}')
                }
                default {
                    $text = $utf8.GetString($bytes)
                    if ($text -notmatch '<svg') { throw 'Logo download was not an SVG.' }
                    [IO.File]::WriteAllBytes($path, $bytes)
                    $Out.Enqueue($head + 'null}}')
                }
            }
            $Shared.LastError = $null
        } catch {
            if ($item.Gen -eq $Shared.Gen -and -not $Shared.Halted) {
                $Shared.Errors++
                $msg = $_.Exception.Message
                if ($_.Exception.InnerException) { $msg = $_.Exception.InnerException.Message }
                $Shared.LastError = $msg
                $Out.Enqueue('{"event":"data","data":{"key":' + (ConvertTo-Json $item.Key) + ',"ok":false,"error":' + (ConvertTo-Json -InputObject ([string]$msg) -Compress) + '}}')
            }
        } finally {
            if ($item) { $Shared.Pending.Remove($item.Key) }
        }
    }
}

function Start-WorkerRunspace {
    if ($script:Worker) { return }
    $ps = [PowerShell]::Create()
    $ps.Runspace = [RunspaceFactory]::CreateRunspace()
    $ps.Runspace.Open()
    [void]$ps.AddScript($script:WorkerScript).AddArgument($script:Shared).AddArgument($script:Queue).AddArgument($script:Out).AddArgument($script:CacheDir).AddArgument("NHLDash/$($script:Version) (personal dashboard)")
    $script:WorkerHandle = $ps.BeginInvoke()
    $script:Worker = $ps
}

function Clear-Queue {
    $x = $null
    while ($script:Queue.TryTake([ref]$x)) { }
    $script:Shared.Pending.Clear()
}

function Get-Snapshot {
    return @{
        mode = [string]$script:Ctx.Mode; version = $script:Version; theme = [string]$script:Ctx.Theme
        launcherVersion = [string]$script:Ctx.LauncherVersion
        halted = [bool]$script:Shared.Halted; live = [int]$script:Shared.Live
        error = $script:Shared.LastError
        settings = $script:Settings
        today = (Get-Date).ToString('yyyy-MM-dd')
        traffic = @{ requests = [int]$script:Shared.Requests; bytes = [long]$script:Shared.Bytes; errors = [int]$script:Shared.Errors }
    }
}

function Reset-AutoTimer {
    if ($script:Settings.autoRefresh -and $script:Visible -and -not $script:Shared.Halted) {
        $script:NextAuto = (Get-Date).AddSeconds($script:Settings.refreshSeconds)
    } else { $script:NextAuto = [datetime]::MaxValue }
}

# ---------------------------------------------------------------- contract functions
function Initialize-Dash {
    <# Takes the host lock, loads settings and makes folders. Fetches nothing. #>
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
    $local = Join-Path $env:LOCALAPPDATA 'NHLDash'
    $roam = Join-Path $env:APPDATA 'NHLDash'
    $script:CacheDir = Join-Path $local 'cache'
    $script:WebViewDataDir = Join-Path $local 'webview2'
    foreach ($d in @($script:CacheDir, (Join-Path $script:CacheDir 'logos'), $script:WebViewDataDir, $roam)) {
        if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
    }
    $script:SettingsFile = Join-Path $roam 'settings.json'
    $script:Settings = Read-Settings
    $script:Shared = [hashtable]::Synchronized(@{
        Quit = $false; Halted = $false; Gen = 0; Live = 0; Requests = 0; Bytes = [long]0; Errors = 0; LastError = $null
        Pending = [hashtable]::Synchronized(@{}); TodayKey = 'score:' + (Get-Date).ToString('yyyy-MM-dd')
    })
    $script:Queue = New-Object 'System.Collections.Concurrent.BlockingCollection[object]'
    $script:Out = New-Object 'System.Collections.Concurrent.ConcurrentQueue[string]'
    $script:Visible = $false
    $script:Watch = @()
    return @{ Ok = $true; Reason = ''; CacheDir = $script:CacheDir; WebViewDataDir = $script:WebViewDataDir }
}

function Start-DashWorker {
    <# Visible: the worker runs (it only ever downloads what was asked for); automatic refresh resumes if it is on. #>
    if (-not $script:Shared) { return }
    $script:Visible = $true
    if ($script:Shared.Halted) { return }
    Start-WorkerRunspace
    Reset-AutoTimer
}

function Suspend-DashWorker {
    <# Hidden: no timed refresh. Requests already queued finish. #>
    if (-not $script:Shared) { return }
    $script:Visible = $false
    $script:NextAuto = [datetime]::MaxValue
}

function Invoke-DashCommand {
    param([Parameter(Mandatory)]$Message)
    $id = $Message.id
    $a = $Message.args
    try {
        switch ([string]$Message.cmd) {
            'init' { Reply $id (ConvertTo-PageJson (Get-Snapshot)) }
            'data.get' {
                $spec = Resolve-DataKey ([string]$a.key)
                if (-not $spec) { ReplyError $id 'unknown data key'; return }
                if ($spec.MoneyPuck -and -not $script:Settings.moneypuck) { ReplyError $id 'MoneyPuck is turned off in Settings.'; return }
                if ($script:Shared.Halted) {
                    # Paused: cached copies still show, nothing is downloaded.
                    if ($null -ne (Get-CacheAge $spec.File)) { $script:Out.Enqueue((New-DataEvent $spec $true)); Reply $id '"cached"' }
                    else { ReplyError $id 'Data traffic is paused.' }
                    return
                }
                Start-WorkerRunspace
                $r = Request-Data $spec ([bool]$a.force)
                Reply $id (ConvertTo-Json $r)
            }
            'watch.set' {
                $keys = @()
                foreach ($k in @($a.keys)) { if ($k -and (Resolve-DataKey ([string]$k)) -and ([string]$k -notmatch '^(logo|mp):')) { $keys += [string]$k } }
                $script:Watch = @($keys | Select-Object -First 6)
                Reply $id 'true'
            }
            'settings.set' {
                $s = $script:Settings
                switch ([string]$a.key) {
                    'autoRefresh' {
                        $on = [bool]$a.value
                        if ($on -and -not [bool]$a.ack -and -not $s.autoAck) { ReplyError $id 'Automatic refresh needs the warning acknowledged.'; return }
                        $s.autoRefresh = $on; if ($on) { $s.autoAck = $true }
                    }
                    'refreshSeconds' { $s.refreshSeconds = Limit-Seconds $a.value }
                    'moneypuck' {
                        $on = [bool]$a.value
                        if ($on -and -not [bool]$a.ack -and -not $s.mpAck) { ReplyError $id 'MoneyPuck needs the warning acknowledged.'; return }
                        $s.moneypuck = $on; if ($on) { $s.mpAck = $true }
                    }
                    'favTeam' { $v = [string]$a.value; if ($v -and $v -notmatch '^[A-Z]{3}$') { ReplyError $id 'bad team'; return }; $s.favTeam = $v }
                    default { ReplyError $id 'unknown setting'; return }
                }
                Save-Settings
                Reset-AutoTimer
                Reply $id (ConvertTo-PageJson (Get-Snapshot))
            }
            'cache.clear' {
                Get-ChildItem -LiteralPath $script:CacheDir -File -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '\.(json|csv)$' } | Remove-Item -Force -ErrorAction SilentlyContinue
                Reply $id 'true'
            }
            'traffic.stop' {
                Stop-DashTraffic
                Reply $id (ConvertTo-PageJson (Get-Snapshot))
            }
            'traffic.resume' {
                $script:Shared.Halted = $false
                $script:Shared.LastError = $null
                if ($script:Visible) { Start-WorkerRunspace }
                Reset-AutoTimer
                Send-Page '{"event":"traffic","data":{"stopped":false}}'
                Reply $id (ConvertTo-PageJson (Get-Snapshot))
            }
            default { ReplyError $id ('unknown command: ' + [string]$Message.cmd) }
        }
    } catch { ReplyError $id $_.Exception.Message }
}

function Receive-DashEvents {
    <# Every 250 ms: runs the opt-in refresh timer and drains up to 25 worker messages. #>
    if (-not $script:Shared) { return @() }
    $now = Get-Date
    $script:Shared.TodayKey = 'score:' + $now.ToString('yyyy-MM-dd')
    if ($now -ge $script:NextAuto) {
        if ($script:Visible -and $script:Settings.autoRefresh -and -not $script:Shared.Halted) {
            foreach ($k in $script:Watch) { $spec = Resolve-DataKey $k; if ($spec) { [void](Request-Data $spec $true) } }
        }
        Reset-AutoTimer
    }
    $out = New-Object System.Collections.Generic.List[string]
    $msg = $null
    while ($out.Count -lt 25 -and $script:Out.TryDequeue([ref]$msg)) { $out.Add($msg) }
    return $out.ToArray()
}

function Get-DashStatus {
    <# Every 2 seconds: no network, no disk. #>
    $s = $script:Shared
    if (-not $s) { return @{ Live = 0; Syncing = $false; SyncPct = $null; UpdateAvailable = $null; Error = $null; Traffic = @{ Requests = 0; Bytes = 0; Errors = 0 } } }
    $syncing = $false
    if ($script:SyncKeys) {
        $left = @($script:SyncKeys | Where-Object { $s.Pending.ContainsKey($_) }).Count
        if ($left -eq 0) { $script:SyncKeys = $null } else { $syncing = $true }
    }
    return @{
        Live            = $(if ($s.Halted) { 0 } else { [int]$s.Live })
        Syncing         = $syncing
        SyncPct         = $null
        UpdateAvailable = $null
        Error           = $(if ($s.Halted) { $null } else { $s.LastError })
        Traffic         = @{ Requests = [int]$s.Requests; Bytes = [long]$s.Bytes; Errors = [int]$s.Errors }
    }
}

function Stop-DashTraffic {
    <# Kill switch: drop queued downloads, ignore the one in flight, stop the refresh timer. Settings are not changed. #>
    if (-not $script:Shared) { return }
    $script:Shared.Halted = $true
    $script:Shared.Gen++
    Clear-Queue
    $script:SyncKeys = $null
    $script:NextAuto = [datetime]::MaxValue
    Send-Page '{"event":"traffic","data":{"stopped":true}}'
}

function Stop-Dash {
    <# Closing: stop the worker and release the host lock within 2 seconds. #>
    try {
        if ($script:Shared) { $script:Shared.Quit = $true; $script:Shared.Gen++ }
        if ($script:Worker) {
            if (-not $script:WorkerHandle.AsyncWaitHandle.WaitOne(1200)) { try { $script:Worker.Stop() } catch { } }
            $script:Worker.Runspace.Dispose(); $script:Worker.Dispose()
        }
    } catch { }
    $script:Worker = $null; $script:WorkerHandle = $null
    try { if ($script:Mutex) { $script:Mutex.ReleaseMutex(); $script:Mutex.Dispose() } } catch { }
    $script:Mutex = $null
    $script:Ctx = $null
    $script:Shared = $null
}

function Invoke-DashSync {
    <# Optional (master sync, switched off in the launcher for now): today's scores and the standings. #>
    param([ValidateSet('quick')][string]$Scope = 'quick')
    if (-not $script:Shared -or $script:Shared.Halted) { return $false }
    if ($script:SyncKeys) { return $false }
    Start-WorkerRunspace
    $keys = @('score:' + (Get-Date).ToString('yyyy-MM-dd'), 'standings')
    foreach ($k in $keys) { [void](Request-Data (Resolve-DataKey $k) $true) }
    $script:SyncKeys = $keys
    return $true
}

Export-ModuleMember -Function Initialize-Dash, Start-DashWorker, Suspend-DashWorker, Invoke-DashCommand, Receive-DashEvents, Get-DashStatus, Stop-DashTraffic, Stop-Dash, Invoke-DashSync
