@echo off
setlocal
set "HF_DEMO=1"
set "HF_CONTROL_PORT=18765"
set "HF_DEMO_SITE_PORT=8788"
set "APP=%LOCALAPPDATA%\Programs\HFRecorder\HFRecorder.exe"
if not exist "%APP%" (
  echo HF Recorder is not installed. Run the installer in this folder first.
  pause
  exit /b 1
)
taskkill /IM HFRecorder.exe /F >nul 2>&1
start "HF Recorder Demo" "%APP%" --demo
ping -n 3 127.0.0.1 >nul
explorer.exe "http://127.0.0.1:8788"
endlocal
exit /b 0
