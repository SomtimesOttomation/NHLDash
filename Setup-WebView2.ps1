<#
.SYNOPSIS  One-time setup: downloads the WebView2 .NET wrapper DLLs into .\lib (no admin needed).
.NOTES     The WebView2 *runtime* is already installed with Edge on current Windows 10/11.
#>
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$lib = Join-Path $PSScriptRoot 'lib'
if (-not (Test-Path $lib)) { New-Item -ItemType Directory -Path $lib | Out-Null }
$tmp = Join-Path $env:TEMP ('nhldash-wv2-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    $pkg = Join-Path $tmp 'wv2.zip'
    Write-Host 'Downloading Microsoft.Web.WebView2 from NuGet...'
    Invoke-WebRequest -UseBasicParsing -Uri 'https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2' -OutFile $pkg
    Expand-Archive -Path $pkg -DestinationPath (Join-Path $tmp 'x') -Force
    $x = Join-Path $tmp 'x'
    $arch = if ([Environment]::Is64BitProcess) { 'win-x64' } else { 'win-x86' }
    $files = @(
        (Join-Path $x 'lib\net462\Microsoft.Web.WebView2.Core.dll'),
        (Join-Path $x 'lib\net462\Microsoft.Web.WebView2.WinForms.dll'),
        (Join-Path $x "runtimes\$arch\native\WebView2Loader.dll")
    )
    foreach ($f in $files) {
        if (-not (Test-Path $f)) { throw "Not found in package: $f" }
        Copy-Item $f $lib -Force
        Write-Host ("  copied " + (Split-Path $f -Leaf))
    }
    Get-ChildItem $lib | Unblock-File
    Write-Host "Done. DLLs are in $lib"
} finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }

$rt = Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -ErrorAction SilentlyContinue
if (-not $rt) { $rt = Get-ItemProperty 'HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -ErrorAction SilentlyContinue }
if ($rt) { Write-Host "WebView2 runtime found: $($rt.pv)" } else { Write-Host 'WebView2 runtime not detected. Install the Evergreen runtime from Microsoft if the app does not start.' }
