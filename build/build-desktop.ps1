# Build the Electron desktop app: installer + portable → release\electron.
# Usage (PowerShell, from repo root):
#   powershell -ExecutionPolicy Bypass -File build\build-desktop.ps1

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

Write-Host "[1/3] build backend exe"
powershell -ExecutionPolicy Bypass -File build\build.ps1
if ($LASTEXITCODE -ne 0) { throw "backend build failed" }

$ElectronDir = Join-Path $Root "electron"
Push-Location $ElectronDir
try {
    if (-not (Test-Path "node_modules\electron")) {
        Write-Host "[2/3] install electron deps"
        $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
        npm install --registry=https://registry.npmmirror.com
        if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
    } else {
        Write-Host "[2/3] electron deps already installed"
    }

    Write-Host "[3/3] electron-builder"
    $env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
    npm run dist
    if ($LASTEXITCODE -ne 0) { throw "electron-builder failed" }
} finally {
    Pop-Location
}

Get-ChildItem (Join-Path $Root "release\electron") -Filter "*.exe" | ForEach-Object {
    $mb = [math]::Round($_.Length / 1MB, 1)
    Write-Host "built $($_.FullName) ($mb MB)"
}
