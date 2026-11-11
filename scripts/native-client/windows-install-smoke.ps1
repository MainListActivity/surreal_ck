# 仅供一次性 Windows CI runner：安装/可见窗口存活证据，不是业务功能验收。
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$SetupPath,
    [Parameter(Mandatory)][string]$PackageEvidencePath,
    [Parameter(Mandatory)][string]$BuildReceiptPath,
    [Parameter(Mandatory)][string]$EvidenceDir,
    [ValidateRange(20, 300)][int]$ObserveSeconds = 25
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$EvidenceDir = [IO.Path]::GetFullPath($EvidenceDir)
New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null
$result = [ordered]@{
    schema = 1; platform = 'windows'; status = 'failed'; install = 'not-run'
    executable_hash = 'not-run'; launch = 'not-run'; gui = 'not-verified'
    crash_check = 'not-run'; screenshot = 'not-captured'; observation_seconds = 0
    permissions_granted_by_test = $false; update_gate_bypassed = $false
    login_chat_meeting_files_update = 'not-run'; release_eligible = $false
    scope = 'Installer and visible application window survival only; no business acceptance'
    cleanup = 'not-run'; error = $null
}
$app = $null
$tempRoot = $null
$oldLocalAppData = $env:LOCALAPPDATA
$started = Get-Date
try {
    if ([Environment]::OSVersion.Platform -ne 'Win32NT') { throw 'Windows runner required; no simulated result is accepted' }
    $setup = Get-Item -LiteralPath $SetupPath
    if ($setup.Extension -ne '.exe') { throw 'SetupPath must name the exact setup EXE' }
    $package = Get-Content -LiteralPath $PackageEvidencePath -Raw | ConvertFrom-Json
    $receipt = Get-Content -LiteralPath $BuildReceiptPath -Raw | ConvertFrom-Json
    foreach ($document in @($package, $receipt)) {
        if ($document.platform -ne 'windows' -or $document.app_id -ne 'top.maplayer.collaboration') { throw 'Wrong platform/application evidence' }
        # 启动器只读取编译时更新配置。拒绝生产配置，不以环境覆盖或跳过门禁。
        if ($document.update_config -ne 'absent-blocked' -or $null -ne $document.update_config_sha256 -or $null -ne $document.update_config_public) {
            throw 'Smoke only permits absent-blocked builds with no embedded update service'
        }
    }
    if ($package.entrypoint -ne 'native-client/src/main.rs' -or $package.executable -ne 'SurrealCK/surreal-collaboration.exe') { throw 'Wrong packaged executable' }
    foreach ($key in @('commit', 'source_sha256', 'version', 'build')) {
        if ($package.$key -ne $receipt.$key) { throw "Package/installer evidence mismatch: $key" }
    }
    $setupHash = (Get-FileHash -LiteralPath $setup.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($receipt.filename -ne $setup.Name -or $receipt.size -ne $setup.Length -or $receipt.sha256 -ne $setupHash) { throw 'Downloaded setup does not match build receipt' }
    if ($package.packaged_executable_sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Missing packaged executable SHA256' }
    $result.setup_sha256 = $setupHash
    $result.build_receipt_sha256 = (Get-FileHash -LiteralPath $BuildReceiptPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $result.commit = $receipt.commit
    $result.package_evidence_sha256 = (Get-FileHash -LiteralPath $PackageEvidencePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('surreal-install-smoke-' + [guid]::NewGuid().ToString('N'))
    $installDir = Join-Path $tempRoot 'app'
    New-Item -ItemType Directory -Path $tempRoot | Out-Null
    $result.install_directory = $installDir
    # 最低权限安装器，无 RunAs、提权、安全设置修改或自动启动；仅使用临时安装目录。
    $arguments = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/NOICONS',
        "/DIR=`"$installDir`"", "/LOG=`"$(Join-Path $EvidenceDir 'install.log')`"")
    $installer = Start-Process -FilePath $setup.FullName -ArgumentList $arguments -PassThru
    if (-not $installer.WaitForExit(180000)) { Stop-Process -Id $installer.Id -Force; throw 'Installer timed out' }
    $result.installer_exit_code = $installer.ExitCode
    if ($installer.ExitCode -ne 0) { throw "Installer failed: $($installer.ExitCode)" }
    $result.install = 'passed'
    $exe = Join-Path $installDir 'surreal-collaboration.exe'
    $installedHash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
    $result.installed_executable_sha256 = $installedHash
    if ($installedHash -ne $package.packaged_executable_sha256) { throw 'Installed executable SHA256 differs from packaged evidence' }
    $result.executable_hash = 'passed'
    if ($package.media_runtime.status -eq 'bundled') {
        & python scripts/native-client/smoke-installed-media.py (Join-Path $installDir 'media-runtime') $PackageEvidencePath (Join-Path $EvidenceDir 'installed-media-smoke.json')
        if ($LASTEXITCODE -ne 0) { throw 'Installed app-local media smoke failed' }
        $result['media_runtime'] = 'installed-app-local-no-device-smoke-passed'
    }
    $env:LOCALAPPDATA = Join-Path $tempRoot 'user-data'
    New-Item -ItemType Directory -Path $env:LOCALAPPDATA | Out-Null
    $started = Get-Date
    $app = Start-Process -FilePath $exe -WorkingDirectory $installDir -PassThru `
        -RedirectStandardOutput (Join-Path $EvidenceDir 'app-stdout.log') `
        -RedirectStandardError (Join-Path $EvidenceDir 'app-stderr.log')
    $result.process_id = $app.Id
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $samples = @()
    while ($timer.Elapsed.TotalSeconds -lt $ObserveSeconds) {
        Start-Sleep -Seconds 1
        $app.Refresh()
        if ($app.HasExited) { throw "Application exited early: $($app.ExitCode)" }
        $samples += [ordered]@{ seconds = [math]::Round($timer.Elapsed.TotalSeconds, 2); window = $app.MainWindowHandle.ToInt64(); responding = $app.Responding }
    }
    $result.observation_seconds = [math]::Round($timer.Elapsed.TotalSeconds, 2)
    $result.window_samples = $samples
    $result.launch = 'passed'
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class SmokeWindow {
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
}
'@
    $app.Refresh()
    if ($app.HasExited -or $app.MainWindowHandle -eq [IntPtr]::Zero -or -not $app.Responding -or -not [SmokeWindow]::IsWindowVisible($app.MainWindowHandle)) {
        throw 'No responsive visible application window; GUI launch is NOT verified'
    }
    $result.gui = 'visible-responsive-window'
    $result.window_title = $app.MainWindowTitle
    # 仅捕获应用窗口区域；截图可失败但不得伪造 GUI 或锁定界面的视觉验收。
    try {
        Add-Type -AssemblyName System.Drawing
        $rect = New-Object SmokeWindow+Rect
        if (-not [SmokeWindow]::GetWindowRect($app.MainWindowHandle, [ref]$rect)) { throw 'Cannot get window bounds' }
        $bitmap = New-Object Drawing.Bitmap ($rect.Right - $rect.Left), ($rect.Bottom - $rect.Top)
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
            $bitmap.Save((Join-Path $EvidenceDir 'application-window.png'), [Drawing.Imaging.ImageFormat]::Png)
            $result.screenshot = 'captured-window-region; pixels require human review'
        } finally { $graphics.Dispose(); $bitmap.Dispose() }
    } catch { $result.screenshot = 'unavailable: ' + $_.Exception.Message }
    $events = @()
    try {
        $events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = $started; Id = @(1000, 1001, 1026) } -ErrorAction Stop |
            Where-Object { $_.Message -match 'surreal-collaboration\.exe' })
    } catch {
        if ($_.FullyQualifiedErrorId -notlike 'NoMatchingEventsFound*') { throw }
    }
    $events | Format-List TimeCreated, Id, ProviderName, Message | Out-String | Set-Content (Join-Path $EvidenceDir 'application-events.txt')
    if ($events.Count -gt 0) { throw 'Application crash events detected' }
    $stderr = Get-Content (Join-Path $EvidenceDir 'app-stderr.log') -Raw
    if ($stderr -match 'panicked at|fatal runtime error|access violation') { throw 'Application stderr indicates fatal error' }
    $app.Refresh()
    if ($app.HasExited) { throw 'Application exited during evidence capture' }
    $result.crash_check = 'no-matching-crash-event-or-fatal-stderr-during-observation'
    $result.status = 'passed'
} catch {
    $result.error = $_.Exception.Message
} finally {
    try {
        if ($null -ne $app) {
            $app.Refresh()
            if (-not $app.HasExited) { Stop-Process -Id $app.Id -Force -ErrorAction Stop }
        }
    } catch { $result.status = 'failed'; $result.error = 'Process cleanup failed: ' + $_.Exception.Message }
    $env:LOCALAPPDATA = $oldLocalAppData
    try {
        if ($tempRoot) {
            $uninstaller = Join-Path $tempRoot 'app/unins000.exe'
            if (Test-Path -LiteralPath $uninstaller) {
                $uninstall = Start-Process -FilePath $uninstaller -ArgumentList '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART' -PassThru
                if (-not $uninstall.WaitForExit(60000)) { Stop-Process -Id $uninstall.Id -Force; throw 'Uninstall timeout' }
                if ($uninstall.ExitCode -ne 0) { throw "Uninstall failed: $($uninstall.ExitCode)" }
            }
            Remove-Item -LiteralPath $tempRoot -Recurse -Force
        }
        $result.cleanup = 'passed'
    } catch { $result.cleanup = $_.Exception.Message; $result.status = 'failed' }
    $result.finished_utc = [DateTime]::UtcNow.ToString('o')
    $result | ConvertTo-Json -Depth 10 | Set-Content -Encoding utf8 (Join-Path $EvidenceDir 'smoke-result.json')
    $result | Format-List | Out-String | Set-Content -Encoding utf8 (Join-Path $EvidenceDir 'smoke-result.txt')
}
if ($result.status -ne 'passed') { throw "Windows installation smoke failed: $($result.error); cleanup: $($result.cleanup)" }
