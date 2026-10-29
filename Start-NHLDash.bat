@echo off
rem Starts the NHL dash on its own. First run: Setup-WebView2.ps1 is run automatically if the DLLs are missing.
cd /d "%~dp0"
if not exist "lib\Microsoft.Web.WebView2.Core.dll" (
  echo First run: downloading WebView2 libraries...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup-WebView2.ps1"
  if errorlevel 1 pause & exit /b 1
)
start "" powershell.exe -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0Start-NHLDash.ps1" %*
