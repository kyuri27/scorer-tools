@echo off
chcp 65001 >/dev/null
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo [오류] 설치가 필요합니다. 먼저 '윈도우_설치.bat'을 실행해주세요.
    pause
    exit /b 1
)

.venv\Scripts\python main.py
pause
