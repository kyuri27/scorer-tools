@echo off
cd /d "%~dp0"

if exist ".venv\Scripts\python.exe" goto :run

echo [오류] 설치가 필요합니다. 먼저 윈도우_설치.bat 을 실행해주세요.
pause
exit /b 1

:run
chcp 65001 >nul
.venv\Scripts\python main.py
pause
