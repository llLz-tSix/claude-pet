#!/bin/sh
# macOS: двойной щелчок запускает питомца (нужен Node.js: https://nodejs.org). Первый запуск ставит Electron.
cd "$(dirname "$0")" || exit 1
if [ ! -x node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ]; then
  echo "First run: installing Electron (about 100 MB)..."
  npm install || { echo "npm install failed. Is Node.js installed? https://nodejs.org"; exit 1; }
fi
nohup node_modules/electron/dist/Electron.app/Contents/MacOS/Electron "$(pwd)" >/dev/null 2>&1 &
echo "Claude pet started."
