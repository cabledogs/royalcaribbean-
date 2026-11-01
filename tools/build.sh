#!/usr/bin/env bash
# Builds app/build/CruiseDeals.apk without the Android SDK manager.
# Needs: JDK 17+, python3 (+Pillow only to regenerate the icon), and in $TOOLS:
#   android.jar (API 34), dx.jar (com.jakewharton.android.repackaged:dalvik-dx:16.0.1),
#   apksig.jar (com.android.tools.build:apksig:2.3.0)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS="${TOOLS:-$ROOT/.toolchain}"
OUT="$ROOT/app/build"
SRC="$ROOT/app/src/main"
rm -rf "$OUT" && mkdir -p "$OUT/classes" "$OUT/signer"

echo "== compile java"
javac -nowarn -Xlint:-options -source 8 -target 8 -encoding UTF-8 \
  -bootclasspath "$TOOLS/android.jar" -d "$OUT/classes" $(find "$SRC/java" -name '*.java')

echo "== dex"
java -cp "$TOOLS/dx.jar" com.android.dx.command.Main --dex --min-sdk-version=26 --output="$OUT/classes.dex" "$OUT/classes"

echo "== icon"
[ -f "$SRC/res/drawable/ic_launcher.png" ] || python3 "$ROOT/tools/make_icon.py" "$SRC/res/drawable/ic_launcher.png"

echo "== package"
python3 "$ROOT/tools/apkbuild.py" "$SRC/AndroidManifest.xml" "$SRC/res/values/strings.xml" \
  "$SRC/res/drawable/ic_launcher.png" "$OUT/classes.dex" "$SRC/assets" "$OUT/unsigned.apk"

echo "== sign"
KS="${KEYSTORE:-$ROOT/.toolchain/release.p12}"
KSPASS="${KEYSTORE_PASS:-cruisedeals}"
if [ ! -f "$KS" ]; then
  keytool -genkeypair -storetype PKCS12 -keystore "$KS" -storepass "$KSPASS" -keypass "$KSPASS" -alias app \
    -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Cruise Deals" >/dev/null 2>&1
fi
javac -nowarn -cp "$TOOLS/apksig.jar" -d "$OUT/signer" "$ROOT/tools/Sign.java"
java --add-exports java.base/sun.security.x509=ALL-UNNAMED --add-exports java.base/sun.security.pkcs=ALL-UNNAMED --add-exports java.base/sun.security.util=ALL-UNNAMED -cp "$TOOLS/apksig.jar:$OUT/signer" Sign "$KS" "$KSPASS" app "$OUT/unsigned.apk" "$OUT/CruiseDeals.apk"
ls -la "$OUT/CruiseDeals.apk"
