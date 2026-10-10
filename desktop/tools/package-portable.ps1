param([string]$Output = "")
$ErrorActionPreference = 'Stop'
$desktopDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$projectDir = Join-Path $desktopDir 'src-tauri'
$agentDir = Join-Path $desktopDir 'agent'
if (-not (Test-Path (Join-Path $agentDir 'node_modules'))) {
    throw 'Install Agent dependencies first: cd desktop/agent; npm ci'
}
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$nodeVersion = & $nodeExe -p 'process.versions.node'
$parts = $nodeVersion.Split('.')
if ([int]$parts[0] -lt 22 -or ([int]$parts[0] -eq 22 -and [int]$parts[1] -lt 19)) {
    throw "Node.js 22.19+ is required; found $nodeVersion"
}
if (-not $Output) { $Output = Join-Path $desktopDir 'dist-portable' }
$Output = [IO.Path]::GetFullPath($Output)
if (Test-Path -LiteralPath $Output) { $Output = "$Output-$(Get-Date -Format yyyyMMdd-HHmmss)" }
New-Item -ItemType Directory -Force -Path $Output | Out-Null
$env:RUSTUP_TOOLCHAIN = 'stable'
$targetDir = if ($env:CARGO_TARGET_DIR) { [IO.Path]::GetFullPath($env:CARGO_TARGET_DIR) } else { Join-Path $projectDir 'target' }
Push-Location $projectDir
try { & cargo build --release; if ($LASTEXITCODE -ne 0) { throw 'Cargo release build failed' } }
finally { Pop-Location }
Copy-Item -LiteralPath (Join-Path $targetDir 'release\summon-desktop.exe') -Destination (Join-Path $Output 'Summon.exe') -Force
New-Item -ItemType Directory -Force -Path (Join-Path $Output 'runtime'), (Join-Path $Output 'agent') | Out-Null
Copy-Item -LiteralPath $nodeExe -Destination (Join-Path $Output 'runtime\node.exe') -Force
Copy-Item -LiteralPath (Join-Path $agentDir 'bridge.mjs') -Destination (Join-Path $Output 'agent\bridge.mjs') -Force
Copy-Item -LiteralPath (Join-Path $agentDir 'approval.mjs') -Destination (Join-Path $Output 'agent\approval.mjs') -Force
Copy-Item -LiteralPath (Join-Path $agentDir 'roles.mjs') -Destination (Join-Path $Output 'agent\roles.mjs') -Force
Copy-Item -LiteralPath (Join-Path $agentDir 'images.mjs') -Destination (Join-Path $Output 'agent\images.mjs') -Force
Copy-Item -LiteralPath (Join-Path $agentDir 'files.mjs') -Destination (Join-Path $Output 'agent\files.mjs') -Force
Copy-Item -LiteralPath (Join-Path $agentDir 'endpoint.mjs') -Destination (Join-Path $Output 'agent\endpoint.mjs') -Force
Copy-Item -LiteralPath (Join-Path $agentDir 'memory.mjs') -Destination (Join-Path $Output 'agent\memory.mjs') -Force
Copy-Item -LiteralPath (Join-Path $agentDir 'providers.mjs') -Destination (Join-Path $Output 'agent\providers.mjs') -Force
Copy-Item -LiteralPath (Join-Path $agentDir 'memory-agent.mjs') -Destination (Join-Path $Output 'agent\memory-agent.mjs') -Force
foreach ($module in @('capabilities.mjs', 'browser.mjs', 'learning-tools.mjs', 'learner.mjs', 'sandbox.mjs', 'user-config.mjs', 'mcp.mjs')) { Copy-Item -LiteralPath (Join-Path $agentDir $module) -Destination (Join-Path $Output "agent\$module") -Force }
Copy-Item -LiteralPath (Join-Path $agentDir 'role-skills.mjs') -Destination (Join-Path $Output 'agent\role-skills.mjs') -Force
Copy-Item -LiteralPath (Join-Path $agentDir 'skills') -Destination (Join-Path $Output 'agent\skills') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $agentDir 'package.json') -Destination (Join-Path $Output 'agent\package.json') -Force
# Copy dependency trees without mirroring/deleting destination files.
& robocopy.exe (Join-Path $agentDir 'node_modules') (Join-Path $Output 'agent\node_modules') /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
if ($LASTEXITCODE -gt 7) { throw "Agent dependency copy failed (robocopy $LASTEXITCODE)" }
Copy-Item -LiteralPath (Join-Path $desktopDir 'PI-DESKTOP-LICENSE') -Destination (Join-Path $Output 'PI-DESKTOP-LICENSE') -Force
Copy-Item -LiteralPath (Join-Path $desktopDir 'README.md') -Destination (Join-Path $Output 'README.md') -Force
Write-Host "Portable build: $Output"
