# 会话级环境变量：source scripts/env.sh 后再构建。不改系统环境。
# 工具链根目录可用 FF_TOOLCHAIN_WIN / FF_TOOLCHAIN_POSIX 覆盖（默认 D 盘）
TC_WIN="${FF_TOOLCHAIN_WIN:-D:/android-toolchain}"
TC_POSIX="${FF_TOOLCHAIN_POSIX:-/d/android-toolchain}"
export JAVA_HOME="$TC_WIN/jdk-21"
export ANDROID_HOME="$TC_WIN/sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export GRADLE_USER_HOME="$TC_WIN/gradle-home"
export ANDROID_USER_HOME="$TC_WIN/android-user-home"
export TEMP="$TC_WIN/tmp"
export TMP="$TEMP"
export npm_config_cache="$TC_WIN/npm-cache"
# PATH 必须用 POSIX 形式（/d/...），Windows 盘符冒号会被 bash 当分隔符
export PATH="$TC_POSIX/jdk-21/bin:$TC_POSIX/sdk/platform-tools:$TC_POSIX/sdk/cmdline-tools/latest/bin:$PATH"
mkdir -p "$TEMP" "$ANDROID_USER_HOME"