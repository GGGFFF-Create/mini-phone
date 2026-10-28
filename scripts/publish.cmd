@echo off
REM 小手机 · 发布
REM
REM 双击运行，或者：
REM   publish.cmd -Token ghp_xxx
REM   publish.cmd -Gh
REM   publish.cmd -Ssh
REM
REM 这个包装的作用：绕过 PowerShell 的执行策略，不用改系统设置。

setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish.ps1" %*
set code=%ERRORLEVEL%
if not "%code%"=="0" (
  echo.
  echo 退出码 %code%
)
endlocal & exit /b %code%
