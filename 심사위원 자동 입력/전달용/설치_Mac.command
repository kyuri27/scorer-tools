#!/bin/bash
echo "=============================="
echo " 심사위원 자동입력 - 설치"
echo "=============================="
echo ""

# Python 확인
if ! command -v python3 &> /dev/null; then
    echo "❌ Python3가 설치되어 있지 않습니다."
    echo "   https://www.python.org 에서 Python을 설치한 뒤 다시 실행해주세요."
    read -p "엔터를 눌러 종료..."
    exit 1
fi

echo "✅ Python3 확인: $(python3 --version)"
echo ""
echo "📦 playwright 설치 중..."
python3 -m pip install playwright
echo ""
echo "🌐 Chromium 브라우저 설치 중..."
python3 -m playwright install chromium
echo ""
echo "=============================="
echo "✅ 설치 완료! 이제 '심사위원자동입력.command'를 실행하세요."
echo "=============================="
read -p "엔터를 눌러 종료..."
