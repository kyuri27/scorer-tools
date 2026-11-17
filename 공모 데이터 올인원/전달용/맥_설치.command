#!/bin/bash
cd "$(dirname "$0")"
echo "================================================="
echo "  공모 데이터 입력 도구 — 설치"
echo "================================================="
echo ""

if ! command -v python3 &>/dev/null; then
    echo "[!] Python3가 없습니다. 자동 설치를 시도합니다..."
    echo ""
    if command -v brew &>/dev/null; then
        brew install python3
    else
        echo "  Homebrew를 먼저 설치합니다 (시간이 걸릴 수 있습니다)..."
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        if command -v brew &>/dev/null; then
            brew install python3
        else
            echo ""
            echo "[자동 설치 실패] 직접 설치해주세요:"
            echo "  https://www.python.org/downloads/"
            open "https://www.python.org/downloads/"
            read -p "설치 후 이 파일을 다시 실행해주세요. 엔터를 눌러 종료..."
            exit 1
        fi
    fi
    echo ""
fi

echo "✅ $(python3 --version) 확인"
echo ""

echo "[1/3] 가상환경 생성 중..."
# Homebrew Python 우선 사용 (macOS 기본 python3는 venv 생성 불가)
PYTHON3=""
for p in /opt/homebrew/bin/python3 /usr/local/bin/python3 python3; do
    if command -v "$p" &>/dev/null && "$p" -m venv --help &>/dev/null 2>&1; then
        PYTHON3="$p"
        break
    fi
done
if [ -z "$PYTHON3" ]; then
    echo "❌ 사용 가능한 Python3를 찾지 못했습니다."
    read -p "엔터를 눌러 종료..."
    exit 1
fi
"$PYTHON3" -m venv .venv
if [ $? -ne 0 ]; then
    echo "❌ 가상환경 생성 실패."
    read -p "엔터를 눌러 종료..."
    exit 1
fi
echo "✅ 가상환경 준비 완료"
echo ""

echo "[2/3] playwright 설치 중..."
.venv/bin/pip install --quiet playwright
if [ $? -ne 0 ]; then
    echo "❌ playwright 설치 실패."
    read -p "엔터를 눌러 종료..."
    exit 1
fi
echo "✅ playwright 설치 완료"
echo ""

echo "[3/3] Chromium 브라우저 설치 중... (시간이 걸릴 수 있습니다)"
.venv/bin/python -m playwright install chromium
if [ $? -ne 0 ]; then
    echo "❌ Chromium 설치 실패."
    read -p "엔터를 눌러 종료..."
    exit 1
fi

echo ""
echo "================================================="
echo "  ✅ 설치 완료!"
echo "  '맥_실행.command'를 더블클릭하면 시작됩니다."
echo "================================================="
read -p "엔터를 눌러 종료..."
