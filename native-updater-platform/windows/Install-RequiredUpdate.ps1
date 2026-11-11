# 仅由本机可信桥传入经 native-updater 验证的参数。禁止网络直接调用。
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Installer,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$Sha256,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$PublisherCertificateSha256
)
$ErrorActionPreference = 'Stop'
$path = (Resolve-Path -LiteralPath $Installer).ProviderPath
$item = Get-Item -LiteralPath $path
if ($item.PSIsContainer -or $item.Extension -ne '.exe' -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe installer path' }
# 更新文件必须位于用户私有应用数据目录；不会提权、改变执行策略或绕过UAC。
$root = [IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\') + '\'
if (-not $path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw 'Installer outside private user data' }
# 持有只读共享句柄，阻止验证到启动之间替换/写入安装器。
$stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
    $hash = [Security.Cryptography.SHA256]::Create()
    try {
        $actual = [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '')
        if ($actual -ne $Sha256) { throw 'Installer digest mismatch' }
        $signature = Get-AuthenticodeSignature -LiteralPath $path
        if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) { throw 'Untrusted Authenticode signature' }
        $publisher = [BitConverter]::ToString($hash.ComputeHash($signature.SignerCertificate.RawData)).Replace('-', '')
        if ($publisher -ne $PublisherCertificateSha256) { throw 'Publisher certificate mismatch' }
    } finally { $hash.Dispose() }
    # 仅固定参数，不从策略接受shell片段、路径或提升权限。
    $process = Start-Process -FilePath $path -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/SP-','/CLOSEAPPLICATIONS','/RESTARTAPPLICATIONS') -PassThru -Wait
    if ($process.ExitCode -ne 0) { throw "Installer failed: $($process.ExitCode)" }
} finally { $stream.Dispose() }
# 退出0不是客户端Ready；新进程还需完整在线验证。
