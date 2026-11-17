#!/usr/bin/env bash
# 生成 release 签名密钥（一次性）。产物 android/forforever.keystore 与 keystore.properties 均已 gitignore。
# 用法：bash scripts/gen-keystore.sh [storepass，默认随机生成]
set -e
cd "$(dirname "$0")/.."
source scripts/env.sh
PASS="${1:-$(openssl rand -hex 16)}"
if [ -f android/forforever.keystore ]; then
  echo "keystore 已存在，跳过生成"
else
  keytool -genkeypair -v -keystore android/forforever.keystore -alias forforever \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$PASS" -keypass "$PASS" \
    -dname "CN=Forforever, OU=Dev, O=Forforever, C=CN"
fi
cat > android/keystore.properties <<EOF
storeFile=forforever.keystore
storePassword=$PASS
keyAlias=forforever
keyPassword=$PASS
EOF
echo "keystore ready. 备份好 android/forforever.keystore 与密码：丢失后无法更新同签名应用。"