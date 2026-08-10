#!/usr/bin/env bash
# 启动 EngBlog Reader
set -e
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  echo "首次运行：创建虚拟环境并安装依赖…"
  python3 -m venv .venv
  .venv/bin/pip install -r server/requirements.txt
fi

exec .venv/bin/python server/main.py
