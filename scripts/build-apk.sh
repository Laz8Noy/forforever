#!/usr/bin/env bash
# 一键构建 APK：source 环境 → web 构建 → cap sync → gradle assembleDebug → 拷贝到 release/
set -e
cd "$(dirname "$0")/.."
source scripts/env.sh
npm run build
npx cap sync android
cd android
./gradlew assembleDebug --no-daemon
mkdir -p ../release
cp app/build/outputs/apk/debug/app-debug.apk ../release/Forforever-v0.1.0.apk
echo "APK ready: E:/Forforever/release/Forforever-v0.1.0.apk"