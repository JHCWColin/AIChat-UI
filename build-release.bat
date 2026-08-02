@echo off
setlocal
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-release.ps1"
set "EXITCODE=%ERRORLEVEL%"

echo.
if not "%EXITCODE%"=="0" (
    echo 打包失败，退出码 %EXITCODE%。
) else (
    echo 打包流程已结束。
)

pause
exit /b %EXITCODE%
