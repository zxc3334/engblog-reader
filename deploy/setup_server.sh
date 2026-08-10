#!/usr/bin/env bash
# EngBlog Reader 服务器一键部署脚本（Ubuntu 22.04 / 24.04，1GB 内存友好）
# 用法：以 root 或 sudo 运行
set -euo pipefail

APP_DIR=/opt/engblog-reader
SERVICE=engblog.service

echo "==> [1/6] 安装系统依赖（python3-venv / git / curl）"
apt-get update -qq
apt-get install -y -qq python3-venv python3-pip git curl >/dev/null

echo "==> [2/6] 准备 1GB swap（防止 OOM）"
if [ ! -f /swapfile ]; then
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "    已创建 1G swap"
else
  echo "    swap 已存在，跳过"
fi

echo "==> [3/6] 部署项目到 $APP_DIR"
if [ ! -d "$APP_DIR" ]; then
  read -rp "请输入你的项目 git 仓库地址（留空则从本机 scp 上传）: " REPO
  if [ -n "$REPO" ]; then
    git clone "$REPO" "$APP_DIR"
  else
    echo "    请在本机执行: scp -r /home/jackson/engblog-reader/* root@<服务器IP>:$APP_DIR"
    mkdir -p "$APP_DIR"
    exit 0
  fi
fi
cd "$APP_DIR"

echo "==> [4/6] 创建虚拟环境并安装依赖"
python3 -m venv .venv
.venv/bin/pip install -q -r server/requirements.txt

echo "==> [5/6] 创建运行用户并配置 systemd"
id -u www-data >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin www-data
mkdir -p "$APP_DIR/data"
chown -R www-data:www-data "$APP_DIR"
cp deploy/engblog.service /etc/systemd/system/$SERVICE
systemctl daemon-reload
systemctl enable $SERVICE
systemctl restart $SERVICE
sleep 2
systemctl --no-pager status $SERVICE --lines=5 || true

echo "==> [6/6] 验证"
sleep 2
IP=$(curl -s ifconfig.me || hostname -I | awk '{print $1}')
echo ""
echo "=================================================="
echo " 部署完成！公网访问:  http://$IP:8000"
echo ""
echo " 还没完，还差两步："
echo "  ① Azure NSG: 网络安全组放行 TCP 8000 入站"
echo "  ② 数据迁移:  本地设置→数据管理→导出JSON，"
echo "               然后服务器设置→从备份恢复"
echo "  ③ 安全提醒:  公网务必加登录保护（找我配置）"
echo "=================================================="
