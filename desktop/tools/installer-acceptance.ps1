param([Parameter(Mandatory=$true)][string]$Installer)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$desktop = [Environment]::GetFolderPath('DesktopDirectory')
$programs = [Environment]::GetFolderPath('Programs')
# Never replace an existing installation or user shortcut during acceptance.
foreach ($key in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Reed', 'HKCU:\Software\reed\Reed')) {
    if (Test-Path -LiteralPath $key) { throw "Existing installation settings found; isolated acceptance stopped: $key" }
}
foreach ($shortcut in @((Join-Path $desktop 'Reed.lnk'), (Join-Path $programs 'Reed.lnk'))) {
    if (Test-Path -LiteralPath $shortcut) { throw "Existing shortcut found; isolated acceptance stopped: $shortcut" }
}
$testRoot = Join-Path $env:TEMP ('reed-installer-acceptance-' + [Guid]::NewGuid().ToString('N'))
$installDir = Join-Path $testRoot 'app'
$profile = Join-Path $testRoot 'profile'
New-Item -ItemType Directory -Path $testRoot,$profile | Out-Null
$setup = Join-Path $testRoot 'setup.exe'
Copy-Item -LiteralPath (Resolve-Path -LiteralPath $Installer).Path -Destination $setup
$env:SUMMON_TEST_DATA_DIR = $profile
$sentinel = Join-Path $profile 'preserve-me.txt'
[IO.File]::WriteAllText($sentinel, 'isolated user data')
$checks = [Collections.Generic.List[string]]::new()
function Install-TestPackage {
    $result = Start-Process -FilePath $setup -ArgumentList "/S /D=$installDir" -WindowStyle Hidden -Wait -PassThru
    if ($result.ExitCode -ne 0) { throw "Installer exited $($result.ExitCode)" }
    foreach ($file in @('Reed.exe','runtime/node.exe','agent/bridge.mjs','agent/user-config.mjs','uninstall.exe')) {
        if (-not (Test-Path -LiteralPath (Join-Path $installDir $file))) { throw "Missing installed file: $file" }
    }
}
Install-TestPackage
$checks.Add('Current-user silent installation includes app, runtime, Agent and uninstaller')
Install-TestPackage
if ([IO.File]::ReadAllText($sentinel) -ne 'isolated user data') { throw 'Upgrade changed profile data' }
$checks.Add('Reinstall preserves isolated profile')
$env:SUMMON_TEST_PACKAGE = $installDir
& node (Join-Path $PSScriptRoot 'desktop-acceptance.cjs') *> (Join-Path $root 'dist/installed-desktop-test.log')
if ($LASTEXITCODE -ne 0) { throw 'Installed app acceptance failed; see dist/installed-desktop-test.log' }
$checks.Add('Installed binary passes isolated desktop and PI Agent acceptance')
$uninstaller = Start-Process -FilePath (Join-Path $installDir 'uninstall.exe') -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
if ($uninstaller.ExitCode -ne 0) { throw "Uninstaller exited $($uninstaller.ExitCode)" }
$deadline = (Get-Date).AddSeconds(30)
while ((Test-Path -LiteralPath (Join-Path $installDir 'Reed.exe')) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
if (Test-Path -LiteralPath (Join-Path $installDir 'Reed.exe')) { throw 'Uninstall did not remove application' }
if ([IO.File]::ReadAllText($sentinel) -ne 'isolated user data') { throw 'Uninstall changed profile data' }
if (Test-Path -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Reed') { throw 'Uninstall registration remains' }
$checks.Add('Uninstall removes application and uninstall registration, preserves profile')
$report = @{ checks = $checks.ToArray(); testRoot = $testRoot; installer = $Installer }
[IO.File]::WriteAllText((Join-Path $root 'dist/installer-acceptance-report.json'), ($report | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
$report | ConvertTo-Json -Depth 5
