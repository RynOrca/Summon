param([string]$Output = "")
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$tauri = Join-Path $root 'node_modules/.bin/tauri.cmd'
if (-not (Test-Path -LiteralPath $tauri)) { throw 'Run npm ci in the repository first.' }
if (-not $Output) { $Output = Join-Path $root 'dist/Reed-release' }
$Output = [IO.Path]::GetFullPath($Output)
if (Test-Path -LiteralPath $Output) { $Output = "$Output-$(Get-Date -Format yyyyMMdd-HHmmss)" }
New-Item -ItemType Directory -Path $Output | Out-Null
$portable = Join-Path $Output 'Reed-portable'
& (Join-Path $PSScriptRoot 'package-portable.ps1') -Output $portable
if ($LASTEXITCODE -gt 7) { throw 'Portable staging failed' }
$resources = @{}
foreach ($folder in @('agent','runtime')) { $resources[(Join-Path $portable "$folder/")] = "$folder/" }
foreach ($file in @('LICENSE','NOTICE.md','PI-DESKTOP-LICENSE','MARKED-LICENSE')) { $resources[(Join-Path $portable $file)] = $file }
$config = @{
    bundle = @{
        active = $true; useLocalToolsDir = $true; targets = @('nsis'); icon = @('icons/icon.ico')
        shortDescription = 'Reed 一苇 — 一苇以航，轻渡学海。'
        resources = $resources
        windows = @{
            nsis = @{ installMode = 'currentUser'; languages = @('SimpChinese','English'); displayLanguageSelector = $false; installerIcon = 'icons/icon.ico'; compression = 'lzma' }
            webviewInstallMode = @{ type = 'downloadBootstrapper' }
        }
    }
}
$configPath = Join-Path $Output 'installer-config.json'
[IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
$env:RUSTUP_TOOLCHAIN = 'stable'
$target = if ($env:CARGO_TARGET_DIR) { [IO.Path]::GetFullPath($env:CARGO_TARGET_DIR) } else { Join-Path $root 'desktop/src-tauri/target' }
Push-Location (Join-Path $root 'desktop')
try { & $tauri build --bundles nsis --config $configPath; if ($LASTEXITCODE -ne 0) { throw 'Installer build failed' } }
finally { Pop-Location }
$installer = Get-ChildItem -LiteralPath (Join-Path $target 'release/bundle/nsis') -Filter '*setup.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $installer) { throw 'Installer output not found' }
Copy-Item -LiteralPath $installer.FullName -Destination (Join-Path $Output 'Reed-0.1.0-setup.exe')
$version = @{ product = 'Reed'; version = '0.1.0'; sourceCommit = (& git -C $root rev-parse HEAD); dataDirectory = '%APPDATA%\Reed' }
[IO.File]::WriteAllText((Join-Path $portable 'VERSION.json'), ($version | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
Compress-Archive -Path (Join-Path $portable '*') -DestinationPath (Join-Path $Output 'Reed-0.1.0-portable.zip')
$checksums = foreach ($file in Get-ChildItem -LiteralPath $Output -File | Where-Object { $_.Extension -in @('.exe','.zip') }) {
    "$((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLower())  $($file.Name)"
}
[IO.File]::WriteAllLines((Join-Path $Output 'SHA256SUMS.txt'), $checksums, [Text.UTF8Encoding]::new($false))
Write-Host "Release artifacts: $Output"
