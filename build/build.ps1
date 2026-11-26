# Build the Windows backend exe used by the Electron shell.
# Usage (PowerShell, from repo root):
#   powershell -ExecutionPolicy Bypass -File build\build.ps1
# 输出到 build\_backend\（Electron 会把它打进 resources\backend\），不是对外产物。

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$Py = Join-Path $Root ".venv\Scripts\python.exe"
if (-not (Test-Path $Py)) { throw "Missing .venv, see docs/DEPLOY.md" }

Write-Host "[1/3] check build deps"
& $Py -c "import PyInstaller, pystray, PIL" 2>$null
if ($LASTEXITCODE -ne 0) {
    & $Py -m pip install pyinstaller pystray pillow -i https://pypi.tuna.tsinghua.edu.cn/simple
}

Write-Host "[2/3] make icon"
& $Py build\make_icon.py

Write-Host "[3/3] pyinstaller onefile"
# 上一版进程还开着会锁住 exe，先收掉；杀毒/索引可能还会占用几秒。
Get-Process -Name EchoQ-Ops -ErrorAction SilentlyContinue | Stop-Process -Force
$Target = Join-Path $Root "build\_backend\EchoQ-Ops.exe"
for ($i = 0; $i -lt 40 -and (Test-Path $Target); $i++) {
    try {
        $stream = [IO.File]::Open($Target, 'Open', 'ReadWrite', 'None')
        $stream.Close()
        break
    } catch {
        Start-Sleep -Milliseconds 500
    }
}
& $Py -m PyInstaller --noconfirm --clean --distpath build\_backend --workpath build\_work build\echoq.spec
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }

$Exe = Join-Path $Root "build\_backend\EchoQ-Ops.exe"
if (-not (Test-Path $Exe)) { throw "Missing $Exe" }
$Size = [math]::Round((Get-Item $Exe).Length / 1MB, 1)
Write-Host "built $Exe ($Size MB)"
