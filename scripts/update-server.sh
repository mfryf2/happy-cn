#!/bin/bash
# =============================================================
# 服务端一键更新脚本
# 功能：将本地最新版本同步到远程服务器，自动重启服务
#
# 用法：
#   bash scripts/update-server.sh                        # 更新后端 + 前端
#   bash scripts/update-server.sh --server-only          # 只更新后端
#   bash scripts/update-server.sh --webapp-only          # 只更新前端
#
# 前置配置（第一次运行前填写）：
#   SERVER_HOST  服务器 IP 或域名
#   SERVER_USER  SSH 用户名（通常是 root）
#   SSH_KEY      SSH 私钥路径
#   DOMAIN       你的域名（用于构建 Web App）
#   DEPLOY_DIR   服务器上的部署目录
# =============================================================

set -e

# ========== 配置区（按实际情况修改）==========
SERVER_HOST="${HAPPY_SERVER_HOST:-}"         # 服务器 IP，或设置环境变量 HAPPY_SERVER_HOST
SERVER_USER="${HAPPY_SERVER_USER:-root}"     # SSH 用户名
SSH_KEY="${HAPPY_SSH_KEY:-~/.ssh/id_ed25519}" # SSH 私钥
DOMAIN="${HAPPY_DOMAIN:-}"                  # 你的域名，或设置环境变量 HAPPY_DOMAIN
DEPLOY_DIR="/www/wwwroot/happy"             # 服务器部署目录
WEBAPP_DIR="/www/wwwroot/happy-webapp"      # Web App 目录
# =============================================

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

# 解析参数
UPDATE_SERVER=true
UPDATE_WEBAPP=true
for arg in "$@"; do
    case $arg in
        --server-only) UPDATE_WEBAPP=false ;;
        --webapp-only) UPDATE_SERVER=false ;;
    esac
done

echo "=========================================="
echo "  Happy CN — 服务端一键更新"
echo "=========================================="
echo ""

# 检查必要配置
if [ -z "$SERVER_HOST" ]; then
    echo "❌ 请先配置服务器 IP："
    echo "   export HAPPY_SERVER_HOST=你的服务器IP"
    echo "   或修改脚本中的 SERVER_HOST 变量"
    exit 1
fi

if [ -z "$DOMAIN" ] && [ "$UPDATE_WEBAPP" = true ]; then
    echo "❌ 请先配置域名："
    echo "   export HAPPY_DOMAIN=your-domain.com"
    echo "   或修改脚本中的 DOMAIN 变量"
    exit 1
fi

SSH_CMD="ssh -T -i $SSH_KEY $SERVER_USER@$SERVER_HOST"

echo "📡 目标服务器：$SERVER_USER@$SERVER_HOST"
echo ""

# ==========================================
# 更新后端（happy-server）
# ==========================================
if [ "$UPDATE_SERVER" = true ]; then
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  [1/2] 更新后端服务"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    echo "📦 打包后端代码..."
    tar --exclude='node_modules' --exclude='.git' \
        --exclude='packages/happy-app' \
        --exclude='packages/happy-cli' \
        --exclude='packages/happy-agent' \
        --exclude='packages/happy-app-logs' \
        --exclude='environments/data' \
        -czf /tmp/happy-server-deploy.tar.gz \
        package.json yarn.lock scripts patches \
        packages/happy-server packages/happy-wire

    # 打包 migrations（如有新增）
    tar -czf /tmp/happy-migrations.tar.gz \
        packages/happy-server/prisma/migrations 2>/dev/null || true

    echo "⬆️  上传到服务器..."
    scp -i "$SSH_KEY" /tmp/happy-server-deploy.tar.gz \
        "$SERVER_USER@$SERVER_HOST:/www/wwwroot/"
    scp -i "$SSH_KEY" /tmp/happy-migrations.tar.gz \
        "$SERVER_USER@$SERVER_HOST:/www/wwwroot/" 2>/dev/null || true

    echo "🔨 服务器上安装依赖并构建..."
    $SSH_CMD << 'ENDSSH'
        export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh"
        cd /www/wwwroot/happy
        tar -xzf /www/wwwroot/happy-server-deploy.tar.gz
        tar -xzf /www/wwwroot/happy-migrations.tar.gz 2>/dev/null || true

        SKIP_HAPPY_WIRE_BUILD=1 yarn install \
            --frozen-lockfile --ignore-engines \
            --registry https://registry.npmmirror.com

        yarn workspace @slopus/happy-wire build
        yarn workspace happy-server generate

        # 运行数据库迁移
        cd packages/happy-server
        set -a; source /www/wwwroot/happy/.env.prod; set +a
        ../../node_modules/.bin/tsx sources/standalone.ts migrate

        # 重启服务
        systemctl restart happy-server
        sleep 2

        # 验证
        if curl -sf http://localhost:3005/health > /dev/null; then
            echo "✅ 后端服务启动成功"
        else
            echo "❌ 后端服务启动失败，查看日志："
            echo "   tail -50 /www/wwwroot/logs/happy-server.log"
            exit 1
        fi
ENDSSH

    echo "✅ 后端更新完成"
    echo ""
fi

# ==========================================
# 更新前端（Web App）
# ==========================================
if [ "$UPDATE_WEBAPP" = true ]; then
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  [2/2] 更新 Web App 前端"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    echo "🔨 本地构建 Web App（目标域名：$DOMAIN）..."
    EXPO_PUBLIC_HAPPY_SERVER_URL="https://$DOMAIN" \
    APP_ENV=production \
    yarn workspace happy-app expo export \
        --platform web \
        --output-dir packages/happy-app/dist-self-hosted

    echo "📦 打包前端..."
    cd packages/happy-app
    tar -czf /tmp/happy-webapp.tar.gz dist-self-hosted
    cd "$REPO_DIR"

    echo "⬆️  上传到服务器..."
    scp -i "$SSH_KEY" /tmp/happy-webapp.tar.gz \
        "$SERVER_USER@$SERVER_HOST:/www/wwwroot/"

    echo "🚀 服务器上替换静态文件..."
    $SSH_CMD << ENDSSH
        cd /www/wwwroot
        tar -xzf happy-webapp.tar.gz
        cp -r dist-self-hosted/* $WEBAPP_DIR/
        rm -rf dist-self-hosted
        echo "✅ Web App 更新完成（nginx 无需重启）"
ENDSSH

    echo "✅ 前端更新完成"
    echo ""
fi

# 清理临时文件
rm -f /tmp/happy-server-deploy.tar.gz \
      /tmp/happy-migrations.tar.gz \
      /tmp/happy-webapp.tar.gz

echo "=========================================="
echo "  ✅ 服务端更新全部完成！"
if [ "$UPDATE_WEBAPP" = true ]; then
    echo "  Web App：https://$DOMAIN"
fi
echo "=========================================="
