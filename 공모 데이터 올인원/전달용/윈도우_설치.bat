@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
echo =================================================
echo   공모 데이터 입력 도구 -- 설치
echo =================================================
echo.

REM Python 확인
call :find_python
if defined PYTHON_CMD (
    for /f "tokens=*" %%i in ('"%PYTHON_CMD%" --version') do echo %%i 확인
    echo.
    goto :install_venv
)

REM Python 없으면 자동 설치
echo [!] Python이 없습니다. python.org 에서 자동 다운로드합니다...
echo     (수 분 정도 걸릴 수 있습니다)
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$url='https://www.python.org/ftp/python/3.12.9/python-3.12.9-amd64.exe'; $out=$env:TEMP+'\python_setup.exe'; Write-Host '  다운로드 중...'; Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing; Write-Host '  설치 중...'; Start-Process $out -ArgumentList '/quiet InstallAllUsers=0 PrependPath=1' -Wait; Write-Host '  완료'"
if %errorlevel% neq 0 (
    echo.
    echo [자동 설치 실패] 직접 설치해주세요:
    echo  1. https://www.python.org/downloads/ 접속
    echo  2. 최신 버전 다운로드
    echo  3. 설치 시 'Add Python to PATH' 반드시 체크!
    echo  4. 설치 완료 후 이 파일을 다시 실행
    start https://www.python.org/downloads/
    pause
    exit /b 1
)
echo.

call :find_python
if not defined PYTHON_CMD (
    echo [!] Python 설치됐지만 경로를 찾지 못했습니다.
    echo     이 창을 닫고 설치 파일을 다시 실행해주세요.
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('"%PYTHON_CMD%" --version') do echo %%i 확인
echo.

:install_venv
echo [1/3] 가상환경 생성 중...
"%PYTHON_CMD%" -m venv .venv
if %errorlevel% neq 0 (
    echo [오류] 가상환경 생성 실패.
    pause
    exit /b 1
)
echo 가상환경 준비 완료
echo.

echo [2/3] playwright 설치 중...
.venv\Scripts\pip install --quiet playwright
if %errorlevel% neq 0 (
    echo [오류] playwright 설치 실패.
    pause
    exit /b 1
)
echo playwright 설치 완료
echo.

echo [3/3] Chromium 설치 중... (수 분 정도 걸릴 수 있습니다)
chcp 437 >nul
.venv\Scripts\python -m playwright install chromium
set CHROM_ERR=%errorlevel%
chcp 949 >nul
if %CHROM_ERR% neq 0 (
    echo.
    echo [오류] Chromium 설치 실패.
    echo 인터넷 연결을 확인하거나, 잠시 후 설치 파일을 다시 실행해주세요.
    pause
    exit /b 1
)

echo.
echo =================================================
echo   설치 완료! 윈도우_실행.bat 을 실행하세요.
echo =================================================
pause
exit /b 0

:find_python
set PYTHON_CMD=
for /f %%i in ('python -c "print(1)" 2^>nul') do (
    if "%%i"=="1" set "PYTHON_CMD=python"
)
if defined PYTHON_CMD goto :eof
for /f %%i in ('py -c "print(1)" 2^>nul') do (
    if "%%i"=="1" set "PYTHON_CMD=py"
)
if defined PYTHON_CMD goto :eof
for %%v in (313 312 311 310) do (
    if not defined PYTHON_CMD (
        if exist "%LOCALAPPDATA%\Programs\Python\Python%%v\python.exe" (
            set "PYTHON_CMD=%LOCALAPPDATA%\Programs\Python\Python%%v\python.exe"
        )
    )
)
for %%v in (313 312 311 310) do (
    if not defined PYTHON_CMD (
        if exist "%PROGRAMFILES%\Python%%v\python.exe" (
            set "PYTHON_CMD=%PROGRAMFILES%\Python%%v\python.exe"
        )
    )
)
for %%v in (313 312 311 310) do (
    if not defined PYTHON_CMD (
        if exist "C:\Python%%v\python.exe" (
            set "PYTHON_CMD=C:\Python%%v\python.exe"
        )
    )
)
goto :eof
