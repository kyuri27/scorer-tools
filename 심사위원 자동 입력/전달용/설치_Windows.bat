@echo off
echo ==============================
echo  심사위원 자동입력 - 설치
echo ==============================
echo.

python --version >/dev/null 2>&1
if %errorlevel% neq 0 (
    echo X Python이 설치되어 있지 않습니다.
    echo   https://www.python.org 에서 Python을 설치한 뒤 다시 실행해주세요.
    echo   설치 시 "Add Python to PATH" 옵션을 반드시 체크하세요!
    pause
    exit /b 1
)

echo [OK] Python 확인 완료
echo.
echo playwright 설치 중...
python -m pip install playwright
echo.
echo Chromium 브라우저 설치 중...
python -m playwright install chromium
echo.
echo ==============================
echo [OK] 설치 완료! 이제 심사위원자동입력.bat을 실행하세요.
echo ==============================
pause
