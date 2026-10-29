<#
.SYNOPSIS
    NHL dash on its own: a WebView2 window around modules\NHLDash.Host.psm1.
.DESCRIPTION
    Windows PowerShell 5.1. This is the whole "thin host" a dash needs to run standalone under DashLauncher's dash
    contract: make the window and WebView2, build the context, call the backend. DashLauncher does the same for its tab.
#>
param([switch]$Debug)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$Title = 'NHL 2026-27'

if ([Threading.Thread]::CurrentThread.GetApartmentState() -ne 'STA') {
    $relaunch = @('-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath)
    if ($Debug) { $relaunch += '-Debug' }
    & powershell.exe @relaunch
    exit $LASTEXITCODE
}

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()

# ---------------------------------------------------------------- WebView2 assemblies
$lib = Join-Path $Root 'lib'
$need = 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll'
$missing = @($need | Where-Object { -not (Test-Path (Join-Path $lib $_)) })
if ($missing.Count) {
    [Windows.Forms.MessageBox]::Show("Missing WebView2 files in $lib :`n`n$($missing -join "`n")`n`nRun Setup-WebView2.ps1 once.", $Title, 'OK', 'Warning') | Out-Null
    exit 1
}
Add-Type -Namespace NHLDash -Name Native -MemberDefinition '[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetDllDirectory(string path);'
[NHLDash.Native]::SetDllDirectory($lib) | Out-Null
Add-Type -Path (Join-Path $lib 'Microsoft.Web.WebView2.Core.dll')
Add-Type -Path (Join-Path $lib 'Microsoft.Web.WebView2.WinForms.dll')

# ---------------------------------------------------------------- window
$form = New-Object Windows.Forms.Form
$form.Text = $Title
$form.StartPosition = 'CenterScreen'
$form.Size = New-Object Drawing.Size(1100, 800)
$form.MinimumSize = New-Object Drawing.Size(700, 500)
$webView = New-Object Microsoft.Web.WebView2.WinForms.WebView2
$webView.Dock = 'Fill'
$form.Controls.Add($webView)

# ---------------------------------------------------------------- backend (dash contract)
$wv = $webView; $fm = $form
$context = [pscustomobject]@{
    Mode            = 'standalone'
    Root            = $Root
    Post            = { param([string]$Json) try { $wv.CoreWebView2.PostWebMessageAsJson($Json) } catch { } }.GetNewClosure()
    Close           = { $fm.Close() }.GetNewClosure()
    Relaunch        = '"' + (Join-Path $Root 'Start-NHLDash.bat') + '"'
    HostPid         = $PID
    Theme           = ''
    LauncherVersion = ''
    Debug           = [bool]$Debug
}
Import-Module (Join-Path $Root 'modules\NHLDash.Host.psm1') -Force
$init = Initialize-Dash -Context $context
if (-not $init.Ok) {
    $why = if ($init.Reason -eq 'locked') { 'The NHL dash is already open, in its own window or in DashLauncher.' } else { "The NHL dash could not start: $($init.Reason)" }
    [Windows.Forms.MessageBox]::Show($why, $Title, 'OK', 'Information') | Out-Null
    exit 1
}
$props = New-Object Microsoft.Web.WebView2.WinForms.CoreWebView2CreationProperties
$props.UserDataFolder = $init.WebViewDataDir
$webView.CreationProperties = $props

$webView.add_CoreWebView2InitializationCompleted({
    param($sender, $e)
    if (-not $e.IsSuccess) {
        [Windows.Forms.MessageBox]::Show("WebView2 failed to start:`n$($e.InitializationException.Message)", $Title, 'OK', 'Error') | Out-Null
        $form.Close(); return
    }
    $core = $webView.CoreWebView2
    $core.SetVirtualHostNameToFolderMapping('nhldash.ui', (Join-Path $Root 'ui'), [Microsoft.Web.WebView2.Core.CoreWebView2HostResourceAccessKind]::Allow)
    $core.SetVirtualHostNameToFolderMapping('nhldash.cache', $init.CacheDir, [Microsoft.Web.WebView2.Core.CoreWebView2HostResourceAccessKind]::Allow)
    $core.Settings.AreDefaultContextMenusEnabled = [bool]$Debug
    $core.Settings.AreDevToolsEnabled = [bool]$Debug
    $core.Settings.IsStatusBarEnabled = $false
    $core.add_NewWindowRequested({ param($s, $a) $a.Handled = $true })
    $core.Navigate('https://nhldash.ui/index.html')
})
$webView.add_WebMessageReceived({
    param($s, $a)
    $msg = $null
    try { $msg = $a.WebMessageAsJson | ConvertFrom-Json } catch { return }
    Invoke-DashCommand -Message $msg
})
$webView.add_NavigationStarting({ param($s, $a) if ($a.Uri -notmatch '^https://nhldash\.(ui|cache)/') { $a.Cancel = $true } })

$timer = New-Object Windows.Forms.Timer
$timer.Interval = 250
$timer.add_Tick({ try { foreach ($json in @(Receive-DashEvents)) { if ($json) { $webView.CoreWebView2.PostWebMessageAsJson($json) } } } catch { } })

$form.add_Shown({ Start-DashWorker; $timer.Start(); [void]$webView.EnsureCoreWebView2Async($null) })
$form.add_FormClosing({ $timer.Stop(); Stop-Dash })
[Windows.Forms.Application]::Run($form)
