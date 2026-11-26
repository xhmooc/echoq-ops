@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "PY=.venv\Scripts\python.exe"
if not exist "%PY%" (
    echo [x] .venv not found. See DEPLOY.md for setup steps.
    exit /b 1
)

set "TARGET=%~1"
if "%TARGET%"=="" set "TARGET=spider"

if /i "%TARGET%"=="spider" goto run_spider
if /i "%TARGET%"=="login"  goto run_login
if /i "%TARGET%"=="demo"   goto run_demo
if /i "%TARGET%"=="main"   goto run_main
if /i "%TARGET%"=="check"  goto run_check
if /i "%TARGET%"=="ops"    goto run_ops
if /i "%TARGET%"=="shell"  goto run_shell

echo Unknown target: %TARGET%
echo Usage: run.cmd [spider ^| login ^| demo ^| main ^| check ^| ops ^| shell]
exit /b 2

:run_spider
"%PY%" -X utf8 -m vendor.spider.spider
exit /b %errorlevel%

:run_login
"%PY%" -X utf8 vendor\upstream\login.py %2
exit /b %errorlevel%

:run_demo
"%PY%" -X utf8 vendor\upstream\demo.py
exit /b %errorlevel%

:run_main
"%PY%" -X utf8 vendor\upstream\main.py
exit /b %errorlevel%

:run_check
"%PY%" -X utf8 check_env.py
exit /b %errorlevel%

:run_ops
set "OPS_ARGS="
shift
:ops_collect
if "%~1"=="" goto ops_run
set "OPS_ARGS=%OPS_ARGS% %1"
shift
goto ops_collect

:ops_run
if "%OPS_ARGS%"=="" set "OPS_ARGS=serve"
"%PY%" -X utf8 -m ops%OPS_ARGS%
exit /b %errorlevel%

:run_shell
"%PY%" -X utf8
exit /b %errorlevel%
