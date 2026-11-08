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
$script:LastSyncPct = -1
$script:Shared = $null
$script:Queue = $null
$script:Out = $null
$script:Worker = $null
$script:WorkerHandle = $null

$script:NhlApi = 'https://api-web.nhle.com/v1/'
$script:NhlStats = 'https://api.nhle.com/stats/rest/en/'
$script:Espn = 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/'
$script:LogoBase = 'https://assets.nhle.com/logos/nhl/svg/'
$script:MoneyPuck = 'https://moneypuck.com/moneypuck/playerData/seasonSummary/'

function New-DefaultSettings {
    return [ordered]@{ autoRefresh = $false; autoAck = $false; refreshSeconds = 60; moneypuck = $false; mpAck = $false; favorites = @(); updateCheck = $true }
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
    $s.updateCheck = [bool]$s.updateCheck
    $s.moneypuck = [bool]$s.moneypuck; $s.mpAck = [bool]$s.mpAck
    $s.refreshSeconds = Limit-Seconds $s.refreshSeconds
    $old = $null; try { if (Test-Path $script:SettingsFile) { $old = ([IO.File]::ReadAllText($script:SettingsFile) | ConvertFrom-Json).favTeam } } catch { }
    $list = @($s.favorites)
    if ($old) { $list += [string]$old }      # 0.2.0 kept one favourite team
    $s.favorites = Limit-Teams $list
    return $s
}
function Save-Settings {
    try { [IO.File]::WriteAllText($script:SettingsFile, (ConvertTo-Json -InputObject $script:Settings -Compress)) } catch { }
}
function Limit-Teams {
    param($Value)
    $out = New-Object System.Collections.Generic.List[string]
    foreach ($t in @($Value)) { $v = [string]$t; if ($v -cmatch '^[A-Z]{3}$' -and -not $out.Contains($v) -and $out.Count -lt 32) { $out.Add($v) } }
    return , $out.ToArray()
}
function Limit-Seconds { param($Value) $n = 60; try { $n = [int]$Value } catch { }; return [Math]::Max(20, [Math]::Min(600, $n)) }

# ---------------------------------------------------------------- data keys
function Get-SeasonStartYear {
    $d = Get-Date
    if ($d.Month -ge 9) { return $d.Year } else { return $d.Year - 1 }
}

function Get-SeasonId { $y = Get-SeasonStartYear; return '{0}{1}' -f $y, ($y + 1) }
function Get-SeasonWeeks {
    <# Mondays from the week before the earliest possible opener up to this week (or the end of June). #>
    $y = Get-SeasonStartYear
    $d = (Get-Date -Year $y -Month 9 -Day 22).Date
    while ($d.DayOfWeek -ne 'Monday') { $d = $d.AddDays(-1) }
    $end = (Get-Date).Date
    $stop = (Get-Date -Year ($y + 1) -Month 6 -Day 30).Date
    if ($end -gt $stop) { $end = $stop }
    $list = @()
    while ($d -le $end) { $list += $d.ToString('yyyy-MM-dd'); $d = $d.AddDays(7) }
    return , $list
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
    if ($k -cmatch '^sched:([A-Z]{3})$') { return @{ Key = $k; Url = $script:NhlApi + "club-schedule-season/$($Matches[1])/now"; File = "sched-$($Matches[1]).json"; Kind = 'json'; Ttl = 600 } }
    if ($k -cmatch '^team:([A-Z]{3})$') { return @{ Key = $k; Url = $script:NhlApi + "club-stats/$($Matches[1])/now"; File = "team-$($Matches[1]).json"; Kind = 'json'; Ttl = 1800 } }
    if ($k -match '^player:(\d{7,8})$') { return @{ Key = $k; Url = $script:NhlApi + "player/$($Matches[1])/landing"; File = "player-$($Matches[1]).json"; Kind = 'json'; Ttl = 3600 } }
    if ($k -match '^plog:(\d{7,8})$') { return @{ Key = $k; Url = $script:NhlApi + "player/$($Matches[1])/game-log/now"; File = "plog-$($Matches[1]).json"; Kind = 'json'; Ttl = 900 } }
    if ($k -match '^week:(\d{4}-\d{2}-\d{2})$') {
        # One request per week (the NHL's schedule feed answers with 7 days). Finished weeks never change.
        $d = [datetime]::ParseExact($Matches[1], 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
        $ttl = if ($d.AddDays(8) -lt (Get-Date).Date) { 2592000 } else { 600 }
        return @{ Key = $k; Url = $script:NhlApi + 'schedule/' + $Matches[1]; File = "week-$($Matches[1]).json"; Kind = 'json'; Ttl = $ttl }
    }
    if ($k -eq 'rookies') {
        return @{ Key = $k; Url = $script:NhlStats + 'skater/summary?isAggregate=false&isGame=false&sort=%5B%7B%22property%22:%22points%22,%22direction%22:%22DESC%22%7D%5D&start=0&limit=100&cayenneExp=isRookie%3D%271%27%20and%20seasonId%3D' + (Get-SeasonId) + '%20and%20gameTypeId%3D2'; File = 'rookies.json'; Kind = 'json'; Ttl = 3600 }
    }
    if ($k -eq 'espn:injuries') { return @{ Key = $k; Url = $script:Espn + 'injuries'; File = 'espn-injuries.json'; Kind = 'json'; Ttl = 1800 } }
    if ($k -eq 'espn:transactions') { return @{ Key = $k; Url = $script:Espn + 'transactions?limit=1000'; File = 'espn-transactions.json'; Kind = 'json'; Ttl = 1800 } }
    if ($k -match '^psearch:([a-z'' .-]{3,30})$') {
        # The NHL's own player search, asked only when the page's local index finds fewer than 3 players.
        $q = $Matches[1]; $safe = ($q -replace '[^a-z]', '_')
        return @{ Key = $k; Url = 'https://search.d3.nhle.com/api/v1/search/player?culture=en-us&limit=20&q=' + [uri]::EscapeDataString($q); File = "psearch/$safe.json"; Kind = 'json'; Ttl = 86400 }
    }
    if ($k -eq 'seasonbox') { return @{ Key = $k; Url = ''; File = 'season-box.json'; Kind = 'json'; Ttl = 0; Local = $true } }
    if ($k -eq 'standings') { return @{ Key = $k; Url = $script:NhlApi + 'standings/now'; File = 'standings.json'; Kind = 'json'; Ttl = 600 } }
    if ($k -eq 'leaders') {
        return @{ Key = $k; Url = $script:NhlApi + 'skater-stats-leaders/current?categories=points,goals,assists,plusMinus&limit=10'; File = 'leaders.json'; Kind = 'json'; Ttl = 1800 }
    }
    if ($k -eq 'goalies') {
        return @{ Key = $k; Url = $script:NhlApi + 'goalie-stats-leaders/current?categories=wins,savePctg,goalsAgainstAverage,shutouts&limit=10'; File = 'goalies.json'; Kind = 'json'; Ttl = 1800 }
    }
    if ($k -match '^box:(\d{10})$') { return @{ Key = $k; Url = $script:NhlApi + "gamecenter/$($Matches[1])/boxscore"; File = "box-$($Matches[1]).json"; Kind = 'json'; Ttl = 15 } }
    if ($k -match '^pbp:(\d{10})$') { return @{ Key = $k; Url = $script:NhlApi + "gamecenter/$($Matches[1])/play-by-play"; File = "pbp-$($Matches[1]).json"; Kind = 'json'; Ttl = 15 } }
    if ($k -cmatch '^logo:([A-Z]{3})(:dark)?$') {
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

$script:FinalFiles = @{}
function Test-FinalFile {
    <# A saved box score or play-by-play of a finished game never changes, so it is never downloaded again. #>
    param([string]$File)
    if ($script:FinalFiles.ContainsKey($File)) { return $true }
    try {
        $p = Join-Path $script:CacheDir $File
        $fs = [IO.File]::OpenRead($p); $buf = New-Object byte[] 2048; $n = $fs.Read($buf, 0, 2048); $fs.Close()
        if ([Text.Encoding]::UTF8.GetString($buf, 0, $n) -match '"gameState"\s*:\s*"(OFF|FINAL)"') { $script:FinalFiles[$File] = $true; return $true }
    } catch { }
    return $false
}

function Request-Data {
    <# Answers from the cache when it is fresh enough, otherwise queues a download. Returns 'cached', 'queued' or 'busy'. #>
    param($Spec, [bool]$Force, $Extra)
    $age = Get-CacheAge $Spec.File
    if ($Spec.Local) {
        if ($null -ne $age) { $script:Out.Enqueue((New-DataEvent $Spec $true)); return 'cached' }
        return 'missing'
    }
    if (-not $Force -and $null -ne $age -and $Spec.Key -match '^(box|pbp):' -and (Test-FinalFile $Spec.File)) {
        try { $script:Out.Enqueue((New-DataEvent $Spec $true)); return 'cached' } catch { }
    }
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
    if ($Extra) { foreach ($k in $Extra.Keys) { $item[$k] = $Extra[$k] } }
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

    function Get-Sec([string]$T) { if ($T -match '^(\d+):(\d+)$') { return [int]$Matches[1] * 60 + [int]$Matches[2] }; return 0 }
    function Save-CompactBox([string]$Text, [string]$Date) {
        # A small copy of a finished game's box score for season pages (players of the week, form, leaderboards).
        $b = $Text | ConvertFrom-Json
        if ($b.gameState -ne 'OFF' -and $b.gameState -ne 'FINAL') { return }
        $rows = New-Object System.Collections.Generic.List[string]
        $gks = New-Object System.Collections.Generic.List[string]
        foreach ($side in @('awayTeam', 'homeTeam')) {
            $ab = [string]$b.$side.abbrev
            $t = $b.playerByGameStats.$side
            foreach ($p in @($t.forwards) + @($t.defense)) {
                if (-not $p) { continue }
                $rows.Add((ConvertTo-Json -Compress -InputObject @([int]$p.playerId, [string]$p.name.default, $ab, [string]$p.position, [int]$p.goals, [int]$p.assists, [int]$p.plusMinus, [int]$p.sog, [int]$p.hits, [int]$p.blockedShots, [int]$p.pim, (Get-Sec $p.toi), [double]$p.faceoffWinningPctg, [int]$p.powerPlayGoals, [int]$p.giveaways, [int]$p.takeaways)))
            }
            foreach ($g in @($t.goalies)) {
                if (-not $g -or (Get-Sec $g.toi) -eq 0) { continue }
                $gks.Add((ConvertTo-Json -Compress -InputObject @([int]$g.playerId, [string]$g.name.default, $ab, [int]$g.shotsAgainst, [int]$g.saves, [int]$g.goalsAgainst, (Get-Sec $g.toi), [string]$g.decision)))
            }
        }
        $d = if ($Date) { $Date } else { [string]$b.gameDate }
        $json = '{{"id":{0},"date":"{1}","type":{2},"last":"{3}","away":{{"a":"{4}","s":{5},"sog":{6}}},"home":{{"a":"{7}","s":{8},"sog":{9}}},"p":[{10}],"g":[{11}]}}' -f $b.id, $d, [int]$b.gameType, [string]$b.gameOutcome.lastPeriodType, $b.awayTeam.abbrev, [int]$b.awayTeam.score, [int]$b.awayTeam.sog, $b.homeTeam.abbrev, [int]$b.homeTeam.score, [int]$b.homeTeam.sog, ($rows -join ','), ($gks -join ',')
        $dir = Join-Path $CacheDir 'boxc'
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        [IO.File]::WriteAllText((Join-Path $dir "$($b.id).json"), $json, $utf8)
    }
    function Add-SyncBoxes($Item) {
        # Second step of a season sync: every finished game in the saved weeks whose box score is not saved yet.
        $added = 0
        foreach ($f in @(Get-ChildItem -LiteralPath $CacheDir -Filter 'week-*.json' -File -ErrorAction SilentlyContinue)) {
            try { $w = [IO.File]::ReadAllText($f.FullName) | ConvertFrom-Json } catch { continue }
            foreach ($day in @($w.gameWeek)) {
                foreach ($g in @($day.games)) {
                    if (-not $g -or [int]$g.gameType -lt 2) { continue }
                    if ($g.gameState -ne 'OFF' -and $g.gameState -ne 'FINAL') { continue }
                    if (Test-Path (Join-Path $CacheDir "boxc/$($g.id).json")) { continue }
                    $Queue.Add(@{ Key = "box:$($g.id)"; Url = $Item.NhlApi + "gamecenter/$($g.id)/boxscore"; File = "box-$($g.id).json"; Kind = 'json'; Sync = $true; Quiet = $true; Date = [string]$day.date; Delay = 600; Gen = $Item.Gen })
                    $Shared.SyncTotal++; $added++
                }
            }
        }
        $Queue.Add(@{ Key = 'syncpack'; Kind = 'syncpack'; Sync = $true; Gen = $Item.Gen; Url = '' })
        $Shared.SyncTotal++
        $Shared.SyncNote = "$added box scores to download"
    }
    function Save-SeasonPack {
        # Joins every saved small box score into one file the page reads in one go.
        $parts = foreach ($f in @(Get-ChildItem -LiteralPath (Join-Path $CacheDir 'boxc') -Filter '*.json' -File -ErrorAction SilentlyContinue)) { [IO.File]::ReadAllText($f.FullName) }
        [IO.File]::WriteAllText((Join-Path $CacheDir 'season-box.json'), ('[' + (@($parts) -join ',') + ']'), $utf8)
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
        if (-not $Queue.TryTake([ref]$item, 500)) { if ($Shared.ExitWhenIdle) { break }; continue }
        try {
            if ($Shared.Halted -or $item.Gen -ne $Shared.Gen -or $Shared.Skip.ContainsKey($item.Key)) { continue }
            if ($item.Sync -and $Shared.SyncCancel) { continue }
            if ($item.Kind -eq 'syncboxes') { Add-SyncBoxes $item; continue }
            if ($item.Kind -eq 'syncpack') { Save-SeasonPack; continue }
            if ($item.Delay) { Start-Sleep -Milliseconds ([int]$item.Delay) }
            $Shared.Requests++
            $hostName = ([uri]$item.Url).Host
            if (-not $Shared.ByHost.ContainsKey($hostName)) { $Shared.ByHost[$hostName] = @{ requests = 0; bytes = [long]0; errors = 0 } }
            $hs = $Shared.ByHost[$hostName]; $hs.requests++
            $t0 = Get-Date
            $bytes = Get-Bytes $item.Url
            $Shared.Bytes += $bytes.Length; $hs.bytes += $bytes.Length
            [void]$Shared.Last.Insert(0, @{ at = $t0.ToString('o'); key = $item.Key; host = $hostName; bytes = $bytes.Length; ms = [int]((Get-Date) - $t0).TotalMilliseconds; ok = $true })
            while ($Shared.Last.Count -gt 40) { $Shared.Last.RemoveAt(40) }
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
                    if ($item.Key -like 'box:*') { try { Save-CompactBox $text $item.Date } catch { } }
                    if ($item.Key -eq $Shared.TodayKey) {
                        $Shared.Live = ([regex]::Matches($text, '"gameState"\s*:\s*"(LIVE|CRIT)"')).Count
                    }
                    if (-not $item.Quiet) { $Out.Enqueue($head + $text + '}}') }
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
                try { $hn = ([uri]$item.Url).Host; if ($Shared.ByHost.ContainsKey($hn)) { $Shared.ByHost[$hn].errors++ }; [void]$Shared.Last.Insert(0, @{ at = (Get-Date).ToString('o'); key = $item.Key; host = $hn; bytes = 0; ms = 0; ok = $false }) } catch { }
                $msg = $_.Exception.Message
                if ($_.Exception.InnerException) { $msg = $_.Exception.InnerException.Message }
                $Shared.LastError = $msg
                $Out.Enqueue('{"event":"data","data":{"key":' + (ConvertTo-Json $item.Key) + ',"ok":false,"error":' + (ConvertTo-Json -InputObject ([string]$msg) -Compress) + '}}')
            }
        } finally {
            if ($item) { $Shared.Pending.Remove($item.Key); if ($item.Sync) { $Shared.SyncDone++ } }
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
        cacheDir = $script:CacheDir
        traffic = @{ requests = [int]$script:Shared.Requests; bytes = [long]$script:Shared.Bytes; errors = [int]$script:Shared.Errors }
    }
}

function Reset-AutoTimer {
    if ($script:Settings.autoRefresh -and $script:Visible -and -not $script:Shared.Halted) {
        $script:NextAuto = (Get-Date).AddSeconds($script:Settings.refreshSeconds)
    } else { $script:NextAuto = [datetime]::MaxValue }
}

# ---------------------------------------------------------------- updater (child process, ported from NBADash)
$script:UpdDir = ''
$script:UpdProc = $null
$script:UpdAction = ''
$script:LastUpdJson = ''
$script:UpdateAvailable = $null
$script:UpdateNote = $null
$script:UpdOut = ''
$script:UpdEvents = $null

function Get-ChildProgress {
    # Reads a child's console output: the last ##PROGRESS marker.
    param([string]$Path)
    $r = @{ pct = 0; text = '' }
    try {
        $fs = [IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite')
        $sr = New-Object IO.StreamReader($fs)
        while (($l = $sr.ReadLine()) -ne $null) {
            if ($l.Trim() -match '^##PROGRESS (\d+)\|(.*)$') { $r.pct = [int]$Matches[1]; $r.text = $Matches[2] }
        }
        $sr.Close(); $fs.Close()
    } catch { }
    return $r
}
function Read-UpdateJson {
    param([string]$Name)
    $p = Join-Path $script:UpdDir $Name
    if (Test-Path $p) { try { return ([IO.File]::ReadAllText($p) | ConvertFrom-Json) } catch { } }
    return $null
}
function Start-Updater {
    <# Update checks talk to GitHub only, so the pause switch leaves them alone. #>
    param([string]$Action)
    if ($script:UpdProc -and -not $script:UpdProc.HasExited) { return $false }
    $cur = if ($env:NHLDASH_FAKE_VERSION) { $env:NHLDASH_FAKE_VERSION } else { $script:Version }     # test hook: pretend to be older
    Remove-Item (Join-Path $script:UpdDir 'update-result.json') -Force -ErrorAction SilentlyContinue
    $argsList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f (Join-Path $script:Root 'Update-NHLDash.ps1')),
                  '-Action', $Action, '-CurrentVersion', $cur, '-WorkDir', ('"{0}"' -f $script:UpdDir))
    if ($env:NHLDASH_UPDATE_API) { $argsList += '-ApiBase'; $argsList += $env:NHLDASH_UPDATE_API }   # test hook
    $exe = if ($env:NHLDASH_PS) { $env:NHLDASH_PS } else { 'powershell.exe' }                         # test hook
    $script:UpdAction = $Action
    $sp = @{ FilePath = $exe; ArgumentList = $argsList; PassThru = $true; RedirectStandardOutput = $script:UpdOut }
    if ($IsWindows -ne $false) { $sp.WindowStyle = 'Hidden' }       # $IsWindows is $null in Windows PowerShell 5.1
    $script:UpdProc = Start-Process @sp
    $script:LastUpdJson = ''
    $script:Out.Enqueue((ConvertTo-PageJson @{ event = 'update'; data = @{ running = $true; action = $Action; pct = 0; text = 'Starting...' } }))
    return $true
}
function Get-UpdateEvents {
    $list = @()
    if (-not $script:UpdProc) { return $list }
    if ($script:UpdProc.HasExited) {
        $res = Read-UpdateJson 'update-result.json'
        if (-not $res) { $res = [pscustomobject]@{ status = 'error'; error = 'The update check ended without an answer.' } }
        $script:UpdProc = $null
        if ([string]$res.status -eq 'available' -or [string]$res.status -eq 'staged') { $script:UpdateAvailable = [string]$res.latest }
        elseif ([string]$res.status -eq 'current') { $script:UpdateAvailable = $null }
        $list += (ConvertTo-Json -InputObject @{ event = 'update'; data = @{ running = $false; action = $script:UpdAction; result = $res } } -Depth 6 -Compress)
    } else {
        $prog = Get-ChildProgress $script:UpdOut
        $json = ConvertTo-PageJson @{ event = 'update'; data = @{ running = $true; action = $script:UpdAction; pct = $prog.pct; text = $prog.text } }
        if ($json -ne $script:LastUpdJson) { $script:LastUpdJson = $json; $list += $json }
    }
    return $list
}

# ---------------------------------------------------------------- season sync (page button, master sync, nightly task)
function Start-SeasonSync {
    <# Weeks (schedule and results), standings, rookies, then (when asked) every finished game's box score.
       Saved weeks and saved finished box scores are never downloaded again, so a cancelled sync resumes. #>
    param([bool]$Boxes = $true)
    $sh = $script:Shared
    $sh.SyncCancel = $false; $sh.SyncDone = 0; $sh.SyncTotal = 0; $sh.SyncNote = ''; $sh.SyncActive = $true
    $script:LastSyncPct = -1
    $weeks = Get-SeasonWeeks
    for ($i = 0; $i -lt $weeks.Count; $i++) {
        $spec = Resolve-DataKey ('week:' + $weeks[$i])
        if ((Request-Data $spec ($i -eq $weeks.Count - 1) @{ Sync = $true; Quiet = $true }) -eq 'queued') { $sh.SyncTotal++ }
    }
    foreach ($k in @('standings', 'rookies')) { if ((Request-Data (Resolve-DataKey $k) $true @{ Sync = $true }) -eq 'queued') { $sh.SyncTotal++ } }
    if ($Boxes) { $script:Queue.Add(@{ Key = 'syncboxes'; Kind = 'syncboxes'; Sync = $true; Gen = $sh.Gen; Url = ''; NhlApi = $script:NhlApi }); $sh.SyncTotal++ }
    if ($sh.SyncTotal -eq 0) { $sh.SyncActive = $false }
    return $sh.SyncTotal
}

$script:TaskName = 'NHLDash Nightly Sync'
function Get-NightlyTask {
    try {
        $t = Get-ScheduledTask -TaskName $script:TaskName -ErrorAction Stop
        $at = ''; try { $at = ([datetime]$t.Triggers[0].StartBoundary).ToString('HH:mm') } catch { }
        $info = $null; try { $info = $t | Get-ScheduledTaskInfo } catch { }
        return @{ exists = $true; time = $at; lastRun = $(if ($info -and $info.LastRunTime.Year -gt 2000) { $info.LastRunTime.ToString('o') } else { '' }) }
    } catch { return @{ exists = $false; time = ''; lastRun = '' } }
}
function Set-NightlyTask {
    param([string]$Time = '04:00', [switch]$Remove)
    $script = Join-Path $script:Root 'Register-NHLSyncTask.ps1'
    $args2 = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $script))
    if ($Remove) { $args2 += '-Unregister' } else { $args2 += @('-Time', $Time) }
    try { Start-Process -FilePath 'powershell.exe' -ArgumentList $args2 -WindowStyle Hidden -Wait | Out-Null } catch { return @{ exists = $false; error = $_.Exception.Message } }
    return Get-NightlyTask
}

function Invoke-NhlHeadlessSync {
    <# Used by Sync-NHLCache.ps1 (the nightly task): the same season sync with no window, then exit.
       Skips when NHLDash is open, so two copies never write the cache at once. #>
    param([string]$Root = (Split-Path $PSScriptRoot))
    $created = $false
    $m = New-Object System.Threading.Mutex($true, 'Local\DashHost-nhldash', [ref]$created)
    if (-not $created) { $m.Dispose(); return 'NHLDash is open; skipped (it syncs from its own window).' }
    try {
        $ctx = [pscustomobject]@{ Mode = 'headless'; Root = $Root; Post = $null; Close = $null; Relaunch = ''; HostPid = $PID; Theme = ''; LauncherVersion = ''; Debug = $false }
        $script:Root = $Root
        try { $script:Version = ([IO.File]::ReadAllText((Join-Path $Root 'VERSION'))).Trim() } catch { }
        $local = Join-Path $env:LOCALAPPDATA 'NHLDash'
        $script:CacheDir = Join-Path $local 'cache'
        if (-not (Test-Path $script:CacheDir)) { New-Item -ItemType Directory -Path $script:CacheDir -Force | Out-Null }
        $script:Ctx = $ctx
        $script:Shared = [hashtable]::Synchronized(@{ Quit = $false; Halted = $false; Gen = 0; Live = 0; Requests = 0; Bytes = [long]0; Errors = 0; LastError = $null
            Pending = [hashtable]::Synchronized(@{}); Skip = [hashtable]::Synchronized(@{}); ByHost = [hashtable]::Synchronized(@{}); Last = [System.Collections.ArrayList]::Synchronized((New-Object System.Collections.ArrayList)); Started = Get-Date; TodayKey = ''; ExitWhenIdle = $true })
        $script:Queue = New-Object 'System.Collections.Concurrent.BlockingCollection[object]'
        $script:Out = New-Object 'System.Collections.Concurrent.ConcurrentQueue[string]'
        [void](Start-SeasonSync $true)
        & $script:WorkerScript $script:Shared $script:Queue $script:Out $script:CacheDir "NHLDash/$($script:Version) (nightly sync)"
        return ('Done: {0} requests, {1} errors, {2}' -f $script:Shared.Requests, $script:Shared.Errors, $script:Shared.SyncNote)
    } finally { $script:Ctx = $null; $script:Shared = $null; try { $m.ReleaseMutex() } catch { }; $m.Dispose() }
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
    $script:UpdDir = Join-Path $local 'update'
    if (-not (Test-Path $script:UpdDir)) { New-Item -ItemType Directory -Path $script:UpdDir -Force | Out-Null }
    $script:UpdOut = Join-Path $script:UpdDir 'update.out'
    # After an update the helper leaves a "pending" note: report the result once; the page load confirms it worked.
    $script:UpdateNote = $null
    $pend = Read-UpdateJson 'update-pending.json'
    if ($pend -and [string]$pend.to -eq $script:Version) { $script:UpdateNote = @{ ok = $true; from = [string]$pend.from; to = [string]$pend.to } }
    $failed = Read-UpdateJson 'update-failed.json'
    if ($failed) {
        $script:UpdateNote = @{ ok = $false; from = [string]$failed.from; to = [string]$failed.to; reason = [string]$failed.reason }
        Remove-Item (Join-Path $script:UpdDir 'update-failed.json') -Force -ErrorAction SilentlyContinue
        Remove-Item (Join-Path $script:UpdDir 'update-pending.json') -Force -ErrorAction SilentlyContinue
    }
    $script:Settings = Read-Settings
    $script:Shared = [hashtable]::Synchronized(@{
        Quit = $false; Halted = $false; Gen = 0; Live = 0; Requests = 0; Bytes = [long]0; Errors = 0; LastError = $null
        Pending = [hashtable]::Synchronized(@{}); Skip = [hashtable]::Synchronized(@{}); ByHost = [hashtable]::Synchronized(@{})
        Last = [System.Collections.ArrayList]::Synchronized((New-Object System.Collections.ArrayList)); Started = Get-Date; TodayKey = 'score:' + (Get-Date).ToString('yyyy-MM-dd')
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
            'init' {
                $snap = Get-Snapshot
                $snap.updateNote = $script:UpdateNote
                Reply $id (ConvertTo-PageJson $snap)
                if ($script:UpdateNote -and $script:UpdateNote.ok) {
                    # the page loaded: tell the update helper the new version works
                    try { [IO.File]::WriteAllText((Join-Path $script:UpdDir 'update-ok.json'), '{"ok":true}') } catch { }
                    Remove-Item (Join-Path $script:UpdDir 'update-pending.json') -Force -ErrorAction SilentlyContinue
                }
                $script:UpdateNote = $null
            }
            'update.check' { Reply $id ((Start-Updater 'Check').ToString().ToLower()) }
            'update.stage' { Reply $id ((Start-Updater 'Stage').ToString().ToLower()) }
            'update.cancel' {
                try { if ($script:UpdProc -and -not $script:UpdProc.HasExited) { $script:UpdProc.Kill() } } catch { }
                Reply $id 'true'
            }
            'update.apply' {
                $st = Read-UpdateJson 'staged.json'
                $stage = Join-Path $script:UpdDir 'stage'
                if (-not $st -or -not (Test-Path (Join-Path $stage 'Start-NHLDash.ps1'))) { ReplyError $id 'There is no downloaded update to install. Download it again.'; return }
                # run the helper from a copy so replacing the app files cannot touch the running helper
                $runDir = Join-Path $script:UpdDir 'run'
                if (-not (Test-Path $runDir)) { New-Item -ItemType Directory -Path $runDir -Force | Out-Null }
                $helper = Join-Path $runDir 'Apply-Update.ps1'
                Copy-Item (Join-Path $script:Root 'Apply-Update.ps1') $helper -Force
                # Context.Relaunch is passed through exactly as given (it may include arguments, e.g. -Open nhldash)
                $relaunch = if ($script:Ctx.Relaunch) { [string]$script:Ctx.Relaunch } else { '"' + (Join-Path $script:Root 'Start-NHLDash.bat') + '"' }
                $relaunchB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($relaunch))
                $hostPid = if ($script:Ctx.HostPid) { [int]$script:Ctx.HostPid } else { $PID }
                $h = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $helper), '-AppDir', ('"{0}"' -f $script:Root), '-StageDir', ('"{0}"' -f $stage),
                       '-WorkDir', ('"{0}"' -f $script:UpdDir), '-ParentPid', [string]$hostPid, '-RelaunchB64', $relaunchB64,
                       '-OldVersion', $script:Version, '-NewVersion', [string]$st.version)
                Start-Process -FilePath 'powershell.exe' -ArgumentList $h -WindowStyle Hidden | Out-Null
                Reply $id 'true'
                if ($script:Ctx.Close) { & $script:Ctx.Close }
            }
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
                if ([bool]$a.cacheOnly) {
                    if ($null -ne (Get-CacheAge $spec.File)) { $script:Out.Enqueue((New-DataEvent $spec $true)); Reply $id '"cached"' } else { Reply $id '"missing"' }
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
                    'favorites' { $s.favorites = Limit-Teams $a.value }
                    'updateCheck' { $s.updateCheck = [bool]$a.value }
                    default { ReplyError $id 'unknown setting'; return }
                }
                Save-Settings
                Reset-AutoTimer
                Reply $id (ConvertTo-PageJson (Get-Snapshot))
            }
            'season.weeks' {
                $weeks = foreach ($w in (Get-SeasonWeeks)) { @{ monday = $w; cached = ($null -ne (Get-CacheAge "week-$w.json")) } }
                Reply $id (ConvertTo-Json -InputObject @($weeks) -Compress)
            }
            'sync.run' {
                if ($script:Shared.Halted) { ReplyError $id 'Data traffic is paused. Resume first.'; return }
                if ($script:Shared.SyncActive) { Reply $id 'false'; return }
                Start-WorkerRunspace
                $n = Start-SeasonSync ([bool]$a.boxes)
                Reply $id (ConvertTo-Json @{ started = $true; requests = $n } -Compress)
            }
            'sync.cancel' {
                if ($script:Shared.SyncActive) { $script:Shared.SyncCancel = $true }
                Reply $id 'true'
            }
            'sync.status' {
                $sh = $script:Shared
                Reply $id (ConvertTo-Json @{ running = [bool]$sh.SyncActive; done = [int]$sh.SyncDone; total = [int]$sh.SyncTotal; note = [string]$sh.SyncNote; savedGames = @(Get-ChildItem -LiteralPath (Join-Path $script:CacheDir 'boxc') -Filter '*.json' -File -ErrorAction SilentlyContinue).Count } -Compress)
            }
            'schedule.get' { Reply $id (ConvertTo-PageJson (Get-NightlyTask)) }
            'schedule.set' {
                $t = [string]$a.time
                if ($t -notmatch '^([01]\d|2[0-3]):[0-5]\d$') { ReplyError $id 'Time must look like 04:00.'; return }
                if (-not [bool]$a.ack) { ReplyError $id 'The nightly sync needs the warning acknowledged.'; return }
                Reply $id (ConvertTo-PageJson (Set-NightlyTask -Time $t))
            }
            'schedule.remove' { Reply $id (ConvertTo-PageJson (Set-NightlyTask -Remove)) }
            'traffic.get' {
                $s = $script:Shared
                $hosts = @{}
                foreach ($h in @($s.ByHost.Keys)) { $hosts[$h] = $s.ByHost[$h] }
                $obj = @{ uptimeSec = [int]((Get-Date) - $s.Started).TotalSeconds; requests = [int]$s.Requests; bytes = [long]$s.Bytes; errors = [int]$s.Errors; byHost = $hosts; last = @($s.Last.ToArray()) }
                Reply $id (ConvertTo-Json -InputObject $obj -Depth 5 -Compress)
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
    foreach ($u in @(Get-UpdateEvents)) { if ($u) { $out.Add($u) } }
    $sh = $script:Shared
    if ($sh.SyncActive) {
        $tot = [Math]::Max(1, [int]$sh.SyncTotal)
        $pct = [int][Math]::Min(100, 100 * $sh.SyncDone / $tot)
        if ($sh.SyncDone -ge $sh.SyncTotal) {
            $sh.SyncActive = $false
            $out.Add(('{{"event":"sync","data":{{"running":false,"pct":100,"cancelled":{0},"note":{1}}}}}' -f ([bool]$sh.SyncCancel).ToString().ToLower(), (ConvertTo-Json ([string]$sh.SyncNote))))
        } elseif ($pct -ne $script:LastSyncPct) { $script:LastSyncPct = $pct; $out.Add(('{{"event":"sync","data":{{"running":true,"pct":{0},"done":{1},"total":{2}}}}}' -f $pct, $sh.SyncDone, $sh.SyncTotal)) }
    }
    $msg = $null
    while ($out.Count -lt 25 -and $script:Out.TryDequeue([ref]$msg)) { $out.Add($msg) }
    return $out.ToArray()
}

function Get-DashStatus {
    <# Every 2 seconds: no network, no disk. #>
    $s = $script:Shared
    if (-not $s) { return @{ Live = 0; Syncing = $false; SyncPct = $null; UpdateAvailable = $null; Error = $null; Traffic = @{ Requests = 0; Bytes = 0; Errors = 0 } } }
    $syncing = $false
    $syncPct = $null
    if ($s.SyncActive) { $syncing = $true; $syncPct = [int][Math]::Min(100, 100 * $s.SyncDone / [Math]::Max(1, [int]$s.SyncTotal)) }
    return @{
        Live            = $(if ($s.Halted) { 0 } else { [int]$s.Live })
        Syncing         = $syncing
        SyncPct         = $syncPct
        UpdateAvailable = $script:UpdateAvailable
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
    if ($script:Shared.SyncActive) { $script:Shared.SyncActive = $false; $script:Out.Enqueue('{"event":"sync","data":{"running":false,"pct":0,"cancelled":true}}') }
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
    if ($script:Shared.SyncActive) { return $false }
    Start-WorkerRunspace
    [void](Start-SeasonSync $false)
    return $true
}

Export-ModuleMember -Function Invoke-NhlHeadlessSync, Initialize-Dash, Start-DashWorker, Suspend-DashWorker, Invoke-DashCommand, Receive-DashEvents, Get-DashStatus, Stop-DashTraffic, Stop-Dash, Invoke-DashSync
