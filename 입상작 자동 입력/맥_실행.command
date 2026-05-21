#!/bin/bash
cd "$(dirname "$0")"
python3 main.py
osascript -e 'tell application "Terminal" to close front window' > /dev/null 2>&1 &
