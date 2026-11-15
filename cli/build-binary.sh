#!/bin/sh
# Самостоятельный бинарник testbolctl (без установленного Node.js) — Node.js Single Executable Applications.
# Собирается на той ОС, для которой нужен бинарник: Linux → testbolctl, Windows → testbolctl.exe, macOS → testbolctl.
# Нужны Node.js 20+ и доступ к npm (утилита postject).
set -e
cd "$(dirname "$0")"
mkdir -p lib dist
cp ../scripts/report.js lib/report.js
# один файл: report.js встраивается внутрь, чтобы бинарнику не нужны были соседние файлы
node -e "
const fs=require('fs');
const lib=fs.readFileSync('lib/report.js','utf8').replace(/^#!.*\n/,'');
const cli=fs.readFileSync('bin/testbolctl.js','utf8').replace(/^#!.*\n/,'')
  .replace(/const report = require\([^;]+\);/, () => 'const report = (() => { const module = { exports: {} }; (function (module, exports, require) {\n' + lib + '\n})(module, module.exports, require); return module.exports; })();');
fs.writeFileSync('dist/testbolctl.bundle.js', cli);
"
echo '{ "main": "dist/testbolctl.bundle.js", "output": "dist/sea-prep.blob", "disableExperimentalSEAWarning": true }' > dist/sea-config.json
node --experimental-sea-config dist/sea-config.json
OUT=dist/testbolctl; case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) OUT=dist/testbolctl.exe;; esac
cp "$(command -v node)" "$OUT"
if [ "$(uname -s)" = "Darwin" ]; then codesign --remove-signature "$OUT" || true; fi
npx --yes postject "$OUT" NODE_SEA_BLOB dist/sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 $( [ "$(uname -s)" = "Darwin" ] && echo --macho-segment-name NODE_SEA )
if [ "$(uname -s)" = "Darwin" ]; then codesign --sign - "$OUT" || true; fi
echo "Готово: $OUT"
