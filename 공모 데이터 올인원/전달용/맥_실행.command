#!/bin/bash
cd "$(dirname "$0")"

# 설치 여부 확인
if [ ! -f ".venv/bin/python" ]; then
    echo "❌ 설치가 필요합니다. 먼저 '맥_설치.command'를 실행해주세요."
    read -p "엔터를 눌러 종료..."
    exit 1
fi

.venv/bin/python main.py
