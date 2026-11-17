#!/usr/bin/env bash
# 一次性安装精简安卓工具链（JDK21 + cmdline-tools + SDK35 + build-tools），国内镜像。
# 用法：bash scripts/install-toolchain.sh [目标目录POSIX形式，默认 /d/android-toolchain]
set -e
TC_POSIX="${1:-/d/android-toolchain}"
TC_WIN="$(cygpath -w "$TC_POSIX" | sed 's|\\|/|g')"
mkdir -p "$TC_POSIX/downloads"
cd "$TC_POSIX/downloads"

if [ ! -d "$TC_POSIX/jdk-21" ]; then
  curl -sSL --retry 3 -o jdk21.zip "https://mirrors.tuna.tsinghua.edu.cn/Adoptium/21/jdk/x64/windows/OpenJDK21U-jdk_x64_windows_hotspot_21.0.13_9.zip"
  unzip -q jdk21.zip -d "$TC_POSIX"
  mv "$TC_POSIX/jdk-21.0.13+9" "$TC_POSIX/jdk-21"
  rm -f jdk21.zip
fi

if [ ! -d "$TC_POSIX/sdk/cmdline-tools/latest" ]; then
  curl -sSL --retry 3 -o cmdtools.zip "https://mirrors.cloud.tencent.com/AndroidSDK/commandlinetools-win-11076708_latest.zip"
  unzip -q cmdtools.zip -d ct-tmp
  mkdir -p "$TC_POSIX/sdk/cmdline-tools"
  mv ct-tmp/cmdline-tools "$TC_POSIX/sdk/cmdline-tools/latest"
  rmdir ct-tmp
  rm -f cmdtools.zip
fi

export FF_TOOLCHAIN_WIN="$TC_WIN" FF_TOOLCHAIN_POSIX="$TC_POSIX"
source "$(dirname "$0")/env.sh"
yes | sdkmanager.bat --licenses > "$TC_POSIX/licenses.log" 2>&1 || true
sdkmanager.bat "platform-tools" "platforms;android-35" "build-tools;35.0.0"
echo "toolchain ready: $TC_WIN"