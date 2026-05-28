@echo off
chcp 65001 >/dev/null
cd /d "%~dp0"
echo =================================================
echo   공모 데이터 입력 도구 — 설치
echo =================================================
echo.

python --version >/dev/null 2>&1
if %errorlevel% neq 0 (
    echo [오류] Python이 설치되어 있지 않습니다.
    echo.
    echo 설치 방법:
    echo   1. https://www.python.org/downloads/ 접속
    echo   2. 최신 버전 다운로드 ^(설치 시 "Add to PATH" 체크^)
    echo   3. 설치 완료 후 이 파일을 다시 실행해주세요.
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('python --version') do echo ✅ %%i
echo.

echo [1/3] 가상환경 생성 중...
python -m venv .venv
if %errorlevel% neq 0 (
    echo [오류] 가상환경 생성 실패.
    pause
    exit /b 1
)
echo ✅ 가상환경 준비 완료
echo.

echo [2/3] playwright 설치 중...
.venv\Scripts\pip install --quiet playwright
if %errorlevel% neq 0 (
    echo [오류] playwright 설치 실패.
    pause
    exit /b 1
)
echo ✅ playwright 설치 완료
echo.

echo [3/3] Chromium 브라우저 설치 중... (시간이 걸릴 수 있습니다)
.venv\Scripts\python -m playwright install chromium
if %errorlevel% neq 0 (
    echo [오류] Chromium 설치 실패.
    pause
    exit /b 1
)

echo.
echo =================================================
echo   설치 완료! '윈도우_실행.bat'을 실행하세요.
echo =================================================
pause
