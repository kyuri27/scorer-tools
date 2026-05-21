#!/bin/bash
echo "=========================================="
echo "  수상작 자동 입력 툴 - 설치"
echo "=========================================="
echo ""

# Python 확인
if ! command -v python3 &> /dev/null; then
    echo "❌ Python3가 설치되어 있지 않습니다."
    echo "   https://www.python.org 에서 설치 후 다시 실행해주세요."
    read -p "엔터를 눌러 종료..."
    exit 1
fi

echo "✅ Python3 확인: $(python3 --version)"
echo ""

# pip로 playwright 설치
echo "📦 playwright 설치 중..."
python3 -m pip install playwright --quiet
if [ $? -ne 0 ]; then
    echo "❌ playwright 설치 실패. 인터넷 연결을 확인해주세요."
    read -p "엔터를 눌러 종료..."
    exit 1
fi
echo "✅ playwright 설치 완료"
echo ""

# Chromium 브라우저 설치
echo "🌐 Chromium 브라우저 설치 중... (시간이 걸릴 수 있습니다)"
python3 -m playwright install chromium
if [ $? -ne 0 ]; then
    echo "❌ Chromium 설치 실패."
    read -p "엔터를 눌러 종료..."
    exit 1
fi
echo "✅ Chromium 설치 완료"
echo ""

# 실행.command 실행 권한 부여
chmod +x "$(dirname "$0")/실행.command"

echo "=========================================="
echo "  설치 완료! 이제 '실행.command'를 더블클릭하면 됩니다."
echo "=========================================="
echo ""
read -p "엔터를 눌러 종료..."
