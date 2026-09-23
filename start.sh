#!/bin/bash
# nav-hub 启动脚本
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

PORT="${NAV_PORT:-7788}"

# 已经在跑就不再起一个
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "nav-hub 已在运行：http://127.0.0.1:$PORT"
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "找不到 node，请先安装 Node.js（>= 22.5）" >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Node 版本过低（当前 $(node -v)），需要 >= 22.5" >&2
  exit 1
fi

echo "启动 nav-hub…"
# 环境变量会原样透传：NAV_HOST / NAV_PORT / NAV_AUTH / NAV_DB / NAV_DATA_DIR
exec node server.js
