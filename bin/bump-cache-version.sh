#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."
VER=$(date -u +%Y%m%d%H%M%S)
sed -i -E "s/(src|href)=\"((engine|network|ui|images|assets)\/[^\"?]+)(\?v=[0-9]+)?\"/\1=\"\2?v=${VER}\"/g" index.html
echo "Cache version bumped to v=${VER}"
