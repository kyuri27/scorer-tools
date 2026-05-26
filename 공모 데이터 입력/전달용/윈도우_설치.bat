@echo off
chcp 65001 > nul
echo =================================================
echo   공모 데이터 입력 도구 -- 설치
echo =================================================
echo.

python --version > nul 2>&1
if %errorlevel% neq 0 (
    echo [X] Python이 설치되어 있지 않습니다.
    echo.
    echo 설치 방법:
    echo   1. https://www.python.org/downloads/ 접속
    echo   2. 최신 버전 다운로드 및 설치
    echo   3. 설치 시 "Add Python to PATH" 반드시 체크!
    echo   4. 설치 완료 후 이 파일을 다시 실행해주세요.
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('python --version 2^>^&1') do echo [OK] %%i
echo.

echo [1/2] playwright 설치 중...
python -m pip install playwright
if %errorlevel% neq 0 (
    echo.
    echo [X] playwright 설치 실패.
    pause
    exit /b 1
)
echo.

echo [2/2] Chromium 브라우저 설치 중... (시간이 걸릴 수 있습니다)
python -m playwright install chromium
if %errorlevel% neq 0 (
    echo.
    echo [X] Chromium 설치 실패.
    pause
    exit /b 1
)

echo.
echo =================================================
echo   [OK] 설치 완료!
echo   '윈도우_실행.bat' 를 더블클릭하면 시작됩니다.
echo =================================================
pause
