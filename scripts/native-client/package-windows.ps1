$ErrorActionPreference = 'Stop'
& python scripts/native-client/check-version.py
if ($LASTEXITCODE -ne 0) { throw 'Client version mismatch' }
$root = (Get-Location).Path
$out = Join-Path $root 'dist/native-client/windows'
& python scripts/native-client/build-receipt.py begin $out windows
if ($LASTEXITCODE -ne 0) { throw 'Build preflight failed' }
& nsh package native-client --target windows --out "$out/raw"
if ($LASTEXITCODE -ne 0) { throw 'NSH Windows packaging failed' }
$exe = @(Get-ChildItem "$out/raw" -Recurse -Filter '*.exe')
if ($exe.Count -ne 1) { throw 'Expected exactly one NSH application executable' }
$status = 'unsigned'
# The certificate must already be installed by an authorized signing service/runner.
function Sign-File([string]$path) {
    $cert = Get-Item "Cert:\CurrentUser\My\$env:WINDOWS_CERT_THUMBPRINT"
    if (-not $cert.HasPrivateKey) { throw 'Signing certificate has no private key' }
    $result = Set-AuthenticodeSignature -FilePath $path -Certificate $cert -HashAlgorithm SHA256 -TimestampServer 'http://timestamp.digicert.com'
    if ($result.Status -ne 'Valid') { throw "Authenticode failed: $($result.Status)" }
}
if ($env:WINDOWS_CERT_THUMBPRINT) { Sign-File $exe[0].FullName; $status = 'authenticode' }
$appDir = $exe[0].Directory.FullName
$exeName = $exe[0].Name
$version = (Get-Content native-client/nsh.json | ConvertFrom-Json).version
@"
[Setup]
AppId=SurrealCK.NativeClient
AppName=SurrealCK
AppVersion=$version
DefaultDirName={localappdata}\Programs\SurrealCK
DefaultGroupName=SurrealCK
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=$out
OutputBaseFilename=SurrealCK-windows-x64-setup
Compression=lzma2
SolidCompression=yes
UninstallDisplayIcon={app}\$exeName
[Files]
Source: "$appDir\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
[Icons]
Name: "{group}\SurrealCK"; Filename: "{app}\$exeName"
[Run]
Filename: "{app}\$exeName"; Description: "Launch SurrealCK"; Flags: nowait postinstall skipifsilent
"@ | Set-Content "$out/installer.iss"
& 'C:/Program Files (x86)/Inno Setup 6/ISCC.exe' "$out/installer.iss"
if ($LASTEXITCODE -ne 0) { throw 'Inno Setup failed' }
if ($env:WINDOWS_CERT_THUMBPRINT) { Sign-File "$out/SurrealCK-windows-x64-setup.exe" }
"platform=windows`nsigning=$status`ncommit=$env:GITHUB_SHA" | Set-Content "$out/signing-status.txt"

& python scripts/native-client/build-receipt.py finish $out windows
if ($LASTEXITCODE -ne 0) { throw 'Build receipt verification failed' }
