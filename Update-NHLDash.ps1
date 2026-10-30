<#
.SYNOPSIS
    Checks GitHub for a newer NHLDash release, and downloads + verifies it into a staging folder.
.DESCRIPTION
    Windows PowerShell 5.1. Runs as a hidden child of the dashboard (like its data worker) so the window never freezes.
    -Action Check : asks GitHub for the latest release and writes the answer to -ResultFile.
    -Action Stage : Check, then downloads the release zip, verifies its SHA-256 against the published checksum,
                    extracts it to <WorkDir>\stage (rejecting unsafe paths), syntax-checks the PowerShell files,
                    and writes <WorkDir>\staged.json. Nothing in the installed app is touched here.
    Progress lines on stdout:  ##PROGRESS <pct>|<text>
    The result is a JSON file (UTF-8, no BOM): { status, current, latest, tag, notes, published, error, ... }.
    Only api.github.com and the release download hosts it redirects to are contacted.
#>
param(
    [Parameter(Mandatory)][ValidateSet('Check', 'Stage')][string]$Action,
    [Parameter(Mandatory)][string]$CurrentVersion,
    [Parameter(Mandatory)][string]$WorkDir,
    [string]$ResultFile = (Join-Path $WorkDir 'update-result.json'),
    [string]$Repo = 'SomtimesOttomation/NHLDash',
    [string]$ApiBase = 'https://api.github.com',
    [long]$MaxZipBytes = 100MB,
    [long]$MaxUnpackedBytes = 300MB
)

$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$utf8 = New-Object System.Text.UTF8Encoding($false)
if (-not (Test-Path $WorkDir)) { New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null }

function Set-Progress {
    param([int]$Pct, [string]$Text)
    Write-Output ("##PROGRESS {0}|{1}" -f $Pct, $Text)
}

function Write-Result {
    param([hashtable]$Result)
    $tmp = "$ResultFile.tmp"
    [IO.File]::WriteAllText($tmp, ($Result | ConvertTo-Json -Depth 4), $utf8)
    Move-Item -Path $tmp -Destination $ResultFile -Force
}

function Get-ErrorText {
    param($Err)
    $m = $Err.Exception.Message
    $resp = $Err.Exception.Response
    if ($resp -and $resp.StatusCode) {
        $code = [int]$resp.StatusCode
        if ($code -eq 403 -or $code -eq 429) { return 'GitHub is limiting requests from this network right now. Try again in a few minutes.' }
        return "GitHub answered HTTP $code."
    }
    if ($m -match 'remote name could not be resolved|unable to connect|timed out|connection was closed|No such host') { return 'Could not reach GitHub. Check the internet connection and try again.' }
    return $m
}

function ConvertTo-Ver {
    param([string]$Text)
    if ($Text -match '^\s*v?(\d+)\.(\d+)\.(\d+)\s*$') { return New-Object Version ([int]$Matches[1], [int]$Matches[2], [int]$Matches[3]) }
    return $null
}

function Get-Latest {
    $uri = "$ApiBase/repos/$Repo/releases/latest"
    $hdr = @{ 'User-Agent' = 'NHLDash-Updater'; 'Accept' = 'application/vnd.github+json' }
    try {
        $rel = Invoke-RestMethod -Uri $uri -Headers $hdr -TimeoutSec 20 -UseBasicParsing
    } catch {
        $resp = $_.Exception.Response
        if ($resp -and [int]$resp.StatusCode -eq 404) { return @{ status = 'none' } }
        throw
    }
    $ver = ConvertTo-Ver ([string]$rel.tag_name)
    if (-not $ver) { throw "The latest release has an unexpected tag '$($rel.tag_name)' (expected vX.Y.Z)." }
    $tag = 'v{0}' -f $ver
    $zip = @($rel.assets | Where-Object { $_.name -eq "NHLDash-$tag.zip" }) | Select-Object -First 1
    $sha = @($rel.assets | Where-Object { $_.name -eq "NHLDash-$tag.zip.sha256" }) | Select-Object -First 1
    $notes = [string]$rel.body
    if ($notes.Length -gt 6000) { $notes = $notes.Substring(0, 6000) + "`n..." }
    return @{
        status = 'ok'; version = $ver; tag = $tag; notes = $notes; published = [string]$rel.published_at; htmlUrl = [string]$rel.html_url
        zipUrl = $(if ($zip) { [string]$zip.browser_download_url } else { '' }); zipSize = $(if ($zip) { [long]$zip.size } else { 0 })
        shaUrl = $(if ($sha) { [string]$sha.browser_download_url } else { '' })
    }
}

function Save-Url {
    # Streams a URL to a file, reporting progress between $PctFrom and $PctTo. Follows GitHub's redirect to the asset host.
    param([string]$Url, [string]$Dest, [long]$MaxBytes, [int]$PctFrom, [int]$PctTo, [string]$Label)
    if ($Url -notmatch '^https://' -and $Url -notmatch '^http://(127\.0\.0\.1|localhost)[:/]') { throw 'Refusing a download link that is not https.' }
    $req = [Net.HttpWebRequest]::Create($Url)
    $req.UserAgent = 'NHLDash-Updater'
    $req.Timeout = 30000
    $req.ReadWriteTimeout = 30000
    $req.AllowAutoRedirect = $true
    $resp = $req.GetResponse()
    try {
        $total = $resp.ContentLength
        if ($total -gt $MaxBytes) { throw "The download is larger than expected ($total bytes)." }
        $in = $resp.GetResponseStream()
        $out = [IO.File]::Create($Dest)
        try {
            $buf = New-Object byte[] 65536
            $done = 0L; $last = -1
            while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) {
                $out.Write($buf, 0, $n); $done += $n
                if ($done -gt $MaxBytes) { throw 'The download is larger than expected.' }
                if ($total -gt 0) {
                    $pct = $PctFrom + [int](($PctTo - $PctFrom) * $done / $total)
                    if ($pct -ne $last) { $last = $pct; Set-Progress $pct ('{0} {1:N1} of {2:N1} MB' -f $Label, ($done / 1MB), ($total / 1MB)) }
                }
            }
        } finally { $out.Close(); $in.Close() }
    } finally { $resp.Close() }
}

function Expand-Safe {
    # Extracts a zip entry by entry. Rejects path tricks, app-data folders and oversized archives.
    param([string]$Zip, [string]$Dest)
    $destFull = [IO.Path]::GetFullPath($Dest).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    $blockedTop = 'cache', 'lib', 'update', 'logs', '.git'
    $archive = [IO.Compression.ZipFile]::OpenRead($Zip)
    try {
        $count = 0; $bytes = 0L
        foreach ($e in $archive.Entries) {
            $name = $e.FullName
            if ($name -match '(^|[\\/])\.\.([\\/]|$)' -or $name -match '^[\\/]' -or $name -match ':') { throw "Unsafe path in the update package: $name" }
            $top = ($name -split '[\\/]')[0].ToLowerInvariant()
            if ($blockedTop -contains $top) { throw "The update package contains a protected folder: $top" }
            $target = [IO.Path]::GetFullPath((Join-Path $Dest $name))
            if (-not $target.StartsWith($destFull, [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe path in the update package: $name" }
            $count++; $bytes += $e.Length
            if ($count -gt 3000 -or $bytes -gt $MaxUnpackedBytes) { throw 'The update package is larger than expected.' }
            if ($name.EndsWith('/') -or $name.EndsWith('\')) { New-Item -ItemType Directory -Path $target -Force | Out-Null; continue }
            $dir = Split-Path $target
            if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
            [IO.Compression.ZipFileExtensions]::ExtractToFile($e, $target, $true)
        }
    } finally { $archive.Dispose() }
}

try {
    Set-Progress 2 'Asking GitHub for the latest release...'
    $cur = ConvertTo-Ver $CurrentVersion
    if (-not $cur) { throw "This copy has an unreadable version ('$CurrentVersion')." }
    $latest = Get-Latest
    if ($latest.status -eq 'none') {
        Write-Result @{ status = 'none'; current = "$cur"; checkedAt = (Get-Date).ToString('o') }
        exit 0
    }
    $base = @{
        current = "$cur"; latest = "$($latest.version)"; tag = $latest.tag; notes = $latest.notes; published = $latest.published
        htmlUrl = $latest.htmlUrl; checkedAt = (Get-Date).ToString('o')
    }
    if ($latest.version -le $cur) {
        $base.status = $(if ($latest.version -lt $cur) { 'ahead' } else { 'current' })
        Write-Result $base
        exit 0
    }
    if ($Action -eq 'Check') {
        $base.status = 'available'
        $base.size = $latest.zipSize
        $base.installable = [bool]($latest.zipUrl -and $latest.shaUrl)
        Write-Result $base
        exit 0
    }

    # ---- Stage: download, verify, unpack, sanity-check --------------------------------------------------
    if (-not $latest.zipUrl -or -not $latest.shaUrl) { throw "Release $($latest.tag) has no update package or checksum attached yet." }
    $zipPath = Join-Path $WorkDir "NHLDash-$($latest.tag).zip"
    $stageDir = Join-Path $WorkDir 'stage'
    $stagedJson = Join-Path $WorkDir 'staged.json'
    Remove-Item $stagedJson -Force -ErrorAction SilentlyContinue
    Remove-Item $zipPath, "$zipPath.part", "$zipPath.sha256" -Force -ErrorAction SilentlyContinue
    if (Test-Path $stageDir) { Remove-Item $stageDir -Recurse -Force }

    Set-Progress 5 'Downloading the checksum...'
    Save-Url $latest.shaUrl "$zipPath.sha256" 4096 5 6 'Checksum'
    $line = ([IO.File]::ReadAllText("$zipPath.sha256")).Trim()
    if ($line -notmatch '^([0-9a-fA-F]{64})\b') { throw 'The published checksum file is not in the expected format.' }
    $expected = $Matches[1].ToLowerInvariant()

    Save-Url $latest.zipUrl "$zipPath.part" $MaxZipBytes 6 80 'Downloading'
    Set-Progress 82 'Checking the download...'
    $actual = (Get-FileHash -Path "$zipPath.part" -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
        Remove-Item "$zipPath.part" -Force -ErrorAction SilentlyContinue
        throw 'The download did not match its published checksum and was discarded. Nothing was installed.'
    }
    Move-Item "$zipPath.part" $zipPath -Force

    Set-Progress 86 'Unpacking...'
    New-Item -ItemType Directory -Path $stageDir -Force | Out-Null
    Expand-Safe $zipPath $stageDir

    Set-Progress 92 'Checking the new files...'
    $vf = Join-Path $stageDir 'VERSION'
    if (-not (Test-Path $vf)) { throw 'The update package has no VERSION file.' }
    $pkgVer = ConvertTo-Ver ([IO.File]::ReadAllText($vf))
    if (-not $pkgVer -or $pkgVer -ne $latest.version) { throw "The package version does not match the release ($($latest.tag))." }
    foreach ($must in 'Start-NHLDash.ps1', 'Start-NHLDash.bat', 'ui/index.html', 'modules/NHLDash.Host.psm1') {
        if (-not (Test-Path (Join-Path $stageDir $must))) { throw "The update package is missing $must." }
    }
    foreach ($f in Get-ChildItem $stageDir -Recurse -File -Include *.ps1, *.psm1) {
        $errs = $null; $tokens = $null
        [void][Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$errs)
        if ($errs -and $errs.Count) { throw "The update package has a damaged script ($($f.Name)). Nothing was installed." }
    }

    $staged = @{ version = "$($latest.version)"; tag = $latest.tag; stageDir = $stageDir; stagedAt = (Get-Date).ToString('o'); from = "$cur" }
    [IO.File]::WriteAllText($stagedJson, ($staged | ConvertTo-Json), $utf8)
    Remove-Item $zipPath, "$zipPath.sha256" -Force -ErrorAction SilentlyContinue
    Set-Progress 100 'Ready to install'
    $base.status = 'staged'
    Write-Result $base
    exit 0
} catch {
    Remove-Item (Join-Path $WorkDir '*.part') -Force -ErrorAction SilentlyContinue
    if ($Action -eq 'Stage') { Remove-Item (Join-Path $WorkDir 'stage') -Recurse -Force -ErrorAction SilentlyContinue; Remove-Item (Join-Path $WorkDir 'NHLDash-v*.zip*') -Force -ErrorAction SilentlyContinue }
    Write-Result @{ status = 'error'; current = $CurrentVersion; error = (Get-ErrorText $_); checkedAt = (Get-Date).ToString('o') }
    exit 1
}
