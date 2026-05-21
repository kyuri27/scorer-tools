@echo off
chcp 65001 > nul
echo ==========================================
echo   수상작 자동 입력 툴 - 설치
echo ==========================================
echo.

python --version > nul 2>&1
if errorlevel 1 (
    echo [오류] Python이 설치되어 있지 않습니다.
    echo https://www.python.org 에서 설치 후 다시 실행해주세요.
    echo.
    echo 설치 시 "Add Python to PATH" 옵션을 반드시 체크하세요!
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('python --version') do echo [확인] %%v
echo.

echo [설치 중] playwright...
python -m pip install playwright --quiet
if errorlevel 1 (
    echo [오류] playwright 설치 실패. 인터넷 연결을 확인해주세요.
    pause
    exit /b 1
)
echo [완료] playwright 설치

echo.
echo [설치 중] Chromium 브라우저 (시간이 걸릴 수 있습니다)...
python -m playwright install chromium
if errorlevel 1 (
    echo [오류] Chromium 설치 실패.
    pause
    exit /b 1
)
echo [완료] Chromium 설치

echo.
echo ==========================================
echo   설치 완료! 이제 실행.bat을 더블클릭하세요.
echo ==========================================
echo.
pause
