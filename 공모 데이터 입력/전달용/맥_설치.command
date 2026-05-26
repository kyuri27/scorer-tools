#!/bin/bash
cd "$(dirname "$0")"
echo "================================================="
echo "  공모 데이터 입력 도구 — 설치"
echo "================================================="
echo ""

# Python3 확인
if ! command -v python3 &>/dev/null; then
    echo "❌ Python3가 설치되어 있지 않습니다."
    echo ""
    echo "설치 방법:"
    echo "  1. https://www.python.org/downloads/ 접속"
    echo "  2. 최신 버전 다운로드 및 설치"
    echo "  3. 설치 완료 후 이 파일을 다시 실행해주세요."
    read -p "엔터를 눌러 종료..."
    exit 1
fi

echo "✅ $(python3 --version)"
echo ""

echo "[1/2] playwright 설치 중..."
python3 -m pip install playwright
if [ $? -ne 0 ]; then
    echo ""
    echo "❌ playwright 설치 실패."
    echo "   터미널에서 직접 실행: python3 -m pip install playwright"
    read -p "엔터를 눌러 종료..."
    exit 1
fi
echo ""

echo "[2/2] Chromium 브라우저 설치 중... (시간이 걸릴 수 있습니다)"
python3 -m playwright install chromium
if [ $? -ne 0 ]; then
    echo ""
    echo "❌ Chromium 설치 실패."
    echo "   터미널에서 직접 실행: python3 -m playwright install chromium"
    read -p "엔터를 눌러 종료..."
    exit 1
fi

echo ""
echo "================================================="
echo "  ✅ 설치 완료!"
echo "  '맥_실행.command'를 더블클릭하면 시작됩니다."
echo "================================================="
read -p "엔터를 눌러 종료..."
