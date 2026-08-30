@echo off
setlocal
pushd "%~dp0"
node.exe "src\cli.js" "stop" "--timeout-seconds" "3600"
set "OCEAN_WAVE_STOP_EXIT=%ERRORLEVEL%"
popd
if not "%OCEAN_WAVE_STOP_EXIT%"=="0" (
  echo.
  echo Ocean Wave safe stop did not complete. No runtime was forcibly terminated.
  pause
)
exit /b %OCEAN_WAVE_STOP_EXIT%
